import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { digest, issueToken } from "../packages/auth/src/index";

/** `toolstile auth login` and `toolstile mcp setup` against the production HTTP server. */
describe.skipIf(!process.env.TEST_BASE_URL)(
	"CLI device sign-in and the CLI endpoints",
	() => {
		const base = process.env.TEST_BASE_URL ?? "";
		const json = { "Content-Type": "application/json" };
		let runtime: typeof import("../apps/web/src/server/runtime");
		beforeAll(async () => {
			runtime = await import("../apps/web/src/server/runtime");
		});
		afterAll(async () => {
			await runtime?.pool.end();
		});
		const auth = (path: string, init: RequestInit = {}) =>
			fetch(`${base}/api/auth${path}`, {
				...init,
				headers: { ...json, origin: base, ...init.headers },
			});
		const cli = (path: string, token: string, init: RequestInit = {}) =>
			fetch(`${base}/api/cli${path}`, {
				...init,
				headers: {
					...json,
					authorization: `Bearer ${token}`,
					...init.headers,
				},
			});
		async function person() {
			const email = `${randomUUID()}@test.invalid`,
				invitation = issueToken();
			await runtime.pool.query(
				'insert into invitations(id,email,"expiresAt") values($1,$2,$3)',
				[digest(invitation), email, new Date(Date.now() + 60000)],
			);
			const response = await auth("/sign-up/email", {
				method: "POST",
				body: JSON.stringify({
					email,
					name: "CLI user",
					password: "Local-test-password-12345",
					invitationToken: invitation,
				}),
			});
			expect(response.status).toBe(200);
			const cookie = response.headers
				.getSetCookie()
				.map((value) => value.split(";")[0])
				.join("; ");
			const {
				rows: [user],
			} = await runtime.pool.query<{ id: string }>(
				'select id from "user" where email=$1',
				[email],
			);
			return { email, cookie, id: user.id };
		}
		type Person = Awaited<ReturnType<typeof person>>;
		async function deviceCode() {
			const response = await auth("/device/code", {
				method: "POST",
				body: JSON.stringify({ client_id: "toolstile-cli" }),
			});
			expect(response.status).toBe(200);
			return (await response.json()) as {
				device_code: string;
				user_code: string;
				verification_uri_complete: string;
			};
		}
		/**
		 * A same-origin request from the approval page, signed in as `as` when given. Like the
		 * page, it names the account it shows: `as`, unless the body names another.
		 */
		const page = (
			path: string,
			body: Record<string, unknown>,
			as?: Person,
			origin = base,
		) =>
			fetch(`${base}/api/cli${path}`, {
				method: "POST",
				headers: { ...json, origin, ...(as ? { cookie: as.cookie } : {}) },
				body: JSON.stringify(as ? { accountId: as.id, ...body } : body),
			});
		/** What the approval page does first: looking the code up binds it to the account. */
		const lookUp = (code: { user_code: string }, as: Person) =>
			page("/lookup", { userCode: code.user_code }, as);
		const deny = (code: { user_code: string }, as: Person) =>
			page("/deny", { userCode: code.user_code }, as);
		const devicesNamed = async (as: Person, label: string) =>
			(
				await runtime.pool.query(
					'select id from devices where "ownerId"=$1 and label=$2',
					[as.id, label],
				)
			).rowCount;
		const status = async (code: { device_code: string }) =>
			(
				await runtime.pool.query<{ status: string }>(
					'select status from device_code where "deviceCode"=$1',
					[code.device_code],
				)
			).rows[0]?.status;
		const approve = (
			code: { user_code: string },
			as: Person,
			deviceName = "build-box",
			origin = base,
		) => page("/approve", { userCode: code.user_code, deviceName }, as, origin);
		async function poll(code: { device_code: string }) {
			// The plugin refuses polls faster than its interval.
			await runtime.pool.query(
				'update device_code set "lastPolledAt"=null where "deviceCode"=$1',
				[code.device_code],
			);
			return (await (
				await auth("/device/token", {
					method: "POST",
					body: JSON.stringify({
						grant_type: "urn:ietf:params:oauth:grant-type:device_code",
						device_code: code.device_code,
						client_id: "toolstile-cli",
					}),
				})
			).json()) as { access_token?: string; error?: string };
		}
		async function signIn(as: Person, deviceName = "build-box") {
			const code = await deviceCode();
			expect((await (await lookUp(code, as)).json()).status).toBe("pending");
			expect((await approve(code, as, deviceName)).status).toBe(200);
			const granted = await poll(code);
			expect(granted.access_token).toBeTruthy();
			return granted.access_token as string;
		}

		it("signs the CLI in through an approved code and manages its device's agents", async () => {
			const owner = await person();
			const code = await deviceCode();
			// Self-hosted account pages live under /auth.
			expect(code.verification_uri_complete).toBe(
				`${base}/auth/device?user_code=${code.user_code}`,
			);
			expect((await poll(code)).error).toBe("authorization_pending");
			expect((await (await lookUp(code, owner)).json()).status).toBe("pending");
			// The library's own lookup, approval and denial routes are disabled.
			for (const [path, method] of [
				[`/device?user_code=${code.user_code}`, "GET"],
				["/device/approve", "POST"],
				["/device/deny", "POST"],
			] as const) {
				const raw = await auth(path, {
					method,
					headers: { cookie: owner.cookie },
					...(method === "POST"
						? { body: JSON.stringify({ userCode: code.user_code }) }
						: {}),
				});
				expect([path, raw.status]).toEqual([path, 404]);
			}
			const approved = await approve(code, owner, "token-box");
			expect(approved.status).toBe(200);
			const { device: named } = await approved.json();
			expect(named).toMatchObject({ label: "token-box" });
			const token = must((await poll(code)).access_token);

			const account = await (await cli("/account", token)).json();
			expect(account).toMatchObject({
				email: owner.email,
				name: "CLI user",
				edition: "self-hosted",
				workspaces: [],
				mcpUrl: `${base}/mcp`,
				device: named,
			});
			expect(new Date(account.expiresAt).getTime()).toBeGreaterThan(Date.now());

			// A workspace ID from a client written for another server is ignored.
			const device = await (
				await cli("/device", token, {
					method: "POST",
					body: JSON.stringify({ workspaceId: "ignored", label: "build-box" }),
				})
			).json();
			expect(device).toMatchObject({ label: "build-box" });
			expect(
				await (
					await cli("/device", token, {
						method: "POST",
						body: JSON.stringify({ id: device.id, label: "kept" }),
					})
				).json(),
			).toEqual({ id: device.id, label: "build-box" });
			expect(
				await (
					await cli("/device", token, {
						method: "POST",
						body: JSON.stringify({
							id: device.id,
							label: "renamed-box",
							rename: true,
						}),
					})
				).json(),
			).toEqual({ id: device.id, label: "renamed-box" });

			const created = await cli("/agents", token, {
				method: "POST",
				body: JSON.stringify({ deviceId: device.id, label: "Claude Code" }),
			});
			expect(created.status).toBe(201);
			const agent = await created.json();
			expect(agent).toMatchObject({ label: "Claude Code" });
			expect(agent.token).toMatch(/^ts_/);
			expect(
				await (
					await cli(`/agents?deviceId=${device.id}&workspaceId=x`, token)
				).json(),
			).toEqual({ agents: [{ id: agent.id, label: "Claude Code" }] });
			// The token is an ordinary agent credential for the gateway.
			const initialize = () =>
				fetch(`${base}/mcp`, {
					method: "POST",
					headers: {
						...json,
						accept: "application/json, text/event-stream",
						authorization: `Bearer ${agent.token}`,
					},
					body: JSON.stringify({
						jsonrpc: "2.0",
						id: 1,
						method: "initialize",
						params: {
							protocolVersion: "2025-06-18",
							capabilities: {},
							clientInfo: { name: "cli-test", version: "1" },
						},
					}),
				});
			expect((await initialize()).status).toBe(200);

			expect(
				(await cli(`/agents/${agent.id}`, token, { method: "DELETE" })).status,
			).toBe(204);
			expect((await initialize()).status).toBe(401);
			expect(
				(await cli(`/agents/${agent.id}`, token, { method: "DELETE" })).status,
			).toBe(404);
			expect(
				await (await cli(`/agents?deviceId=${device.id}`, token)).json(),
			).toEqual({ agents: [] });

			expect((await cli("/sign-out", token, { method: "POST" })).status).toBe(
				204,
			);
			expect((await cli("/account", token)).status).toBe(401);
			const refused = await cli("/agents", token, {
				method: "POST",
				body: JSON.stringify({ deviceId: device.id, label: "Late" }),
			});
			expect(refused.status).toBe(401);
			expect(await refused.json()).toEqual({
				message: "Sign in with toolstile auth login",
			});
		});

		it("keeps each account's devices and agents to itself", async () => {
			const owner = await person(),
				intruder = await person();
			const mine = await signIn(owner),
				theirs = await signIn(intruder);
			const device = await (
				await cli("/device", mine, {
					method: "POST",
					body: JSON.stringify({ label: "owner-box" }),
				})
			).json();
			const agent = await (
				await cli("/agents", mine, {
					method: "POST",
					body: JSON.stringify({ deviceId: device.id, label: "Codex" }),
				})
			).json();
			expect(
				await (await cli(`/agents?deviceId=${device.id}`, theirs)).json(),
			).toEqual({ agents: [] });
			// Another account's device ID is never reused or renamed.
			const foreign = await (
				await cli("/device", theirs, {
					method: "POST",
					body: JSON.stringify({ id: device.id, label: "mine", rename: true }),
				})
			).json();
			expect(foreign.id).not.toBe(device.id);
			expect(
				(
					await cli("/agents", theirs, {
						method: "POST",
						body: JSON.stringify({ deviceId: device.id, label: "Planted" }),
					})
				).status,
			).toBe(403);
			expect(
				(await cli(`/agents/${agent.id}`, theirs, { method: "DELETE" })).status,
			).toBe(404);
			expect(
				await (await cli(`/agents?deviceId=${device.id}`, mine)).json(),
			).toEqual({ agents: [{ id: agent.id, label: "Codex" }] });
			expect(
				(
					await runtime.pool.query(
						'select label from devices where id=$1 and "ownerId"=$2',
						[device.id, owner.id],
					)
				).rows,
			).toEqual([{ label: "owner-box" }]);
		});

		it("accepts the CLI token only on /api/cli and signs out only that session", async () => {
			const owner = await person();
			const first = await signIn(owner),
				second = await signIn(owner);
			// Better Auth and the dashboard API read only the signed browser cookie.
			const session = await auth("/get-session", {
				headers: { authorization: `Bearer ${first}` },
			});
			expect(await session.json()).toBeNull();
			const rpc = await fetch(`${base}/api/rpc/snapshot`, {
				method: "POST",
				headers: { ...json, origin: base, authorization: `Bearer ${first}` },
				body: "{}",
			});
			expect(rpc.status).toBe(401);
			expect((await cli("/account", "not-a-session-token")).status).toBe(401);
			expect((await fetch(`${base}/api/cli/account`)).status).toBe(401);
			expect((await cli("/unknown", first)).status).toBe(404);

			expect((await cli("/sign-out", first, { method: "POST" })).status).toBe(
				204,
			);
			expect((await cli("/account", first)).status).toBe(401);
			expect((await cli("/account", second)).status).toBe(200);
			const browser = await auth("/get-session", {
				headers: { cookie: owner.cookie },
			});
			expect((await browser.json())?.user?.email).toBe(owner.email);
		});

		it("names the device on approval and reuses one with the same name", async () => {
			const owner = await person();
			const device = async (name: string) =>
				(await (await cli("/account", await signIn(owner, name))).json())
					.device;
			const first = await device("build-box");
			expect(first).toMatchObject({ label: "build-box" });
			expect(await device("Build-Box")).toEqual(first);
			expect((await device("laptop")).id).not.toBe(first.id);
		});

		it("refuses codes that are unbound, foreign, expired, denied or from another client", async () => {
			const owner = await person(),
				other = await person();
			expect(
				(
					await auth("/device/code", {
						method: "POST",
						body: JSON.stringify({ client_id: "someone-else" }),
					})
				).status,
			).toBe(400);

			const unbound = await deviceCode();
			expect((await approve(unbound, owner)).status).toBe(400);

			// Bound to another account by its lookup: this account cannot approve it.
			const foreign = await deviceCode();
			await lookUp(foreign, other);
			const refused = await approve(foreign, owner);
			expect(refused.status).toBe(400);
			expect(await refused.json()).toEqual({
				message:
					"This code is not valid or has expired. Run toolstile auth login again.",
			});
			expect(
				(await approve(foreign, other, "x", "https://evil.example")).status,
			).toBe(403);
			expect(
				(
					await fetch(`${base}/api/cli/approve`, {
						method: "POST",
						headers: { ...json, origin: base },
						body: JSON.stringify({
							userCode: foreign.user_code,
							deviceName: "x",
						}),
					})
				).status,
			).toBe(401);
			expect((await poll(foreign)).error).toBe("authorization_pending");

			const expired = await deviceCode();
			await lookUp(expired, owner);
			await runtime.pool.query(
				`update device_code set "expiresAt"=now() - interval '1 minute' where "deviceCode"=$1`,
				[expired.device_code],
			);
			expect((await approve(expired, owner)).status).toBe(400);

			const denied = await deviceCode();
			await lookUp(denied, owner);
			expect((await deny(denied, owner)).status).toBe(204);
			expect((await approve(denied, owner)).status).toBe(400);
			expect((await poll(denied)).error).toBe("access_denied");

			// Used once: a second approval and a second redemption both fail.
			const used = await deviceCode();
			await lookUp(used, owner);
			expect((await approve(used, owner)).status).toBe(200);
			expect((await approve(used, owner)).status).toBe(400);
			expect((await poll(used)).access_token).toBeTruthy();
			expect((await poll(used)).access_token).toBeUndefined();

			// None of the refused approvals named a device.
			expect(await devicesNamed(owner, "x")).toBe(0);
			expect(await devicesNamed(other, "x")).toBe(0);
		});

		it("creates no device when an approval fails", async () => {
			const owner = await person();
			const expired = await deviceCode();
			await lookUp(expired, owner);
			await runtime.pool.query(
				`update device_code set "expiresAt"=now() - interval '1 minute' where "deviceCode"=$1`,
				[expired.device_code],
			);
			expect((await approve(expired, owner, "expired-box")).status).toBe(400);
			const denied = await deviceCode();
			await lookUp(denied, owner);
			expect((await deny(denied, owner)).status).toBe(204);
			expect((await approve(denied, owner, "denied-box")).status).toBe(400);
			const approved = await deviceCode();
			await lookUp(approved, owner);
			expect((await approve(approved, owner, "first-box")).status).toBe(200);
			expect((await approve(approved, owner, "second-box")).status).toBe(400);
			// Concurrent approvals of one code: one wins, and only its device exists.
			const raced = await deviceCode();
			await lookUp(raced, owner);
			const outcomes = await Promise.all(
				["race-a", "race-b"].map(async (name) => ({
					name,
					status: (await approve(raced, owner, name)).status,
				})),
			);
			expect(outcomes.map((outcome) => outcome.status).sort()).toEqual([
				200, 400,
			]);
			for (const outcome of outcomes)
				expect([outcome.name, await devicesNamed(owner, outcome.name)]).toEqual(
					[outcome.name, outcome.status === 200 ? 1 : 0],
				);
			for (const name of ["expired-box", "denied-box", "second-box"])
				expect([name, await devicesNamed(owner, name)]).toEqual([name, 0]);
			expect(await devicesNamed(owner, "first-box")).toBe(1);
		});

		it("denies only a pending code the signed-in account looked up", async () => {
			const owner = await person(),
				other = await person();
			const approved = await deviceCode();
			await lookUp(approved, owner);
			expect((await approve(approved, owner)).status).toBe(200);
			const late = await deny(approved, owner);
			expect(late.status).toBe(400);
			expect(await late.json()).toEqual({
				message:
					"This code is not valid or has expired. Run toolstile auth login again.",
			});
			expect(await status(approved)).toBe("approved");
			expect((await poll(approved)).access_token).toBeTruthy();

			const pending = await deviceCode();
			await lookUp(pending, owner);
			expect((await deny(pending, other)).status).toBe(400);
			expect(await status(pending)).toBe("pending");
			expect(
				(await page("/deny", { userCode: pending.user_code })).status,
			).toBe(401);
			expect(
				(
					await page(
						"/deny",
						{ userCode: pending.user_code },
						owner,
						"https://evil.example",
					)
				).status,
			).toBe(403);
			expect(await status(pending)).toBe("pending");
			expect((await deny(pending, owner)).status).toBe(204);
			expect(await status(pending)).toBe("denied");
			expect((await deny(pending, owner)).status).toBe(400);
		});

		it("looks codes up only for a signed-in account, limited per account", async () => {
			const owner = await person(),
				other = await person();
			const code = await deviceCode();
			// Anonymous lookups are refused before any limit, and bind nothing.
			for (let attempt = 0; attempt < 15; attempt++)
				expect(
					(await page("/lookup", { userCode: code.user_code })).status,
				).toBe(401);
			expect(
				(
					await page(
						"/lookup",
						{ userCode: code.user_code },
						owner,
						"https://evil.example",
					)
				).status,
			).toBe(403);
			expect(
				(
					await runtime.pool.query(
						'select "userId" from device_code where "deviceCode"=$1',
						[code.device_code],
					)
				).rows,
			).toEqual([{ userId: null }]);
			// Ten lookups per account; misses count too, so codes cannot be guessed.
			expect(await (await lookUp(code, owner)).json()).toEqual({
				status: "pending",
			});
			for (let attempt = 1; attempt < 10; attempt++)
				expect(
					(await page("/lookup", { userCode: "ZZZZ-ZZZZ" }, owner)).status,
				).toBe(400);
			const limited = await lookUp(code, owner);
			expect(limited.status).toBe(429);
			expect(await limited.json()).toEqual({
				message: "Too many attempts. Wait a minute and try again.",
			});
			// Another account keeps its own quota, and cannot see a code bound to the owner.
			expect((await lookUp(code, other)).status).toBe(400);
			const own = await deviceCode();
			expect(await (await lookUp(own, other)).json()).toEqual({
				status: "pending",
			});
			// The owner's earlier lookup still lets it approve.
			expect((await approve(code, owner)).status).toBe(200);
		});

		it("refuses requests from a page that showed another account", async () => {
			const owner = await person(),
				other = await person();
			const code = await deviceCode();
			const switched = { accountId: other.id };
			// The browser signed in as the owner after the page showed the other account.
			for (const [path, body] of [
				["/lookup", { userCode: code.user_code }],
				["/approve", { userCode: code.user_code, deviceName: "switched-box" }],
				["/deny", { userCode: code.user_code }],
			] as const) {
				const refused = await page(path, { ...body, ...switched }, owner);
				expect([path, refused.status]).toEqual([path, 409]);
				expect(await refused.json()).toEqual({
					message: "You signed in as a different account. Reload this page.",
				});
			}
			expect(
				(
					await runtime.pool.query(
						'select "userId",status from device_code where "deviceCode"=$1',
						[code.device_code],
					)
				).rows,
			).toEqual([{ userId: null, status: "pending" }]);
			// Bound and approvable by the owner, the mismatch still changes nothing.
			await lookUp(code, owner);
			expect(
				(
					await page(
						"/approve",
						{
							userCode: code.user_code,
							deviceName: "switched-box",
							...switched,
						},
						owner,
					)
				).status,
			).toBe(409);
			expect(await status(code)).toBe("pending");
			expect(await devicesNamed(owner, "switched-box")).toBe(0);
			// A request without the shown account is invalid.
			const missing = await fetch(`${base}/api/cli/lookup`, {
				method: "POST",
				headers: { ...json, origin: base, cookie: owner.cookie },
				body: JSON.stringify({ userCode: code.user_code }),
			});
			expect(missing.status).toBe(400);
		});

		it("denies an approved code that was not redeemed before the account was reset", async () => {
			const owner = await person();
			const code = await deviceCode();
			await lookUp(code, owner);
			expect((await approve(code, owner)).status).toBe(200);
			await runtime.accounts.emergencyReset(
				owner.id,
				"operator-fixture",
				"Fixture identity verification",
			);
			expect(
				(
					await runtime.pool.query(
						'select status from device_code where "deviceCode"=$1',
						[code.device_code],
					)
				).rows,
			).toEqual([{ status: "denied" }]);
			expect((await poll(code)).access_token).toBeUndefined();
		});
	},
);

function must<T>(value: T | undefined): T {
	if (value === undefined) throw new Error("Missing value");
	return value;
}
