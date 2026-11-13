import { createServer } from "node:http";
import { SdkError, SdkErrorCode } from "@modelcontextprotocol/client";
import { afterAll, expect, it } from "vitest";
import {
	createDestinationPolicy,
	DestinationError,
	fetchWithoutRedirects,
	permittedAddress,
	upstreamUnreachable,
	validateUpstreamHeaders,
} from "../packages/gateway/src/index";

const server = createServer(async (request, response) => {
	if (request.url === "/redirect") {
		response.writeHead(302, { Location: "/" });
		response.end();
		return;
	}
	let body = "";
	for await (const chunk of request) body += chunk;
	response.setHeader("Content-Type", "application/json");
	response.end(
		JSON.stringify({
			method: request.method,
			header: request.headers["x-fixture"],
			body,
		}),
	);
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
it("enforces public HTTPS/443 and rejects empty or mixed DNS answers", async () => {
	const policy = createDestinationPolicy({
		protocols: ["https:"],
		ports: [443],
		resolve: async () => [{ address: "1.1.1.1", family: 4 }],
	});
	await expect(
		policy.validateDestination(new URL("https://example.invalid/mcp")),
	).resolves.toBeUndefined();
	for (const url of [
		"http://example.invalid",
		"https://example.invalid:444",
		"https://127.0.0.1",
		"https://[::1]",
		"https://169.254.169.254",
		"https://user:pass@example.invalid",
		"https://example.invalid/#fragment",
	])
		await expect(policy.validateDestination(new URL(url))).rejects.toThrow();
	for (const entries of [
		[],
		[
			{ address: "1.1.1.1", family: 4 },
			{ address: "127.0.0.1", family: 4 },
		],
	])
		await expect(
			createDestinationPolicy({
				resolve: async () => entries,
			}).validateDestination(new URL("https://example.invalid")),
		).rejects.toThrow();
});
it("supports operator private networks and preserves Request method, headers, body and abort signal", async () => {
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("Missing fixture port");
	const base = `http://127.0.0.1:${address.port}`;
	const policy = createDestinationPolicy({ allowPrivateNetworks: true });
	const response = await policy.fetch(
		new Request(base, {
			method: "POST",
			headers: { "x-fixture": "preserved" },
			body: "payload",
		}),
	);
	expect(await response.json()).toEqual({
		method: "POST",
		header: "preserved",
		body: "payload",
	});
	await expect(
		policy.fetch(`${base}/redirect`, { redirect: "follow" }),
	).rejects.toThrow();
	const controller = new AbortController();
	controller.abort();
	await expect(
		policy.fetch(new Request(base, { signal: controller.signal })),
	).rejects.toThrow();
	await expect(
		createDestinationPolicy({ allowPrivateNetworks: false }).fetch(base),
	).rejects.toThrow();
});
it("allows plain HTTP only to private destinations on private networks", async () => {
	const answers: Record<string, string[]> = {
		"public.invalid": ["1.1.1.1"],
		"mixed.invalid": ["10.0.0.5", "1.1.1.1"],
		"lan.invalid": ["192.168.1.20"],
	};
	const resolve = async (hostname: string) =>
		(answers[hostname] ?? []).map((address) => ({ address, family: 4 }));
	const open = createDestinationPolicy({ allowPrivateNetworks: true, resolve });
	for (const url of [
		"http://public.invalid/mcp",
		"http://1.1.1.1/mcp",
		"http://[2606:4700:4700::1111]/mcp",
		// One public answer is enough to refuse plain HTTP.
		"http://mixed.invalid/mcp",
	]) {
		const error = await open.validateDestination(new URL(url)).then(
			() => undefined,
			(reason: unknown) => reason,
		);
		expect(error, url).toBeInstanceOf(DestinationError);
		expect((error as DestinationError).advice, url).toMatch(
			/^Use an https:\/\/ address\. Plain http:\/\/ is only allowed/,
		);
	}
	for (const url of [
		"http://127.0.0.1:8080/mcp",
		"http://[::1]/mcp",
		"http://lan.invalid/mcp",
		"http://[fd12::1]/mcp",
		"https://public.invalid/mcp",
	])
		await expect(
			open.validateDestination(new URL(url)),
			url,
		).resolves.toBeUndefined();
	const closed = createDestinationPolicy({
		allowPrivateNetworks: false,
		resolve,
	});
	for (const url of ["http://127.0.0.1/mcp", "http://public.invalid/mcp"])
		await expect(closed.validateDestination(new URL(url)), url).rejects.toThrow(
			DestinationError,
		);
	await expect(
		closed.validateDestination(new URL("https://public.invalid/mcp")),
	).resolves.toBeUndefined();
	// fetch() refuses before any I/O.
	await expect(open.fetch("http://public.invalid/mcp")).rejects.toThrow(
		DestinationError,
	);
});

it("rejects unsafe upstream headers", () => {
	expect(validateUpstreamHeaders({ Authorization: "Bearer fixture" })).toEqual({
		Authorization: "Bearer fixture",
	});
	for (const headers of [
		{ Host: "override" },
		{ "Mcp-Session-Id": "override" },
		{ "x-test": "bad\r\nvalue" },
		{ "bad key": "value" },
	] as Record<string, string>[])
		expect(() =>
			validateUpstreamHeaders(headers, { message: "Denied header" }),
		).toThrow("Denied header");
});

it("classifies bracketed public IPv6 literals without DNS or live I/O", async () => {
	const url = new URL("https://[2606:4700:4700::1111]/mcp");
	expect(permittedAddress(url.hostname)).toBe(true);
	expect(permittedAddress("[::1]")).toBe(false);
	const policy = createDestinationPolicy({
		protocols: ["https:"],
		ports: [443],
		resolve: async () => {
			throw new Error("literal must not use DNS");
		},
	});
	await expect(policy.validateDestination(url)).resolves.toBeUndefined();
});

it("refuses instance metadata addresses in every form, even on private networks", async () => {
	for (const address of [
		"169.254.169.254",
		"fd00:ec2::254",
		"[fd00:0ec2:0:0:0:0:0:0254]",
		"::ffff:169.254.169.254",
		"::ffff:a9fe:a9fe",
		"::a9fe:a9fe",
		"64:ff9b::a9fe:a9fe",
		"64:ff9b:1::a9fe:a9fe",
	]) {
		expect(permittedAddress(address, false)).toBe(false);
		expect(permittedAddress(address, true)).toBe(false);
	}
	// Neighbouring unique-local and IPv4-compatible addresses keep their range.
	expect(permittedAddress("fd00:ec2::253", true)).toBe(true);
	expect(permittedAddress("::7f00:1", false)).toBe(false);
	expect(permittedAddress("::7f00:1", true)).toBe(true);
	expect(permittedAddress("::101:101", false)).toBe(true);
	const policy = createDestinationPolicy({
		allowPrivateNetworks: true,
		resolve: async () => [{ address: "fd00:ec2::254", family: 6 }],
	});
	for (const url of [
		"http://[fd00:ec2::254]/latest/meta-data/",
		"http://[::ffff:169.254.169.254]/",
		"http://metadata.example.invalid/",
	])
		await expect(policy.validateDestination(new URL(url))).rejects.toThrow(
			DestinationError,
		);
	await expect(
		policy.fetch("http://metadata.example.invalid/"),
	).rejects.toThrow(DestinationError);
});

it("explains each refused destination in plain words", async () => {
	const policy = createDestinationPolicy({
		protocols: ["https:"],
		ports: [443],
		resolve: async (hostname) => {
			if (hostname === "missing.invalid")
				throw Object.assign(new Error("queryA ENOTFOUND"), {
					code: "ENOTFOUND",
				});
			return [
				{
					address: hostname === "localhost" ? "127.0.0.1" : "1.1.1.1",
					family: 4,
				},
			];
		},
	});
	for (const [url, advice] of [
		["javascript:alert(1)", "Use an https:// address."],
		["ftp://example.invalid", "Use an https:// address."],
		["http://example.invalid/mcp", "Use an https:// address."],
		[
			"https://user:pass@example.invalid",
			"Remove the user name, password or # part from the address.",
		],
		[
			"https://example.invalid:444",
			"Use an https:// address without a port number.",
		],
		[
			"http://localhost/mcp",
			"Private and local network addresses can't be connected.",
		],
		[
			"http://127.0.0.1:5432/mcp",
			"Private and local network addresses can't be connected.",
		],
		[
			"http://169.254.169.254/latest/meta-data",
			"Private and local network addresses can't be connected.",
		],
		[
			"https://missing.invalid/mcp",
			"No server was found at this address. Check the address, then try again.",
		],
	]) {
		const error = await policy.validateDestination(new URL(url)).then(
			() => undefined,
			(reason: unknown) => reason,
		);
		expect(error, url).toBeInstanceOf(DestinationError);
		expect((error as DestinationError).advice, url).toBe(advice);
	}
});

it("tells unreachable upstreams apart from refusals and policy denials", () => {
	const timeout = new TypeError("fetch failed", {
		cause: Object.assign(new Error("Connect Timeout Error"), {
			code: "UND_ERR_CONNECT_TIMEOUT",
		}),
	});
	expect(upstreamUnreachable(timeout)).toBe("UND_ERR_CONNECT_TIMEOUT");
	expect(upstreamUnreachable(new Error("wrapped", { cause: timeout }))).toBe(
		"UND_ERR_CONNECT_TIMEOUT",
	);
	expect(
		upstreamUnreachable(
			new SdkError(SdkErrorCode.RequestTimeout, "Request timed out"),
		),
	).toBe(SdkErrorCode.RequestTimeout);
	expect(
		upstreamUnreachable(new DOMException("timed out", "TimeoutError")),
	).toBe("TimeoutError");
	expect(
		upstreamUnreachable(
			new TypeError("fetch failed", {
				cause: new DestinationError("fixture", "network"),
			}),
		),
	).toBeUndefined();
	expect(
		upstreamUnreachable(new Error("Capability unavailable or access denied")),
	).toBeUndefined();
	expect(upstreamUnreachable("fetch failed")).toBeUndefined();
});

it("observes the request signal while resolving, and checks it before any lookup", async () => {
	let lookups = 0;
	const policy = createDestinationPolicy({
		protocols: ["https:"],
		ports: [443],
		resolve: () => {
			lookups++;
			return new Promise(() => {});
		},
	});
	const aborted = new AbortController();
	aborted.abort(new Error("already aborted"));
	await expect(
		policy.fetch("https://stalled.example.invalid/", {
			signal: aborted.signal,
		}),
	).rejects.toThrow("already aborted");
	expect(lookups).toBe(0);
	const started = performance.now();
	await expect(
		policy.fetch("https://stalled.example.invalid/", {
			signal: AbortSignal.timeout(50),
		}),
	).rejects.toMatchObject({ name: "TimeoutError" });
	expect(performance.now() - started).toBeLessThan(1_000);
	expect(lookups).toBe(1);
});

it("never leaves a cancelled lookup's later rejection unhandled", async () => {
	const unhandled: unknown[] = [];
	const onUnhandled = (reason: unknown) => unhandled.push(reason);
	process.on("unhandledRejection", onUnhandled);
	try {
		// Aborted exactly when the settings check resolves: no lookup starts.
		let lookups = 0;
		const settings = new AbortController();
		const afterSettings = createDestinationPolicy({
			allowPrivateNetworks: async () => {
				settings.abort(new Error("cancelled after settings"));
				return false;
			},
			resolve: async () => {
				lookups++;
				throw new Error("late DNS rejection");
			},
		});
		await expect(
			afterSettings.fetch("https://host.example.invalid/", {
				signal: settings.signal,
			}),
		).rejects.toThrow("cancelled after settings");
		expect(lookups).toBe(0);
		// Aborted while DNS is pending; DNS later rejects or resolves.
		for (const outcome of ["reject", "resolve"] as const) {
			const controller = new AbortController();
			let settle: (() => void) | undefined;
			const pending = createDestinationPolicy({
				resolve: () =>
					new Promise((resolve, reject) => {
						settle = () =>
							outcome === "reject"
								? reject(new Error("late DNS rejection"))
								: resolve([{ address: "1.1.1.1", family: 4 }]);
					}),
			});
			const result = pending.fetch("https://host.example.invalid/", {
				signal: controller.signal,
			});
			await new Promise((resolve) => setTimeout(resolve, 10));
			const started = performance.now();
			controller.abort(new Error(`cancelled during DNS (${outcome})`));
			await expect(result).rejects.toThrow("cancelled during DNS");
			expect(performance.now() - started).toBeLessThan(100);
			settle?.();
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(unhandled).toEqual([]);
	} finally {
		process.off("unhandledRejection", onUnhandled);
	}
});

it("sends redirect manual and refuses redirect responses without following them", async () => {
	const modes: (RequestRedirect | undefined)[] = [];
	let cancelled = false;
	const send: typeof fetch = async (_input, init) => {
		modes.push(init?.redirect);
		return new Response(
			new ReadableStream({
				cancel() {
					cancelled = true;
				},
			}),
			{ status: 307, headers: { location: "https://elsewhere.invalid/" } },
		);
	};
	await expect(
		fetchWithoutRedirects(send, "https://upstream.invalid/", { redirect: "error" }),
	).rejects.toThrow("Upstream redirects are not permitted");
	expect(modes).toEqual(["manual"]);
	expect(cancelled).toBe(true);
	const ok = await fetchWithoutRedirects(async () => Response.json({}), "https://upstream.invalid/");
	expect(ok.status).toBe(200);
});
