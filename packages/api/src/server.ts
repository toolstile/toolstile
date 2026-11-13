import type { Context } from "@orpc/server";
import { ORPCError, onError, os, ValidationError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { DestinationError, UpstreamUnavailableError } from "@toolstile/gateway";
import { BodyReadError, boundedRequest } from "@toolstile/gateway/request-body";
import { z } from "zod";
import {
	type Actor,
	accountDeletionView,
	accountStatusView,
	agentCatalogInput,
	agentCatalogView,
	agentCreatedView,
	allAgentGrantInput,
	connectionCreatedView,
	connectionInput,
	connectionOAuthView,
	debugPayloadView,
	debugSelectionInput,
	debugStatusView,
	idView,
	mutationView,
	nameInput,
	RULES_INPUT_MAX_BYTES,
	recoveryCodesView,
	renameInput,
	type rules,
	rulesInput,
	type Snapshot,
	snapshotView,
	toolTestInput,
	toolTestView,
	upstreamOAuthInput,
	verificationView,
} from "./contract.js";

export interface Services {
	debugStatus(actor: Actor): Promise<z.infer<typeof debugStatusView>>;
	startDebug(
		actor: Actor,
		input: z.infer<typeof debugSelectionInput>,
	): Promise<{ id: string }>;
	extendDebug(actor: Actor, id: string): Promise<{ ok: boolean }>;
	stopDebug(actor: Actor, id: string): Promise<{ ok: boolean }>;
	debugPayload(
		actor: Actor,
		id: string,
	): Promise<z.infer<typeof debugPayloadView>>;

	agentCatalog(
		actor: Actor,
		input: z.infer<typeof agentCatalogInput>,
	): Promise<z.infer<typeof agentCatalogView>>;
	testTool(
		actor: Actor,
		input: z.infer<typeof toolTestInput>,
	): Promise<z.infer<typeof toolTestView>>;
	startConnectionOAuth(
		actor: Actor,
		input: z.infer<typeof upstreamOAuthInput>,
	): Promise<{ url: string }>;
	snapshot(actor: Actor): Promise<Snapshot>;
	addConnection(
		actor: Actor,
		input: z.infer<typeof connectionInput>,
	): Promise<{
		id: string;
		label: string;
		url: string;
		transport: "http" | "sse";
		authentication: "headers" | "oauth";
		status: string;
	}>;
	removeConnection(actor: Actor, id: string): Promise<void>;
	addDevice(actor: Actor, label: string): Promise<{ id: string }>;
	addAgent(
		actor: Actor,
		input: { label: string; deviceId: string; expiresInDays: number | null },
	): Promise<{ id: string; token: string }>;
	renameDevice(actor: Actor, input: z.infer<typeof renameInput>): Promise<void>;
	renameAgent(actor: Actor, input: z.infer<typeof renameInput>): Promise<void>;
	revokeAgent(actor: Actor, id: string): Promise<void>;
	revokeDevice(actor: Actor, id: string): Promise<void>;
	saveGrant(
		actor: Actor,
		input: {
			agentId: string;
			connectionId: string;
			rules: z.infer<typeof rules>;
		},
	): Promise<void>;
	verify(
		actor: Actor,
		id: string,
	): Promise<{ tools: string[]; resources: string[]; prompts: string[] }>;
}
export interface AccountServices {
	accountStatus(actor: Actor): Promise<z.infer<typeof accountStatusView>>;
	rotateRecoveryCodes(actor: Actor): Promise<{ codes: string[] }>;
	deleteAccount(actor: Actor): Promise<{ purgeAfter: string }>;
}
export interface AllAgentGrantServices {
	saveAllAgentGrant(
		actor: Actor,
		input: z.infer<typeof allAgentGrantInput>,
	): Promise<void>;
	removeAllAgentGrant(actor: Actor, connectionId: string): Promise<void>;
}
export interface ApiContext {
	actor: Actor;
	services: Services;
}
export function createCommonRouter() {
	const procedure = os.$context<ApiContext>();

	return {
		debugStatus: procedure
			.output(debugStatusView)
			.handler(({ context }) => context.services.debugStatus(context.actor)),
		startDebug: procedure
			.input(debugSelectionInput)
			.output(idView)
			.handler(({ context, input }) =>
				context.services.startDebug(context.actor, input),
			),
		extendDebug: procedure
			.input(z.object({ id: z.string().min(1) }))
			.output(mutationView)
			.handler(({ context, input }) =>
				context.services.extendDebug(context.actor, input.id),
			),
		stopDebug: procedure
			.input(z.object({ id: z.string().min(1) }))
			.output(mutationView)
			.handler(({ context, input }) =>
				context.services.stopDebug(context.actor, input.id),
			),
		debugPayload: procedure
			.input(z.object({ id: z.string().min(1) }))
			.output(debugPayloadView)
			.handler(({ context, input }) =>
				context.services.debugPayload(context.actor, input.id),
			),

		agentCatalog: procedure
			.input(agentCatalogInput)
			.output(agentCatalogView)
			.handler(({ context, input }) =>
				context.services.agentCatalog(context.actor, input),
			),
		testTool: procedure
			.input(toolTestInput)
			.output(toolTestView)
			.handler(({ context, input }) =>
				context.services.testTool(context.actor, input),
			),
		startConnectionOAuth: procedure
			.input(upstreamOAuthInput)
			.output(connectionOAuthView)
			.handler(({ context, input }) =>
				context.services.startConnectionOAuth(context.actor, input),
			),
		snapshot: procedure
			.output(snapshotView)
			.handler(({ context }) => context.services.snapshot(context.actor)),
		addConnection: procedure
			.input(connectionInput)
			.output(connectionCreatedView)
			.handler(({ context, input }) =>
				context.services.addConnection(context.actor, input),
			),
		removeConnection: procedure
			.input(z.object({ id: z.string() }))
			.output(mutationView)
			.handler(async ({ context, input }) => {
				await context.services.removeConnection(context.actor, input.id);
				return { ok: true };
			}),
		addDevice: procedure
			.input(z.object({ label: nameInput }))
			.output(idView)
			.handler(({ context, input }) =>
				context.services.addDevice(context.actor, input.label),
			),
		addAgent: procedure
			.input(
				z.object({
					label: nameInput,
					deviceId: z.string(),
					expiresInDays: z
						.number()
						.int()
						.min(1)
						.max(3650)
						.nullable()
						.default(90),
				}),
			)
			.output(agentCreatedView)
			.handler(({ context, input }) =>
				context.services.addAgent(context.actor, input),
			),
		renameDevice: procedure
			.input(renameInput)
			.output(mutationView)
			.handler(async ({ context, input }) => {
				await context.services.renameDevice(context.actor, input);
				return { ok: true };
			}),
		renameAgent: procedure
			.input(renameInput)
			.output(mutationView)
			.handler(async ({ context, input }) => {
				await context.services.renameAgent(context.actor, input);
				return { ok: true };
			}),
		revokeAgent: procedure
			.input(z.object({ id: z.string() }))
			.output(mutationView)
			.handler(async ({ context, input }) => {
				await context.services.revokeAgent(context.actor, input.id);
				return { ok: true };
			}),
		revokeDevice: procedure
			.input(z.object({ id: z.string() }))
			.output(mutationView)
			.handler(async ({ context, input }) => {
				await context.services.revokeDevice(context.actor, input.id);
				return { ok: true };
			}),
		saveGrant: procedure
			.input(
				z.object({
					agentId: z.string(),
					connectionId: z.string(),
					rules: rulesInput,
				}),
			)
			.output(mutationView)
			.handler(async ({ context, input }) => {
				await context.services.saveGrant(context.actor, input);
				return { ok: true };
			}),
		verify: procedure
			.input(z.object({ id: z.string() }))
			.output(verificationView)
			.handler(({ context, input }) =>
				context.services.verify(context.actor, input.id),
			),
	};
}
export type CommonRouter = ReturnType<typeof createCommonRouter>;

export function createAccountRouter() {
	const procedure = os.$context<{ actor: Actor; services: AccountServices }>();
	return {
		accountStatus: procedure
			.output(accountStatusView)
			.handler(({ context }) => context.services.accountStatus(context.actor)),
		rotateRecoveryCodes: procedure
			.output(recoveryCodesView)
			.handler(({ context }) =>
				context.services.rotateRecoveryCodes(context.actor),
			),
		deleteAccount: procedure
			.input(z.object({ confirmation: z.literal("DELETE") }))
			.output(accountDeletionView)
			.handler(({ context }) => context.services.deleteAccount(context.actor)),
	};
}
export type AccountRouter = ReturnType<typeof createAccountRouter>;

export function createAllAgentGrantRouter() {
	const procedure = os.$context<{
		actor: Actor;
		services: AllAgentGrantServices;
	}>();
	return {
		saveAllAgentGrant: procedure
			.input(allAgentGrantInput)
			.output(mutationView)
			.handler(async ({ context, input }) => {
				await context.services.saveAllAgentGrant(context.actor, input);
				return { ok: true };
			}),
		removeAllAgentGrant: procedure
			.input(z.object({ connectionId: z.string().min(1) }))
			.output(mutationView)
			.handler(async ({ context, input }) => {
				await context.services.removeAllAgentGrant(
					context.actor,
					input.connectionId,
				);
				return { ok: true };
			}),
	};
}
export type AllAgentGrantRouter = ReturnType<typeof createAllAgentGrantRouter>;

/** Replace generic failures with what the person can change or retry. */
function readableError(error: unknown) {
	if (
		error instanceof ORPCError &&
		error.code === "BAD_REQUEST" &&
		error.cause instanceof ValidationError
	) {
		const [issue] = error.cause.issues;
		if (issue?.message)
			throw new ORPCError("BAD_REQUEST", {
				message: issue.message,
				data: error.data,
				cause: error.cause,
			});
	}
	if (error instanceof ORPCError) return;
	for (
		let current = error, depth = 0;
		current instanceof Error && depth < 5;
		current = current.cause, depth++
	) {
		if (current instanceof DestinationError)
			throw new ORPCError("BAD_REQUEST", {
				message: current.advice,
				cause: error,
			});
		if (current instanceof UpstreamUnavailableError) {
			console.warn("MCP server unreachable", current.reason);
			throw new ORPCError("BAD_GATEWAY", {
				message: current.message,
				cause: error,
			});
		}
	}
}
/** Management mutations require a matching origin; actor/context resolution stays app-owned. */
/** Maps a failure to resolve the RPC caller. Authentication and account-state
 * refusals keep 401/403; anything else (for example an unavailable database) is
 * a retryable 503, reported to `log` without its message. */
export function rpcCallerError(
	error: unknown,
	log: (error: unknown) => void = (failure) =>
		console.error(
			"RPC caller resolution failed",
			failure instanceof Error ? failure.name : typeof failure,
		),
) {
	if (error instanceof ORPCError && error.status < 500)
		return Response.json(
			{ message: error.message },
			{ status: error.code === "UNAUTHORIZED" ? 401 : 403 },
		);
	log(error);
	return Response.json(
		{ message: "Service temporarily unavailable. Try again." },
		{ status: 503 },
	);
}
/** RPC framing and the fields around a procedure's largest input. */
export const RPC_ENVELOPE_BYTES = 64 * 1024;
/** Most RPC inputs are small JSON documents; tool-test arguments stop at 100 KB. */
const RPC_BODY_MAX = 1024 * 1024;
/** Procedures whose schema accepts more than the default: one full rule set. */
const sharedBodyLimits: Record<string, number> = {
	saveGrant: RULES_INPUT_MAX_BYTES + RPC_ENVELOPE_BYTES,
	saveAllAgentGrant: RULES_INPUT_MAX_BYTES + RPC_ENVELOPE_BYTES,
};
export function createRpcHandler<A, C extends Context>(deps: {
	resolveActor(request: Request): Promise<A>;
	router: ConstructorParameters<typeof RPCHandler<C>>[0];
	context(actor: A, request: Request): C;
	origin: string;
	prefix?: `/${string}`;
	mapError(error: unknown): Response;
	/** Larger body limits, in bytes, for named procedures whose schemas need them. */
	bodyLimits?: Record<string, number>;
}) {
	const limits = { ...sharedBodyLimits, ...deps.bodyLimits };
	const bodyLimit = (request: Request) => {
		const name = new URL(request.url).pathname.split("/").at(-1) ?? "";
		return Object.hasOwn(limits, name) ? limits[name] : RPC_BODY_MAX;
	};
	const rpc = new RPCHandler<C>(deps.router, {
		clientInterceptors: [onError(readableError)],
	});
	return async (request: Request) => {
		try {
			if (
				request.method !== "GET" &&
				request.headers.get("origin") !== deps.origin
			)
				return new Response("Invalid origin", { status: 403 });
			const actor = await deps.resolveActor(request);
			let bounded: Request;
			try {
				bounded = await boundedRequest(request, {
					maximum: bodyLimit(request),
					timeoutMs: 30_000,
				});
			} catch (error) {
				if (!(error instanceof BodyReadError)) throw error;
				return Response.json(
					{ message: error.message },
					{ status: error.status },
				);
			}
			const result = await rpc.handle(bounded, {
				prefix: deps.prefix ?? "/api/rpc",
				context: deps.context(actor, request),
			});
			return result.response ?? new Response("Not found", { status: 404 });
		} catch (error) {
			return deps.mapError(error);
		}
	};
}
