import { expect, test, vi } from "vitest";
import { createMcpGateway } from "../packages/gateway/src/index";

test("both shutdown phases await the same delayed MCP cleanup before closing storage", async () => {
	const { createInstanceRuntime } = await import(
		"../apps/web/src/server/runtime"
	);
	const gateway = createMcpGateway({ sweep: false });
	let release!: () => void;
	const pendingCleanup = new Promise<void>((done) => {
		release = done;
	});
	const originalClose = gateway.close.bind(gateway);
	const close = vi.spyOn(gateway, "close").mockImplementation(async () => {
		// A subscription can remove itself from the registry before its remote
		// client and stream teardown finish. Final cleanup must await this work.
		await pendingCleanup;
		await originalClose();
	});
	const runtime = createInstanceRuntime({ gateway });
	const end = vi.spyOn(runtime.pool, "end");
	let closed = false;
	try {
		const streams = runtime.closeStreams();
		const finished = runtime.close().then(() => {
			closed = true;
		});
		await new Promise((done) => setTimeout(done, 20));
		expect(close).toHaveBeenCalledTimes(1);
		expect(end).not.toHaveBeenCalled();
		expect(closed).toBe(false);
		release();
		await Promise.all([streams, finished]);
		expect(end).toHaveBeenCalledTimes(1);
		await runtime.close();
		expect(close).toHaveBeenCalledTimes(1);
	} finally {
		release();
		await runtime.close();
	}
});

test("a rejected MCP teardown still attempts storage cleanup and remains a failure", async () => {
	const { createInstanceRuntime } = await import(
		"../apps/web/src/server/runtime"
	);
	const gateway = createMcpGateway({ sweep: false });
	const originalClose = gateway.close.bind(gateway);
	vi.spyOn(gateway, "close").mockRejectedValue(
		new Error("fixture cleanup failure"),
	);
	const runtime = createInstanceRuntime({ gateway });
	const end = vi.spyOn(runtime.pool, "end");
	try {
		await expect(runtime.closeStreams()).rejects.toThrow(
			"fixture cleanup failure",
		);
		await expect(runtime.close()).rejects.toThrow("Runtime cleanup failed");
		expect(end).toHaveBeenCalledTimes(1);
		await expect(runtime.close()).rejects.toThrow("Runtime cleanup failed");
		expect(end).toHaveBeenCalledTimes(1);
	} finally {
		await originalClose();
	}
});
