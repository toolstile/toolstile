import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { defined } from "./assertions";
import { startFixture } from "./fixture";

/** Local OAuth authorization server and protected MCP, with rotating refresh tokens. */
export async function startOAuthHttpFixture(port = 0) {
	const mcp = await startFixture();
	const codes = new Map<
		string,
		{ challenge: string; redirect: string; clientId: string }
	>();
	let origin = "",
		access = "",
		refresh = "",
		exchanges = 0;
	const server = createServer(async (incoming, outgoing) => {
		try {
			const url = new URL(incoming.url ?? "/", origin);
			const json = (value: unknown, status = 200) => {
				outgoing.writeHead(status, { "Content-Type": "application/json" });
				outgoing.end(JSON.stringify(value));
			};
			if (url.pathname.startsWith("/.well-known/oauth-protected-resource"))
				return json({
					resource: `${origin}/mcp`,
					authorization_servers: [origin],
				});
			if (url.pathname === "/.well-known/oauth-authorization-server")
				return json({
					issuer: origin,
					authorization_endpoint: `${origin}/authorize`,
					token_endpoint: `${origin}/token`,
					registration_endpoint: `${origin}/register`,
					response_types_supported: ["code"],
					grant_types_supported: ["authorization_code", "refresh_token"],
					token_endpoint_auth_methods_supported: ["none"],
					code_challenge_methods_supported: ["S256"],
					authorization_response_iss_parameter_supported: true,
				});
			const chunks: Buffer[] = [];
			for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
			const body = Buffer.concat(chunks);
			if (url.pathname === "/register") {
				const metadata = JSON.parse(body.toString());
				return json(
					{
						...metadata,
						client_id: "local-oauth-fixture",
						token_endpoint_auth_method: "none",
					},
					201,
				);
			}
			if (url.pathname === "/authorize") {
				const code = randomUUID(),
					query = url.searchParams;
				if (
					query.get("code_challenge_method") !== "S256" ||
					!query.get("code_challenge")
				)
					return json({ error: "invalid_request" }, 400);
				const redirect = defined(query.get("redirect_uri"));
				codes.set(code, {
					challenge: defined(query.get("code_challenge")),
					redirect,
					clientId: defined(query.get("client_id")),
				});
				const callback = new URL(redirect);
				callback.searchParams.set("code", code);
				callback.searchParams.set("state", defined(query.get("state")));
				callback.searchParams.set("iss", origin);
				outgoing.writeHead(302, { Location: callback.href });
				outgoing.end();
				return;
			}
			if (url.pathname === "/token") {
				const form = new URLSearchParams(body.toString());
				if (form.get("grant_type") === "authorization_code") {
					const code = defined(form.get("code")),
						saved = codes.get(code);
					codes.delete(code);
					if (
						!saved ||
						createHash("sha256")
							.update(form.get("code_verifier") ?? "")
							.digest("base64url") !== saved.challenge ||
						form.get("redirect_uri") !== saved.redirect ||
						form.get("client_id") !== saved.clientId
					)
						return json({ error: "invalid_grant" }, 400);
				} else if (
					form.get("grant_type") !== "refresh_token" ||
					form.get("refresh_token") !== refresh
				)
					return json({ error: "invalid_grant" }, 400);
				exchanges++;
				access = randomUUID();
				refresh = randomUUID();
				return json({
					access_token: access,
					refresh_token: refresh,
					token_type: "Bearer",
					expires_in: 3600,
				});
			}
			if (url.pathname === "/mcp") {
				if (!access || incoming.headers.authorization !== `Bearer ${access}`) {
					outgoing.writeHead(401, {
						"WWW-Authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
					});
					outgoing.end();
					return;
				}
				const headers = new Headers();
				for (const [key, value] of Object.entries(incoming.headers))
					if (
						value &&
						![
							"host",
							"authorization",
							"content-length",
							"transfer-encoding",
							"connection",
						].includes(key)
					)
						headers.set(key, Array.isArray(value) ? value.join(",") : value);
				const response = await fetch(mcp.url, {
					method: incoming.method,
					headers,
					...(incoming.method !== "GET" && incoming.method !== "HEAD"
						? { body }
						: {}),
				});
				outgoing.writeHead(
					response.status,
					Object.fromEntries(response.headers),
				);
				outgoing.end(Buffer.from(await response.arrayBuffer()));
				return;
			}
			json({ error: "not_found" }, 404);
		} catch {
			outgoing.writeHead(500);
			outgoing.end();
		}
	});
	await new Promise<void>((resolve) =>
		server.listen(port, "127.0.0.1", resolve),
	);
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("OAuth fixture did not start");
	origin = `http://127.0.0.1:${address.port}`;
	return {
		url: `${origin}/mcp`,
		exchanges: () => exchanges,
		close: async () => {
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			);
			await mcp.close();
		},
	};
}
if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	const fixture = await startOAuthHttpFixture(4313);
	console.log(`Local OAuth MCP fixture: ${fixture.url}`);
}
