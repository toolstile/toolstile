import { randomUUID } from "node:crypto";
import { ORPCError, os } from "@orpc/server";
import { type Pool, statement } from "@toolstile/database/sql";
import {
	advisoryLock,
	type Fence,
	transaction,
} from "@toolstile/database/transaction";
import type { DebugSql, ObservedTool, ToolReview } from "@toolstile/gateway";
import type { z } from "zod";
import { type Actor, mutationView } from "./contract.js";
import {
	type ToolChange,
	type ToolReviewStatus,
	type ToolReviewSummary,
	toolReviewAcceptInput,
	toolReviewConnectionInput,
	toolReviewModeInput,
	toolReviewStatusView,
	toolReviewSummaryView,
} from "./tool-review-contract.js";
export type ToolReviewSql = DebugSql;
export type ToolReviewChange =
	| {
			kind: "enabled";
			connectionId: string;
			tools: number;
	  }
	| {
			kind: "disabled";
			connectionId: string;
	  }
	| {
			kind: "accepted";
			connectionId: string;
			tools: string[];
	  };
/**
 * Host tables, each keyed by the host's own scope (`scopeId`) and gateway connection id:
 * - settings: `scopeId`, `connectionId` (unique), `enabledBy`, `enabledAt`
 * - definitions: `id`, `scopeId`, `connectionId`, `name`, `digest`, `snapshot`, `observedAt`,
 *   unique over (`connectionId`, `name`, `digest`)
 * - reviews: `scopeId`, `connectionId`, `name`, `digest`, `reviewedBy`, `reviewedAt`, unique
 *   over (`connectionId`, `name`)
 */
export interface ToolReviewStoreOptions<A extends Actor = Actor> {
	pool: Pool;
	tables: {
		settings: string;
		definitions: string;
		reviews: string;
	};
	/**
	 * Live authorization on the given executor: whether the actor may change review of this
	 * connection. Throw when its review status is not visible to them.
	 */
	authorize(
		executor: ToolReviewSql,
		actor: A,
		connectionId: string,
	): Promise<{
		canReview: boolean;
	}>;
	/**
	 * Fences a review change holds before its snapshot: the host's exclusive fence for a change
	 * to state its gateway and approval bindings read, and the actor's own fence.
	 */
	fences?(actor: A): readonly Fence[];
	/** Connections in the actor's scope whose review status they may see. */
	visible(actor: A): Promise<
		{
			id: string;
			label: string;
		}[]
	>;
	/** Every live tool definition of the connection, read when review is switched on. */
	baseline(actor: A, connectionId: string): Promise<ObservedTool[]>;
	/** Records the change inside its transaction (for example an audit log). */
	record?(
		executor: ToolReviewSql,
		actor: A,
		change: ToolReviewChange,
	): Promise<void>;
	/** After a committed change: drop open agent sessions so they list tools again. */
	changed?(actor: A, connectionId: string): Promise<void>;
	/** A newly observed definition is waiting; notify whoever reviews this connection. */
	waiting?(
		scopeId: string,
		connectionId: string,
		tools: string[],
	): Promise<void>;
}
export interface ToolReviewServices {
	toolReviewSummary(actor: Actor): Promise<ToolReviewSummary>;
	toolReviewStatus(
		actor: Actor,
		connectionId: string,
	): Promise<ToolReviewStatus>;
	setToolReview(
		actor: Actor,
		input: z.infer<typeof toolReviewModeInput>,
	): Promise<{
		ok: boolean;
	}>;
	acceptToolChanges(
		actor: Actor,
		input: z.infer<typeof toolReviewAcceptInput>,
	): Promise<{
		ok: boolean;
	}>;
}
const MAX_OBSERVED = 1000;
/** Versions waiting for review per connection; the oldest are dropped beyond it. */
const MAX_WAITING = 1000;
/** Waiting changes returned per status read; the count covers the rest. */
const MAX_SHOWN = 100;
const forbidden = () =>
	new ORPCError("FORBIDDEN", { message: "Unavailable or access denied" });
export function createToolReviewStore<A extends Actor = Actor>(
	options: ToolReviewStoreOptions<A>,
) {
	for (const name of Object.values(options.tables))
		if (!/^[a-z_][a-z0-9_]*$/.test(name))
			throw new Error("Invalid tool review table name");
	const settings = `"${options.tables.settings}"`;
	const definitions = `"${options.tables.definitions}"`;
	const reviews = `"${options.tables.reviews}"`;
	const { pool } = options;
	async function observe(
		scopeId: string,
		connectionId: string,
		tools: ObservedTool[],
	) {
		// One version per name; a server listing a name twice cannot write it twice.
		const unique = [
			...new Map(
				tools
					.filter((tool) => tool.digest !== "unrepresentable")
					.slice(0, MAX_OBSERVED)
					.map((tool) => [tool.name, tool] as const),
			).values(),
		];
		if (!unique.length) return;
		const accepted = `not exists(select 1 from ${reviews} r where r."connectionId"=d."connectionId" and r.name=d.name and r.digest=d.digest)`;
		const definitionsJson = JSON.stringify(
			unique.map((tool) => ({
				id: randomUUID(),
				name: tool.name,
				digest: tool.digest,
				snapshot: tool.snapshot ?? null,
			})),
		);
		const statements = [
			statement(
				`insert into ${definitions}(id, "scopeId", "connectionId", name, digest, snapshot)
                 select i.value->>'id', $1, $2, i.value->>'name', i.value->>'digest', i.value->>'snapshot'
                 from jsonb_array_elements($3::jsonb) i
                 where exists (select 1 from ${settings} where "connectionId"=$2 and "scopeId"=$1)
                 on conflict("connectionId",name,digest) do nothing returning name`,
				[scopeId, connectionId, definitionsJson],
			),
			statement(
				`update ${definitions} AS d set "observedAt"=clock_timestamp()
                where d."connectionId"=$1 and exists(select 1 from jsonb_array_elements($2::jsonb) i where i.value->>'name'=d.name and i.value->>'digest'=d.digest)`,
				[connectionId, definitionsJson],
			),
			statement(
				`delete from ${definitions} AS d where d."connectionId"=$1 and ${accepted}
                and exists(select 1 from jsonb_array_elements($2::jsonb) i where i.value->>'name'=d.name and i.value->>'digest'<>d.digest)`,
				[connectionId, definitionsJson],
			),
			statement(
				`delete from ${definitions} where id in(select d.id from ${definitions} d where d."connectionId"=$1 and ${accepted}
                order by d."observedAt" desc,d.id OFFSET ${MAX_WAITING})`,
				[connectionId],
			),
		];
		// Read committed: observation runs on every tool listing and every statement is an
		// idempotent upsert or delete keyed by connection, name and digest.
		const inserted = await transaction(
			pool,
			async (tx) => {
				const results = [];
				for (const { sql, params } of statements)
					results.push(await tx.query<{ name: string }>(sql, params));
				return results[0];
			},
			{ isolation: "read committed" },
		);
		const fresh = inserted.rows.map((row) => String(row.name));
		if (fresh.length)
			await options.waiting?.(scopeId, connectionId, fresh).catch(() => {});
	}
	/** Reviews for the connections that have review switched on, read on the given executor. */
	async function forConnections(
		executor: ToolReviewSql,
		scopeId: string,
		connectionIds: string[],
	): Promise<Map<string, ToolReview>> {
		const result = new Map<string, ToolReview>();
		if (!connectionIds.length) return result;
		const { rows: enabled } = await executor.query<{
			connectionId: string;
		}>(
			`select "connectionId" from ${settings} where "scopeId" = $1 and "connectionId" IN (SELECT value FROM jsonb_array_elements_text($2))`,
			[scopeId, connectionIds],
		);
		if (!enabled.length) return result;
		const ids = enabled.map((row) => row.connectionId);
		const { rows } = await executor.query<{
			connectionId: string;
			name: string;
			digest: string;
		}>(
			`select "connectionId", name, digest from ${reviews}
\t\t\twhere "scopeId" = $1 and "connectionId" IN (SELECT value FROM jsonb_array_elements_text($2))`,
			[scopeId, ids],
		);
		for (const id of ids) {
			const reviewed = new Map(
				rows
					.filter((row) => row.connectionId === id)
					.map((row) => [row.name, row.digest] as const),
			);
			result.set(id, {
				reviewed,
				observe: (tools) => observe(scopeId, id, tools),
			});
		}
		return result;
	}
	async function status(
		executor: ToolReviewSql,
		actor: A,
		connectionId: string,
	): Promise<ToolReviewStatus> {
		const { canReview } = await options.authorize(
			executor,
			actor,
			connectionId,
		);
		const {
			rows: [setting],
		} = await executor.query<{
			enabledAt: Date;
		}>(
			`select "enabledAt" from ${settings} where "scopeId" = $1 and "connectionId" = $2`,
			[actor.scopeId, connectionId],
		);
		if (!setting)
			return {
				connectionId,
				enabled: false,
				enabledAt: null,
				canReview,
				reviewedCount: 0,
				pendingCount: 0,
				pending: [],
			};
		const {
			rows: [count],
		} = await executor.query<{
			n: number;
			waiting: number;
		}>(
			`select (select count(*) from ${reviews} where "scopeId" = $1 and "connectionId" = $2) as n,
\t\t\t(select count(*) from ${definitions} d left join ${reviews} r
\t\t\t\ton r."connectionId" = d."connectionId" and r.name = d.name
\t\t\t\twhere d."scopeId" = $1 and d."connectionId" = $2 and r.digest is distinct from d.digest) as waiting`,
			[actor.scopeId, connectionId],
		);
		const { rows } = await executor.query<{
			name: string;
			digest: string;
			snapshot: string | null;
			observedAt: Date;
			previousDigest: string | null;
			previousSnapshot: string | null;
		}>(
			`select d.name, d.digest, d.snapshot, d."observedAt",
\t\t\t\tr.digest as "previousDigest", p.snapshot as "previousSnapshot"
\t\t\tfrom ${definitions} d
\t\t\tleft join ${reviews} r on r."connectionId" = d."connectionId" and r.name = d.name
\t\t\tleft join ${definitions} p on p."connectionId" = r."connectionId" and p.name = r.name
\t\t\t\tand p.digest = r.digest
\t\t\twhere d."scopeId" = $1 and d."connectionId" = $2 and r.digest is distinct from d.digest
\t\t\torder by d."observedAt" desc, d.name
\t\t\tlimit ${MAX_SHOWN}`,
			[actor.scopeId, connectionId],
		);
		return {
			connectionId,
			enabled: true,
			enabledAt: setting.enabledAt.toISOString(),
			canReview,
			reviewedCount: count?.n ?? 0,
			pendingCount: count?.waiting ?? 0,
			pending: rows.map(
				(row): ToolChange => ({
					name: row.name,
					digest: row.digest,
					...(row.snapshot ? { snapshot: row.snapshot } : {}),
					observedAt: row.observedAt.toISOString(),
					...(row.previousDigest
						? {
								previous: {
									digest: row.previousDigest,
									...(row.previousSnapshot
										? { snapshot: row.previousSnapshot }
										: {}),
								},
							}
						: {}),
				}),
			),
		};
	}
	/** This connection's review key, then authorization (the host's fences are already held). */
	async function reviewer(tx: ToolReviewSql, actor: A, connectionId: string) {
		// One change at a time per connection keeps the baseline and accepted set consistent;
		// enabling review has no settings row to lock yet.
		await advisoryLock(tx, `tool-review:${connectionId}`);
		const { canReview } = await options.authorize(tx, actor, connectionId);
		if (!canReview) throw forbidden();
	}
	const services: ToolReviewServices = {
		async toolReviewSummary(actor) {
			const visible = await options.visible(actor as A);
			if (!visible.length) return { connections: [] };
			const { rows } = await pool.query<{
				connectionId: string;
				pending: number;
			}>(
				`select s."connectionId", (select count(*) from ${definitions} d
\t\t\t\t\tleft join ${reviews} r on r."connectionId" = d."connectionId" and r.name = d.name
\t\t\t\t\twhere d."connectionId" = s."connectionId" and r.digest is distinct from d.digest
\t\t\t\t) as pending
\t\t\t\tfrom ${settings} s where s."scopeId" = $1 and s."connectionId" IN (SELECT value FROM jsonb_array_elements_text($2))`,
				[actor.scopeId, visible.map((connection) => connection.id)],
			);
			const enabled = new Map(
				rows.map((row) => [row.connectionId, row.pending]),
			);
			return {
				connections: visible.map((connection) => ({
					connectionId: connection.id,
					label: connection.label,
					enabled: enabled.has(connection.id),
					pending: enabled.get(connection.id) ?? 0,
				})),
			};
		},
		toolReviewStatus: (actor, connectionId) =>
			status(pool, actor as A, connectionId),
		async setToolReview(actor, input) {
			const a = actor as A;
			// Check before reading the live catalog, which the reviewer's check would otherwise wait on.
			const { canReview } = await options.authorize(
				pool,
				a,
				input.connectionId,
			);
			if (!canReview) throw forbidden();
			// The live catalog is read outside the transaction; failing to read it leaves review off.
			const baseline = input.enabled
				? await options.baseline(a, input.connectionId)
				: [];
			await transaction(
				pool,
				async (tx) => {
					await reviewer(tx, a, input.connectionId);
					if (!input.enabled) {
						for (const table of [settings, definitions, reviews])
							await tx.query(
								`delete from ${table} where "scopeId" = $1 and "connectionId" = $2`,
								[actor.scopeId, input.connectionId],
							);
						await options.record?.(tx, a, {
							kind: "disabled",
							connectionId: input.connectionId,
						});
						return;
					}
					const existing = await tx.query(
						`select 1 from ${settings} where "connectionId"=$1`,
						[input.connectionId],
					);
					if (existing.rowCount) return;
					await tx.query(
						`insert into ${settings} ("scopeId","connectionId","enabledBy") values($1,$2,$3)`,
						[actor.scopeId, input.connectionId, actor.userId],
					);
					const accepted = baseline
						.filter((tool) => tool.digest !== "unrepresentable")
						.slice(0, MAX_OBSERVED);
					for (const tool of accepted) {
						await tx.query(
							`insert into ${definitions} (id, "scopeId", "connectionId", name, digest, snapshot)
\t\t\t\t\t\tvalues ($1, $2, $3, $4, $5, $6) on conflict ("connectionId", name, digest) do nothing`,
							[
								randomUUID(),
								actor.scopeId,
								input.connectionId,
								tool.name,
								tool.digest,
								tool.snapshot ?? null,
							],
						);
						await tx.query(
							`insert into ${reviews} ("scopeId", "connectionId", name, digest, "reviewedBy")
\t\t\t\t\t\tvalues ($1, $2, $3, $4, $5) on conflict ("connectionId", name) do nothing`,
							[
								actor.scopeId,
								input.connectionId,
								tool.name,
								tool.digest,
								actor.userId,
							],
						);
					}
					await options.record?.(tx, a, {
						kind: "enabled",
						connectionId: input.connectionId,
						tools: accepted.length,
					});
				},
				{ fences: options.fences?.(a) },
			);
			await options.changed?.(a, input.connectionId);
			return { ok: true };
		},
		async acceptToolChanges(actor, input) {
			const a = actor as A;
			await transaction(
				pool,
				async (tx) => {
					await reviewer(tx, a, input.connectionId);
					const {
						rows: [setting],
					} = await tx.query(
						`select 1 from ${settings} where "scopeId" = $1 and "connectionId" = $2`,
						[actor.scopeId, input.connectionId],
					);
					if (!setting)
						throw new ORPCError("CONFLICT", {
							message: "Tool review is off for this connection",
						});
					for (const tool of input.tools) {
						const {
							rows: [observed],
						} = await tx.query(
							`select 1 from ${definitions} where "scopeId" = $1 and "connectionId" = $2
\t\t\t\t\t\tand name = $3 and digest = $4`,
							[actor.scopeId, input.connectionId, tool.name, tool.digest],
						);
						// Only a version Toolstile observed can be accepted; anything else was never shown.
						if (!observed)
							throw new ORPCError("CONFLICT", {
								message: `${tool.name} changed again; reload and review the latest version`,
							});
					}
					const accepted: string[] = [];
					for (const tool of input.tools) {
						await tx.query(
							`insert into ${reviews} ("scopeId", "connectionId", name, digest, "reviewedBy")
\t\t\t\t\t\tvalues ($1, $2, $3, $4, $5) on conflict ("connectionId", name)
\t\t\t\t\t\tdo update set digest = excluded.digest, "reviewedBy" = excluded."reviewedBy",
\t\t\t\t\t\t\t"reviewedAt" = clock_timestamp()`,
							[
								actor.scopeId,
								input.connectionId,
								tool.name,
								tool.digest,
								actor.userId,
							],
						);
						await tx.query(
							`delete from ${definitions} where "connectionId" = $1 and name = $2 and digest <> $3`,
							[input.connectionId, tool.name, tool.digest],
						);
						accepted.push(tool.name);
					}
					await options.record?.(tx, a, {
						kind: "accepted",
						connectionId: input.connectionId,
						tools: accepted,
					});
				},
				{ fences: options.fences?.(a) },
			);
			await options.changed?.(a, input.connectionId);
			return { ok: true };
		},
	};
	return { forConnections, observe, services };
}
export interface ToolReviewContext {
	actor: Actor;
	services: ToolReviewServices;
	dashboardSession?: boolean;
}
export function createToolReviewRouter() {
	const procedure = os
		.$context<ToolReviewContext>()
		.use(({ context, next }) => {
			if (context.dashboardSession !== true || !context.actor.sessionId)
				throw new ORPCError("UNAUTHORIZED");
			return next();
		});
	return {
		toolReviewSummary: procedure
			.output(toolReviewSummaryView)
			.handler(({ context }) =>
				context.services.toolReviewSummary(context.actor),
			),
		toolReviewStatus: procedure
			.input(toolReviewConnectionInput)
			.output(toolReviewStatusView)
			.handler(({ context, input }) =>
				context.services.toolReviewStatus(context.actor, input.connectionId),
			),
		setToolReview: procedure
			.input(toolReviewModeInput)
			.output(mutationView)
			.handler(({ context, input }) =>
				context.services.setToolReview(context.actor, input),
			),
		acceptToolChanges: procedure
			.input(toolReviewAcceptInput)
			.output(mutationView)
			.handler(({ context, input }) =>
				context.services.acceptToolChanges(context.actor, input),
			),
	};
}
export type ToolReviewRouter = ReturnType<typeof createToolReviewRouter>;
