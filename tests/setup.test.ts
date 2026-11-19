import { randomUUID } from "node:crypto";
import type { Actor, Snapshot } from "@toolstile/api/contract";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	createSetupRouter,
	createSetupService,
} from "../apps/web/src/server/setup";
import {
	createORPCClient,
	ORPCError,
	type RouterClient,
	RPCHandler,
	RPCLink,
} from "../apps/web/test-support/setup-rpc";
import { emptyRules, type Runtime } from "../packages/gateway/src/index";
import { createAccountTestDatabase } from "./account-database";

describe.skipIf(!process.env.DATABASE_URL)("persisted guided setup", () => {
	const first = randomUUID(),
		second = randomUUID();
	let storage: Awaited<ReturnType<typeof createAccountTestDatabase>>;
	let catalogRequests = 0,
		allowed = false,
		revoked = false,
		deleted = false,
		revision = "one";
	const actor: Actor = { userId: first, scopeId: first };
	const other: Actor = { userId: second, scopeId: second };
	const baseInput = {
		client: "codex" as const,
		connectionId: "connection",
		agentId: "agent",
		step: "verify" as const,
		action: "save" as const,
	};
	const data = (current: Actor): Snapshot => ({
		user: { name: "Fixture", email: "fixture@test.invalid", operator: false },
		connections:
			current.userId === first
				? [
						{
							id: "connection",
							label: "Fixture",
							url: "https://example.invalid/mcp",
							transport: "http",
							status: "reachable",
							authentication: "headers",
							canManageAuthentication: true,
						},
					]
				: [],
		agents:
			current.userId === first && !deleted
				? [
						{
							id: "agent",
							label: "Fixture agent",
							deviceId: "device",
							revoked,
							canTest: true,
							expiresAt: null,
						},
					]
				: [],
		devices: [],
		grants: [],
		allAgentGrants: [],
		activity: [],
	});
	const dependencies = () => ({
		pool: storage.pool,
		authorize: async (current: Actor) => {
			if (
				!new Set<string>([first, second]).has(current.userId) ||
				current.scopeId !== current.userId
			)
				throw new ORPCError("FORBIDDEN");
		},
		services: {
			snapshot: async (current: Actor) => data(current),
			agentCatalog: async () => {
				if (!allowed || revoked) throw new ORPCError("FORBIDDEN");
				catalogRequests++;
				return { tools: [] };
			},
		},
		runtime: (): Runtime => ({
			authenticate: async () => {
				if (revoked) throw new ORPCError("FORBIDDEN");
			},
			connections: async () => {
				const rule = emptyRules();
				rule.full = allowed;
				return [
					{
						id: "connection",
						label: "Fixture",
						url: "https://example.invalid/mcp",
						transport: "http",
						headers: {},
						identityKey: revision,
						rules: [rule],
					},
				];
			},
			admit: async () => {},
			record: async () => {},
			validateDestination: async () => {},
		}),
	});
	beforeAll(async () => {
		storage = await createAccountTestDatabase();
		await storage.pool.query(
			'INSERT INTO "user"(id,name,email) VALUES ($1,$2,$3),($4,$5,$6)',
			[
				first,
				"First",
				`${first}@test.invalid`,
				second,
				"Second",
				`${second}@test.invalid`,
			],
		);
	});
	afterAll(async () => {
		await storage?.close();
	});
	const record = async (row: {
		agentId: string | null;
		connectionId: string;
		origin: "agent" | "dashboard" | null;
		agent?: string;
		method?: string;
		outcome?: string;
		createdAt?: string;
	}) => {
		const id = randomUUID();
		await storage.pool.query(
			`INSERT INTO activity (id,"ownerId",agent,connection,"agentId","connectionId",origin,method,target,outcome,"durationMs","createdAt")
            VALUES ($1,$2,$3,'Fixture',$4,$5,$6,$7,'read',$8,1,$9)`,
			[
				id,
				first,
				row.agent ?? "Fixture agent",
				row.agentId,
				row.connectionId,
				row.origin,
				row.method ?? "tools/call",
				row.outcome ?? "forwarded",
				row.createdAt ?? new Date().toISOString(),
			],
		);
		return id;
	};
	it("does not contact the provider or create permissions while deriving incomplete steps", async () => {
		const service = createSetupService(dependencies());
		const initial = await service.status(actor);
		expect(initial.status).toBe("active");
		expect(initial.completed).toEqual({
			connect: false,
			agent: false,
			access: false,
			verify: false,
			call: false,
		});
		const saved = await service.save(actor, baseInput);
		expect(saved.completed).toEqual({
			connect: true,
			agent: true,
			access: false,
			verify: false,
			call: false,
		});
		expect(catalogRequests).toBe(0);
		await expect(
			service.save(actor, { ...baseInput, action: "finish" }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		await expect(service.verify(actor, baseInput)).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
	});
	it("persists skip and resume through typed HTTP with independent user scope", async () => {
		const router = createSetupRouter(dependencies());
		const handler = new RPCHandler(router);
		const client = (current: Actor) =>
			createORPCClient<RouterClient<typeof router>>(
				new RPCLink({
					url: "http://setup.test/api/rpc",
					fetch: async (request) =>
						(
							await handler.handle(new Request(request), {
								prefix: "/api/rpc",
								context: { actor: current },
							})
						).response ?? new Response("Not found", { status: 404 }),
				}),
			);
		await client(actor).saveSetup({
			...baseInput,
			step: "agent",
			action: "skip",
		});
		expect((await client(actor).setupStatus()).status).toBe("skipped");
		expect((await client(other).setupStatus()).status).toBe("active");
		const reconstructed = createSetupService(dependencies());
		expect((await reconstructed.status(actor)).step).toBe("agent");
		await client(actor).saveSetup({
			...baseInput,
			step: "agent",
			action: "resume",
		});
		expect((await reconstructed.status(actor)).status).toBe("active");
		expect(catalogRequests).toBe(0);
	});
	it("lists only the caller's usable agents for the step 2 poll, without deriving progress", async () => {
		const router = createSetupRouter(dependencies());
		const handler = new RPCHandler(router);
		const client = (current: Actor) =>
			createORPCClient<RouterClient<typeof router>>(
				new RPCLink({
					url: "http://setup.test/api/rpc",
					fetch: async (request) =>
						(
							await handler.handle(new Request(request), {
								prefix: "/api/rpc",
								context: { actor: current },
							})
						).response ?? new Response("Not found", { status: 404 }),
				}),
			);
		expect(await client(actor).setupAgents()).toEqual({ agentIds: ["agent"] });
		expect(await client(other).setupAgents()).toEqual({ agentIds: [] });
		await expect(
			client({ userId: randomUUID(), scopeId: first }).setupAgents(),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		revoked = true;
		expect(await client(actor).setupAgents()).toEqual({ agentIds: [] });
		revoked = false;
		expect(catalogRequests).toBe(0);
	});
	it("rejects foreign record selections and derives verification only from an explicit catalog check", async () => {
		const service = createSetupService(dependencies());
		await expect(service.save(other, baseInput)).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		await expect(
			service.save(actor, { ...baseInput, connectionId: "foreign" }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		allowed = true;
		const before = await service.status(actor);
		expect(before.completed.access).toBe(true);
		expect(before.completed.verify).toBe(false);
		expect(catalogRequests).toBe(0);
		const verified = await service.verify(actor, baseInput);
		expect(verified.completed.verify).toBe(true);
		expect(catalogRequests).toBe(1);
		expect(
			(await createSetupService(dependencies()).status(actor)).verifiedAt,
		).toBe(verified.verifiedAt);
		// Only a forwarded tools/call the selected agent sent on the selected connection counts.
		await record({
			agentId: "agent",
			connectionId: "connection",
			origin: "agent",
			method: "tools/list",
		});
		await record({
			agentId: "agent",
			connectionId: "connection",
			origin: "dashboard",
			agent: "Dashboard test / Fixture agent",
		});
		await record({
			agentId: "other",
			connectionId: "connection",
			origin: "agent",
		});
		await record({ agentId: "agent", connectionId: "other", origin: "agent" });
		await record({
			agentId: "agent",
			connectionId: "connection",
			origin: "agent",
			outcome: "denied",
		});
		await record({ agentId: null, connectionId: "connection", origin: null });
		expect((await service.status(actor)).completed).toMatchObject({
			verify: true,
			call: false,
		});
		await expect(
			service.save(actor, { ...baseInput, action: "finish" }),
		).rejects.toMatchObject({
			code: "BAD_REQUEST",
			message:
				"Complete the connection, agent, access, verification and first-call steps first.",
		});
		// A call the provider failed counts, marked as failed, until one succeeds.
		const failed = await record({
			agentId: "agent",
			connectionId: "connection",
			origin: "agent",
			outcome: "upstream_error",
			createdAt: "2025-12-31T00:00:00Z",
		});
		expect((await service.status(actor)).firstCall).toMatchObject({
			id: failed,
			failed: true,
		});
		await record({
			agentId: "agent",
			connectionId: "connection",
			origin: "agent",
			createdAt: "2026-01-02T00:00:00Z",
		});
		const earliest = await record({
			agentId: "agent",
			connectionId: "connection",
			origin: "agent",
			createdAt: "2026-01-01T00:00:00Z",
		});
		const called = await service.status(actor);
		expect(called.completed).toMatchObject({ verify: true, call: true });
		expect(called.firstCall).toEqual({
			id: earliest,
			target: "read",
			createdAt: "2026-01-01T00:00:00.000Z",
			failed: false,
		});
		// The poll reads the stored selection and writes nothing.
		const router = createSetupRouter(dependencies());
		const handler = new RPCHandler(router);
		const client = (current: Actor) =>
			createORPCClient<RouterClient<typeof router>>(
				new RPCLink({
					url: "http://setup.test/api/rpc",
					fetch: async (request) =>
						(
							await handler.handle(new Request(request), {
								prefix: "/api/rpc",
								context: { actor: current },
							})
						).response ?? new Response("Not found", { status: 404 }),
				}),
			);
		const progress = async () =>
			(
				await storage.pool.query(
					'SELECT * FROM setup_progress WHERE "userId"=$1',
					[first],
				)
			).rows;
		const stored = await progress();
		expect(await client(actor).setupFirstCall()).toEqual({
			firstCall: called.firstCall,
		});
		expect(await client(other).setupFirstCall()).toEqual({ firstCall: null });
		await expect(
			client({ userId: randomUUID(), scopeId: first }).setupFirstCall(),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(await progress()).toEqual(stored);
		expect(
			(await service.save(actor, { ...baseInput, action: "finish" })).status,
		).toBe("finished");
		revision = "two";
		expect((await service.status(actor)).completed.verify).toBe(false);
		await expect(
			service.save(actor, { ...baseInput, action: "finish" }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		revoked = true;
		expect((await service.status(actor)).completed.agent).toBe(false);
		expect((await service.status(actor)).completed.access).toBe(false);
	});
	it("treats a persisted deleted agent or device selection as unselected", async () => {
		revoked = false;
		deleted = false;
		const service = createSetupService(dependencies());
		await service.save(actor, baseInput);
		deleted = true;
		const state = await createSetupService(dependencies()).status(actor);
		expect(state.agentId).toBeUndefined();
		expect(state.completed.agent).toBe(false);
		expect(state.completed.access).toBe(false);
		expect(state.completed.verify).toBe(false);
		expect(state.verifiedAt).toBeNull();
	});
	it("can skip stale selections without retaining inaccessible identifiers", async () => {
		const service = createSetupService(dependencies());
		const skipped = await service.save(actor, {
			...baseInput,
			connectionId: "removed",
			agentId: "revoked",
			action: "skip",
		});
		expect(skipped.status).toBe("skipped");
		expect(skipped.connectionId).toBeUndefined();
		expect(skipped.agentId).toBeUndefined();
		expect((await service.status(actor)).status).toBe("skipped");
	});
});
