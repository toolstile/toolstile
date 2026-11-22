import type {
	AccountClient,
	AllAgentGrantClient,
	ManagementClient,
} from "@toolstile/api/client";
import {
	type AccountServices,
	type AllAgentGrantServices,
	createAccountRouter,
	createAllAgentGrantRouter,
	createCommonRouter,
	type Services,
} from "@toolstile/api/server";
import { activityOrigin } from "../packages/database/src/activity-origin";
import { describe, expect, it, vi } from "vitest";
import {
	call,
	createORPCClient,
	RPCHandler,
	RPCLink,
} from "../apps/web/test-support/setup-rpc";
import { emptyRules } from "../packages/gateway/src/index";

const actor = { userId: "owner", scopeId: "owner" };
const extra = { adapterOnlyField: "must stay inside the adapter" };
const addAgent = vi.fn(async () => ({
	id: "agent",
	token: "issued-token",
	...extra,
}));
const services = {
	debugStatus: async () => ({
		sessions: [],
		payloads: [],
		activityRetentionDays: 30,
		payloadRetentionHours: 24,
		...extra,
	}),
	startDebug: async () => ({ id: "debug", ...extra }),
	extendDebug: async () => ({ ok: true, ...extra }),
	stopDebug: async () => ({ ok: true, ...extra }),
	debugPayload: async () => ({
		arguments: {},
		result: {},
		truncated: false,
		...extra,
	}),
	agentCatalog: async () => ({ tools: [], ...extra }),
	testTool: async () => ({
		isError: false,
		preview: "ok",
		truncated: false,
		...extra,
	}),
	startConnectionOAuth: async () => ({
		url: "https://example.invalid/oauth",
		...extra,
	}),
	snapshot: async () => ({
		user: {
			name: "Owner",
			email: "owner@example.invalid",
			operator: false,
			...extra,
		},
		connections: [],
		devices: [],
		agents: [],
		grants: [],
		allAgentGrants: [],
		activity: [],
		...extra,
	}),
	activityRequest: async (_actor: unknown, id: string) =>
		id === "request"
			? {
					id,
					agent: "Agent",
					connection: "Connection",
					origin: "agent" as const,
					method: "tools/call",
					target: null,
					outcome: "forwarded",
					durationMs: 1,
					createdAt: "2026-11-19T00:00:00.000Z",
					...extra,
				}
			: null,
	addConnection: async () => ({
		id: "connection",
		label: "Connection",
		url: "https://mcp.example.com/mcp",
		transport: "http" as const,
		authentication: "headers" as const,
		status: "reachable",
		...extra,
	}),
	removeConnection: async () => {},
	addDevice: async () => ({ id: "device", ...extra }),
	addAgent,
	renameDevice: async () => {},
	renameAgent: async () => {},
	revokeAgent: async () => {},
	revokeDevice: async () => {},
	saveGrant: async () => {},
	verify: async () => ({
		tools: ["tool"],
		resources: [],
		prompts: [],
		descriptions: [
			{
				capability: "tools",
				name: "tool",
				description: "Does a thing",
				...extra,
			},
		],
		hints: [{ name: "tool", readOnly: true, ...extra }],
		...extra,
	}),
	accountStatus: async () => ({
		identifier: "owner",
		providers: ["credential"],
		recoveryCodesRemaining: 4,
		recoveryWindowDays: 30,
		...extra,
	}),
	rotateRecoveryCodes: async () => ({
		codes: ["issued-recovery-code"],
		...extra,
	}),
	deleteAccount: async () => ({
		purgeAfter: "2026-11-20T00:00:00.000Z",
		...extra,
	}),
	saveAllAgentGrant: async () => {},
	removeAllAgentGrant: async () => {},
} satisfies Services & AccountServices & AllAgentGrantServices;

type FixtureContext = { actor: typeof actor; services: typeof services };
function transport(
	router: ConstructorParameters<typeof RPCHandler<FixtureContext>>[0],
) {
	const handler = new RPCHandler<FixtureContext>(router);
	return new RPCLink({
		url: "https://example.invalid/api/rpc",
		fetch: async (request) =>
			(
				await handler.handle(new Request(request), {
					prefix: "/api/rpc",
					context: { actor, services },
				})
			).response ?? new Response("Not found", { status: 404 }),
	});
}
const common = createCommonRouter();
const client = createORPCClient<ManagementClient>(transport(common));
const selection = { agentIds: ["agent"], connectionIds: ["connection"] };
const catalog = { agentId: "agent", connectionId: "connection" };

describe("management response boundaries", () => {
	it("strips mutation adapter fields while retaining issued tokens and input defaults", async () => {
		expect(
			await client.addConnection({ url: "https://example.invalid/mcp" }),
		).toEqual({
			id: "connection",
			label: "Connection",
			url: "https://mcp.example.com/mcp",
			transport: "http",
			authentication: "headers",
			status: "reachable",
		});
		expect(await client.addDevice({ label: "Device" })).toEqual({
			id: "device",
		});
		expect(
			await client.addAgent({ label: "Agent", deviceId: "device" }),
		).toEqual({ id: "agent", token: "issued-token" });
		expect(addAgent).toHaveBeenLastCalledWith(actor, {
			label: "Agent",
			deviceId: "device",
			expiresInDays: 90,
		});
		expect(await client.startConnectionOAuth({ id: "connection" })).toEqual({
			url: "https://example.invalid/oauth",
		});
		expect(await client.startDebug(selection)).toEqual({ id: "debug" });
		expect(await client.extendDebug({ id: "debug" })).toEqual({ ok: true });
		expect(await client.stopDebug({ id: "debug" })).toEqual({ ok: true });
		expect(await client.verify({ id: "connection" })).toEqual({
			tools: ["tool"],
			resources: [],
			prompts: [],
			descriptions: [
				{ capability: "tools", name: "tool", description: "Does a thing" },
			],
			hints: [{ name: "tool", readOnly: true }],
		});
	});
	it("keeps read response allowlists, including nested fields", async () => {
		expect(await client.snapshot()).toEqual({
			user: { name: "Owner", email: "owner@example.invalid", operator: false },
			connections: [],
			devices: [],
			agents: [],
			grants: [],
			allAgentGrants: [],
			activity: [],
		});
		expect(await client.debugStatus()).toEqual({
			sessions: [],
			payloads: [],
			activityRetentionDays: 30,
			payloadRetentionHours: 24,
		});
		expect(await client.debugPayload({ id: "debug" })).toEqual({
			arguments: {},
			result: {},
			truncated: false,
		});
		expect(await client.activityRequest({ id: "request" })).toEqual({
			id: "request",
			agent: "Agent",
			connection: "Connection",
			origin: "agent",
			method: "tools/call",
			target: null,
			outcome: "forwarded",
			durationMs: 1,
			createdAt: "2026-11-19T00:00:00.000Z",
		});
		expect(await client.activityRequest({ id: "other" })).toBeNull();
		await expect(client.activityRequest({ id: "" })).rejects.toThrow();
		await expect(
			client.activityRequest({ id: "x".repeat(201) }),
		).rejects.toThrow();
		expect(await client.agentCatalog(catalog)).toEqual({ tools: [] });
		expect(
			await client.testTool({ ...catalog, name: "tool", arguments: {} }),
		).toEqual({ isError: false, preview: "ok", truncated: false });
	});
	it("validates explicitly composed capability outputs", async () => {
		const capabilities = createORPCClient<AccountClient & AllAgentGrantClient>(
			transport({ ...createAccountRouter(), ...createAllAgentGrantRouter() }),
		);
		expect(await capabilities.accountStatus()).toEqual({
			identifier: "owner",
			providers: ["credential"],
			recoveryCodesRemaining: 4,
			recoveryWindowDays: 30,
		});
		expect(await capabilities.rotateRecoveryCodes()).toEqual({
			codes: ["issued-recovery-code"],
		});
		expect(
			await capabilities.deleteAccount({ confirmation: "DELETE" }),
		).toEqual({ purgeAfter: "2026-11-20T00:00:00.000Z" });
		expect(
			await capabilities.saveAllAgentGrant({
				connectionId: "connection",
				rules: emptyRules(),
			}),
		).toEqual({ ok: true });
		expect(
			await capabilities.removeAllAgentGrant({ connectionId: "connection" }),
		).toEqual({ ok: true });
	});
	it.each([
		"accountStatus",
		"rotateRecoveryCodes",
		"deleteAccount",
		"saveAllAgentGrant",
		"removeAllAgentGrant",
	])("does not mount unsupported %s in the common router", async (name) => {
		expect(common).not.toHaveProperty(name);
		const result = await new RPCHandler(common).handle(
			new Request(`https://example.invalid/api/rpc/${name}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ json: {} }),
			}),
			{ prefix: "/api/rpc", context: { actor, services } },
		);
		expect(result.matched).toBe(false);
		expect(result.response).toBeUndefined();
	});
});
describe("activity origin", () => {
	it("keeps stored origins and derives legacy ones from the dashboard's labels", () => {
		expect(activityOrigin("agent", "Dashboard")).toBe("agent");
		expect(activityOrigin("dashboard", "Claude Code")).toBe("dashboard");
		expect(activityOrigin(null, "Dashboard")).toBe("dashboard");
		expect(activityOrigin(null, "Dashboard test / Claude Code")).toBe(
			"dashboard",
		);
		for (const label of ["Claude Code", "Dashboard agent", "Dashboard test"])
			expect(activityOrigin(null, label), label).toBe("agent");
	});
});

it("passes the request's signal to checks that open a server", async () => {
	const actor = { userId: "u", scopeId: "u" };
	const services = {
		verify: vi.fn(async () => ({ tools: [], resources: [], prompts: [] })),
		agentCatalog: vi.fn(async () => ({ tools: [] })),
		testTool: vi.fn(async () => ({
			isError: false,
			preview: "",
			truncated: false,
		})),
	};
	const options = () => ({
		context: { actor, services: services as unknown as Services },
		signal: new AbortController().signal,
	});
	const router = createCommonRouter();
	const verify = options();
	await call(router.verify, { id: "c" }, verify);
	expect(services.verify).toHaveBeenCalledWith(actor, "c", verify.signal);
	const listed = options();
	await call(router.agentCatalog, catalog, listed);
	expect(services.agentCatalog).toHaveBeenCalledWith(
		actor,
		catalog,
		listed.signal,
	);
	const tested = options();
	await call(
		router.testTool,
		{ ...catalog, name: "search", arguments: {} },
		tested,
	);
	expect(services.testTool).toHaveBeenCalledWith(
		actor,
		{ ...catalog, name: "search", arguments: {} },
		tested.signal,
	);
});
