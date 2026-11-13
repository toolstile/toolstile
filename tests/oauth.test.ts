import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createClient } from "@toolstile/api/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { digest, issueToken } from "../packages/auth/src/index";
import { defined } from "./assertions";

describe.skipIf(!process.env.TEST_BASE_URL)(
	"agent OAuth PKCE and live revocation",
	() => {
		const base = process.env.TEST_BASE_URL ?? "";
		let runtime: typeof import("../apps/web/src/server/runtime");
		let cookie = "";
		beforeAll(async () => {
			runtime = await import("../apps/web/src/server/runtime");
			const invitation = issueToken(),
				email = `${randomUUID()}@test.invalid`;
			await runtime.pool.query(
				'insert into invitations(id,email,"expiresAt") values($1,$2,$3)',
				[digest(invitation), email, new Date(Date.now() + 60000)],
			);
			const response = await fetch(`${base}/api/auth/sign-up/email`, {
				method: "POST",
				headers: { Origin: base, "Content-Type": "application/json" },
				body: JSON.stringify({
					email,
					name: "OAuth test",
					password: "Local-test-password-12345",
					invitationToken: invitation,
				}),
			});
			expect(response.status).toBe(200);
			cookie = response.headers
				.getSetCookie()
				.map((c) => c.split(";")[0])
				.join("; ");
		});
		afterAll(async () => {
			await runtime?.pool.end();
		});
		const browser = (path: string, body: unknown) =>
			fetch(`${base}${path}`, {
				method: "POST",
				headers: { cookie, Origin: base, "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
		const api = () =>
			createClient(`${base}/api/rpc`, () => ({ cookie, origin: base }));

		async function consentFlow(
			clientName: string | null = "Detected editor",
			extra: Record<string, string> = {},
		) {
			const registered = await browser("/api/auth/oauth2/register", {
				...(clientName ? { client_name: clientName } : {}),
				redirect_uris: ["http://127.0.0.1:49150/callback"],
				token_endpoint_auth_method: "none",
				grant_types: ["authorization_code"],
				response_types: ["code"],
			});
			expect(registered.status).toBe(201);
			const client = await registered.json();
			const query = new URLSearchParams({
				client_id: client.client_id,
				redirect_uri: "http://127.0.0.1:49150/callback",
				response_type: "code",
				code_challenge_method: "S256",
				code_challenge: createHash("sha256")
					.update(randomBytes(32))
					.digest("base64url"),
				state: randomUUID(),
				scope: "mcp:access",
				resource: `${base}/mcp`,
				...extra,
			});
			const start = await fetch(`${base}/api/auth/oauth2/authorize?${query}`, {
				headers: { cookie, Accept: "text/html" },
				redirect: "manual",
			});
			expect([200, 302]).toContain(start.status);
			const location = new URL(
				start.headers.get("location") ?? (await start.json()).url,
				base,
			);
			return location.search.slice(1);
		}
		const consentGet = (query: string, headers: Record<string, string> = {}) =>
			fetch(
				`${base}/api/agent-oauth?${new URLSearchParams({ oauth_query: query })}`,
				{
					headers: { cookie, ...headers },
				},
			);
		it("suggests registered client names and unique active labels with platform and browser detection", async () => {
			const query = await consentFlow();
			const device = await api().addDevice({ label: "Mac · Chrome" });
			await api().addDevice({ label: "Mac · Chrome (2)" });
			for (const label of ["Detected editor", "Detected editor (2)"])
				await api().addAgent({ label, deviceId: device.id, expiresInDays: 90 });
			const response = await consentGet(query, {
				"sec-ch-ua-platform": '"macOS"',
				"user-agent": "Mozilla Chrome/140.0 Safari/537.36",
			});
			expect(response.status).toBe(200);
			expect(response.headers.get("cache-control")).toBe("no-store");
			expect((await response.json()).suggested).toEqual({
				clientName: "Detected editor",
				agentLabel: "Detected editor (3)",
				deviceLabel: "Mac · Chrome (3)",
				deviceId: null,
			});
			for (const [headers, expected] of [
				[
					{
						"sec-ch-ua-platform": '"Windows"',
						"user-agent": "Chrome/140 Safari/537 Edg/140",
					},
					"Windows · Edge",
				],
				[
					{
						"sec-ch-ua-platform": '"Linux"',
						"sec-ch-ua": '"Chromium";v="140"',
						"user-agent": "",
					},
					"Linux · Chrome",
				],
				[
					{
						"user-agent":
							"Mozilla/5.0 (iPhone; CPU iPhone OS 18_0) Version/18.0 Mobile/15 Safari/604.1",
					},
					"iPhone · Safari",
				],
				[
					{
						"sec-ch-ua-platform": '"iOS"',
						"user-agent": "Mozilla/5.0 (iPad) Safari/604",
					},
					"iPad · Safari",
				],
				[
					{
						"user-agent":
							"Mozilla/5.0 (Linux; Android 15) Chrome/140 Safari/537",
					},
					"Android · Chrome",
				],
				[
					{
						"user-agent":
							"Mozilla/5.0 (X11; CrOS x86_64) Chrome/140 Safari/537",
					},
					"ChromeOS · Chrome",
				],
				[
					{ "user-agent": "Mozilla/5.0 (X11; Linux) Firefox/140" },
					"Linux · Firefox",
				],
				[
					{
						"sec-ch-ua-platform": '"Chrome OS"',
						"sec-ch-ua": '"Chromium";v="140"',
						"user-agent": "",
					},
					"ChromeOS · Chrome",
				],
				[{ "user-agent": "" }, "Device"],
			] as [Record<string, string>, string][]) {
				expect(
					(await (await consentGet(query, headers)).json()).suggested
						.deviceLabel,
				).toBe(expected);
			}
			expect(
				(await consentGet(query.replace("sig=", "sig=invalid"))).status,
			).toBe(400);
		});
		it("falls back to Agent when client metadata has no name", async () => {
			const query = await consentFlow(null);
			expect((await (await consentGet(query)).json()).suggested).toMatchObject({
				clientName: null,
				agentLabel: "Agent",
				deviceId: null,
			});
		});
		it("automatically creates a device and agent and reuses the hashed browser binding", async () => {
			const query = await consentFlow();
			const before = await api().snapshot();
			const suggestion = (await (await consentGet(query)).json()).suggested;
			const response = await browser("/api/agent-oauth", {
				oauth_query: query,
			});
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({ ok: true });
			const setCookie = response.headers.get("set-cookie") ?? "";
			expect(setCookie).toContain("toolstile-device=");
			for (const attribute of [
				"Max-Age=31536000",
				"HttpOnly",
				"SameSite=Lax",
				"Path=/api/agent-oauth",
			])
				expect(setCookie).toContain(attribute);
			expect(/;\s*Secure(?:;|$)/i.test(setCookie)).toBe(
				new URL(base).protocol === "https:",
			);
			const binding = setCookie.split(";")[0] ?? "";
			const after = await api().snapshot();
			expect(after.devices).toHaveLength(before.devices.length + 1);
			expect(after.agents).toHaveLength(before.agents.length + 1);
			const agent = after.agents.find(
				(entry) => !before.agents.some((old) => old.id === entry.id),
			);
			expect(agent).toMatchObject({
				label: suggestion.agentLabel,
				expiresAt: null,
			});
			const device = after.devices.find(
				(entry) => entry.id === agent?.deviceId,
			);
			expect(device?.label).toBe(suggestion.deviceLabel);
			expect(binding).not.toContain(device?.id);
			const stored = await runtime.pool.query(
				'select "browserKeyHash" from devices where id=$1',
				[device?.id],
			);
			const token = binding.slice(binding.indexOf("=") + 1);
			expect(stored.rows[0].browserKeyHash).toBe(
				createHash("sha256").update(token).digest("hex"),
			);
			expect(JSON.stringify(after)).not.toContain(
				stored.rows[0].browserKeyHash,
			);
			const headers = { cookie: `${cookie}; ${binding}` };
			expect(
				(await (await consentGet(query, headers)).json()).suggested.deviceId,
			).toBe(device?.id);
			const reused = await fetch(`${base}/api/agent-oauth`, {
				method: "POST",
				headers: {
					...headers,
					Origin: base,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					oauth_query: await consentFlow(),
					agentLabel: "  Browser editor  ",
				}),
			});
			expect(reused.status).toBe(200);
			expect(reused.headers.get("set-cookie")).toBeNull();
			expect((await api().snapshot()).devices).toHaveLength(
				after.devices.length,
			);
			expect(
				(await api().snapshot()).agents.find(
					(a) => a.label === "Browser editor",
				)?.deviceId,
			).toBe(device?.id);
			await api().revokeDevice({ id: device?.id ?? "" });
			expect(
				(await api().snapshot()).devices.some((d) => d.id === device?.id),
			).toBe(false);
			expect(
				(
					await runtime.pool.query("select id from devices where id=$1", [
						device?.id,
					])
				).rows,
			).toEqual([]);
			expect(
				(
					await runtime.pool.query(
						'select id from agents where "deviceId"=$1',
						[device?.id],
					)
				).rows,
			).toEqual([]);

			expect(
				(await (await consentGet(query, headers)).json()).suggested.deviceId,
			).toBeNull();
		});
		it("names the device from a device_name added on the agent's machine, not the approving browser", async () => {
			const name = `Mac mini ${randomUUID().slice(0, 8)}`;
			const query = await consentFlow("Remote editor", {
				device_name: ` ${name}\u0007 `,
			});
			const local = await browser("/api/agent-oauth", {
				oauth_query: await consentFlow(),
			});
			const binding = (local.headers.get("set-cookie") ?? "").split(";")[0];
			const headers = { cookie: `${cookie}; ${binding}` };
			const suggested = (await (await consentGet(query, headers)).json())
				.suggested;
			expect(suggested).toMatchObject({ deviceLabel: name, deviceId: null });
			const approved = await fetch(`${base}/api/agent-oauth`, {
				method: "POST",
				headers: {
					...headers,
					Origin: base,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ oauth_query: query }),
			});
			expect(approved.status).toBe(200);
			// The approving browser keeps its own device binding.
			expect(approved.headers.get("set-cookie")).toBeNull();
			// The name survives re-signing for consent, where the page shows the remote command.
			const next = await browser("/api/auth/oauth2/continue", {
				oauth_query: query,
				postLogin: true,
			});
			const consentUrl = new URL((await next.json()).url, base);
			expect(consentUrl.searchParams.get("device_name")).toBe(
				` ${name}\u0007 `,
			);
			const consent = await browser("/api/auth/oauth2/consent", {
				oauth_query: consentUrl.search.slice(1),
				accept: true,
			});
			expect(new URL((await consent.json()).url).host).toBe("127.0.0.1:49150");
			const remote = (await api().snapshot()).devices.find(
				(device) => device.label === name,
			);
			expect(remote).toBeDefined();
			const again = await consentFlow("Remote editor", {
				device_name: name.toUpperCase(),
			});
			expect(
				(await (await consentGet(again, headers)).json()).suggested.deviceId,
			).toBe(remote?.id);
		});
		it("returns an OAuth refusal with unchanged state and retains the saved entry", async () => {
			const query = await consentFlow("Decline editor");
			expect((await browser("/api/agent-oauth", { oauth_query: query, newDevice: true, agentLabel: "Declined entry", deviceLabel: "Decline laptop" })).status).toBe(200);
			const next = await browser("/api/auth/oauth2/continue", { oauth_query: query, postLogin: true });
			expect(next.status).toBe(200);
			const consentQuery = new URL((await next.json()).url, base).search.slice(1);
			const response = await browser("/api/auth/oauth2/consent", { oauth_query: consentQuery, accept: false });
			expect(response.status).toBe(200);
			const callback = new URL((await response.json()).url);
			expect(callback.origin + callback.pathname).toBe("http://127.0.0.1:49150/callback");
			expect(callback.searchParams.get("error")).toBe("access_denied");
			expect(callback.searchParams.get("state")).toBe(new URLSearchParams(query).get("state"));
			expect(callback.searchParams.has("code")).toBe(false);
			const entry = (await api().snapshot()).agents.find((a) => a.label === "Declined entry");
			expect(entry).toBeDefined();
			await api().revokeDevice({ id: entry?.deviceId ?? "" });
		});
		it("returns the session-bound enrollment identity and reuses it on an explicit retry", async () => {
			const query = await consentFlow("Identity editor");
			const before = await api().snapshot();
			const enroll = () =>
				browser("/api/agent-oauth", {
					oauth_query: query,
					newDevice: true,
					agentLabel: "Chosen agent",
					deviceLabel: "Chosen laptop",
				});
			expect((await enroll()).status).toBe(200);
			const once = await api().snapshot();
			const context = await consentGet(query);
			expect(context.status).toBe(200);
			const identity = await context.json();
			expect(identity.account.email).toContain("@test.invalid");
			expect(identity.selected).toEqual({
				agentLabel: "Chosen agent",
				deviceLabel: "Chosen laptop",
			});
			expect((await enroll()).status).toBe(200);
			const retried = await api().snapshot();
			expect(once.agents.length).toBe(before.agents.length + 1);
			expect(retried.agents.length).toBe(once.agents.length);
			expect(retried.devices.length).toBe(once.devices.length);
			expect(
				(await consentGet(query.replace("sig=", "sig=invalid"))).status,
			).toBe(400);
			const agent = once.agents.find((entry) => entry.label === "Chosen agent");
			await api().revokeDevice({ id: agent?.deviceId ?? "" });
		});
		it("binds an explicitly selected owned device and preserves legacy agent reuse", async () => {
			const query = await consentFlow();
			const device = await api().addDevice({ label: "Existing laptop" });
			const before = await api().snapshot();
			const response = await browser("/api/agent-oauth", {
				oauth_query: query,
				deviceId: device.id,
				deviceLabel: "Ignored",
				agentLabel: "  Explicit editor  ",
			});
			expect(response.status).toBe(200);
			const binding = response.headers.get("set-cookie")?.split(";")[0] ?? "";
			expect(
				(
					await (
						await consentGet(query, { cookie: `${cookie}; ${binding}` })
					).json()
				).suggested.deviceId,
			).toBe(device.id);
			const after = await api().snapshot();
			expect(after.devices).toHaveLength(before.devices.length);
			const agent = after.agents.find((a) => a.label === "Explicit editor");
			expect(agent?.deviceId).toBe(device.id);
			const legacy = await browser("/api/agent-oauth", {
				oauth_query: query,
				agentId: agent?.id,
			});
			expect(legacy.status).toBe(200);
			expect(legacy.headers.get("set-cookie")).toBeNull();
			expect((await api().snapshot()).agents).toHaveLength(after.agents.length);
			await api().revokeDevice({ id: device.id });
			expect(
				(
					await browser("/api/agent-oauth", {
						oauth_query: query,
						deviceId: device.id,
					})
				).status,
			).toBe(400);
		});
		it("creates a new device on request even when this browser remembers one", async () => {
			const query = await consentFlow();
			const first = await browser("/api/agent-oauth", {
				oauth_query: query,
				deviceLabel: "Remembered laptop",
			});
			expect(first.status).toBe(200);
			const binding = first.headers.get("set-cookie")?.split(";")[0] ?? "";
			const remembered = (
				await (
					await consentGet(query, { cookie: `${cookie}; ${binding}` })
				).json()
			).suggested.deviceId;
			expect(remembered).toBeTypeOf("string");
			const second = await fetch(`${base}/api/agent-oauth`, {
				method: "POST",
				headers: {
					cookie: `${cookie}; ${binding}`,
					Origin: base,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					oauth_query: await consentFlow(),
					newDevice: true,
					deviceLabel: "Second laptop",
				}),
			});
			expect(second.status).toBe(200);
			const rebinding = second.headers.get("set-cookie")?.split(";")[0] ?? "";
			expect(rebinding).not.toBe("");
			const snapshot = await api().snapshot();
			const created = snapshot.devices.find((d) => d.label === "Second laptop");
			expect(created?.id).toBeTypeOf("string");
			expect(created?.id).not.toBe(remembered);
			expect(
				(
					await (
						await consentGet(query, { cookie: `${cookie}; ${rebinding}` })
					).json()
				).suggested.deviceId,
			).toBe(created?.id);
			for (const id of [remembered, created?.id])
				if (id) await api().revokeDevice({ id });
		});
		it("never reuses another user's browser binding or device", async () => {
			const query = await consentFlow();
			const created = await browser("/api/agent-oauth", {
				oauth_query: query,
				deviceLabel: "Private browser",
			});
			expect(created.status).toBe(200);
			const binding = created.headers.get("set-cookie")?.split(";")[0] ?? "";
			const own = (
				await (
					await consentGet(query, { cookie: `${cookie}; ${binding}` })
				).json()
			).suggested.deviceId;
			expect(own).toBeTypeOf("string");
			const email = `${randomUUID()}@test.invalid`;
			const invitation = issueToken();
			await runtime.pool.query(
				'insert into invitations(id,email,"expiresAt") values($1,$2,$3)',
				[digest(invitation), email, new Date(Date.now() + 60000)],
			);
			const signup = await fetch(`${base}/api/auth/sign-up/email`, {
				method: "POST",
				headers: { Origin: base, "Content-Type": "application/json" },
				body: JSON.stringify({
					email,
					name: "Other OAuth user",
					password: "Local-test-password-12345",
					invitationToken: invitation,
				}),
			});
			expect(signup.status).toBe(200);
			const otherCookie = signup.headers
				.getSetCookie()
				.map((entry) => entry.split(";")[0])
				.join("; ");
			const other = await fetch(
				`${base}/api/agent-oauth?${new URLSearchParams({ oauth_query: query })}`,
				{ headers: { cookie: `${otherCookie}; ${binding}` } },
			);
			expect(other.status).toBe(200);
			expect((await other.json()).suggested.deviceId).toBeNull();
			const denied = await fetch(`${base}/api/agent-oauth`, {
				method: "POST",
				headers: {
					cookie: `${otherCookie}; ${binding}`,
					Origin: base,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ oauth_query: query, deviceId: own }),
			});
			expect(denied.status).toBe(400);
			expect(
				(
					await (
						await consentGet(query, { cookie: `${cookie}; ${binding}` })
					).json()
				).suggested.deviceId,
			).toBe(own);
		});
		it("rejects malformed labels, origins and unowned device selections before creating records", async () => {
			const query = await consentFlow();
			const before = await api().snapshot();
			for (const body of [
				{ deviceId: randomUUID() },
				{ agentLabel: " " },
				{ deviceLabel: "x".repeat(101) },
				{ agentId: randomUUID() },
			])
				expect(
					(await browser("/api/agent-oauth", { oauth_query: query, ...body }))
						.status,
				).toBe(400);
			const wrongOrigin = await fetch(`${base}/api/agent-oauth`, {
				method: "POST",
				headers: {
					cookie,
					origin: "https://other.invalid",
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ oauth_query: query }),
			});
			expect(wrongOrigin.status).toBe(403);
			expect((await api().snapshot()).devices).toHaveLength(
				before.devices.length,
			);
			expect((await api().snapshot()).agents).toHaveLength(
				before.agents.length,
			);
		});
		it("discovers metadata and requires a resource-bound token", async () => {
			const metadata = await (
				await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)
			).json();
			expect(metadata.resource).toBe(`${base}/mcp`);
			// RFC 9728 §3: the suffix-less document would describe the origin itself.
			for (const path of ["", "/"])
				expect(
					(await fetch(`${base}/.well-known/oauth-protected-resource${path}`))
						.status,
				).toBe(404);
			const server = await (
				await fetch(`${base}/.well-known/oauth-authorization-server/api/auth`)
			).json();
			expect(server.issuer).toBe(`${base}/api/auth`);
			const response = await fetch(`${base}/mcp`, {
				method: "POST",
				body: "{}",
				headers: { "Content-Type": "application/json" },
			});
			expect(response.status).toBe(401);
			expect(response.headers.get("www-authenticate")).toContain(
				`resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`,
			);
		});
		it.each(["agent", "device"])(
			"binds PKCE, consent and refresh to deletion of an independent %s",
			async (kind) => {
				const clientResponse = await browser("/api/auth/oauth2/register", {
					client_name: "PKCE integration",
					redirect_uris: ["http://127.0.0.1:49150/callback"],
					token_endpoint_auth_method: "none",
					grant_types: ["authorization_code", "refresh_token"],
					response_types: ["code"],
				});
				expect(clientResponse.status).toBe(201);
				const client = await clientResponse.json();
				const verifier = randomBytes(32).toString("base64url");
				const query = new URLSearchParams({
					client_id: client.client_id,
					redirect_uri: "http://127.0.0.1:49150/callback",
					response_type: "code",
					code_challenge_method: "S256",
					code_challenge: createHash("sha256")
						.update(verifier)
						.digest("base64url"),
					state: randomUUID(),
					scope: "openid offline_access mcp:access",
					resource: `${base}/mcp`,
				});
				const start = await fetch(
					`${base}/api/auth/oauth2/authorize?${query}`,
					{
						headers: { cookie, Accept: "text/html" },
						redirect: "manual",
					},
				);
				expect([200, 302]).toContain(start.status);
				const selectionUrl = new URL(
					start.headers.get("location") ?? (await start.json()).url,
					base,
				);
				expect(selectionUrl.pathname).toBe("/authorize-agent");
				const signed = selectionUrl.search.slice(1);
				expect(
					(
						await browser("/api/agent-oauth", {
							oauth_query: signed.replace("sig=", "sig=invalid"),
							label: "forged",
						})
					).status,
				).toBe(400);
				const label = `OAuth agent ${randomUUID()}`;
				const selection = await browser("/api/agent-oauth", {
					oauth_query: signed,
					agentLabel: label,
					deviceLabel: "OAuth fixture",
				});
				expect(selection.status).toBe(200);
				const next = await browser("/api/auth/oauth2/continue", {
					oauth_query: signed,
					postLogin: true,
				});
				expect(next.status).toBe(200);
				const consentUrl = new URL((await next.json()).url, base);
				expect(consentUrl.pathname).toBe("/consent-agent");
				const consent = await browser("/api/auth/oauth2/consent", {
					oauth_query: consentUrl.search.slice(1),
					accept: true,
				});
				expect(consent.status).toBe(200);
				const callback = new URL((await consent.json()).url);
				expect(callback.searchParams.get("state")).toBe(query.get("state"));
				const code = defined(callback.searchParams.get("code"));
				async function exchange(body: Record<string, string>) {
					return fetch(`${base}/api/auth/oauth2/token`, {
						method: "POST",
						headers: { "Content-Type": "application/x-www-form-urlencoded" },
						body: new URLSearchParams({ client_id: client.client_id, ...body }),
					});
				}
				const tokenResponse = await exchange({
					grant_type: "authorization_code",
					code,
					code_verifier: verifier,
					redirect_uri: callback.origin + callback.pathname,
					resource: `${base}/mcp`,
				});
				expect(tokenResponse.status).toBe(200);
				const tokens = await tokenResponse.json();
				expect(tokens.refresh_token).toBeTypeOf("string");
				const claims = JSON.parse(
					Buffer.from(
						tokens.access_token.split(".")[1],
						"base64url",
					).toString(),
				);
				expect([claims.aud].flat()).toContain(`${base}/mcp`);
				expect(claims.toolstile_authorization).toBeTypeOf("string");
				const { Client, StreamableHTTPClientTransport } = await import(
					"@modelcontextprotocol/client"
				);
				const probe = await fetch(`${base}/mcp`, {
					method: "POST",
					headers: {
						Authorization: `Bearer ${tokens.access_token}`,
						"Content-Type": "application/json",
						Accept: "application/json, text/event-stream",
					},
					body: JSON.stringify({
						jsonrpc: "2.0",
						id: 1,
						method: "initialize",
						params: {
							protocolVersion: "2026-07-28",
							capabilities: {},
							clientInfo: { name: "test", version: "1" },
						},
					}),
				});
				expect(
					probe.status,
					JSON.stringify({
						body: await probe.text(),
						challenge: probe.headers.get("www-authenticate"),
						issuer: claims.iss,
					}),
				).toBe(200);
				const mcp = new Client({ name: "oauth-test", version: "1" });
				await mcp.connect(
					new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
						requestInit: {
							headers: { Authorization: `Bearer ${tokens.access_token}` },
						},
					}),
				);
				// No grants: only the built-in Toolstile tools.
				expect((await mcp.listTools()).tools.map((t) => t.name)).toEqual([
					"search_catalog",
					"get_catalog_entry",
					"get_my_access",
				]);
				const refreshed = await exchange({
					grant_type: "refresh_token",
					refresh_token: tokens.refresh_token,
					resource: `${base}/mcp`,
				});
				expect(refreshed.status).toBe(200);
				const replacement = await refreshed.json();
				expect(replacement.refresh_token).not.toBe(tokens.refresh_token);
				const agent = defined(
					(await api().snapshot()).agents.find((a) => a.label === label),
				);
				if (kind === "agent") await api().revokeAgent({ id: agent.id });
				else await api().revokeDevice({ id: agent.deviceId });
				await expect(mcp.listTools()).rejects.toThrow();
				await mcp.close();
				expect(
					(
						await runtime.pool.query(
							'select id from "oauthClient" where "clientId"=$1',
							[client.client_id],
						)
					).rows,
				).toHaveLength(1);
				expect(
					(await api().snapshot()).agents.some((a) => a.id === agent.id),
				).toBe(false);
				for (const table of [
					"oauthAccessToken",
					"oauthRefreshToken",
					"oauthConsent",
					"oauth_flow_selection",
				])
					expect(
						(
							await runtime.pool.query(
								`select id from "${table}" where "referenceId"=$1`,
								[claims.toolstile_authorization],
							)
						).rows,
					).toEqual([]);

				const denied = await fetch(`${base}/mcp`, {
					method: "POST",
					headers: {
						Authorization: `Bearer ${replacement.access_token}`,
						"Content-Type": "application/json",
					},
					body: "{}",
				});
				expect(denied.status).toBe(403);
				expect(
					(
						await exchange({
							grant_type: "refresh_token",
							refresh_token: replacement.refresh_token,
							resource: `${base}/mcp`,
						})
					).ok,
				).toBe(false);
			},
		);
	},
);
