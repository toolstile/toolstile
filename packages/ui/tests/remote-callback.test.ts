import { expect, it } from "vitest";
import { remoteCallback } from "../src/AuthNavigation";

const query = "client_id=c&device_name=Mac%20mini%07&sig=s";

it("hands loopback redirects for another machine to a command run there", () => {
	expect(
		remoteCallback(query, "http://127.0.0.1:49150/call'back?code=a&state=b'c"),
	).toEqual({
		device: "Mac mini",
		command: `curl -fsS 'http://127.0.0.1:49150/call'\\''back?code=a&state=b%27c'`,
	});
	for (const host of ["localhost:3118", "[::1]:3118"])
		expect(
			remoteCallback(query, `http://${host}/callback?code=a`)?.command,
		).toContain(host);
});

it("follows the redirect when this browser is the agent's machine or it leaves loopback", () => {
	const local = "http://127.0.0.1:49150/callback?code=a";
	expect(remoteCallback("client_id=c&sig=s", local)).toBeNull();
	expect(remoteCallback("client_id=c&device_name=%20&sig=s", local)).toBeNull();
	for (const url of [
		"https://app.example/callback?code=a",
		"http://127.0.0.1.example/callback",
		"/consent-agent?client_id=c",
	])
		expect(remoteCallback(query, url)).toBeNull();
});
