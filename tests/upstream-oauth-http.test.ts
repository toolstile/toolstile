import { randomUUID } from "node:crypto";
import { createClient } from "@toolstile/api/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { digest, issueToken } from "../packages/auth/src/index";
import { defined } from "./assertions";
import { startOAuthHttpFixture } from "./oauth-http-fixture";

describe.skipIf(!process.env.TEST_BASE_URL)(
	"upstream OAuth browser callback and MCP forwarding",
	() => {
		const base = process.env.TEST_BASE_URL ?? "";
		let runtime: typeof import("../apps/web/src/server/runtime"),
			fixture: Awaited<ReturnType<typeof startOAuthHttpFixture>>,
			cookie = "",
			connectionId = "";
		const api = () =>
			createClient(`${base}/api/rpc`, () => ({ cookie, origin: base }));
		beforeAll(async () => {
			runtime = await import("../apps/web/src/server/runtime");
			fixture = await startOAuthHttpFixture();
			const token = issueToken(),
				email = `${randomUUID()}@test.invalid`;
			await runtime.pool.query(
				'insert into invitations(id,email,"expiresAt") values($1,$2,$3)',
				[digest(token), email, new Date(Date.now() + 60000)],
			);
			const signup = await fetch(`${base}/api/auth/sign-up/email`, {
				method: "POST",
				headers: { Origin: base, "Content-Type": "application/json" },
				body: JSON.stringify({
					email,
					name: "Upstream OAuth fixture",
					password: "Local-test-password-12345",
					invitationToken: token,
				}),
			});
			expect(signup.status).toBe(200);
			cookie = signup.headers
				.getSetCookie()
				.map((value) => value.split(";")[0])
				.join("; ");
		});
		afterAll(async () => {
			await fixture?.close();
			await runtime?.pool.end();
		});
		it("authenticates, verifies, refreshes and rejects a reused callback without exposing credentials", async () => {
			connectionId = (
				await api().addConnection({
					label: "OAuth-protected fixture",
					url: fixture.url,
					transport: "http",
					authentication: "oauth",
					headers: {},
				})
			).id;
			const status = async () =>
				(
					await runtime.pool.query(
						"select status from connections where id=$1",
						[connectionId],
					)
				).rows[0]?.status;
			// Checking tools before sign-in keeps the sign-in prompt instead of blaming the address.
			await expect(api().verify({ id: connectionId })).rejects.toThrow(
				/Sign in/,
			);
			expect(await status()).toBe("authentication required");
			const { url } = await api().startConnectionOAuth({ id: connectionId });
			const provider = await fetch(url, { redirect: "manual" });
			expect(provider.status).toBe(302);
			const callback = defined(provider.headers.get("location"));
			const response = await fetch(callback, {
				headers: { cookie },
				redirect: "manual",
			});
			expect(response.status).toBe(302);
			// The dashboard highlights the signed-in connection; provider code and state stay behind.
			expect(response.headers.get("location")).toBe(
				`/app/connections?oauth=connected&oauthConnection=${connectionId}`,
			);
			expect(response.headers.get("cache-control")).toBe("no-store");
			expect((await api().verify({ id: connectionId })).tools).toContain(
				"read_docs",
			);
			expect(fixture.exchanges()).toBe(1);
			expect(await status()).toBe("authenticated");
			const {
				rows: [grant],
			} = await runtime.pool.query(
				'select g.id,g."encryptedData" from upstream_oauth_grants g join connection_oauth c on c."grantId"=g.id where c."connectionId"=$1',
				[connectionId],
			);
			const { secretBox } = await import("../packages/auth/src/index");
			const box = secretBox(defined(process.env.ENCRYPTION_KEY));
			const data = box.decrypt<Record<string, unknown>>(grant.encryptedData);
			data.expiresAt = Date.now() - 1;
			await runtime.pool.query(
				'update upstream_oauth_grants set "encryptedData"=$2 where id=$1',
				[grant.id, box.encrypt(data)],
			);
			expect((await api().verify({ id: connectionId })).tools).toContain(
				"read_docs",
			);
			expect(fixture.exchanges()).toBe(2);
			const reused = await fetch(callback, {
				headers: { cookie },
				redirect: "manual",
			});
			expect(reused.headers.get("location")).toBe(
				"/app/connections?oauth=failed",
			);
			expect(fixture.exchanges()).toBe(2);
			const snapshot = JSON.stringify(await api().snapshot());
			expect(snapshot).not.toContain("access_token");
			expect(snapshot).not.toContain("refresh_token");
			expect(snapshot).not.toContain("encryptedData");
			await api().removeConnection({ id: connectionId });
			expect(
				(
					await runtime.pool.query(
						"select id from upstream_oauth_grants where id=$1",
						[grant.id],
					)
				).rows,
			).toHaveLength(0);
		});
	},
);
