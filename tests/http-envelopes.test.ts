import { RULES_INPUT_MAX_BYTES, rulesInput } from "@toolstile/api/contract";
import {
	createCommonRouter,
	createRpcHandler,
	rpcCallerError,
	type Services,
} from "@toolstile/api/server";
import { expect, it, vi } from "vitest";
import { ORPCError } from "../apps/web/test-support/setup-rpc";
import {
	createAgentConsentHandler,
	createMcpHttpHandler,
	createUpstreamOAuthHttpHandlers,
} from "../packages/auth/src/http";
import {
	DestinationError,
	type Runtime,
	UpstreamUnavailableError,
} from "../packages/gateway/src/index";

const origin = "https://example.invalid";
const session = { user: { id: "user" }, session: { id: "session" } };
it("keeps RPC mutation origin checks before actor resolution and maps resolver errors", async () => {
	const resolveActor = vi.fn(async () => {
		throw new Error("fixture");
	});
	const handler = createRpcHandler({
		origin,
		router: {},
		resolveActor,
		context: () => ({}),
		mapError: () => new Response("Mapped", { status: 401 }),
	});
	for (const headers of [{}, { origin: "https://other.invalid" }] as Record<
		string,
		string
	>[])
		expect(
			(
				await handler(
					new Request(`${origin}/api/rpc`, { method: "POST", headers }),
				)
			).status,
		).toBe(403);
	expect(resolveActor).not.toHaveBeenCalled();
	expect((await handler(new Request(`${origin}/api/rpc`))).status).toBe(401);
	expect(
		(
			await handler(
				new Request(`${origin}/api/rpc`, {
					method: "POST",
					headers: { origin },
				}),
			)
		).status,
	).toBe(401);
	const missing = createRpcHandler({
		origin,
		router: {},
		resolveActor: async () => "actor",
		context: () => ({}),
		mapError: () => new Response(null, { status: 500 }),
	});
	expect((await missing(new Request(`${origin}/api/rpc/absent`))).status).toBe(
		404,
	);
});
it("requires an exact origin for consent mutations and resolves session before listing", async () => {
	const list = vi.fn(async () => ({ devices: [], agents: [] }));
	const handler = createAgentConsentHandler({
		origin,
		secret: "fixture",
		clientName: async () => null,
		browserDevice: { lookup: async () => null, bind: async () => {} },
		session: async () => session,
		resolveActor: async () => ({ userId: "user" }),
		list,
		addDevice: async () => ({ id: "device" }),
		addAgent: async () => ({ id: "agent" }),
		resolveReference: async () => "reference",
		describeReference: async () => ({
			agentLabel: "Agent",
			deviceLabel: "Device",
		}),
		selection: { save: async () => {}, lookup: async () => undefined },
	});
	expect((await handler(new Request(`${origin}/consent`))).status).toBe(200);
	expect(list).toHaveBeenCalledOnce();
	for (const headers of [{}, { origin: "https://other.invalid" }] as Record<
		string,
		string
	>[])
		expect(
			(
				await handler(
					new Request(`${origin}/consent`, { method: "POST", headers }),
				)
			).status,
		).toBe(403);
	expect(
		(
			await handler(
				new Request(`${origin}/consent`, {
					method: "POST",
					headers: { origin },
					body: "{}",
				}),
			)
		).status,
	).toBe(400);
	expect(
		(
			await handler(
				new Request(`${origin}/consent`, {
					method: "POST",
					headers: { origin },
					body: JSON.stringify({ oauth_query: "x".repeat(70 * 1024) }),
				}),
			)
		).status,
	).toBe(413);
});
it("keeps 401/403 for caller refusals and reports infrastructure failures as 503", async () => {
	const log = vi.fn();
	const status = async (error: unknown) => {
		const handler = createRpcHandler({
			origin,
			router: {},
			resolveActor: async () => {
				throw error;
			},
			context: () => ({}),
			mapError: (failure) => rpcCallerError(failure, log),
		});
		return (await handler(new Request(`${origin}/api/rpc/snapshot`))).status;
	};
	expect(await status(new ORPCError("UNAUTHORIZED"))).toBe(401);
	expect(await status(new ORPCError("FORBIDDEN"))).toBe(403);
	expect(log).not.toHaveBeenCalled();
	const unavailable = Object.assign(new Error("connect ECONNREFUSED secret"), {
		code: "ECONNREFUSED",
	});
	expect(await status(unavailable)).toBe(503);
	expect(await status(new ORPCError("INTERNAL_SERVER_ERROR"))).toBe(503);
	expect(log).toHaveBeenCalledTimes(2);
	const response = rpcCallerError(unavailable, () => {});
	expect(await response.text()).not.toContain("secret");
});
it("bounds RPC bodies after resolving the caller and keeps small inputs intact", async () => {
	const handler = createRpcHandler({
		origin,
		router: createCommonRouter(),
		resolveActor: async () => ({ userId: "user", scopeId: "user" }),
		context: (actor) => ({
			actor,
			services: { snapshot: async () => ({}) } as unknown as Services,
		}),
		mapError: () => new Response(null, { status: 500 }),
	});
	const post = (body: string) =>
		handler(
			new Request(`${origin}/api/rpc/renameDevice`, {
				method: "POST",
				headers: { origin, "content-type": "application/json" },
				body,
			}),
		);
	expect((await post(`{"json":"${"x".repeat(1024 * 1024)}"}`)).status).toBe(
		413,
	);
	// A normal input reaches oRPC validation rather than the body boundary.
	expect((await post('{"json":{"id":1}}')).status).toBe(400);
});
it.each([
	["three-byte characters", "\u20ac"],
	["lone surrogates escaped as \\uXXXX", "\ud800"],
	["escaped quotes and backslashes", '"\\'],
])("accepts the largest schema-valid grant in %s", async (_name, unit) => {
	// Seven full lists of names at the 256-unit limit.
	const names = Array.from({ length: 1000 }, (_, i) =>
		`${i}`.padStart(256, unit),
	);
	const rules = {
		full: false,
		allow: { tools: names, resources: names, prompts: names },
		block: { tools: names, resources: names, prompts: names },
		requireApproval: names,
	};
	expect(rulesInput.safeParse(rules).success).toBe(true);
	const body = JSON.stringify({
		json: { agentId: "agent", connectionId: "connection", rules },
	});
	const bytes = new TextEncoder().encode(body).byteLength;
	expect(bytes).toBeGreaterThan(1024 * 1024);
	expect(bytes).toBeLessThanOrEqual(RULES_INPUT_MAX_BYTES);
	if (unit === "\ud800") expect(bytes).toBeGreaterThan(10 * 1024 * 1024);
	const saveGrant = vi.fn(async () => {});
	const handler = createRpcHandler({
		origin,
		router: createCommonRouter(),
		resolveActor: async () => ({ userId: "user", scopeId: "user" }),
		context: (actor) => ({
			actor,
			services: { saveGrant } as unknown as Services,
		}),
		mapError: () => new Response(null, { status: 500 }),
	});
	const post = (procedure: string, payload: string) =>
		handler(
			new Request(`${origin}/api/rpc/${procedure}`, {
				method: "POST",
				headers: { origin, "content-type": "application/json" },
				body: payload,
			}),
		);
	expect((await post("saveGrant", body)).status).toBe(200);
	expect(saveGrant).toHaveBeenCalledOnce();
	// Other procedures keep the small default.
	expect((await post("renameDevice", body)).status).toBe(413);
	expect(
		(
			await post(
				"saveGrant",
				`{"json":"${"x".repeat(RULES_INPUT_MAX_BYTES + 64 * 1024)}"}`,
			)
		).status,
	).toBe(413);
});
it("preserves upstream callback identity, private cache headers and injected restoration", async () => {
	const finish = vi.fn(async () => ({ reference: "selected" }));
	const handlers = createUpstreamOAuthHttpHandlers({
		session: async () => session,
		metadata: () => ({ client_name: "Fixture" }),
		finish,
		successLocation: (context) => `/connections?selected=${context.reference}`,
	});
	const response = await handlers.callback(
		new Request(`${origin}/callback?state=state&code=code&iss=issuer`),
	);
	expect(finish).toHaveBeenCalledWith(
		{ userId: "user", sessionId: "session" },
		"state",
		"code",
		"issuer",
	);
	expect(response.headers.get("location")).toBe(
		"/connections?selected=selected",
	);
	expect(response.headers.get("cache-control")).toBe("no-store");
	expect(response.headers.get("referrer-policy")).toBe("no-referrer");
	expect(handlers.metadata().headers.get("cache-control")).toBe(
		"public, max-age=3600",
	);
	finish.mockRejectedValueOnce(new Error("fixture"));
	expect(
		(await handlers.callback(new Request(`${origin}/callback`))).headers.get(
			"location",
		),
	).toBe("/app/connections?oauth=failed");
});
it("rejects expired bearer credentials before runtime or ingress and maps token dispatch failures", async () => {
	const row = {
		auth: { expiresAt: new Date(0) as Date | null, revokedAt: null },
		device: { revokedAt: null },
	};
	const resolveRuntime = vi.fn(async () => ({}) as Runtime),
		ingress = vi.fn(async () => {});
	const handler = createMcpHttpHandler({
		origin,
		auth: { options: { baseURL: origin } } as Parameters<
			typeof createMcpHttpHandler
		>[0]["auth"],
		resolveAuthorization: async () => row,
		resolveRuntime,
		ingress,
		handle: async () => {
			throw new Error("fixture");
		},
		mapError: (_error, mode) =>
			Response.json(
				{ mode, jsonrpc: "2.0", error: { code: -32603 }, id: null },
				{ status: mode === "token" ? 500 : 403 },
			),
	});
	const request = () =>
		new Request(`${origin}/mcp`, {
			headers: { authorization: "Bearer ts_fixture" },
		});
	expect((await handler(request())).status).toBe(401);
	expect(resolveRuntime).not.toHaveBeenCalled();
	expect(ingress).not.toHaveBeenCalled();
	row.auth.expiresAt = null;
	const failed = await handler(request());
	expect(failed.status).toBe(500);
	expect((await failed.json()).mode).toBe("token");
	expect(ingress).toHaveBeenCalledOnce();
	const wrongOrigin = new Request(`${origin}/mcp`, {
		headers: {
			authorization: "Bearer ts_fixture",
			origin: "https://other.invalid",
		},
	});
	expect((await handler(wrongOrigin)).status).toBe(403);
});
it("does not dispatch when injected ingress rejects", async () => {
	const dispatch = vi.fn(async () => new Response("Unexpected"));
	const handler = createMcpHttpHandler({
		origin,
		auth: {} as Parameters<typeof createMcpHttpHandler>[0]["auth"],
		resolveAuthorization: async () => ({
			auth: { expiresAt: null, revokedAt: null },
			device: { revokedAt: null },
		}),
		resolveRuntime: async () => ({}) as Runtime,
		ingress: async () => {
			throw new Error("Limited");
		},
		handle: dispatch,
		mapError: (error) =>
			new Response(error instanceof Error ? error.message : "Denied", {
				status: 429,
				headers: { "Retry-After": "60" },
			}),
	});
	const response = await handler(
		new Request(`${origin}/mcp`, {
			headers: { authorization: "Bearer ts_fixture" },
		}),
	);
	expect(response.status).toBe(429);
	expect(response.headers.get("retry-after")).toBe("60");
	expect(dispatch).not.toHaveBeenCalled();
});

it("rejects GET RPC mutations with a foreign Origin without invoking the service", async () => {
	const revokeAgent = vi.fn(async () => {});
	const handler = createRpcHandler({
		origin,
		router: createCommonRouter(),
		resolveActor: async () => ({ userId: "user", scopeId: "user" }),
		context: (actor) => ({
			actor,
			services: { revokeAgent } as unknown as Services,
		}),
		mapError: () => new Response(null, { status: 500 }),
	});
	const response = await handler(
		new Request(
			`${origin}/api/rpc/revokeAgent?data=${encodeURIComponent(JSON.stringify({ json: { id: "agent" } }))}`,
			{ headers: { origin: "https://other.invalid" } },
		),
	);
	expect(response.status).toBe(405);
	expect(revokeAgent).not.toHaveBeenCalled();
});

it("masks unexpected consent storage errors while preserving invalid-request guidance", async () => {
	const list = vi.fn(
		async (): Promise<{ devices: never[]; agents: never[] }> => {
			throw new Error(
				"duplicate key violates secret_constraint: select * from session",
			);
		},
	);
	const handler = createAgentConsentHandler({
		origin,
		secret: "fixture",
		session: async () => session,
		resolveActor: async () => ({ userId: "user" }),
		clientName: async () => null,
		browserDevice: { lookup: async () => null, bind: async () => {} },
		list,
		addDevice: async () => ({ id: "device" }),
		addAgent: async () => ({ id: "agent" }),
		resolveReference: async () => "reference",
		describeReference: async () => ({
			agentLabel: "Agent",
			deviceLabel: "Device",
		}),
		selection: { save: async () => {}, lookup: async () => undefined },
	});
	const response = await handler(new Request(`${origin}/consent`));
	expect(response.status).toBe(400);
	expect(await response.json()).toEqual({
		message: "Authorization failed. Try again.",
	});
	expect(response.headers.get("cache-control")).toBe("no-store");
	list.mockResolvedValue({ devices: [], agents: [] });
	const invalid = await handler(
		new Request(`${origin}/consent`, {
			method: "POST",
			headers: { origin },
			body: JSON.stringify({ oauth_query: "unsigned" }),
		}),
	);
	expect(await invalid.json()).toEqual({
		message:
			"Authorization request is invalid or expired. Start sign-in again.",
	});
	const validation = await handler(
		new Request(`${origin}/consent`, {
			method: "POST",
			headers: { origin },
			body: "{}",
		}),
	);
	expect(await validation.json()).toEqual({
		message:
			"Invalid authorization request. Check your selection and try again.",
	});
});

it("returns specific messages for invalid input, refused destinations and unreachable servers", async () => {
	const addDevice = vi.fn(async () => ({ id: "device" }));
	const addConnection = vi.fn(async () => {
		throw new DestinationError("fixture", "network");
	});
	const agentCatalog = vi.fn(async () => {
		throw new UpstreamUnavailableError(
			"https://mcp.example.com/mcp",
			"UND_ERR_CONNECT_TIMEOUT",
			{ cause: new TypeError("fetch failed") },
		);
	});
	const saveGrant = vi.fn(async () => {});
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	const handler = createRpcHandler({
		origin,
		router: createCommonRouter(),
		resolveActor: async () => ({ userId: "user", scopeId: "user" }),
		context: (actor) => ({
			actor,
			services: {
				addDevice,
				addConnection,
				agentCatalog,
				saveGrant,
			} as unknown as Services,
		}),
		mapError: () => new Response(null, { status: 500 }),
	});
	const call = async (name: string, json: unknown) => {
		const response = await handler(
			new Request(`${origin}/api/rpc/${name}`, {
				method: "POST",
				headers: { origin, "content-type": "application/json" },
				body: JSON.stringify({ json }),
			}),
		);
		const body = await response.json();
		return { status: response.status, message: body.json?.message };
	};
	const rules = {
		full: false,
		allow: { tools: ["search"], resources: [], prompts: [] },
		block: { tools: [], resources: [], prompts: [] },
	};
	try {
		expect(await call("addDevice", { label: "   " })).toEqual({
			status: 400,
			message: "Enter a name.",
		});
		expect(await call("addDevice", { label: "a".repeat(101) })).toEqual({
			status: 400,
			message: "Use a name of 100 characters or fewer.",
		});
		expect(await call("addDevice", { label: "evil\u202Ename" })).toMatchObject({
			status: 400,
		});
		expect(addDevice).not.toHaveBeenCalled();
		for (const [url, message] of [
			["javascript:alert(1)", "Use an https:// address."],
			["ftp://x", "Use an https:// address."],
			["not a url", "This address isn't a valid URL."],
			[
				`https://example.com/${"a".repeat(2048)}`,
				"Use an address of 2,048 characters or fewer.",
			],
		])
			expect(await call("addConnection", { url })).toEqual({
				status: 400,
				message,
			});
		expect(addConnection).not.toHaveBeenCalled();
		expect(
			await call("addConnection", { url: "https://127.0.0.1:5432/mcp" }),
		).toEqual({
			status: 400,
			message: "Private and local network addresses can't be connected.",
		});
		expect(
			await call("agentCatalog", { agentId: "agent", connectionId: "c" }),
		).toEqual({
			status: 502,
			message:
				"Couldn't reach example.com just now. Check that the server is online, then try again.",
		});
		expect(warn).toHaveBeenCalledWith(
			"MCP server unreachable",
			"UND_ERR_CONNECT_TIMEOUT",
		);
		for (const name of ["<script>\n", "a".repeat(257), " padded"])
			expect(
				(
					await call("saveGrant", {
						agentId: "agent",
						connectionId: "c",
						rules: { ...rules, allow: { ...rules.allow, tools: [name] } },
					})
				).status,
			).toBe(400);
		expect(
			await call("saveGrant", { agentId: "agent", connectionId: "c", rules }),
		).toEqual({ status: 200, message: undefined });
	} finally {
		warn.mockRestore();
	}
});
