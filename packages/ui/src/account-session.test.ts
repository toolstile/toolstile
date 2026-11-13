import { afterEach, describe, expect, it, vi } from "vitest";
import { readAccountSession } from "./AccountSession";

const present = () =>
	Response.json({ session: { id: "fixture" }, user: { id: "fixture-user" } });
afterEach(() => vi.unstubAllGlobals());
describe("shared account session resolution", () => {
	it("does not call the application's access adapter without a session", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(null)));
		const check = vi.fn(async () => true);
		expect(await readAccountSession(check)).toBe("anonymous");
		expect(check).not.toHaveBeenCalled();
	});
	it.each([true, false])(
		"uses the injected protected check (%s)",
		async (allowed) => {
			vi.stubGlobal("fetch", vi.fn().mockResolvedValue(present()));
			const controller = new AbortController();
			const check = vi.fn(async () => allowed);
			expect(await readAccountSession(check, controller.signal)).toBe(
				allowed ? "authenticated" : "restricted",
			);
			expect(check).toHaveBeenCalledWith(controller.signal);
		},
	);
	it("keeps access service outages distinct from an access denial", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(present()));
		await expect(
			readAccountSession(async () => {
				throw new Error("unavailable");
			}),
		).rejects.toThrow("unavailable");
	});
	it("does not call an access adapter for a malformed session", async () => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValue(Response.json({ session: {}, user: { id: 123 } })),
		);
		const check = vi.fn(async () => true);
		await expect(readAccountSession(check)).rejects.toThrow(
			"Unable to check your session.",
		);
		expect(check).not.toHaveBeenCalled();
	});
	it("cancels before dispatch and after a non-cancellable adapter completes", async () => {
		const controller = new AbortController();
		const request = vi.fn().mockResolvedValue(present());
		vi.stubGlobal("fetch", request);
		controller.abort();
		await expect(
			readAccountSession(async () => true, controller.signal),
		).rejects.toMatchObject({ name: "AbortError" });
		expect(request).not.toHaveBeenCalled();
		const next = new AbortController();
		await expect(
			readAccountSession(async () => {
				next.abort();
				return true;
			}, next.signal),
		).rejects.toMatchObject({ name: "AbortError" });
	});
});
