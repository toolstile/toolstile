import { afterEach, describe, expect, it, vi } from "vitest";
import { readAccountSession } from "./account-session";

afterEach(() => vi.unstubAllGlobals());
describe("account session resolution", () => {
	it("recognizes an explicit no-session response", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(null)));
		expect(await readAccountSession()).toBe("anonymous");
	});
	it("redirects authenticated users only after the protected account check succeeds", async () => {
		const request = vi
			.fn()
			.mockResolvedValueOnce(
				Response.json({
					session: { id: "fixture" },
					user: { id: "fixture-user" },
				}),
			)
			.mockResolvedValueOnce(Response.json({ json: {} }));
		vi.stubGlobal("fetch", request);
		expect(await readAccountSession()).toBe("authenticated");
		expect(request.mock.calls[1][0]).toBe("/api/rpc/accountStatus");
	});
	it.each([401, 403])(
		"keeps recovery pages available after protected account denial (%s)",
		async (status) => {
			vi.stubGlobal(
				"fetch",
				vi
					.fn()
					.mockResolvedValueOnce(
						Response.json({
							session: { id: "fixture" },
							user: { id: "fixture-user" },
						}),
					)
					.mockResolvedValueOnce(new Response("denied", { status })),
			);
			expect(await readAccountSession()).toBe("restricted");
		},
	);
	it("keeps protected account service failures retriable", async () => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValueOnce(
					Response.json({
						session: { id: "fixture" },
						user: { id: "fixture-user" },
					}),
				)
				.mockResolvedValueOnce(new Response("unavailable", { status: 503 })),
		);
		await expect(readAccountSession()).rejects.toThrow(
			"Unable to check your session.",
		);
	});
	it.each([{}, { user: {} }, { session: null, user: null }])(
		"does not treat a malformed response as signed out",
		async (body) => {
			vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(body)));
			await expect(readAccountSession()).rejects.toThrow(
				"Unable to check your session.",
			);
		},
	);
	it("keeps server/network failures retriable", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(new Response("unavailable", { status: 503 })),
		);
		await expect(readAccountSession()).rejects.toThrow(
			"Unable to check your session.",
		);
	});
});
