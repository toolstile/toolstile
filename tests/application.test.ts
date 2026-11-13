import { randomUUID } from "node:crypto";
import {
	Client,
	StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { createClient } from "@toolstile/api/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { digest, issueToken } from "../packages/auth/src/index";
import { alias } from "../packages/gateway/src/index";
import { startFixture } from "./fixture";
import { modernFixture } from "./modern-fixture";
import { serveFixture, startSessionFixture } from "./session-fixture";

describe.skipIf(!process.env.TEST_BASE_URL)(
	"HTTP authentication and user isolation",
	() => {
		const base = process.env.TEST_BASE_URL ?? "";
		let runtime: typeof import("../apps/web/src/server/runtime");
		let cookie = "",
			otherCookie = "";
		const email = `${randomUUID()}@test.invalid`,
			other = `${randomUUID()}@test.invalid`;
		beforeAll(async () => {
			runtime = await import("../apps/web/src/server/runtime");
		});
		afterAll(async () => {
			await runtime?.pool.end();
		});
		async function signup(email: string, invited = true) {
			const token = issueToken();
			if (invited)
				await runtime.pool.query(
					'insert into invitations(id,email,"expiresAt") values($1,$2,$3)',
					[digest(token), email, new Date(Date.now() + 60000)],
				);
			return fetch(`${base}/api/auth/sign-up/email`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Origin: base },
				body: JSON.stringify({
					email,
					name: "Test user",
					password: "Local-test-password-12345",
					invitationToken: token,
				}),
			});
		}
		const api = () =>
			createClient(`${base}/api/rpc`, () => ({ cookie, origin: base }));
		it("rejects registration without an invitation and anonymous management", async () => {
			expect((await signup(`${randomUUID()}@test.invalid`, false)).status).toBe(
				403,
			);
			// Catalog loaders, such as the access editor's starter selections, need a session too.
			for (const [path, body] of [
				["snapshot", {}],
				[
					"connectorStarters",
					{ json: { url: "https://mcp.example.test/mcp" } },
				],
			] as const)
				expect(
					(
						await fetch(`${base}/api/rpc/${path}`, {
							method: "POST",
							headers: { Origin: base, "Content-Type": "application/json" },
							body: JSON.stringify(body),
						})
					).status,
					path,
				).toBe(401);
		});
		it("creates invited users and scopes CRUD to the signed-in account", async () => {
			const a = await signup(email);
			expect(a.status).toBe(200);
			cookie = a.headers
				.getSetCookie()
				.map((c) => c.split(";")[0])
				.join("; ");
			const b = await signup(other);
			expect(b.status).toBe(200);
			otherCookie = b.headers
				.getSetCookie()
				.map((c) => c.split(";")[0])
				.join("; ");
			const connection = await api().addConnection({
				label: "Private fixture",
				url: "http://127.0.0.1:9999/mcp",
				transport: "http",
				headers: { Authorization: "Bearer hidden" },
			});
			expect(
				(await api().snapshot()).connections.some(
					(c) => c.id === connection.id,
				),
			).toBe(true);
			const otherApi = createClient(`${base}/api/rpc`, () => ({
				cookie: otherCookie,
				origin: base,
			}));
			expect((await otherApi.snapshot()).connections).toEqual([]);
			await expect(
				otherApi.removeConnection({ id: connection.id }),
			).rejects.toThrow();
			expect(JSON.stringify(await api().snapshot())).not.toContain("hidden");
		});
		it("issues independently expiring agents with no default grants", async () => {
			const device = await api().addDevice({ label: "Test device" });
			const agent = await api().addAgent({
				label: "Test agent",
				deviceId: device.id,
				expiresInDays: 90,
			});
			expect(agent.token).toMatch(/^ts_/);
			const snapshot = await api().snapshot();
			expect(snapshot.grants).toEqual([]);
			expect(JSON.stringify(snapshot)).not.toContain(agent.token);
			await api().revokeAgent({ id: agent.id });
			expect(
				(await api().snapshot()).agents.some((a) => a.id === agent.id),
			).toBe(false);
			const response = await fetch(`${base}/mcp`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${agent.token}`,
					"Content-Type": "application/json",
				},
				body: "{}",
			});
			expect(response.status).toBe(401);
		});
		it("deletes a device, all agents and grants while preserving activity labels", async () => {
			const device = await api().addDevice({ label: "Delete cascade" });
			const connection = await api().addConnection({
				url: "http://127.0.0.1:9999/mcp",
				transport: "http",
			});
			const agents = await Promise.all(
				["First", "Second"].map((label) =>
					api().addAgent({ label, deviceId: device.id, expiresInDays: null }),
				),
			);
			for (const agent of agents)
				await api().saveGrant({
					agentId: agent.id,
					connectionId: connection.id,
					rules: {
						full: true,
						allow: { tools: [], resources: [], prompts: [] },
						block: { tools: [], resources: [], prompts: [] },
					},
				});
			const {
				rows: [owner],
			} = await runtime.pool.query(
				'select "ownerId" from devices where id=$1',
				[device.id],
			);
			const eventId = randomUUID();
			await runtime.pool.query(
				'insert into activity(id,"ownerId",agent,connection,method,outcome,"durationMs") values($1,$2,$3,$4,$5,$6,1)',
				[
					eventId,
					owner.ownerId,
					"First",
					"Cascade fixture",
					"tools/list",
					"success",
				],
			);
			const outsider = createClient(`${base}/api/rpc`, () => ({
				cookie: otherCookie,
				origin: base,
			}));
			await expect(
				outsider.revokeAgent({ id: agents[0].id }),
			).rejects.toThrow();
			await expect(outsider.revokeDevice({ id: device.id })).rejects.toThrow(
				"Unavailable or access denied",
			);
			await expect(api().revokeDevice({ id: randomUUID() })).rejects.toThrow(
				"Unavailable or access denied",
			);
			expect(
				(await api().snapshot()).devices.some((d) => d.id === device.id),
			).toBe(true);
			await api().revokeDevice({ id: device.id });
			const after = await api().snapshot();
			expect(after.devices.some((d) => d.id === device.id)).toBe(false);
			expect(after.agents.some((a) => a.deviceId === device.id)).toBe(false);
			expect(after.activity.find((e) => e.id === eventId)?.agent).toBe("First");
			for (const agent of agents) {
				for (const [table, key] of [
					["agents", "id"],
					["authorizations", "agentId"],
					["grants", "agentId"],
				])
					expect(
						(
							await runtime.pool.query(
								`select id from "${table}" where "${key}"=$1`,
								[agent.id],
							)
						).rows,
					).toEqual([]);
				expect(
					(
						await fetch(`${base}/mcp`, {
							method: "POST",
							headers: {
								Authorization: `Bearer ${agent.token}`,
								"Content-Type": "application/json",
							},
							body: "{}",
						})
					).status,
				).toBe(401);
			}
			await api().removeConnection({ id: connection.id });
		});
		it("renames owned devices and agents and rejects other users and invalid labels", async () => {
			const device = await api().addDevice({ label: "Rename device" });
			const agent = await api().addAgent({
				label: "Rename agent",
				deviceId: device.id,
				expiresInDays: 90,
			});
			const otherApi = createClient(`${base}/api/rpc`, () => ({
				cookie: otherCookie,
				origin: base,
			}));
			await expect(
				otherApi.renameDevice({ id: device.id, label: "Stolen" }),
			).rejects.toThrow();
			await expect(
				otherApi.renameAgent({ id: agent.id, label: "Stolen" }),
			).rejects.toThrow();
			await expect(
				api().renameDevice({ id: device.id, label: "   " }),
			).rejects.toThrow();
			await expect(
				api().renameAgent({ id: agent.id, label: "x".repeat(101) }),
			).rejects.toThrow();
			expect(
				await api().renameDevice({ id: device.id, label: "  Laptop  " }),
			).toEqual({ ok: true });
			expect(
				await api().renameAgent({ id: agent.id, label: "  Editor  " }),
			).toEqual({ ok: true });
			const snapshot = await api().snapshot();
			expect(snapshot.devices.find((d) => d.id === device.id)?.label).toBe(
				"Laptop",
			);
			expect(snapshot.agents.find((a) => a.id === agent.id)?.label).toBe(
				"Editor",
			);
			await api().revokeDevice({ id: device.id });
			await expect(
				api().renameDevice({ id: device.id, label: "Revoked" }),
			).rejects.toThrow();
		});
		it("rejects cross-origin management mutations", async () => {
			const response = await fetch(`${base}/api/rpc/addDevice`, {
				method: "POST",
				headers: {
					cookie,
					Origin: "https://other.invalid",
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ json: { label: "forbidden" } }),
			});
			expect(response.status).toBe(403);
		});
		it("routes real HTTP MCP traffic and enforces explicit blocks", async () => {
			const fixture = await startFixture();
			const client = new Client({ name: "http-test-agent", version: "1" });
			try {
				const connection = await api().addConnection({
					label: "HTTP fixture",
					url: process.env.TEST_UPSTREAM_HOST
						? fixture.url.replace("127.0.0.1", process.env.TEST_UPSTREAM_HOST)
						: fixture.url,
					transport: "http",
					headers: {},
				});
				const device = await api().addDevice({ label: "HTTP test device" });
				const agent = await api().addAgent({
					label: "HTTP test agent",
					deviceId: device.id,
					expiresInDays: 90,
				});
				await api().saveGrant({
					agentId: agent.id,
					connectionId: connection.id,
					rules: {
						full: true,
						allow: { tools: [], resources: [], prompts: [] },
						block: { tools: ["delete_note"], resources: [], prompts: [] },
					},
				});
				await client.connect(
					new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
						requestInit: {
							headers: { Authorization: `Bearer ${agent.token}` },
						},
					}),
				);
				expect((await client.listTools()).tools.map((t) => t.name)).toEqual([
					"search_catalog",
					"get_catalog_entry",
					"get_my_access",
					"http_fixture__read_docs",
					"http_fixture__write_note",
				]);
				// A legacy alias a client cached keeps reaching its own connection.
				for (const name of [
					"http_fixture__read_docs",
					alias(connection.id, "read_docs"),
				])
					expect(
						(await client.callTool({ name, arguments: {} })).content,
					).toEqual([
						{ type: "text", text: "read_docs: local fixture success" },
					]);
				for (const name of [
					"http_fixture__delete_note",
					alias(connection.id, "delete_note"),
				])
					await expect(
						client.callTool({ name, arguments: {} }),
					).rejects.toThrow();
				expect(fixture.calls()).toBe(2);
				expect(
					(
						await api().agentCatalog({
							agentId: agent.id,
							connectionId: connection.id,
						})
					).tools.map((tool) => tool.name),
				).toEqual(["read_docs", "write_note"]);
				const test = await api().testTool({
					agentId: agent.id,
					connectionId: connection.id,
					name: "read_docs",
					arguments: { text: "Do not store this payload" },
				});
				expect(test).toMatchObject({ isError: false, truncated: false });
				expect(test.preview).toContain("read_docs: local fixture success");
				expect(fixture.calls()).toBe(3);
				await expect(
					api().testTool({
						agentId: agent.id,
						connectionId: connection.id,
						name: "delete_note",
						arguments: {},
					}),
				).rejects.toThrow();
				expect(fixture.calls()).toBe(3);
				const outsider = createClient(`${base}/api/rpc`, () => ({
					cookie: otherCookie,
					origin: base,
				}));
				await expect(
					outsider.agentCatalog({
						agentId: agent.id,
						connectionId: connection.id,
					}),
				).rejects.toThrow();
				expect(JSON.stringify(await api().snapshot())).not.toContain(
					"Do not store this payload",
				);
				await api().revokeAgent({ id: agent.id });
				await expect(
					api().agentCatalog({
						agentId: agent.id,
						connectionId: connection.id,
					}),
				).rejects.toThrow();
				await expect(
					api().testTool({
						agentId: agent.id,
						connectionId: connection.id,
						name: "read_docs",
						arguments: {},
					}),
				).rejects.toThrow();
				expect(fixture.calls()).toBe(3);
				await expect(client.listTools()).rejects.toThrow();
			} finally {
				await client.close();
				await fixture.close();
			}
		});
		it("streams nested agent interactions and resource subscriptions through the HTTP application", async () => {
			const fixture = await startSessionFixture();
			const client = new Client(
				{ name: "interactive-http-agent", version: "1" },
				{
					capabilities: { roots: {}, sampling: {}, elicitation: { form: {} } },
				},
			);
			client.setRequestHandler("roots/list", async () => ({
				roots: [{ uri: "file:///http-agent" }],
			}));
			client.setRequestHandler("sampling/createMessage", async () => ({
				role: "assistant",
				model: "http-agent",
				content: { type: "text", text: "http sampling response" },
			}));
			client.setRequestHandler("elicitation/create", async () => ({
				action: "decline",
			}));
			const updates: string[] = [];
			client.setNotificationHandler(
				"notifications/resources/updated",
				(notification) => {
					updates.push(notification.params.uri);
				},
			);
			try {
				const connection = await api().addConnection({
					label: "Interactive HTTP fixture",
					url: fixture.url,
					transport: "http",
					headers: {},
				});
				const device = await api().addDevice({ label: "Interactive device" });
				const agent = await api().addAgent({
					label: "Interactive agent",
					deviceId: device.id,
					expiresInDays: 90,
				});
				await api().saveGrant({
					agentId: agent.id,
					connectionId: connection.id,
					rules: {
						full: true,
						allow: { tools: [], resources: [], prompts: [] },
						block: { tools: [], resources: [], prompts: [] },
					},
				});
				const transport = new StreamableHTTPClientTransport(
					new URL(`${base}/mcp`),
					{
						requestInit: {
							headers: { Authorization: `Bearer ${agent.token}` },
						},
					},
				);
				await client.connect(transport);
				expect(transport.sessionId).toBeTruthy();
				const result = await client
					.callTool({
						name: alias(connection.id, "interactive"),
						arguments: {},
					})
					.catch((error) => {
						throw new Error(
							`${error.message}; upstream headers ${JSON.stringify(fixture.requests)}`,
						);
					});
				expect(JSON.stringify(result)).toContain("http sampling response");
				expect(fixture.callbacks).toEqual(["decline"]);
				const uri = `toolstile://${connection.id}/${Buffer.from("docs://one").toString("base64url")}`;
				await client.subscribeResource({ uri });
				await fixture.publish();
				await vi.waitFor(() => expect(updates).toEqual([uri]), {
					timeout: 2000,
				});
				await client.unsubscribeResource({ uri });
				expect(fixture.upstreams.every((entry) => !entry.subscribed.size)).toBe(
					true,
				);
				await api().revokeDevice({ id: device.id });
				await expect(client.listTools()).rejects.toThrow();
			} finally {
				await client.close();
				await fixture.close();
			}
		});
		it("negotiates modern HTTP and completes multiple input rounds without replaying the operation", async () => {
			const source = modernFixture(),
				http = await serveFixture(source.request);
			const client = new Client(
				{ name: "modern-http-agent", version: "1" },
				{
					versionNegotiation: { mode: { pin: "2026-07-28" } },
					capabilities: { roots: {}, sampling: {}, elicitation: { form: {} } },
				},
			);
			client.setRequestHandler("roots/list", async () => ({
				roots: [{ uri: "file:///modern-http-agent" }],
			}));
			client.setRequestHandler("sampling/createMessage", async () => ({
				role: "assistant",
				model: "local",
				content: { type: "text", text: "modern HTTP sample" },
			}));
			client.setRequestHandler("elicitation/create", async () => ({
				action: "decline",
			}));
			try {
				const connection = await api().addConnection({
					label: "Modern HTTP fixture",
					url: http.url,
					transport: "http",
					headers: {},
				});
				const device = await api().addDevice({ label: "Modern HTTP device" });
				const agent = await api().addAgent({
					label: "Modern HTTP agent",
					deviceId: device.id,
					expiresInDays: 90,
				});
				await api().saveGrant({
					agentId: agent.id,
					connectionId: connection.id,
					rules: {
						full: true,
						allow: { tools: [], resources: [], prompts: [] },
						block: { tools: [], resources: [], prompts: [] },
					},
				});
				const transport = new StreamableHTTPClientTransport(
					new URL(`${base}/mcp`),
					{
						requestInit: {
							headers: { Authorization: `Bearer ${agent.token}` },
						},
					},
				);
				await client.connect(transport);
				expect(transport.sessionId).toBeUndefined();
				const result = await client.callTool({
					name: alias(connection.id, "interactive"),
					arguments: {},
				});
				expect(JSON.stringify(result)).toContain("file:///modern-http-agent");
				expect(JSON.stringify(result)).toContain("modern HTTP sample");
				expect(JSON.stringify(result)).toContain("decline");
				expect(source.starts()).toBe(1);
				const calls = source.calls.filter(
					(call) => call.method === "tools/call",
				);
				expect(calls).toHaveLength(3);
				expect(new Set(calls.map((call) => call.id)).size).toBe(3);
				await api().revokeAgent({ id: agent.id });
				await expect(client.listTools()).rejects.toThrow();
			} finally {
				await client.close();
				await http.close();
			}
		});
	},
);
