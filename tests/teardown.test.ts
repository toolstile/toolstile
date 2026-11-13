import { afterEach, describe, expect, it, vi } from "vitest";
import { settlesWithin } from "../packages/gateway/src/teardown";

describe("bounded session teardown", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("reports a close that finishes within the limit", async () => {
		await expect(settlesWithin(Promise.resolve(), 1_000)).resolves.toBe(true);
	});

	it("reports a rejected close so the owner resets instead", async () => {
		await expect(
			settlesWithin(Promise.reject(new Error("upstream failed")), 1_000),
		).resolves.toBe(false);
	});

	it("stops waiting for a close that never settles", async () => {
		vi.useFakeTimers();
		const result = settlesWithin(new Promise(() => {}), 10_000);
		await vi.advanceTimersByTimeAsync(9_999);
		let settled = false;
		void result.then(() => {
			settled = true;
		});
		await Promise.resolve();
		expect(settled).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		await expect(result).resolves.toBe(false);
	});

	it("clears its timer once the close finishes", async () => {
		vi.useFakeTimers();
		await expect(settlesWithin(Promise.resolve(), 10_000)).resolves.toBe(true);
		expect(vi.getTimerCount()).toBe(0);
	});
});
