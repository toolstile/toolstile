import { isIP } from "node:net";
import { SdkErrorCode, SdkHttpError } from "@modelcontextprotocol/client";
import ipaddr from "ipaddr.js";
import { lookup, resolveDestination } from "./dns";
import { isRedirectResponse } from "./redirects";
import { Agent, send } from "./transport";

/** Cloud instance metadata services, refused even when private networks are allowed. */
const metadataAddresses = new Set(["169.254.169.254", "fd00:ec2::254"]);
const privateRanges = ["private", "loopback", "uniqueLocal"];
/** "public" for global unicast, "private" for private/loopback/unique-local, otherwise refused. */
function addressClass(address: string): "public" | "private" | "refused" {
	try {
		// process() unwraps IPv4-mapped (::ffff:a.b.c.d) addresses.
		let parsed = ipaddr.process(address.replace(/^\[|\]$/g, ""));
		const bytes = parsed.toByteArray();
		// Deprecated IPv4-compatible (::a.b.c.d) addresses carry an IPv4 destination
		// but classify as unicast; NAT64 (64:ff9b::/96) forms are never permitted.
		if (
			parsed.kind() === "ipv6" &&
			parsed.range() === "unicast" &&
			bytes.slice(0, 12).every((byte) => byte === 0)
		)
			parsed = new ipaddr.IPv4(bytes.slice(12));
		if (metadataAddresses.has(parsed.toString())) return "refused";
		const range = parsed.range();
		if (range === "unicast") return "public";
		return privateRanges.includes(range) ? "private" : "refused";
	} catch {
		return "refused";
	}
}
export function permittedAddress(
	address: string,
	allowPrivateNetworks = false,
) {
	const kind = addressClass(address);
	return kind === "public" || (allowPrivateNetworks && kind === "private");
}
const destinationAdvice = {
	protocol: "Use an https:// address.",
	insecure:
		"Use an https:// address. Plain http:// is only allowed for servers on a private or local network.",
	credentials: "Remove the user name, password or # part from the address.",
	port: "Use an https:// address without a port number.",
	network: "Private and local network addresses can't be connected.",
	unresolved:
		"No server was found at this address. Check the address, then try again.",
};
/** A destination refused by policy, with plain advice for the person who entered it. */
export class DestinationError extends Error {
	readonly advice: string;
	constructor(message: string, reason: keyof typeof destinationAdvice) {
		super(message);
		this.name = "DestinationError";
		this.advice = destinationAdvice[reason];
	}
}
const upstreamAttemptTimeout = 2_000;
/** Syntax checks shared by every destination: http(s) only, no credentials, fragments or metadata hosts. */
export async function validateHttpDestination(url: URL) {
	const scheme = ["http:", "https:"].includes(url.protocol);
	if (!scheme || url.username || url.password || url.hash)
		throw new DestinationError(
			"Use an HTTP(S) MCP URL without embedded credentials or fragments",
			scheme ? "credentials" : "protocol",
		);
	if (["169.254.169.254", "metadata.google.internal"].includes(url.hostname))
		throw new DestinationError(
			"Instance metadata destinations are unavailable",
			"network",
		);
}
/**
 * Settles with `work`, or rejects with the signal's reason as soon as it aborts. `work` has
 * already started, so its own later rejection is always observed (never left unhandled).
 */
function untilAborted<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return work;
	work.catch(() => {});
	if (signal.aborted) return Promise.reject(signal.reason);
	return new Promise<T>((resolve, reject) => {
		const abort = () => reject(signal.reason);
		signal.addEventListener("abort", abort, { once: true });
		work
			.then(resolve, reject)
			.finally(() => signal.removeEventListener("abort", abort));
	});
}
export type DestinationOptions = {
	protocols?: readonly string[];
	ports?: readonly number[];
	allowPrivateNetworks?: boolean | (() => Promise<boolean>);
	/** Milliseconds allowed to open a connection (undici's default is 10 s). */
	connectTimeout?: number;
	resolve?: (
		hostname: string,
	) => Promise<readonly { address: string; family: number }[]>;
};
/**
 * Validate before I/O and enforce destination policy at connection time: the
 * dispatcher pins validated addresses. Redirects are rejected.
 * Plain http:// is refused unless every address is private/loopback/unique-local and private
 * networks are allowed, so credentials and tool traffic never cross the internet unencrypted.
 */
export function createDestinationPolicy(options: DestinationOptions = {}) {
	const protocols = options.protocols ?? ["http:", "https:"];
	const allowPrivate = async () =>
		typeof options.allowPrivateNetworks === "function"
			? options.allowPrivateNetworks()
			: (options.allowPrivateNetworks ?? false);
	const addresses =
		options.resolve ??
		resolveDestination;
	const check = (entries: readonly { address: string }[], allow: boolean) => {
		if (
			!entries.length ||
			entries.some((entry) => !permittedAddress(entry.address, allow))
		)
			throw new DestinationError(
				"Destination address is not permitted by network settings",
				"network",
			);
	};
	const checkPlain = (entries: readonly { address: string }[]) => {
		if (entries.some((entry) => addressClass(entry.address) !== "private"))
			throw new DestinationError(
				"Plain HTTP is only permitted to private network destinations",
				"insecure",
			);
	};
	// `plain` dispatchers carry http:// requests: a DNS answer that changes to a public
	// address between validation and connection is refused there too.
	const dispatcher = (allow: boolean, plain = false) =>
		new Agent({
			connect: {
				// Node's 250 ms per-address default aborts distant servers whose
				// handshake takes slightly longer, failing every address.
				autoSelectFamily: true,
				autoSelectFamilyAttemptTimeout: upstreamAttemptTimeout,
				...(options.connectTimeout ? { timeout: options.connectTimeout } : {}),
				lookup(hostname, settings, callback) {
					hostname = hostname.replace(/^\[|\]$/g, "");
					const done = (
						entries: readonly { address: string; family: number }[],
					) => {
						try {
							check(entries, allow);
							if (plain) checkPlain(entries);
						} catch (error) {
							callback(error as Error, "", 0);
							return;
						}
						if (settings.all) callback(null, [...entries]);
						else callback(null, entries[0].address, entries[0].family);
					};
					if (isIP(hostname)) {
						done([{ address: hostname, family: isIP(hostname) }]);
					} else if (options.resolve) {
						void addresses(hostname).then(done, (error) =>
							callback(error, "", 0),
						);
					} else
						lookup(hostname, { all: true }, (error, entries) => {
							if (error) callback(error, "", 0);
							else done(entries);
						});
				},
			},
		});
	const publicDispatcher = dispatcher(false),
		privateDispatcher = dispatcher(true),
		plainDispatcher = dispatcher(true, true);
	async function validate(url: URL, allow: boolean, signal?: AbortSignal) {
		await validateHttpDestination(url);
		// No lookup starts for a request that was cancelled in the meantime.
		signal?.throwIfAborted();
		// Addresses are checked first: a private host is refused whatever its scheme.
		const hostname = url.hostname.replace(/^\[|\]$/g, "");
		const entries = isIP(hostname)
			? [{ address: hostname }]
			: await untilAborted(addresses(hostname), signal).catch((error) => {
					if (["ENOTFOUND", "ENODATA"].includes(error?.code))
						throw new DestinationError(error.message, "unresolved");
					throw error;
				});
		check(entries, allow);
		if (
			!protocols.includes(url.protocol) ||
			(options.ports &&
				!options.ports.includes(
					Number(url.port || (url.protocol === "https:" ? 443 : 80)),
				))
		)
			throw new DestinationError(
				"Destination protocol or port is not permitted",
				protocols.includes(url.protocol) ? "port" : "protocol",
			);
		if (url.protocol === "http:") checkPlain(entries);
	}
	const guardedFetch: typeof fetch = async (input, init) => {
		const request = new Request(input, init);
		// A stalled resolver or settings lookup must not outlive the caller's deadline.
		request.signal.throwIfAborted();
		const allow = await untilAborted(allowPrivate(), request.signal);
		const url = new URL(request.url);
		await validate(url, allow, request.signal);
		request.signal.throwIfAborted();
		const response = await send(request.url, {
			method: request.method,
			headers: Object.fromEntries(request.headers),
			body: request.body,
			duplex: "half",
			signal: request.signal,
			// validate() only admits http:// when private networks are allowed.
			dispatcher:
				url.protocol === "http:"
					? plainDispatcher
					: allow
						? privateDispatcher
						: publicDispatcher,
		});
		return response as unknown as Response;
	};
	return {
		validateDestination: async (url: URL) =>
			validate(url, await allowPrivate()),
		fetch: guardedFetch,
	};
}
/**
 * Send without following redirects: callers send "manual" and refuse a redirect
 * response (any 3xx but 304), cancelling its body.
 */
export async function fetchWithoutRedirects(
	send: typeof fetch,
	input: RequestInfo | URL,
	init?: RequestInit,
): Promise<Response> {
	const response = await send(input, { ...init, redirect: "manual" });
	if (isRedirectResponse(response)) {
		await response.body?.cancel().catch(() => {});
		throw new TypeError("Upstream redirects are not permitted");
	}
	return response;
}
export function validateUpstreamHeaders(
	headers: Record<string, string>,
	options: { message?: string } = {},
) {
	for (const [key, value] of Object.entries(headers)) {
		if (
			!/^[!#$%&'*+.^_`|~0-9a-z-]+$/i.test(key) ||
			/[\r\n]/.test(value) ||
			/^(host|cookie|connection|content-length|transfer-encoding|mcp-.*)$/i.test(
				key,
			)
		)
			throw new Error(options.message ?? "Unsupported upstream header");
	}
	return headers;
}
const unreachableCodes = new Set([
	"ECONNREFUSED",
	"ECONNRESET",
	"ETIMEDOUT",
	"EHOSTUNREACH",
	"ENETUNREACH",
	"ENOTFOUND",
	"EAI_AGAIN",
	"EPIPE",
	SdkErrorCode.RequestTimeout,
	SdkErrorCode.ConnectionClosed,
]);
/** The reason an upstream did not answer (network failure, timeout or server error),
 * or undefined for anything else, such as a refusal, denial or protocol error. */
export function upstreamUnreachable(error: unknown): string | undefined {
	let current = error;
	for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
		// A connection-time policy refusal also surfaces as "fetch failed".
		if (current instanceof DestinationError) return undefined;
		const { code } = current as { code?: unknown };
		if (
			typeof code === "string" &&
			(code.startsWith("UND_ERR_") || unreachableCodes.has(code))
		)
			return code;
		if (current instanceof SdkHttpError && current.status >= 500)
			return `HTTP ${current.status}`;
		if (current.name === "TimeoutError") return current.name;
		if (current instanceof AggregateError) {
			const reason = current.errors
				.map(upstreamUnreachable)
				.find((value) => value !== undefined);
			if (reason) return reason;
		}
		if (current instanceof TypeError && current.message === "fetch failed")
			// undici's cause carries the specific code when there is one.
			return current.cause instanceof DestinationError
				? undefined
				: (upstreamUnreachable(current.cause) ?? current.message);
		current = current.cause;
	}
	return undefined;
}
