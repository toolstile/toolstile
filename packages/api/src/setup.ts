import { createHash } from "node:crypto";
import { ORPCError, os } from "@orpc/server";
import { permitted, type Rules, type Runtime } from "@toolstile/gateway";
import { z } from "zod";
import type { Actor } from "./contract.js";
import type { Services } from "./server.js";
import { type SetupState, setupClients, setupSteps } from "./setup-contract.js";

const selection = z.object({
	connectionId: z.string().min(1).max(200).optional(),
	agentId: z.string().min(1).max(200).optional(),
	client: z.enum(setupClients),
});
const update = selection.extend({
	step: z.enum(setupSteps),
	action: z.enum(["save", "skip", "resume", "finish"]),
});
export type SetupRow = {
	status: SetupState["status"];
	step: SetupState["step"];
	client: SetupState["client"];
	connectionId: string | null;
	agentId: string | null;
	verificationKey: string | null;
	verifiedAt: Date | null;
};
export type SetupDependencies = {
	read(actor: Actor): Promise<SetupRow | undefined>;
	persist(actor: Actor, row: SetupRow): Promise<void>;
	isConnectionReady(
		connection: Awaited<
			ReturnType<Services["snapshot"]>
		>["connections"][number],
	): boolean;
	services: Pick<Services, "snapshot" | "agentCatalog">;
	runtime(actor: Actor, agentId: string): Runtime;
	/**
	 * The earliest retained activity row in the actor's scope that the agent sent to the MCP
	 * endpoint (`origin` agent) as a forwarded `tools/call` on the connection.
	 */
	firstCall(
		actor: Actor,
		input: { agentId: string; connectionId: string },
	): Promise<
		{ id: string; target: string | null; createdAt: Date } | undefined
	>;
};

function usable(agent: {
	canTest: boolean;
	revoked: boolean;
	expiresAt: string | null;
}) {
	return (
		agent.canTest &&
		!agent.revoked &&
		(!agent.expiresAt || new Date(agent.expiresAt) > new Date())
	);
}

function hasAccess(rules: Rules[]) {
	return (
		rules.some((rule) => rule.full) ||
		(["tools", "resources", "prompts"] as const).some((kind) =>
			rules.some((rule) =>
				[
					...rule.allow[kind],
					...(kind === "tools" ? (rule.requireApproval ?? []) : []),
				].some((name) => permitted(rules, kind, name)),
			),
		)
	);
}

/** Inject live authorization and gateway services; this module never imports the runtime. */
export function createSetupService(deps: SetupDependencies) {
	/** Derived from activity on every read and never persisted with the setup row. */
	async function firstCall(
		actor: Actor,
		input: { agentId: string; connectionId: string },
	): Promise<SetupState["firstCall"]> {
		const call = await deps.firstCall(actor, input);
		return call
			? {
					id: call.id,
					target: call.target,
					createdAt: call.createdAt.toISOString(),
				}
			: null;
	}
	async function read(actor: Actor): Promise<SetupRow> {
		const row = await deps.read(actor);
		return (
			row ?? {
				status: "active",
				step: "connect",
				client: "claude-code",
				connectionId: null,
				agentId: null,
				verificationKey: null,
				verifiedAt: null,
			}
		);
	}
	async function derive(
		actor: Actor,
		row: SetupRow,
		data?: Awaited<ReturnType<Services["snapshot"]>>,
	) {
		data ??= await deps.services.snapshot(actor);
		const connection = data.connections.find(
			(entry) => entry.id === row.connectionId,
		);
		const agent = data.agents.find(
			(entry) => entry.id === row.agentId && usable(entry),
		);
		const connected = !!connection && deps.isConnectionReady(connection);
		let access = false,
			key: string | null = null;
		if (connected && agent) {
			try {
				const current = deps.runtime(actor, agent.id);
				await current.authenticate?.();
				const upstream = (await current.connections()).find(
					(entry) => entry.id === connection.id,
				);
				access = !!upstream && hasAccess(upstream.rules);
				if (access && upstream)
					key = createHash("sha256")
						.update(
							JSON.stringify([
								agent.id,
								agent.expiresAt,
								connection.id,
								connection.status,
								upstream.identityKey,
								upstream.rules,
							]),
						)
						.digest("hex");
			} catch (error) {
				// A live revocation is incomplete setup. Infrastructure failures stay visible.
				if (
					!(error instanceof ORPCError) ||
					!["FORBIDDEN", "UNAUTHORIZED"].includes(error.code)
				)
					throw error;
			}
		}
		const verified = !!key && key === row.verificationKey && !!row.verifiedAt;
		// Independent of verification: a call made before verifying still counts. Skipped
		// setup reads no activity.
		const call =
			row.status !== "skipped" && connected && agent
				? await firstCall(actor, {
						agentId: agent.id,
						connectionId: connection.id,
					})
				: null;
		const state: SetupState = {
			status: row.status,
			step: row.step,
			client: row.client,
			connectionId: connection?.id,
			agentId: agent?.id,
			completed: {
				connect: connected,
				agent: !!agent,
				access,
				verify: verified,
				call: !!call,
			},
			verifiedAt:
				verified && row.verifiedAt ? row.verifiedAt.toISOString() : null,
			firstCall: call,
		};
		return { state, key };
	}

	return {
		async status(actor: Actor) {
			let row = await read(actor);
			const data = await deps.services.snapshot(actor);
			// Access can be configured outside the guide. Recover missing selections
			// from live authorized connections, never from a guessed or new grant.
			if (row.status === "active") {
				const selectedConnection = data.connections.find(
					(entry) => entry.id === row.connectionId,
				);
				const activeAgents = data.agents.filter(usable);
				const selectedAgent = activeAgents.find(
					(entry) => entry.id === row.agentId,
				);
				if (!selectedConnection || !selectedAgent) {
					const candidates = selectedAgent ? [selectedAgent] : activeAgents;
					for (const agent of candidates) {
						try {
							const runtime = deps.runtime(actor, agent.id);
							await runtime.authenticate?.();
							const upstreams = await runtime.connections();
							const connection = data.connections.find(
								(entry) =>
									(!selectedConnection || selectedConnection.id === entry.id) &&
									deps.isConnectionReady(entry) &&
									upstreams.some(
										(upstream) =>
											upstream.id === entry.id && hasAccess(upstream.rules),
									),
							);
							if (connection) {
								row = {
									...row,
									connectionId: connection.id,
									agentId: agent.id,
								};
								break;
							}
						} catch (error) {
							if (
								!(error instanceof ORPCError) ||
								!["FORBIDDEN", "UNAUTHORIZED"].includes(error.code)
							)
								throw error;
						}
					}
				}
			}
			const { state } = await derive(actor, row, data);
			if (state.status === "active" && state.completed.access)
				state.step = "verify";
			return state;
		},
		/**
		 * The agents setup can select, without deriving progress. The guide polls this while it
		 * waits for an agent to sign in and reloads the dashboard only when one appears.
		 */
		async agents(actor: Actor) {
			await deps.read(actor);
			const data = await deps.services.snapshot(actor);
			return { agentIds: data.agents.filter(usable).map(({ id }) => id) };
		},
		/**
		 * The stored selection's first call, without deriving the other steps. The guide polls
		 * this while it waits for the agent's first call; it never writes.
		 */
		async firstCall(actor: Actor) {
			const row = await deps.read(actor);
			return {
				firstCall:
					row?.agentId && row.connectionId
						? await firstCall(actor, {
								agentId: row.agentId,
								connectionId: row.connectionId,
							})
						: null,
			};
		},
		async save(actor: Actor, input: z.infer<typeof update>) {
			const previous = await read(actor);
			const row: SetupRow = {
				...previous,
				connectionId: input.connectionId ?? null,
				agentId: input.agentId ?? null,
				client: input.client,
				step: input.step,
				status:
					input.action === "skip"
						? "skipped"
						: input.action === "finish"
							? "finished"
							: "active",
			};
			const { state } = await derive(actor, row);
			if (input.action === "skip" || input.action === "resume") {
				// A deleted or revoked selection must not prevent leaving or resuming setup.
				row.connectionId = state.connectionId ?? null;
				row.agentId = state.agentId ?? null;
			} else if (
				(input.connectionId && state.connectionId !== input.connectionId) ||
				(input.agentId && state.agentId !== input.agentId)
			)
				throw new ORPCError("FORBIDDEN");
			if (
				input.action === "finish" &&
				!Object.values(state.completed).every(Boolean)
			)
				throw new ORPCError("BAD_REQUEST", {
					message:
						"Complete the connection, agent, access, verification and first-call steps first.",
				});
			await deps.persist(actor, row);
			return state;
		},
		async verify(
			actor: Actor,
			input: { connectionId: string; agentId: string },
		) {
			const row = await read(actor);
			row.connectionId = input.connectionId;
			row.agentId = input.agentId;
			const data = await deps.services.snapshot(actor);
			const before = await derive(actor, row, data);
			if (!before.state.completed.access || !before.key)
				throw new ORPCError("FORBIDDEN", {
					message:
						"Choose an active agent and a permitted connection before verifying.",
				});
			// Uses the same authorized catalog path as a dashboard check; never tools/call.
			try {
				await deps.services.agentCatalog(actor, input);
			} catch (error) {
				if (error instanceof ORPCError) throw error;
				const label =
					data.connections.find((entry) => entry.id === input.connectionId)
						?.label ?? "the MCP server";
				throw new ORPCError("BAD_GATEWAY", {
					message: `Couldn't load tools from ${label}. Try again. If it keeps failing, open the connection to check its address and sign-in.`,
					cause: error,
				});
			}
			const after = await derive(actor, row);
			if (before.key !== after.key)
				throw new ORPCError("CONFLICT", {
					message: "Access changed during verification. Check again.",
				});
			row.verificationKey = after.key;
			row.verifiedAt = new Date();
			row.step = "verify";
			await deps.persist(actor, row);
			return (await derive(actor, row)).state;
		},
	};
}
export function createSetupRouter(deps: SetupDependencies) {
	const service = createSetupService(deps);
	const procedure = os.$context<{ actor: Actor }>();
	return {
		setupStatus: procedure.handler(({ context }) =>
			service.status(context.actor),
		),
		setupAgents: procedure.handler(({ context }) =>
			service.agents(context.actor),
		),
		setupFirstCall: procedure.handler(({ context }) =>
			service.firstCall(context.actor),
		),
		saveSetup: procedure
			.input(update)
			.handler(({ context, input }) => service.save(context.actor, input)),
		verifySetup: procedure
			.input(selection.pick({ connectionId: true, agentId: true }).required())
			.handler(({ context, input }) => service.verify(context.actor, input)),
	};
}
export type SetupRouter = ReturnType<typeof createSetupRouter>;
