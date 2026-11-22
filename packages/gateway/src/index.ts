import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import {
	type AuthProvider,
	CLIENT_CAPABILITIES_META_KEY,
	CLIENT_INFO_META_KEY,
	Client,
	isJSONRPCErrorResponse,
	LOG_LEVEL_META_KEY,
	type OAuthClientProvider,
	PROTOCOL_VERSION_META_KEY,
	SdkErrorCode,
	SdkHttpError,
	SSEClientTransport,
	StreamableHTTPClientTransport,
	type Transport,
	UriTemplate,
} from "@modelcontextprotocol/client";
import {
	type ApprovalParameters,
	type ApprovalRequest,
	ApprovalRequiredError,
	ApprovalUnsupportedError,
	approvalMessage,
	canonicalJson,
	envelopeOnly,
	type RuntimeApprovals,
	sha256Hex,
	toolDecision,
} from "./approval";
import { type ContinuationOptions, continuationHandler } from "./continuations";
import { connectionLabel } from "./detect";
import { type ListenOptions, modernSubscriptions } from "./listen";
import { fetchWithoutRedirects, upstreamUnreachable } from "./network";
import {
	AccessRefusedError,
	type RefusalReason,
	refusalOutcome,
} from "./refusal";
import type { ReplayOptions } from "./replay";
import { boundedMcpRequest } from "./request-body";
import {
	type ObservedTool,
	observeTool,
	type ToolReview,
	toolReviewed,
} from "./review";
import {
	accessState,
	clientCapabilities,
	interactionOptions,
	liveConnection,
	modernOrigin,
	type Origin,
	origins,
	type SessionHooks,
	type SessionOptions,
	sessionHandler,
	transportResponse,
	upstreamIdentity,
	wireInteractions,
} from "./sessions";
import {
	type LocalCommand,
	LocalCommandError,
	LocalCommandTransport,
} from "./stdio";
import { resourceSubscriptions } from "./subscriptions";
import { withSessionCleanup } from "./upstream-cleanup";

export * from "./approval";
export * from "./debug";
export * from "./detect";
export * from "./oauth";
export * from "./refusal";
export * from "./review";
export * from "./stdio";

import {
	type CallToolResult,
	type HandlerResultTypeMap,
	isLegacyRequest,
	type Prompt,
	type RequestMethod,
	type RequestTypeMap,
	type Resource,
	type ResourceTemplateType,
	Server,
	type ServerCapabilities,
	type ServerContext,
	type Tool,
	WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/server";

export type Kind = "tools" | "resources" | "prompts";
export interface Rules {
	full: boolean;
	allow: Record<Kind, string[]>;
	block: Record<Kind, string[]>;
	/** Exact tool names granted only per approved call. */
	requireApproval?: string[];
}
export interface Upstream {
	/** Stable selected-account identity, including its credential/grant revision. */
	identityKey?: string;
	id: string;
	label: string;
	/** Readable, scope-unique and never reassigned (`linear`, `linear2`); exposed names are
	 * `<namespace>__<upstream name>`. Without one, names use the opaque legacy alias. */
	namespace?: string;
	/** The remote server's address; empty for a local command. */
	url: string;
	/** `http` or `sse` for a remote server, `stdio` for a local command. */
	transport: string;
	headers: Record<string, string>;
	/** What a `stdio` upstream runs; it starts only when the runtime's `validateCommand` allows it. */
	command?: LocalCommand;
	authProvider?: OAuthClientProvider | AuthProvider;
	rules: Rules[];
	/** When present, only tools whose live definition was reviewed are listed or run. */
	toolReview?: ToolReview;
}
export interface Operation {
	id: string;
	connectionId: string;
	method: string;
	target?: string;
	maintenance?: boolean;
	capability?: Kind;
	/** The claimed approval this wire forwards; hosts may consume it inside admission. */
	approval?: { id: string; operationId: string };
}
export interface CapturedPayload {
	arguments: unknown;
	result: unknown;
}
export type CaptureHook = (
	operation: Operation,
) => Promise<((payload: CapturedPayload) => Promise<void>) | undefined>;
interface Permit {
	id: string;
	digest: string;
	state: "claimed" | "released" | "consumed";
	/** Set only after a provider-known authentication rejection of the dispatched wire. */
	resend: boolean;
}
interface RequestOperation {
	operation: Operation;
	permit?: Permit;
	// Only the first wire belongs to the decoded logical outcome. Later modern
	// follow-ups remain independently metered; no response data is retained here.
	pending?: {
		operation: Operation;
		started: number;
		httpOutcome: "forwarded" | "upstream_error";
		finalized?: boolean;
	};
}
const captureOperation = new AsyncLocalStorage<RequestOperation>();
/** The fields of an outgoing JSON-RPC message that admission reads. */
type WireMessage = {
	id?: string | number;
	method?: string;
	params?: {
		name?: string;
		uri?: string;
		ref?: { type?: string; name?: string; uri?: string };
		[key: string]: unknown;
	};
};
export interface Runtime {
	/** Optional diagnostics. Never receives transport headers or authentication state. */
	capture?: CaptureHook;

	sessionKey?: string;
	authenticate?(): Promise<void>;
	check?(
		connectionId: string,
		kind?: Kind,
		target?: string,
		/** `catalog`: the checked work sends only catalog list requests (tools, resources, templates, prompts). */
		options?: { inFlight?: boolean; catalog?: boolean },
	): Promise<void>;
	/** Fresh authorized descriptors, including sources supplied to inspect(). */
	connections(): Promise<Upstream[]>;
	admit(operation: Operation): Promise<void>;
	record(
		operation: Operation,
		outcome: string,
		durationMs: number,
	): Promise<void>;
	validateDestination(url: URL): Promise<void>;
	/** Allows a local command (`transport: "stdio"`) to start now. Without it they never run. */
	validateCommand?(upstream: Upstream): Promise<void>;
	fetch?: typeof fetch;
	/** Required for approval-gated tools; without it they fail closed. */
	approvals?: RuntimeApprovals;
	/** A short next step (such as a dashboard link) appended to a refusal the agent sees. */
	refusalHint?(reason: RefusalReason, connectionId: string): string | undefined;
	/** First-party tools listed before connection tools. Calls are not metered operations. */
	tools?: BuiltinTools;
}
export interface BuiltinTools {
	/** Names contain no `__` and never start like a legacy alias (`c` + 32 hex digits + `_`),
	 * so they cannot shadow a connection's name. */
	definitions: Tool[];
	call(name: string, args: Record<string, unknown>): Promise<CallToolResult>;
}
export const emptyRules = (): Rules => ({
	full: false,
	allow: { tools: [], resources: [], prompts: [] },
	block: { tools: [], resources: [], prompts: [] },
});
function matches(kind: Kind, grant: string, target: string) {
	if (grant === target) return true;
	if (kind !== "resources" || !UriTemplate.isTemplate(grant)) return false;
	try {
		return new UriTemplate(grant).match(target) !== null;
	} catch {
		return false;
	}
}
export function permitted(rules: Rules[], kind: Kind, name: string) {
	if (
		rules.some((rule) =>
			rule.block[kind].some((grant) => matches(kind, grant, name)),
		)
	)
		return false;
	return rules.some(
		(rule) =>
			rule.full ||
			rule.allow[kind].some((grant) => matches(kind, grant, name)) ||
			(kind === "tools" && !!rule.requireApproval?.includes(name)),
	);
}

/** Canonical binding of the connection, selected account, rule revision and exact parameters. */
export function approvalRequest(
	upstream: Upstream,
	parameters: ApprovalParameters,
): ApprovalRequest {
	const exact = JSON.parse(canonicalJson(parameters)) as ApprovalParameters;
	return {
		connectionId: upstream.id,
		connectionLabel: upstream.label,
		tool: parameters.name,
		parameters: exact,
		binding: canonicalJson(
			{
				v: 1,
				connectionId: upstream.id,
				identity: upstreamIdentity(upstream),
				rules: upstream.rules,
				// Reviewing a new definition invalidates approvals made for the previous one.
				...(upstream.toolReview
					? {
							definition:
								upstream.toolReview.reviewed.get(parameters.name) ?? null,
						}
					: {}),
				parameters: exact,
			},
			{ maxBytes: 8 * 1024 * 1024, maxDepth: 64 },
		),
	};
}
const approvalEnvelope = new Set([
	"progressToken",
	PROTOCOL_VERSION_META_KEY,
	CLIENT_INFO_META_KEY,
	CLIENT_CAPABILITIES_META_KEY,
	LOG_LEVEL_META_KEY,
]);
const unsupportedContinuation = () =>
	new ApprovalUnsupportedError(
		"Approval-gated tools cannot answer upstream input requests or continue a request; ask the connection owner to change the rule if this tool needs follow-up input",
	);
/**
 * The only functional fields an approval-gated tools/call may forward. Anything else, including
 * task augmentation, requester _meta and continuation inputs, fails closed.
 */
function gatedParameters(params: unknown, envelope?: ReadonlySet<string>) {
	if (!params || typeof params !== "object" || Array.isArray(params))
		throw new ApprovalUnsupportedError("Invalid tool call parameters");
	const {
		name,
		arguments: args,
		_meta,
		...rest
	} = params as Record<string, unknown>;
	if ("inputResponses" in rest || "requestState" in rest)
		throw unsupportedContinuation();
	if (Object.keys(rest).length)
		throw new ApprovalUnsupportedError(
			"Approval-gated tool calls accept only a name and arguments",
		);
	if (!envelopeOnly(_meta, envelope ?? new Set(["progressToken"])))
		throw new ApprovalUnsupportedError(
			"Approval-gated tool calls cannot carry request metadata",
		);
	if (
		typeof name !== "string" ||
		(args !== undefined &&
			(!args || typeof args !== "object" || Array.isArray(args)))
	)
		throw new ApprovalUnsupportedError("Invalid tool call parameters");
	return {
		name,
		arguments: (args ?? {}) as Record<string, unknown>,
	} satisfies ApprovalParameters;
}
/** The approval a gated call is waiting on, without the call's parameters. */
function approvalReference({ approval }: ApprovalRequiredError) {
	return {
		id: approval.id,
		status: approval.status,
		expiresAt: approval.expiresAt.toISOString(),
		...(approval.reviewUrl ? { reviewUrl: approval.reviewUrl } : {}),
	};
}
/** Exact approval-required result for an MCP client; it never echoes parameters. */
export function approvalResult(error: ApprovalRequiredError) {
	return {
		isError: true,
		content: [{ type: "text" as const, text: approvalMessage(error) }],
		_meta: { "toolstile/approval": approvalReference(error) },
	};
}
/** MCP list requests that only read a server's catalog. */
const catalogMethods = new Set([
	"tools/list",
	"resources/list",
	"resources/templates/list",
	"prompts/list",
]);
export function operationCapability(operation: Operation): Kind | undefined {
	const kind = operation.capability ?? operation.method.split("/")[0];
	return ["tools", "resources", "prompts"].includes(kind)
		? (kind as Kind)
		: undefined;
}
const aliasPrefix = (id: string) => `c${id.replaceAll("-", "")}_`;
/** The opaque name used before readable namespaces. Still accepted for its own connection,
 * so a name a client cached keeps working and can never reach another connection. */
export const alias = (id: string, name: string) =>
	`${aliasPrefix(id)}${sha256Hex(name).slice(0, 24)}`;
type Named = Pick<Upstream, "id" | "namespace">;
/** MCP's tool name limit; a longer readable name keeps the fixed-length legacy alias. */
const MAX_NAME_LENGTH = 128;
/** The tool or prompt name an agent sees: `linear__get_issue`, `linear2__get_issue`. */
export const exposedName = (upstream: Named, name: string) => {
	const readable = upstream.namespace && `${upstream.namespace}__${name}`;
	return readable && readable.length <= MAX_NAME_LENGTH
		? readable
		: alias(upstream.id, name);
};
/** Whether `value` could name something on this connection, in either form. */
const addressed = (upstream: Named, value: string) =>
	(!!upstream.namespace && value.startsWith(`${upstream.namespace}__`)) ||
	value.startsWith(aliasPrefix(upstream.id));
const names = (upstream: Named, value: string, name: string) =>
	value === exposedName(upstream, name) || value === alias(upstream.id, name);
/** An explicit block names the original; refuse its name before any upstream lookup. */
const blockedAlias = (upstream: Upstream, kind: Kind, value: string) =>
	upstream.rules.some((rule) =>
		rule.block[kind].some((name) => names(upstream, value, name)),
	);
export const resourceAlias = (id: string, uri: string) =>
	`toolstile://${id}/${Buffer.from(uri).toString("base64url")}`;

// A literal prefix preserves every RFC 6570 expression and its expansion exactly.
export const resourceTemplateAlias = (id: string, template: string) =>
	`toolstile://${id}/template/${template}`;
function originalResource(id: string, value: string) {
	const prefix = `toolstile://${id}/`;
	if (!value.startsWith(prefix)) return undefined;
	const rest = value.slice(prefix.length);
	if (rest.startsWith("template/")) return rest.slice("template/".length);
	if (!/^[A-Za-z0-9_-]+$/.test(rest)) return undefined;
	const original = Buffer.from(rest, "base64url").toString("utf8");
	return resourceAlias(id, original) === value ? original : undefined;
}
function routedContent<T>(id: string, content: T): T {
	if (!content || typeof content !== "object") return content;
	const block = content as Record<string, unknown>;
	if (block.type === "resource_link" && typeof block.uri === "string")
		return { ...content, uri: resourceAlias(id, block.uri) };
	if (
		block.type === "resource" &&
		block.resource &&
		typeof block.resource === "object" &&
		"uri" in block.resource &&
		typeof block.resource.uri === "string"
	)
		return {
			...content,
			resource: {
				...block.resource,
				uri: resourceAlias(id, block.resource.uri),
			},
		};
	return content;
}

export async function openUpstream(
	runtime: Runtime,
	selected: Upstream,
	purpose: string,
	_target: string | undefined,
	capability?: Kind,
	signal?: AbortSignal,
): Promise<Client> {
	const upstream: Upstream = {
		...selected,
		headers: { ...selected.headers },
		rules: structuredClone(selected.rules),
	};
	// Capture immutable fingerprints before a live check can resolve a different
	// selected account or mutate the rules attached to this logical connection.
	const expectedIdentity = upstreamIdentity(upstream);
	const expectedRules = accessState(upstream);
	let client: Client | undefined;
	let invalidated = false;
	async function assertExpected() {
		try {
			if (invalidated)
				throw new Error(
					"Upstream authorization changed; reconnect before retrying",
				);
			await liveConnection(
				runtime,
				{ id: upstream.id, identity: expectedIdentity, rules: expectedRules },
				"Upstream authorization changed; reconnect before retrying",
			);
		} catch (error) {
			if (!invalidated) {
				invalidated = true;
				// Reject requests waiting on an interaction response which can no longer
				// be sent safely on this transport.
				void client?.close().catch(() => {});
			}
			throw error;
		}
	}
	/** The live checks before opening; a local command repeats them right before it starts. */
	const authorizeOpen = async () => {
		await assertExpected();
		await runtime.check?.(
			upstream.id,
			capability ??
				operationCapability({
					id: "",
					connectionId: upstream.id,
					method: purpose,
				}),
			_target,
			// Dashboard checks ("discovery") and route validation ("routing") send only list requests.
			{
				catalog:
					purpose === "discovery" ||
					purpose === "routing" ||
					catalogMethods.has(purpose),
			},
		);
		await assertExpected();
	};
	await authorizeOpen();
	// An approved call runs without interactions: an upstream question would add input the
	// reviewer never saw, so the gated client advertises none and wires no handlers.
	const gated =
		purpose === "tools/call" &&
		_target !== undefined &&
		toolDecision(upstream.rules, _target) === "approval";
	client = new Client(
		{ name: "toolstile", version: "0.1.0" },
		{
			capabilities: gated ? {} : clientCapabilities(origins.getStore()),
			versionNegotiation: {
				// A local command gets the plain initialize handshake: the negotiation probe would
				// start a second child for every operation.
				mode:
					upstream.transport === "sse" || upstream.transport === "stdio"
						? "legacy"
						: "auto",
			},
		},
	);
	if (!gated)
		wireInteractions(
			client,
			runtime,
			upstream,
			capability ??
				operationCapability({
					id: "",
					connectionId: upstream.id,
					method: purpose,
				}),
			_target,
		);
	const identities = new Map<string, string>();
	const capturedOperations = new WeakSet<RequestOperation>();
	// A server that cannot be reached never gets an admitted operation, so a failed
	// handshake is recorded on its own (unmetered) for activity to show.
	const opened = Date.now();
	let connected = false,
		unreachable = false;
	let local: LocalCommandTransport | undefined;
	/**
	 * Admission, approval and metering for one outgoing JSON-RPC message, whichever transport
	 * carries it: the HTTP transports call this for each request body, the stdio transport for
	 * each message it writes. `maintenance` sends protocol traffic (the handshake,
	 * notifications and replies to the server) unadmitted; `forward` sends an admitted request.
	 */
	async function guard<T>(
		payload: WireMessage | unknown[],
		carry: {
			maintenance(): Promise<T>;
			forward(): Promise<{ value: T; ok: boolean; reauthenticate?: boolean }>;
		},
	): Promise<T> {
		if (Array.isArray(payload))
			throw new Error("JSON-RPC batches are not supported");
		// Only protocol notifications travel without an id. A request method sent as a
		// notification would skip admission, metering and approval.
		if (
			payload.method &&
			payload.id === undefined &&
			!String(payload.method).startsWith("notifications/")
		)
			throw new Error("Unsupported upstream notification");
		// Transport handshake and notifications are protocol maintenance. Admit each
		// forwarded JSON-RPC operation, including each list page, independently.
		if (
			!payload.method ||
			payload.method === "initialize" ||
			payload.method === "server/discover" ||
			payload.id === undefined
		) {
			await assertExpected();
			return carry.maintenance();
		}
		const context = captureOperation.getStore();
		let permit: Permit | undefined;
		if (
			payload.method === "tools/call" &&
			toolDecision(upstream.rules, String(payload.params?.name)) === "approval"
		) {
			// Defence in depth: every approval-gated wire must carry this call's claimed
			// permit and exactly the reviewed parameters, whoever built the request.
			permit = context?.permit;
			if (!permit)
				throw new ApprovalUnsupportedError(
					"Approval-gated tool calls must go through approval",
				);
			if (
				sha256Hex(
					canonicalJson(gatedParameters(payload.params, approvalEnvelope)),
				) !== permit.digest
			)
				throw new ApprovalUnsupportedError(
					"Tool call parameters differ from the approved request",
				);
			if (
				permit.state === "released" ||
				(permit.state === "consumed" && !permit.resend)
			)
				throw new ApprovalUnsupportedError(
					"An approved tool call is forwarded at most once",
				);
			permit.resend = false;
		}
		const key = String(payload.id),
			id =
				identities.get(key) ??
				(context && !capturedOperations.has(context)
					? context.operation.id
					: randomUUID());
		identities.set(key, id);
		if (context) capturedOperations.add(context);
		const operation: Operation = {
			id,
			connectionId: upstream.id,
			method: payload.method,
			maintenance: purpose === "maintenance",
			target:
				payload.params?.name ??
				payload.params?.uri ??
				payload.params?.ref?.name ??
				payload.params?.ref?.uri,
			...(payload.method === "completion/complete"
				? {
						capability:
							payload.params?.ref?.type === "ref/prompt"
								? ("prompts" as const)
								: ("resources" as const),
					}
				: payload.method === "subscriptions/listen"
					? { capability, target: _target }
					: {}),
			...(permit && context
				? {
						approval: {
							id: permit.id,
							operationId: context.operation.id,
						},
					}
				: {}),
		};
		const started = Date.now();
		try {
			await assertExpected();
			await runtime.admit(operation);
			await assertExpected();
			if (permit?.state === "claimed") {
				// Spent before dispatch: a crash or ambiguous write never re-sends it.
				// The store accepts only this exact claim (or its own earlier consumption
				// during admission) and throws otherwise, so nothing is sent unclaimed.
				if (!runtime.approvals)
					throw new Error("Capability unavailable or access denied");
				await runtime.approvals.settle(
					permit.id,
					context?.operation.id ?? id,
					"consumed",
				);
				permit.state = "consumed";
			}
		} catch (error) {
			if (permit?.state === "claimed") {
				// Nothing was forwarded, so a known refusal returns the approval.
				permit.state = "released";
				await runtime.approvals
					?.release(permit.id, context?.operation.id ?? id)
					.catch(() => {});
			}
			// A denied retry has already finalized this identity. Do not let
			// completion of the original request overwrite the security outcome.
			if (context?.pending?.operation.id === id)
				context.pending.finalized = true;
			await runtime.record(operation, "denied", Date.now() - started);
			throw error;
		}
		let pending: RequestOperation["pending"];
		if (context && id === context.operation.id) {
			context.pending ??= {
				operation,
				started,
				httpOutcome: "upstream_error",
			};
			pending = context.pending;
		}
		try {
			const { value, ok, reauthenticate } = await carry.forward();
			const outcome = ok ? "forwarded" : "upstream_error";
			// The provider refused authentication before running the call; the SDK may
			// re-send this same wire once after refreshing credentials.
			if (permit) permit.resend = reauthenticate === true;
			if (pending) pending.httpOutcome = outcome;
			else await runtime.record(operation, outcome, Date.now() - started);
			return value;
		} catch (error) {
			if (pending) pending.httpOutcome = "upstream_error";
			else
				await runtime.record(operation, "upstream_error", Date.now() - started);
			throw error;
		}
	}
	try {
		let transport: Transport;
		if (upstream.transport === "stdio") {
			// A child process is not a network destination: the host's switch and the owner's
			// role, checked here on every open, take the place of the destination policy.
			if (!upstream.command || !runtime.validateCommand)
				throw new Error("Local commands are turned off on this server");
			const validateCommand = runtime.validateCommand.bind(runtime);
			await validateCommand(upstream);
			await assertExpected();
			const send = async (write: () => Promise<void>) => {
				try {
					await write();
				} catch (error) {
					if (!connected) unreachable = true;
					throw error;
				}
			};
			local = new LocalCommandTransport(upstream.command, {
				// A request cancelled while it waits for a slot never starts the command.
				signal:
					signal ?? (interactionOptions() as { signal?: AbortSignal }).signal,
				// Waiting for a slot can outlast the checks above: the caller's access, then the
				// owner's role and the switch, are checked again right before the child starts.
				// The role check is last, so nothing is awaited between it and the spawn.
				authorize: async () => {
					await authorizeOpen();
					await validateCommand(upstream);
				},
				// A written message is forwarded: stdio has no response status, and a logical
				// request's outcome and duration are recorded when it completes.
				guard: (message, write) =>
					guard<void>(message as WireMessage, {
						maintenance: () => send(write),
						forward: async () => {
							await send(write);
							return { value: undefined, ok: true };
						},
					}),
			});
			transport = local;
		} else {
			const url = new URL(upstream.url);
			await runtime.validateDestination(url);
			const handshake = async (
				input: RequestInfo | URL,
				init?: RequestInit,
			) => {
				try {
					const response = await fetchWithoutRedirects(
						runtime.fetch ?? fetch,
						input,
						init,
					);
					if (!connected && response.status >= 500) unreachable = true;
					return response;
				} catch (error) {
					if (!connected) unreachable = true;
					throw error;
				}
			};
			const guardedFetch: typeof fetch = async (input, init) => {
				const destination = new URL(
					input instanceof Request ? input.url : String(input),
				);
				await runtime.validateDestination(destination);
				// A redirect cannot carry stored credentials to a second destination.
				const contentType = new Headers(init?.headers).get("content-type");
				const payload: unknown =
					typeof init?.body === "string" &&
					contentType?.includes("application/json")
						? JSON.parse(init.body)
						: null;
				if (Array.isArray(payload))
					throw new Error("JSON-RPC batches are not supported");
				// A POST always carries one JSON-RPC message. A body that can't be read here
				// (another encoding, a stream or a Request body) would skip admission below.
				const method = (
					init?.method ?? (input instanceof Request ? input.method : "GET")
				).toUpperCase();
				if (
					method === "POST" &&
					(payload === null || typeof payload !== "object")
				)
					throw new Error("Unsupported upstream request body");
				// Cleanup may follow revocation: it only terminates the captured session,
				// still validates its destination, and never admits another operation.
				if (init?.method === "DELETE")
					return fetchWithoutRedirects(runtime.fetch ?? fetch, input, init);
				return guard<Response>(
					payload && typeof payload === "object"
						? (payload as WireMessage)
						: {},
					{
						maintenance: () => handshake(input, init),
						forward: async () => {
							const response = await fetchWithoutRedirects(
								runtime.fetch ?? fetch,
								input,
								init,
							);
							return {
								value: response,
								ok: response.ok,
								reauthenticate:
									response.status === 401 ||
									(response.status === 403 &&
										/insufficient_scope/i.test(
											response.headers.get("www-authenticate") ?? "",
										)),
							};
						},
					},
				);
			};
			const options = {
				requestInit: { headers: upstream.headers },
				fetch: guardedFetch,
				authProvider: upstream.authProvider,
			};
			await assertExpected();
			transport =
				upstream.transport === "sse"
					? new SSEClientTransport(url, options)
					: new StreamableHTTPClientTransport(url, options);
		}
		withSessionCleanup(client, transport);
		await client.connect(transport, {
			...interactionOptions(),
			...(signal ? { signal } : {}),
		});
		connected = true;

		const capture = runtime.capture;
		const original = client.request.bind(client);
		client.request = ((...args: Parameters<typeof original>) => {
			const [request] = args;
			if (
				![
					"tools/call",
					"resources/read",
					"prompts/get",
					"completion/complete",
				].includes(request.method)
			)
				return original(...args);
			const params = request.params as Record<string, unknown> | undefined;
			const operation: Operation = {
				id: randomUUID(),
				connectionId: upstream.id,
				method: request.method,
				target: _target,
				capability,
				maintenance: purpose === "maintenance",
			};
			const context: RequestOperation = { operation };
			const gatedCall =
				request.method === "tools/call" &&
				toolDecision(upstream.rules, String(params?.name)) === "approval";
			// A permit claimed but never dispatched (e.g. a local SDK failure) cannot be reused.
			async function abandon() {
				const permit = context.permit;
				if (permit?.state !== "claimed") return;
				permit.state = "released";
				await runtime.approvals
					?.settle(permit.id, operation.id, "invalidated")
					.catch(() => {});
			}
			async function recordCompletion(failed: boolean) {
				const pending = context.pending;
				if (pending && !pending.finalized)
					await runtime.record(
						pending.operation,
						failed ? "upstream_error" : pending.httpOutcome,
						Date.now() - pending.started,
					);
			}
			return captureOperation.run(context, async () => {
				if (gatedCall) {
					// Precheck before capture, admission or metering: an unapproved call never
					// reaches the upstream and its parameters never enter diagnostics.
					const denied = async (outcome: string) =>
						runtime
							.record(
								{ ...operation, target: String(params?.name) },
								outcome,
								0,
							)
							.catch(() => {});
					if (!gated || params?.name !== _target) {
						await denied("denied");
						throw new ApprovalUnsupportedError(
							"Approval-gated tools must be opened for that exact call",
						);
					}
					if (!runtime.approvals) {
						await denied("denied");
						throw new Error("Capability unavailable or access denied");
					}
					const parameters = gatedParameters(params);
					const begun = await runtime.approvals.begin(
						approvalRequest(upstream, parameters),
						operation.id,
					);
					if (begun.kind !== "permit") {
						await denied(
							begun.kind === "denied" ? "denied" : "approval_required",
						);
						throw new ApprovalRequiredError({
							id: begun.id,
							status: begun.kind,
							expiresAt: begun.expiresAt,
							reviewUrl: begun.reviewUrl,
						});
					}
					context.permit = {
						id: begun.id,
						digest: sha256Hex(canonicalJson(parameters)),
						state: "claimed",
						resend: false,
					};
				}
				const save = await capture?.(operation).catch(() => undefined);
				let result: Awaited<ReturnType<typeof original>>;
				try {
					result = await original(...args);
				} catch (error) {
					await abandon();
					// Recording must never replace the SDK's domain error.
					await recordCompletion(true).catch(() => {});
					throw error;
				}
				await abandon();
				await recordCompletion(
					request.method === "tools/call" &&
						typeof result === "object" &&
						result !== null &&
						"isError" in result &&
						result.isError === true,
				);
				await assertExpected();
				await runtime.check?.(
					upstream.id,
					operationCapability(operation),
					_target,
					{ inFlight: true },
				);
				if (save) {
					await save({
						arguments:
							params?.arguments ??
							(request.method === "resources/read"
								? { uri: params?.uri }
								: params),
						result,
					}).catch(() => {});
				}
				return result;
			});
		}) as typeof client.request;
		return client;
	} catch (error) {
		await client.close().catch(() => {});
		// A local command that started but never completed the handshake is unreachable too,
		// unless the handshake stopped because access changed.
		const stopped = !!local?.spawned && !connected && !invalidated;
		if (unreachable || stopped)
			await runtime
				.record(
					{
						id: randomUUID(),
						connectionId: upstream.id,
						method: "initialize",
						maintenance: purpose === "maintenance",
					},
					"upstream_error",
					Date.now() - opened,
				)
				.catch(() => {});
		throw stopped && local ? local.failure(error) : error;
	}
}

export async function invoke<T>(
	runtime: Runtime,
	upstream: Upstream,
	purpose: string,
	target: string | undefined,
	work: (client: Client) => Promise<T>,
	capability?: Kind,
	/** The dashboard request this serves; cancelling it stops the open. */
	signal?: AbortSignal,
): Promise<T> {
	const client = await openUpstream(
		runtime,
		upstream,
		purpose,
		target,
		capability,
		signal,
	);
	try {
		return await work(client);
	} finally {
		await client.close().catch(() => {});
	}
}

type CatalogEntry = Record<string, unknown> & {
	name?: string;
	uri?: string;
	uriTemplate?: string;
};
type CatalogKind = Kind | "resourceTemplates";
function missingOptionalMethod(error: unknown) {
	if (!error || typeof error !== "object" || !("code" in error)) return false;
	if (error.code === -32601) return true;
	if (
		!(error instanceof SdkHttpError) ||
		error.code !== SdkErrorCode.ClientHttpNotImplemented
	)
		return false;
	// Some legacy endpoints encode JSON-RPC method-not-found as an HTTP error.
	// The SDK's generic HTTP error code alone does not establish this condition.
	if (
		![400, 404, 501].includes(error.status) ||
		typeof error.data.text !== "string" ||
		error.data.text.length > 8192
	)
		return false;
	try {
		const response: unknown = JSON.parse(error.data.text);
		return isJSONRPCErrorResponse(response) && response.error.code === -32601;
	} catch {
		return false;
	}
}
function catalogField(
	item: CatalogEntry,
	field: "name" | "uri" | "uriTemplate",
) {
	const value = item[field];
	if (value === undefined)
		throw new Error(`Upstream catalog is missing ${field}`);
	return value;
}
async function readCatalog(
	client: Client,
	kind: CatalogKind,
): Promise<CatalogEntry[]> {
	const capability = kind === "resourceTemplates" ? "resources" : kind;
	if (!client.getServerCapabilities()?.[capability]) return [];
	const all: CatalogEntry[] = [];
	let cursor: string | undefined;
	for (let pages = 0; pages < 100; pages++) {
		let page: Awaited<
			ReturnType<
				| Client["listTools"]
				| Client["listResources"]
				| Client["listResourceTemplates"]
				| Client["listPrompts"]
			>
		>;
		try {
			page =
				kind === "tools"
					? await client.listTools({ cursor }, interactionOptions())
					: kind === "resources"
						? await client.listResources({ cursor }, interactionOptions())
						: kind === "resourceTemplates"
							? await client.listResourceTemplates(
									{ cursor },
									interactionOptions(),
								)
							: await client.listPrompts({ cursor }, interactionOptions());
		} catch (error) {
			if (kind === "resourceTemplates" && missingOptionalMethod(error))
				return [];
			throw error;
		}
		all.push(
			...((page as unknown as Record<string, CatalogEntry[]>)[kind] ?? []),
		);
		cursor = page.nextCursor;
		if (!cursor) return all;
	}
	throw new Error("Upstream catalog exceeds 100 pages");
}
async function catalog(
	runtime: Runtime,
	upstream: Upstream,
	kind: CatalogKind,
	routing = false,
	signal?: AbortSignal,
): Promise<CatalogEntry[]> {
	const method =
		kind === "resourceTemplates" ? "resources/templates/list" : `${kind}/list`;
	return invoke(
		runtime,
		upstream,
		routing ? "routing" : method,
		undefined,
		(client) => readCatalog(client, kind),
		kind === "resourceTemplates" ? "resources" : kind,
		signal,
	);
}
/** A dashboard check whose upstream did not answer, named for the person checking it. */
export class UpstreamUnavailableError extends Error {
	readonly reason: string;
	constructor(url: string, reason: string, options?: ErrorOptions) {
		super(
			`Couldn't reach ${URL.canParse(url) ? connectionLabel(url) : url} just now. Check that the server is online, then try again.`,
			options,
		);
		this.name = "UpstreamUnavailableError";
		this.reason = reason;
	}
}
/** The address answered over HTTP, but not as an MCP server (for example a web page or 404). */
class UpstreamNotMcpError extends UpstreamUnavailableError {
	constructor(url: string, reason: string, options?: ErrorOptions) {
		super(url, reason, options);
		this.message = `Toolstile reached ${connectionLabel(url)}, but no MCP server answered at this address. Check the address; many MCP server addresses end in /mcp.`;
	}
}
/** A local command that did not start or answer, with the end of its standard error. */
class LocalCommandUnavailableError extends UpstreamUnavailableError {
	constructor(label: string, error: LocalCommandError) {
		super(label, error.reason, { cause: error });
		this.message = `Couldn't start ${label}: ${error.reason}`;
	}
}
function notMcpStatus(error: unknown) {
	let current = error;
	for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
		if (
			current instanceof SdkHttpError &&
			[400, 404, 405, 406, 415].includes(current.status)
		)
			return current.status;
		current = current.cause;
	}
	return undefined;
}
async function dashboardCheck<T>(upstream: Upstream, work: () => Promise<T>) {
	try {
		return await work();
	} catch (error) {
		if (error instanceof LocalCommandError)
			throw new LocalCommandUnavailableError(upstream.label, error);
		const reason = upstreamUnreachable(error);
		if (reason)
			throw new UpstreamUnavailableError(upstream.url, reason, {
				cause: error,
			});
		const status = notMcpStatus(error);
		if (status)
			throw new UpstreamNotMcpError(upstream.url, `HTTP ${status}`, {
				cause: error,
			});
		throw error;
	}
}
export async function inspect(
	runtime: Runtime,
	upstream: Upstream,
	signal?: AbortSignal,
) {
	return dashboardCheck(upstream, () =>
		inspectCatalog(runtime, upstream, signal),
	);
}
async function inspectCatalog(
	runtime: Runtime,
	upstream: Upstream,
	signal?: AbortSignal,
) {
	return invoke(
		runtime,
		upstream,
		"discovery",
		undefined,
		async (client) => {
			// Tools, resources and templates are asked for together, so a check takes about as long
			// as the slowest of them. Prompts follow only after they succeed: a failing server is not
			// sent a further request.
			const [tools, resources, templates] = await Promise.all([
				readCatalog(client, "tools"),
				readCatalog(client, "resources"),
				readCatalog(client, "resourceTemplates"),
			]);
			const prompts = await readCatalog(client, "prompts");
			// A dashboard check is the explicit refresh that surfaces changed definitions.
			await reviewedTools(upstream, tools);
			const entries = [
				...tools.map(
					(item) => ["tools", catalogField(item, "name"), item] as const,
				),
				...resources.map(
					(item) => ["resources", catalogField(item, "uri"), item] as const,
				),
				...templates.map(
					(item) =>
						["resources", catalogField(item, "uriTemplate"), item] as const,
				),
				...prompts.map(
					(item) => ["prompts", catalogField(item, "name"), item] as const,
				),
			];
			return {
				inventory: catalogInventory(tools, resources, templates, prompts),
				tools: tools.map((item) => catalogField(item, "name")),
				resources: entries
					.filter(([kind]) => kind === "resources")
					.map(([, name]) => name),
				prompts: prompts.map((item) => catalogField(item, "name")),
				// What the upstream declares; shown in the access editor only, never used for access.
				hints: tools.flatMap((item) => {
					const { readOnlyHint, destructiveHint } = toolAnnotations(item);
					return readOnlyHint === true || destructiveHint === true
						? [
								{
									name: catalogField(item, "name"),
									...(readOnlyHint === true ? { readOnly: true } : {}),
									...(destructiveHint === true ? { destructive: true } : {}),
								},
							]
						: [];
				}),
				// Shown beside names in the access editor; long upstream text is cut short.
				descriptions: entries.flatMap(([capability, name, item]) =>
					typeof item.description === "string" && item.description.trim()
						? [
								{
									capability,
									name,
									description: item.description.trim().slice(0, 1000),
								},
							]
						: [],
				),
			};
		},
		undefined,
		signal,
	);
}

/** Short, non-secret listing shape for a shared catalog; input schemas are omitted. */
export interface CatalogListing {
	tools: {
		name: string;
		title?: string;
		description?: string;
		annotations?: Partial<
			Record<
				"readOnlyHint" | "destructiveHint" | "idempotentHint" | "openWorldHint",
				boolean
			>
		>;
	}[];
	resources: {
		uri?: string;
		uriTemplate?: string;
		name: string;
		description?: string;
	}[];
	prompts: { name: string; description?: string }[];
}
function listingText(value: unknown, max: number) {
	if (typeof value !== "string") return undefined;
	const text = value.trim();
	return text ? text.slice(0, max) : undefined;
}
const annotationHints = [
	"readOnlyHint",
	"destructiveHint",
	"idempotentHint",
	"openWorldHint",
] as const;
/** The boolean annotation hints an upstream tool declares; anything else is ignored. */
function toolAnnotations(item: CatalogEntry) {
	const raw =
		item.annotations && typeof item.annotations === "object"
			? (item.annotations as Record<string, unknown>)
			: {};
	return Object.fromEntries(
		annotationHints.flatMap((hint) =>
			typeof raw[hint] === "boolean" ? [[hint, raw[hint]]] : [],
		),
	) as NonNullable<CatalogListing["tools"][number]["annotations"]>;
}
function catalogInventory(
	tools: CatalogEntry[],
	resources: CatalogEntry[],
	templates: CatalogEntry[],
	prompts: CatalogEntry[],
): CatalogListing {
	const named = <T extends { name: string }>(items: (T | undefined)[]) =>
		items.filter((item): item is T => !!item?.name).slice(0, 1000);
	return {
		tools: named(
			tools.map((item) => {
				const name = listingText(item.name, 200);
				if (!name) return undefined;
				const annotations = toolAnnotations(item);
				return {
					name,
					...optional("title", listingText(item.title, 200)),
					...optional("description", listingText(item.description, 1000)),
					...(Object.keys(annotations).length ? { annotations } : {}),
				};
			}),
		),
		resources: named(
			[
				...resources.map((item) => ["uri", item] as const),
				...templates.map((item) => ["uriTemplate", item] as const),
			].map(([field, item]) => {
				const address = listingText(item[field], 2048);
				if (!address) return undefined;
				return {
					[field]: address,
					name: listingText(item.name, 200) ?? address.slice(0, 200),
					...optional("description", listingText(item.description, 1000)),
				};
			}),
		),
		prompts: named(
			prompts.map((item) => {
				const name = listingText(item.name, 200);
				return name
					? {
							name,
							...optional("description", listingText(item.description, 1000)),
						}
					: undefined;
			}),
		),
	};
}
const optional = <K extends string>(key: K, value: string | undefined) =>
	(value === undefined ? {} : { [key]: value }) as Partial<Record<K, string>>;

/** Every live tool definition, as a reviewer accepts them. */
export async function observeToolCatalog(
	runtime: Runtime,
	upstream: Upstream,
): Promise<ObservedTool[]> {
	return (
		await dashboardCheck(upstream, () => catalog(runtime, upstream, "tools"))
	).map(observeTool);
}
export async function agentToolCatalog(
	runtime: Runtime,
	upstream: Upstream,
	signal?: AbortSignal,
): Promise<Tool[]> {
	const tools = await dashboardCheck(upstream, () =>
		catalog(runtime, upstream, "tools", false, signal),
	);
	return (await reviewedTools(
		upstream,
		tools.filter((item) =>
			permitted(upstream.rules, "tools", catalogField(item, "name")),
		),
	)) as unknown as Tool[];
}
export async function testAgentTool(
	runtime: Runtime,
	upstream: Upstream,
	name: string,
	arguments_: Record<string, unknown>,
	signal?: AbortSignal,
) {
	if (!permitted(upstream.rules, "tools", name))
		return deny(
			runtime,
			upstream.id,
			"tools/call",
			name,
			refusalReason(upstream.rules, "tools", name),
		);
	const tool = (
		await dashboardCheck(upstream, () =>
			catalog(runtime, upstream, "tools", true, signal),
		)
	).find((tool) => tool.name === name);
	if (!tool) throw new Error("Tool unavailable");
	if (!(await reviewedTools(upstream, [tool])).length)
		return deny(runtime, upstream.id, "tools/call", name, "unreviewed");
	let result: Awaited<ReturnType<Client["callTool"]>>;
	try {
		result = await dashboardCheck(upstream, () =>
			invoke(
				runtime,
				upstream,
				"tools/call",
				name,
				(client) => client.callTool({ name, arguments: arguments_ }),
				undefined,
				signal,
			),
		);
	} catch (error) {
		if (!(error instanceof ApprovalRequiredError)) throw error;
		return {
			isError: true,
			preview: "",
			truncated: false,
			approval: approvalReference(error),
		};
	}
	const serialized = JSON.stringify(result, null, 2);
	return {
		isError: result.isError === true,
		preview: serialized.slice(0, 65536),
		truncated: serialized.length > 65536,
	};
}

/** Blocked when any rule names it explicitly; otherwise simply not granted. */
function refusalReason(
	rules: Rules[],
	kind: Kind,
	name: string,
): RefusalReason {
	return rules.some((rule) =>
		rule.block[kind].some((grant) => matches(kind, grant, name)),
	)
		? "blocked"
		: "not_granted";
}
const subjects: Record<Kind, string> = {
	tools: "This tool",
	resources: "This resource",
	prompts: "This prompt",
};
async function deny(
	runtime: Runtime,
	connectionId: string,
	method: string,
	target: string,
	reason: RefusalReason = "not_granted",
	kind: Kind = "tools",
): Promise<never> {
	await runtime.record(
		{ id: randomUUID(), connectionId, method, target },
		refusalOutcome(reason),
		0,
	);
	throw new AccessRefusedError(
		reason,
		subjects[kind],
		runtime.refusalHint?.(reason, connectionId),
	);
}
/** Keeps reviewed tools and records the rest as waiting for review. */
async function reviewedTools(upstream: Upstream, tools: CatalogEntry[]) {
	const review = upstream.toolReview;
	if (!review) return tools;
	const waiting: ObservedTool[] = [];
	const visible = tools.filter((item) => {
		const observed = observeTool(item);
		if (toolReviewed(review, observed)) return true;
		waiting.push(observed);
		return false;
	});
	// Recording is best effort; an unreviewed tool stays hidden either way.
	if (waiting.length) await review.observe(waiting).catch(() => {});
	return visible;
}
function createGatewayServer(
	runtime: Runtime,
	hooks?: SessionHooks,
	continuations?: ReturnType<typeof continuationHandler>,
	notifications?: ServerCapabilities,
) {
	const server = new Server(
		{ name: "toolstile", version: "0.1.0" },
		{
			capabilities: {
				tools: notifications?.tools ?? {},
				resources:
					notifications?.resources ??
					(hooks ? { subscribe: true, listChanged: true } : {}),
				prompts: notifications?.prompts ?? {},
				completions: {},
			},
		},
	);
	function on<M extends RequestMethod>(
		method: M,
		handler: (
			request: RequestTypeMap[M],
			context: ServerContext,
		) => HandlerResultTypeMap[M] | Promise<HandlerResultTypeMap[M]>,
	) {
		server.setRequestHandler(method, (req, context) => {
			const origin: Origin = { server, context, active: true };
			return origins.run(origin, async () => {
				if (hooks) hooks.active++;
				try {
					await runtime.authenticate?.();
					if (
						continuations &&
						modernOrigin(origin) &&
						["tools/call", "prompts/get", "resources/read"].includes(method)
					)
						return (await continuations.run(req, origin, runtime, () =>
							handler(req, context),
						)) as HandlerResultTypeMap[M];
					return await handler(req, context);
				} finally {
					if (!origin.flow) origin.active = false;
					if (hooks) {
						hooks.active--;
						hooks.touch();
					}
				}
			});
		});
	}
	if (hooks) {
		const subscriptions = resourceSubscriptions(runtime, server, {
			original: originalResource,
			// A subscription would hold a local command's child open; not offered for them.
			permitted: (upstream, uri) =>
				upstream.transport !== "stdio" &&
				permitted(upstream.rules, "resources", uri),
			open: (upstream, uri) =>
				openUpstream(
					runtime,
					upstream,
					"resources/subscribe",
					uri,
					"resources",
				),
			touch: hooks.touch,
			lost: () => {
				void hooks.close().catch(() => {});
			},
		});
		on("resources/subscribe", (req) =>
			subscriptions.change(req.params.uri, true),
		);
		on("resources/unsubscribe", (req) =>
			subscriptions.change(req.params.uri, false),
		);
		server.onclose = () => {
			void subscriptions.close();
		};
	}
	async function listEntries(kind: Kind) {
		const entries: CatalogEntry[] = [];
		for (const upstream of await runtime.connections()) {
			if (
				!upstream.rules.some(
					(r) =>
						r.full ||
						r.allow[kind].length ||
						(kind === "tools" && r.requireApproval?.length),
				)
			)
				continue;
			const listed = (await catalog(runtime, upstream, kind)).filter((item) =>
				permitted(
					upstream.rules,
					kind,
					kind === "resources"
						? catalogField(item, "uri")
						: catalogField(item, "name"),
				),
			);
			for (const item of kind === "tools"
				? await reviewedTools(upstream, listed)
				: listed) {
				const name =
					kind === "resources"
						? catalogField(item, "uri")
						: catalogField(item, "name");
				entries.push(
					kind === "resources"
						? { ...item, uri: resourceAlias(upstream.id, name) }
						: {
								...item,
								name: exposedName(upstream, name),
								title: `${upstream.label} / ${item.title ?? name}`,
							},
				);
			}
		}
		return entries;
	}
	on("tools/list", async () => ({
		tools: [
			...(runtime.tools?.definitions ?? []),
			...((await listEntries("tools")) as unknown as Tool[]),
		],
	}));
	on("resources/list", async () => ({
		resources: (await listEntries("resources")) as unknown as Resource[],
	}));
	on("resources/templates/list", async () => {
		const templates: ResourceTemplateType[] = [];
		for (const upstream of await runtime.connections()) {
			if (!upstream.rules.some((r) => r.full || r.allow.resources.length))
				continue;
			for (const item of await catalog(
				runtime,
				upstream,
				"resourceTemplates",
			)) {
				if (
					!permitted(
						upstream.rules,
						"resources",
						catalogField(item, "uriTemplate"),
					)
				)
					continue;
				templates.push({
					...item,
					uriTemplate: resourceTemplateAlias(
						upstream.id,
						catalogField(item, "uriTemplate"),
					),
					name: catalogField(item, "name"),
					title: `${upstream.label} / ${item.title ?? item.name}`,
				} as ResourceTemplateType);
			}
		}
		return { resourceTemplates: templates };
	});
	on("prompts/list", async () => ({
		prompts: (await listEntries("prompts")) as unknown as Prompt[],
	}));
	on("tools/call", async (req) => {
		if (runtime.tools?.definitions.some((t) => t.name === req.params.name))
			return runtime.tools.call(req.params.name, req.params.arguments ?? {});
		for (const upstream of await runtime.connections()) {
			if (!addressed(upstream, req.params.name)) continue;
			if (blockedAlias(upstream, "tools", req.params.name))
				await deny(
					runtime,
					upstream.id,
					"tools/call",
					req.params.name,
					"blocked",
				);
			const tools = await catalog(runtime, upstream, "tools", true);
			const tool = tools.find((t) =>
				names(upstream, req.params.name, catalogField(t, "name")),
			);
			if (!tool) continue;
			const name = catalogField(tool, "name") as string;
			if (!permitted(upstream.rules, "tools", name))
				await deny(
					runtime,
					upstream.id,
					"tools/call",
					req.params.name,
					refusalReason(upstream.rules, "tools", name),
				);
			// The live definition is checked on every call, so a change made after the agent
			// listed tools cannot run until it is reviewed.
			if (!(await reviewedTools(upstream, [tool])).length)
				await deny(
					runtime,
					upstream.id,
					"tools/call",
					req.params.name,
					"unreviewed",
				);
			// Gated calls forward only the reviewed name and arguments; requester _meta and
			// task augmentation would be unreviewed inputs.
			const gated = toolDecision(upstream.rules, name) === "approval";
			if (gated && "task" in req.params)
				throw new ApprovalUnsupportedError(
					"Approval-gated tools cannot run as tasks",
				);
			try {
				return await invoke(
					runtime,
					upstream,
					"tools/call",
					name,
					async (client) => {
						const result = await client.callTool(
							gated
								? { name, arguments: req.params.arguments }
								: { ...req.params, name },
							interactionOptions(),
						);
						return {
							...result,
							content: result.content?.map((content) =>
								routedContent(upstream.id, content),
							),
						};
					},
				);
			} catch (error) {
				if (error instanceof ApprovalRequiredError)
					return approvalResult(error);
				throw error;
			}
		}
		throw new Error("Tool unavailable or access denied");
	});
	on("prompts/get", async (req) => {
		for (const upstream of await runtime.connections()) {
			if (!addressed(upstream, req.params.name)) continue;
			if (blockedAlias(upstream, "prompts", req.params.name))
				await deny(
					runtime,
					upstream.id,
					"prompts/get",
					req.params.name,
					"blocked",
					"prompts",
				);
			const prompts = await catalog(runtime, upstream, "prompts", true);
			const prompt = prompts.find((t) =>
				names(upstream, req.params.name, catalogField(t, "name")),
			);
			if (!prompt) continue;
			if (!permitted(upstream.rules, "prompts", catalogField(prompt, "name")))
				await deny(
					runtime,
					upstream.id,
					"prompts/get",
					req.params.name,
					refusalReason(
						upstream.rules,
						"prompts",
						catalogField(prompt, "name") as string,
					),
					"prompts",
				);
			return invoke(
				runtime,
				upstream,
				"prompts/get",
				catalogField(prompt, "name"),
				async (client) => {
					const result = await client.getPrompt(
						{ ...req.params, name: catalogField(prompt, "name") },
						interactionOptions(),
					);
					return {
						...result,
						messages: result.messages.map((message) => ({
							...message,
							content: routedContent(upstream.id, message.content),
						})),
					};
				},
			);
		}
		throw new Error("Prompt unavailable or access denied");
	});
	on("resources/read", async (req) => {
		const upstream = (await runtime.connections()).find(
			(c) => originalResource(c.id, req.params.uri) !== undefined,
		);
		const original = upstream
			? (originalResource(upstream.id, req.params.uri) ?? "")
			: "";
		if (!upstream || !permitted(upstream.rules, "resources", original))
			return deny(
				runtime,
				upstream?.id ?? "",
				"resources/read",
				req.params.uri,
				upstream
					? refusalReason(upstream.rules, "resources", original)
					: "not_granted",
				"resources",
			);
		return invoke(
			runtime,
			upstream,
			"resources/read",
			original,
			async (client) => {
				const result = await client.readResource(
					{ ...req.params, uri: original },
					interactionOptions(),
				);
				return {
					...result,
					contents: result.contents.map((content) => ({
						...content,
						uri: resourceAlias(upstream.id, content.uri),
					})),
				};
			},
		);
	});
	on("completion/complete", async (req) => {
		const ref = req.params.ref;
		for (const upstream of await runtime.connections()) {
			const kind = ref.type === "ref/prompt" ? "prompts" : "resources";
			let target: string | undefined;
			if (ref.type === "ref/prompt") {
				if (!addressed(upstream, ref.name)) continue;
				if (blockedAlias(upstream, "prompts", ref.name))
					return deny(runtime, upstream.id, "completion/complete", ref.name);
				target = (await catalog(runtime, upstream, "prompts", true)).find(
					(item) => names(upstream, ref.name, catalogField(item, "name")),
				)?.name;
			} else {
				target = originalResource(upstream.id, ref.uri);
				if (!target) continue;
				if (!permitted(upstream.rules, "resources", target))
					return deny(runtime, upstream.id, "completion/complete", target);
				if (
					!(await catalog(runtime, upstream, "resourceTemplates", true)).some(
						(item) => item.uriTemplate === target,
					)
				)
					continue;
			}
			if (!target || !permitted(upstream.rules, kind, target))
				return deny(runtime, upstream.id, "completion/complete", target ?? "");
			const resolvedTarget = target;
			return invoke(
				runtime,
				upstream,
				"completion/complete",
				target,
				async (client) => {
					if (!client.getServerCapabilities()?.completions)
						throw new Error("Upstream completion is unavailable");
					const result = await client.complete({
						...req.params,
						ref:
							ref.type === "ref/prompt"
								? { ...ref, name: resolvedTarget }
								: { ...ref, uri: resolvedTarget },
					});
					if (kind !== "resources") return result;
					const template = new UriTemplate(resolvedTarget);
					const values = result.completion.values.filter((value) => {
						const variables = {
							...req.params.context?.arguments,
							[req.params.argument.name]: value,
						};
						if (!template.variableNames.every((name) => name in variables))
							return !upstream.rules.some(
								(rule) => rule.block.resources.length,
							);
						return permitted(
							upstream.rules,
							"resources",
							template.expand(variables),
						);
					});
					return values.length === result.completion.values.length
						? result
						: { completion: { values, hasMore: result.completion.hasMore } };
				},
				kind,
			);
		}
		throw new Error("Completion unavailable or access denied");
	});
	return server;
}
export async function handleMcp(
	request: Request,
	runtime: Runtime,
): Promise<Response> {
	const bounded = await boundedMcpRequest(request);
	if (bounded instanceof Response) return bounded;
	request = bounded;
	if (request.method !== "POST")
		return new Response("Method not allowed", {
			status: 405,
			headers: { Allow: "POST" },
		});
	const server = createGatewayServer(runtime);
	const transport = new WebStandardStreamableHTTPServerTransport({
		sessionIdGenerator: undefined,
		enableJsonResponse: true,
	});
	await server.connect(transport);
	try {
		return transportResponse(await transport.handleRequest(request));
	} finally {
		await server.close();
	}
}

export const createMcpGateway = (
	options?: SessionOptions &
		ContinuationOptions &
		ListenOptions &
		ReplayOptions,
) => {
	const continuations = continuationHandler(options);
	const sessions = sessionHandler(createGatewayServer, handleMcp, options);
	const streams = modernSubscriptions(
		{
			original: originalResource,
			// A watch would hold a local command's child open; stdio sources are never watched.
			permitted: (upstream, kind, target) =>
				upstream.transport === "stdio"
					? false
					: target !== undefined
						? permitted(upstream.rules, kind, target)
						: upstream.rules.some(
								(rule) =>
									rule.full ||
									(kind === "tools" &&
										rule.requireApproval?.some((name) =>
											permitted(upstream.rules, kind, name),
										)) ||
									rule.allow[kind].some((name) =>
										permitted(upstream.rules, kind, name),
									),
							),
			open: (runtime, upstream, kind, target, signal) =>
				openUpstream(runtime, upstream, "maintenance", target, kind, signal),
		},
		options,
	);
	return {
		async handle(request: Request, runtime: Runtime) {
			await runtime.authenticate?.();
			const bounded = await boundedMcpRequest(request);
			if (bounded instanceof Response) return bounded;
			request = bounded;
			if (await isLegacyRequest(request))
				return sessions.handle(request, runtime);
			return transportResponse(
				await streams.handle(request, runtime, (caps) =>
					createGatewayServer(
						runtime,
						undefined,
						continuations,
						caps ?? {
							tools: { listChanged: true },
							prompts: { listChanged: true },
							resources: { listChanged: true, subscribe: true },
						},
					),
				),
			);
		},
		async revoke(key: string) {
			continuations.revoke(key);
			await sessions.revoke(key);
			await streams.revoke(key);
		},
		async close() {
			continuations.close();
			await sessions.close();
			await streams.close();
		},
		get size() {
			return sessions.size;
		},
		get pendingContinuations() {
			return continuations.size;
		},
		get subscriptionStreams() {
			return streams.size;
		},
	};
};

export * from "./network";
