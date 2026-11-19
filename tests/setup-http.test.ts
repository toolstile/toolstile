import { randomUUID } from "node:crypto";
import {
	Client,
	StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { createClient } from "@toolstile/api/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SetupRouter } from "../apps/web/src/server/setup";
import {
	createORPCClient,
	type RouterClient,
	RPCLink,
} from "../apps/web/test-support/setup-rpc";
import { digest, issueToken } from "../packages/auth/src/index";
import { alias } from "../packages/gateway/src/index";
import { startFixture } from "./fixture";

describe.skipIf(!process.env.TEST_BASE_URL)(
	"guided setup over authenticated HTTP",
	() => {
		const base = process.env.TEST_BASE_URL ?? "http://127.0.0.1:4310";
		let backend: typeof import("../apps/web/src/server/runtime");
		let cookie = "";
		let fixture: Awaited<ReturnType<typeof startFixture>>;
		const headers = () => ({ cookie, origin: base });
		const api = createClient(`${base}/api/rpc`, headers);
		const setup = createORPCClient<RouterClient<SetupRouter>>(
			new RPCLink({ url: `${base}/api/rpc`, headers }),
		);
		beforeAll(async () => {
			backend = await import("../apps/web/src/server/runtime");
			fixture = await startFixture();
			const token = issueToken(),
				email = `setup-${randomUUID()}@test.invalid`;
			await backend.pool.query(
				'INSERT INTO invitations(id,email,"expiresAt") VALUES($1,$2,$3)',
				[digest(token), email, new Date(Date.now() + 60000)],
			);
			const response = await fetch(`${base}/api/auth/sign-up/email`, {
				method: "POST",
				headers: { origin: base, "Content-Type": "application/json" },
				body: JSON.stringify({
					email,
					name: "Setup HTTP fixture",
					password: "Setup-HTTP-local-only-2026!",
					invitationToken: token,
				}),
			});
			expect(response.status).toBe(200);
			cookie = response.headers
				.getSetCookie()
				.map((value) => value.split(";")[0])
				.join("; ");
		});
		afterAll(async () => {
			await fixture?.close();
			await backend?.pool.end();
		});
		it("persists skip/resume, verifies permitted catalogs without invoking tools and completes on the agent's first call", async () => {
			const connection = await api.addConnection({
				label: "Setup fixture",
				url: fixture.url,
				transport: "http",
				headers: {},
			});
			const device = await api.addDevice({ label: "Setup fixture" });
			const agent = await api.addAgent({
				label: "Setup fixture",
				deviceId: device.id,
				expiresInDays: 90,
			});
			const input = {
				client: "codex" as const,
				connectionId: connection.id,
				agentId: agent.id,
				step: "access" as const,
				action: "save" as const,
			};
			expect((await setup.saveSetup(input)).completed.access).toBe(false);
			await expect(setup.verifySetup(input)).rejects.toMatchObject({
				code: "FORBIDDEN",
			});
			expect(fixture.calls()).toBe(0);
			await setup.saveSetup({ ...input, action: "skip" });
			expect((await setup.setupStatus()).status).toBe("skipped");
			await setup.saveSetup({ ...input, action: "resume" });
			expect((await setup.setupStatus()).agentId).toBe(agent.id);
			await api.saveGrant({
				agentId: agent.id,
				connectionId: connection.id,
				rules: {
					full: false,
					allow: { tools: ["read_docs"], resources: [], prompts: [] },
					block: { tools: ["delete_note"], resources: [], prompts: [] },
				},
			});
			expect((await setup.setupStatus()).completed.access).toBe(true);
			expect((await setup.verifySetup(input)).completed.verify).toBe(true);
			expect(fixture.calls()).toBe(0);
			const reloaded = createORPCClient<RouterClient<SetupRouter>>(
				new RPCLink({ url: `${base}/api/rpc`, headers }),
			);
			expect((await reloaded.setupStatus()).completed.verify).toBe(true);
			await expect(
				api.testTool({ ...input, name: "delete_note", arguments: {} }),
			).rejects.toThrow();
			expect(fixture.calls()).toBe(0);
			// A dashboard tool test runs under the agent's access but is not its first call.
			await api.testTool({ ...input, name: "read_docs", arguments: {} });
			expect(fixture.calls()).toBe(1);
			expect(await setup.setupFirstCall()).toEqual({ firstCall: null });
			expect((await setup.setupStatus()).completed.call).toBe(false);
			await expect(
				setup.saveSetup({ ...input, step: "verify", action: "finish" }),
			).rejects.toMatchObject({ code: "BAD_REQUEST" });
			const client = new Client({ name: "setup-http-agent", version: "1" });
			try {
				await client.connect(
					new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
						requestInit: {
							headers: { Authorization: `Bearer ${agent.token}` },
						},
					}),
				);
				await client.listTools();
				await client.callTool({
					name: alias(connection.id, "read_docs"),
					arguments: {},
				});
			} finally {
				await client.close();
			}
			expect(fixture.calls()).toBe(2);
			const { rows } = await backend.pool.query<{
				id: string;
				agent: string;
				agentId: string | null;
				connectionId: string | null;
				origin: string | null;
				method: string;
				outcome: string;
			}>(
				`SELECT id,agent,"agentId","connectionId",origin,method,outcome FROM activity WHERE "connectionId"=$1 AND method IN ('tools/list','tools/call') ORDER BY "createdAt",id`,
				[connection.id],
			);
			expect(rows).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						agent: "Dashboard test / Setup fixture",
						agentId: agent.id,
						origin: "dashboard",
						method: "tools/call",
					}),
					expect.objectContaining({
						agent: "Setup fixture",
						agentId: agent.id,
						origin: "agent",
						method: "tools/call",
						outcome: "forwarded",
					}),
				]),
			);
			const agentCall = rows.find(
				(row) => row.origin === "agent" && row.method === "tools/call",
			);
			const { firstCall } = await setup.setupFirstCall();
			expect(firstCall).toMatchObject({
				id: agentCall?.id,
				target: "read_docs",
			});
			expect(await setup.setupStatus()).toMatchObject({
				completed: { verify: true, call: true },
				firstCall,
			});
			const activity = (await api.snapshot()).activity;
			expect(activity.find((entry) => entry.id === agentCall?.id)?.origin).toBe(
				"agent",
			);
			expect(
				activity.find(
					(entry) => entry.agent === "Dashboard test / Setup fixture",
				)?.origin,
			).toBe("dashboard");
			expect(
				(await setup.saveSetup({ ...input, step: "verify", action: "finish" }))
					.status,
			).toBe("finished");
			// A connection check runs under no agent.
			await api.verify({ id: connection.id });
			const checks = await backend.pool.query<{
				agentId: string | null;
				connectionId: string | null;
				origin: string | null;
			}>(
				`SELECT "agentId","connectionId",origin FROM activity WHERE "connectionId"=$1 AND agent='Dashboard'`,
				[connection.id],
			);
			expect(checks.rows.length).toBeGreaterThan(0);
			for (const row of checks.rows)
				expect(row).toEqual({
					agentId: null,
					connectionId: connection.id,
					origin: "dashboard",
				});
			await api.revokeAgent({ id: agent.id });
			expect((await setup.setupStatus()).completed.verify).toBe(false);
		});
	},
);
