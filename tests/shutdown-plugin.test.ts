import { afterEach, expect, test, vi } from "vitest";
import plugin from "../apps/web/server/plugins/lifecycle";
import { registerLifecycleRuntime } from "../apps/web/src/server/lifecycle";

vi.mock("nitro", () => ({ definePlugin: (value: unknown) => value }));
const originalExitCode = process.exitCode;
afterEach(() => {
	process.exitCode = originalExitCode;
	vi.useRealTimers();
	vi.restoreAllMocks();
	delete (globalThis as { __toolstileLifecycle?: unknown })
		.__toolstileLifecycle;
});

test("failed final cleanup retains the hard deadline and nonzero exit status", async () => {
	vi.useFakeTimers();
	vi.spyOn(process, "prependListener").mockReturnValue(process);
	vi.spyOn(process, "removeListener").mockReturnValue(process);
	const exit = vi
		.spyOn(process, "exit")
		.mockImplementation(() => undefined as never);
	vi.spyOn(console, "error").mockImplementation(() => {});
	registerLifecycleRuntime({
		stopMaintenance() {},
		closeStreams: async () => {},
		close: async () => {
			throw new Error("fixture");
		},
	});
	let close!: () => Promise<void>;
	plugin({
		hooks: {
			hook(_name: string, callback: () => Promise<void>) {
				close = callback;
			},
		},
	} as unknown as Parameters<typeof plugin>[0]);
	await expect(close()).rejects.toThrow("Runtime cleanup failed");
	expect(process.exitCode).toBe(1);
	expect(exit).not.toHaveBeenCalled();
	await vi.advanceTimersByTimeAsync(24999);
	expect(exit).not.toHaveBeenCalled();
	await vi.advanceTimersByTimeAsync(1);
	expect(exit).toHaveBeenCalledWith(1);
});

test("successful final cleanup cancels the shutdown deadline", async () => {
	vi.useFakeTimers();
	vi.spyOn(process, "prependListener").mockReturnValue(process);
	vi.spyOn(process, "removeListener").mockReturnValue(process);
	const exit = vi
		.spyOn(process, "exit")
		.mockImplementation(() => undefined as never);
	registerLifecycleRuntime({
		stopMaintenance() {},
		closeStreams: async () => {},
		close: async () => {},
	});
	let close!: () => Promise<void>;
	plugin({
		hooks: {
			hook(_name: string, callback: () => Promise<void>) {
				close = callback;
			},
		},
	} as unknown as Parameters<typeof plugin>[0]);
	await close();
	expect(vi.getTimerCount()).toBe(0);
	await vi.advanceTimersByTimeAsync(25000);
	expect(exit).not.toHaveBeenCalled();
});
