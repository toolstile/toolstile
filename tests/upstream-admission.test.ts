import { expect, it, vi } from "vitest";
import {
	emptyRules,
	openUpstream,
	type Runtime,
	type Upstream,
} from "../packages/gateway/src/index";
import { defined } from "./assertions";
import { fixture } from "./session-fixture";

it("rejects JSON-RPC batches before admission or forwarding", async () => {
	const f = fixture();
	const upstream: Upstream = {
		id: "batch",
		label: "Fixture",
		url: "https://fixture/mcp",
		transport: "http",
		headers: {},
		rules: [{ ...emptyRules(), full: true }],
	};
	const send = vi.fn(f.request),
		admit = vi.fn(async () => {});
	const runtime: Runtime = {
		connections: async () => [upstream],
		admit,
		record: async () => {},
		validateDestination: async () => {},
		fetch: send,
	};
	const client = await openUpstream(
		runtime,
		upstream,
		"tools/list",
		undefined,
		"tools",
	);
	try {
		send.mockClear();
		admit.mockClear();
		const transport = defined(client.transport);
		// Exercise the guarded wire boundary even though this SDK never emits batches.
		const batch = [
			{
				jsonrpc: "2.0",
				id: 99,
				method: "tools/call",
				params: { name: "forbidden" },
			},
		];
		await expect(
			transport.send(batch as unknown as Parameters<typeof transport.send>[0]),
		).rejects.toThrow("JSON-RPC batches are not supported");
		expect(admit).not.toHaveBeenCalled();
		expect(send).not.toHaveBeenCalled();
	} finally {
		await client.close();
		await f.close();
	}
});

it("refuses a POST whose JSON-RPC message can't be read before admission", async () => {
	const f = fixture();
	const upstream: Upstream = {
		id: "opaque",
		label: "Fixture",
		url: "https://fixture/mcp",
		transport: "http",
		headers: {},
		rules: [{ ...emptyRules(), full: true }],
	};
	const send = vi.fn(f.request),
		admit = vi.fn(async () => {});
	const runtime: Runtime = {
		connections: async () => [upstream],
		admit,
		record: async () => {},
		validateDestination: async () => {},
		fetch: send,
	};
	const client = await openUpstream(
		runtime,
		upstream,
		"tools/list",
		undefined,
		"tools",
	);
	try {
		send.mockClear();
		admit.mockClear();
		// The SDK transport keeps the gateway's guarded fetch; call it with bodies it never sends.
		const wire = (
			defined(client.transport) as unknown as { _fetch: typeof fetch }
		)._fetch;
		const call = JSON.stringify({
			jsonrpc: "2.0",
			id: 7,
			method: "tools/call",
			params: { name: "forbidden" },
		});
		for (const init of [
			{ method: "POST", body: call, headers: { "content-type": "text/plain" } },
			{ method: "POST", body: new TextEncoder().encode(call) },
			{
				method: "POST",
				body: "null",
				headers: { "content-type": "application/json" },
			},
		])
			await expect(wire(upstream.url, init)).rejects.toThrow(
				"Unsupported upstream request body",
			);
		await expect(
			wire(
				new Request(upstream.url, {
					method: "POST",
					body: call,
					headers: { "content-type": "application/json" },
				}),
			),
		).rejects.toThrow("Unsupported upstream request body");
		expect(admit).not.toHaveBeenCalled();
		expect(send).not.toHaveBeenCalled();
	} finally {
		await client.close();
		await f.close();
	}
});

it("tells the host which checks cover only catalog list requests", async () => {
	const f = fixture();
	const upstream: Upstream = {
		id: "catalog",
		label: "Fixture",
		url: "https://fixture/mcp",
		transport: "http",
		headers: {},
		rules: [{ ...emptyRules(), full: true }],
	};
	const check = vi.fn(async () => {});
	const runtime: Runtime = {
		connections: async () => [upstream],
		check,
		admit: async () => {},
		record: async () => {},
		validateDestination: async () => {},
		fetch: f.request,
	};
	try {
		for (const [purpose, catalog] of [
			["tools/list", true],
			["resources/templates/list", true],
			["discovery", true],
			["routing", true],
			["tools/call", false],
			["resources/read", false],
		] as const) {
			check.mockClear();
			// Capability is passed explicitly so "discovery" and "routing" are compared alike.
			const client = await openUpstream(
				runtime,
				upstream,
				purpose,
				"x",
				"tools",
			);
			await client.close();
			expect(check).toHaveBeenCalledWith("catalog", "tools", "x", { catalog });
		}
	} finally {
		await f.close();
	}
});
