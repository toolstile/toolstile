import { randomUUID } from "node:crypto";
import { createClient } from "@toolstile/api/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SetupRouter } from "../apps/web/src/server/setup";
import {
	createORPCClient,
	type RouterClient,
	RPCLink,
} from "../apps/web/test-support/setup-rpc";
import { digest, issueToken } from "../packages/auth/src/index";
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
		it("persists skip/resume and verifies permitted catalogs without invoking tools", async () => {
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
			expect(
				(await setup.saveSetup({ ...input, step: "verify", action: "finish" }))
					.status,
			).toBe("finished");
			await expect(
				api.testTool({ ...input, name: "delete_note", arguments: {} }),
			).rejects.toThrow();
			expect(fixture.calls()).toBe(0);
			await api.testTool({ ...input, name: "read_docs", arguments: {} });
			expect(fixture.calls()).toBe(1);
			await api.revokeAgent({ id: agent.id });
			expect((await setup.setupStatus()).completed.verify).toBe(false);
		});
	},
);
