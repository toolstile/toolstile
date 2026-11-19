import type { Actor, Snapshot } from "@toolstile/api/contract";
import { createSetupService, type SetupRow } from "@toolstile/api/setup-server";
import { describe, expect, it, vi } from "vitest";
import { ORPCError } from "../apps/web/test-support/setup-rpc";
import { emptyRules, type Runtime } from "../packages/gateway/src/index";

const actor: Actor = { userId: "owner", scopeId: "owner" };
function fixture() {
	let saved: SetupRow | undefined;
	const rules = emptyRules();
	rules.allow.tools = ["read"];
	const data: Snapshot = {
		user: { name: "Owner", email: "owner@example.test", operator: false },
		connections: ["first", "configured"].map((id) => ({
			id,
			label: id,
			url: "https://example.test/mcp",
			transport: "http",
			status: "ready",
			authentication: "headers",
			canManageAuthentication: true,
		})),
		agents: ["first", "configured"].map((id) => ({
			id,
			label: id,
			deviceId: "device",
			revoked: false,
			canTest: true,
			expiresAt: null,
		})),
		devices: [],
		grants: [],
		allAgentGrants: [],
		activity: [],
	};
	const catalog = vi.fn(async () => ({ tools: [] }));
	const calls: {
		agentId: string;
		connectionId: string;
		id: string;
		target: string | null;
		createdAt: Date;
	}[] = [];
	const firstCall = vi.fn(
		async (_actor: Actor, input: { agentId: string; connectionId: string }) => {
			const call = calls.find(
				(entry) =>
					entry.agentId === input.agentId &&
					entry.connectionId === input.connectionId,
			);
			return (
				call && { id: call.id, target: call.target, createdAt: call.createdAt }
			);
		},
	);
	let writes = 0;
	const runtime = vi.fn((_actor: Actor, id: string): Runtime => ({
		authenticate: async () => {},
		connections: async () =>
			id === "configured"
				? [
						{
							id: "configured",
							label: "Configured",
							url: "https://example.test/mcp",
							transport: "http",
							headers: {},
							identityKey: "one",
							rules: [rules],
						},
					]
				: [],
		admit: async () => {},
		record: async () => {},
		validateDestination: async () => {},
	}));
	const service = createSetupService({
		read: async () => saved,
		persist: async (_actor, row) => {
			writes++;
			saved = row;
		},
		isConnectionReady: (connection) => connection.status === "ready",
		services: { snapshot: async () => data, agentCatalog: catalog },
		runtime,
		firstCall,
	});
	return {
		service,
		data,
		rules,
		catalog,
		runtime,
		calls,
		firstCall,
		writes: () => writes,
		setRow: (row: SetupRow) => {
			saved = row;
		},
	};
}
const progress: SetupRow = {
	status: "active",
	step: "access",
	client: "codex",
	connectionId: null,
	agentId: null,
	verificationKey: null,
	verifiedAt: null,
};

describe("setup reconciles access configured outside the guide", () => {
	it("recovers a live permitted pair among multiple choices without provider calls or grants", async () => {
		const { service, catalog, data } = fixture();
		const state = await service.status(actor);
		expect(state).toMatchObject({
			status: "active",
			step: "verify",
			connectionId: "configured",
			agentId: "configured",
			completed: { connect: true, agent: true, access: true, verify: false },
		});
		expect(catalog).not.toHaveBeenCalled();
		expect(data.grants).toEqual([]);
	});
	it("retains a valid explicit choice instead of replacing it with another agent's access", async () => {
		const { service, setRow } = fixture();
		setRow({ ...progress, connectionId: "first", agentId: "first" });
		expect(await service.status(actor)).toMatchObject({
			connectionId: "first",
			agentId: "first",
			completed: { access: false },
		});
	});
	it("recovers a removed selection but never tests revoked or expired agents", async () => {
		const { service, setRow, data, runtime } = fixture();
		setRow({ ...progress, connectionId: "removed", agentId: "removed" });
		for (const agent of data.agents)
			if (agent.id === "first") agent.revoked = true;
		expect(await service.status(actor)).toMatchObject({
			connectionId: "configured",
			agentId: "configured",
		});
		expect(runtime.mock.calls.every(([, id]) => id !== "first")).toBe(true);
		for (const agent of data.agents)
			if (agent.id === "configured") agent.expiresAt = "2000-01-01T00:00:00Z";
		expect((await service.status(actor)).completed.access).toBe(false);
	});
	it("recognizes approval-only access while honoring an explicit block", async () => {
		const { service, rules } = fixture();
		rules.allow.tools = [];
		rules.requireApproval = ["write"];
		expect((await service.status(actor)).completed.access).toBe(true);
		rules.block.tools = ["write"];
		expect((await service.status(actor)).completed.access).toBe(false);
	});
	it("does not mistake blocked allow entries or an unavailable account for usable access", async () => {
		const { service, rules, data } = fixture();
		rules.block.tools = ["read"];
		expect((await service.status(actor)).completed.access).toBe(false);
		rules.block.tools = [];
		for (const connection of data.connections)
			if (connection.id === "configured")
				connection.status = "approval pending";
		expect((await service.status(actor)).completed.access).toBe(false);
	});
	it("preserves paused and finished progress", async () => {
		const { service, setRow, runtime } = fixture();
		for (const status of ["skipped", "finished"] as const) {
			setRow({ ...progress, status });
			expect(await service.status(actor)).toMatchObject({
				status,
				connectionId: undefined,
				agentId: undefined,
			});
		}
		expect(runtime).not.toHaveBeenCalled();
	});
	it("requires successful catalog verification and a first call before persisting completion", async () => {
		const { service, catalog, calls } = fixture();
		const state = await service.status(actor);
		const input = {
			connectionId: state.connectionId ?? "missing",
			agentId: state.agentId ?? "missing",
			client: state.client,
			step: "verify" as const,
			action: "finish" as const,
		};
		await expect(service.save(actor, input)).rejects.toMatchObject({
			code: "BAD_REQUEST",
		});
		catalog.mockRejectedValueOnce(new Error("provider unavailable"));
		await expect(service.verify(actor, input)).rejects.toMatchObject({
			code: "BAD_GATEWAY",
			message: expect.stringMatching(
				/^Couldn't load tools from \w+\. Try again\. If it keeps failing, open the connection to check its address and sign-in\.$/,
			),
		});
		expect((await service.status(actor)).completed.verify).toBe(false);
		await service.verify(actor, input);
		await expect(service.save(actor, input)).rejects.toMatchObject({
			code: "BAD_REQUEST",
			message:
				"Complete the connection, agent, access, verification and first-call steps first.",
		});
		calls.push({
			agentId: "configured",
			connectionId: "configured",
			id: "call",
			target: "read",
			createdAt: new Date("2026-01-01T00:00:00Z"),
		});
		expect((await service.save(actor, input)).status).toBe("finished");
		expect((await service.status(actor)).status).toBe("finished");
	});
	it("skips live authorization denials but surfaces infrastructure failure", async () => {
		const { service, runtime } = fixture();
		runtime.mockImplementationOnce(() => {
			throw new ORPCError("FORBIDDEN");
		});
		expect((await service.status(actor)).completed.access).toBe(true);
		runtime.mockImplementationOnce(() => {
			throw new Error("database unavailable");
		});
		await expect(service.status(actor)).rejects.toThrow("database unavailable");
	});
	it("derives the first call from activity, independent of verification, and never persists it", async () => {
		const { service, calls, firstCall, setRow, writes } = fixture();
		const empty = await service.status(actor);
		expect(empty.completed.call).toBe(false);
		expect(empty.firstCall).toBeNull();
		// Another agent's call, or one on another connection, is not this selection's.
		calls.push(
			{
				agentId: "first",
				connectionId: "configured",
				id: "other-agent",
				target: "read",
				createdAt: new Date("2026-01-01T00:00:00Z"),
			},
			{
				agentId: "configured",
				connectionId: "first",
				id: "other-connection",
				target: "read",
				createdAt: new Date("2026-01-01T00:00:00Z"),
			},
		);
		expect((await service.status(actor)).completed.call).toBe(false);
		calls.push({
			agentId: "configured",
			connectionId: "configured",
			id: "call",
			target: "read",
			createdAt: new Date("2026-01-02T00:00:00Z"),
		});
		const state = await service.status(actor);
		expect(state).toMatchObject({
			completed: { access: true, verify: false, call: true },
			firstCall: {
				id: "call",
				target: "read",
				createdAt: "2026-01-02T00:00:00.000Z",
			},
		});
		// The poll reads only the stored selection and activity.
		expect(await service.firstCall(actor)).toEqual({ firstCall: null });
		setRow({ ...progress, connectionId: "configured", agentId: "configured" });
		const before = writes();
		expect(await service.firstCall(actor)).toEqual({
			firstCall: state.firstCall,
		});
		expect(writes()).toBe(before);
		// Skipped setup reads no activity.
		setRow({
			...progress,
			status: "skipped",
			connectionId: "configured",
			agentId: "configured",
		});
		firstCall.mockClear();
		expect(await service.status(actor)).toMatchObject({
			completed: { call: false },
			firstCall: null,
		});
		expect(firstCall).not.toHaveBeenCalled();
	});
});
