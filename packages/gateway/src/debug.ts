import { randomUUID } from "node:crypto";
import type { Pool } from "@toolstile/database/sql";
import {
	advisoryLock,
	type Fence,
	holdSharedFence,
	transaction as inTransaction,
} from "@toolstile/database/transaction";
import type { CapturedPayload, CaptureHook } from "./index";
/** Small structural interface keeps the optional diagnostics store host-independent. */
export interface DebugSql {
	query<Row extends Record<string, unknown> = Record<string, unknown>>(
		text: string,
		values?: unknown[],
	): Promise<{
		rows: Row[];
		rowCount: number | null;
	}>;
}
export type DebugPool = Pool;
export interface DebugActor {
	userId: string;
	scopeId: string;
}
export interface DebugSelection {
	agentIds: string[];
	connectionIds: string[];
}
export interface DebugRetention {
	activityRetentionDays: number;
	payloadRetentionHours: number;
}
export interface DebugBox {
	encrypt(value: unknown): string;
	decrypt<T>(value: string): T;
}
type SessionRow = Record<string, unknown> &
	DebugSelection & {
		id: string;
		scopeId: string;
		enabledBy: string;
		stopsAt: Date;
		stoppedAt: Date | null;
		createdAt: Date;
	};
type PayloadRow = {
	id: string;
	agentId: string;
	connectionId: string;
	createdAt: Date;
	expiresAt: Date;
};
const denied = () => new Error("Debug capture unavailable or access denied");
const sensitive =
	/authorization|proxy.?authorization|cookie|password|secret|token|api.?key|oauth|code.?verifier|client.?assertion|headers|^code$/i;
/** Content is bounded before encryption; auth-shaped fields and credential strings are redacted. */
export function boundedDebugPayload(payload: CapturedPayload) {
	let remaining = 12000,
		truncated = false;
	function clean(value: unknown, depth = 0): unknown {
		if (remaining <= 0 || depth > 12) {
			truncated = true;
			return "[truncated]";
		}
		if (typeof value === "string") {
			let text = value
				.replace(
					/([?&](?:code|access_token|refresh_token|client_secret|api_key)=)[^&\s"'<>]+/gi,
					"$1[redacted]",
				)
				.replace(/(https?:\/\/)[^/\s@]+:[^/\s@]+@/gi, "$1[redacted]@")
				.replace(
					/(["'](?:access_token|refresh_token|client_secret|api_key|authorization|password|code_verifier|code)["']\s*:\s*["'])[^"']*/gi,
					"$1[redacted]",
				)
				.replace(/\b(?:Bearer|Basic)\s+[^\s"'<>]+/gi, "[redacted]")
				.replace(
					/((?:access_token|refresh_token|client_secret|api_key|authorization|oauth_code|code_verifier|password)[=:]\s*)[^\s&"'<>]+/gi,
					"$1[redacted]",
				);
			const budget = Math.min(remaining, 8000);
			if (text.length > budget) {
				text = text.slice(0, budget);
				truncated = true;
			}
			remaining -= text.length;
			return text;
		}
		if (Array.isArray(value)) {
			if (value.length > 100) truncated = true;
			return value.slice(0, 100).map((v) => clean(v, depth + 1));
		}
		if (value && typeof value === "object") {
			const entries = Object.entries(value);
			if (entries.length > 100) truncated = true;
			const result: Record<string, unknown> = Object.create(null);
			for (const [key, item] of entries.slice(0, 100)) {
				remaining -= key.length;
				result[key.slice(0, 200)] = sensitive.test(key)
					? "[redacted]"
					: clean(item, depth + 1);
			}
			return result;
		}
		remaining -= 16;
		return value ?? null;
	}
	const result = {
		arguments: clean(payload.arguments),
		result: clean(payload.result),
		truncated,
	};
	if (Buffer.byteLength(JSON.stringify(result)) > 65536)
		return { arguments: "[truncated]", result: "[truncated]", truncated: true };
	return result;
}
/** Callbacks must use the supplied executor, including while a transaction is
 * held. A second pool checkout can deadlock every saturated transaction. */
export function createDebugStore(options: {
	pool: DebugPool;
	box: DebugBox;
	authorize(
		actor: DebugActor,
		selection: DebugSelection | undefined,
		executor: DebugSql,
	): Promise<void>;
	retention(executor: DebugSql): Promise<DebugRetention>;
	/**
	 * Fences a capture change (start, extend, stop) by `actor` holds before its snapshot, so a
	 * concurrent membership or account change is ordered with it. Capture writes take none.
	 */
	fences?(actor: DebugActor): readonly Fence[];
	/**
	 * The fence a capture write holds shared (writers of what `authorize` reads hold it
	 * exclusively). Captures run on every captured call, at read committed: a capture that cannot
	 * get it within a second is dropped rather than delaying the call.
	 */
	captureFence?(scopeId: string): Fence;
	/** Host-owned activity table purged by cleanup(); defaults to `activity`. */
	activityTable?: string;
}) {
	const { pool, box, authorize } = options;
	const activityTable = options.activityTable ?? "activity";
	if (!/^[a-z_][a-z0-9_]*$/.test(activityTable))
		throw new Error("Invalid activity table name");
	async function retention(executor: DebugSql = pool) {
		const r = await options.retention(executor);
		return {
			activityRetentionDays: Math.max(
				1,
				Math.min(3650, r.activityRetentionDays),
			),
			payloadRetentionHours: Math.max(1, Math.min(24, r.payloadRetentionHours)),
		};
	}
	// Serializable (the default): authorization reads conflict with the host's membership and
	// account changes; changes made by a person also hold the host's fences.
	const transaction = <T>(
		actor: DebugActor | undefined,
		work: (tx: DebugSql) => Promise<T>,
	) =>
		inTransaction(pool, work, {
			fences: actor ? options.fences?.(actor) : undefined,
		});
	async function session(
		actor: DebugActor,
		id: string,
		tx: DebugSql,
		live = false,
	) {
		await authorize(actor, undefined, tx);
		const {
			rows: [row],
		} = await tx.query<SessionRow>(
			`select * from debug_sessions where id=$1 and "scopeId"=$2 ${live ? ' and "stoppedAt" is null and "stopsAt">clock_timestamp()' : ""} for update`,
			[id, actor.scopeId],
		);
		if (!row || (live && (row.stoppedAt || row.stopsAt <= new Date())))
			throw denied();
		return row;
	}
	return {
		async status(actor: DebugActor) {
			await authorize(actor, undefined, pool);
			const r = await retention();
			const { rows: sessions } = await pool.query<SessionRow>(
				'select * from debug_sessions where "scopeId"=$1 and ("stoppedAt" is null or "createdAt">clock_timestamp() - $2::double precision * interval \'1 day\') order by "createdAt" desc limit 20',
				[actor.scopeId, r.activityRetentionDays],
			);
			const { rows: payloads } = await pool.query<PayloadRow>(
				'select id,"agentId","connectionId","createdAt","expiresAt" from debug_payloads where "scopeId"=$1 and "expiresAt">clock_timestamp() and "createdAt">clock_timestamp() - $2::double precision * interval \'1 hour\' order by "createdAt" desc limit 100',
				[actor.scopeId, r.payloadRetentionHours],
			);
			return {
				...r,
				sessions: sessions.map((row) => ({
					id: row.id,
					agentIds: row.agentIds,
					connectionIds: row.connectionIds,
					createdAt: row.createdAt.toISOString(),
					stopsAt: row.stopsAt.toISOString(),
					stoppedAt: row.stoppedAt?.toISOString() ?? null,
				})),
				payloads: payloads.map((row) => ({
					...row,
					createdAt: row.createdAt.toISOString(),
					expiresAt: row.expiresAt.toISOString(),
				})),
			};
		},
		async start(actor: DebugActor, input: DebugSelection) {
			const selection = {
				agentIds: [...new Set(input.agentIds)],
				connectionIds: [...new Set(input.connectionIds)],
			};
			if (
				!selection.agentIds.length ||
				!selection.connectionIds.length ||
				selection.agentIds.length > 100 ||
				selection.connectionIds.length > 100
			)
				throw denied();
			await authorize(actor, selection, pool);
			return transaction(actor, async (tx) => {
				// One live session per scope: no row exists to lock before the first one.
				await advisoryLock(tx, `debug:${actor.scopeId}`);
				await authorize(actor, selection, tx);
				await tx.query(
					'update debug_sessions set "stoppedAt"=clock_timestamp() where "scopeId"=$1 and "stoppedAt" is null',
					[actor.scopeId],
				);
				const id = randomUUID();
				await tx.query(
					'insert into debug_sessions(id,"scopeId","enabledBy","agentIds","connectionIds","stopsAt") values($1,$2,$3,$4,$5,clock_timestamp() + (3600000) * interval \'1 millisecond\')',
					[
						id,
						actor.scopeId,
						actor.userId,
						selection.agentIds,
						selection.connectionIds,
					],
				);
				return { id };
			});
		},
		async extend(actor: DebugActor, id: string) {
			// Refuse before checking out a connection; the transaction checks again under its lock.
			await authorize(actor, undefined, pool);
			return transaction(actor, async (tx) => {
				const row = await session(actor, id, tx, true);
				await authorize(
					actor,
					{
						agentIds: row.agentIds,
						connectionIds: row.connectionIds,
					},
					tx,
				);
				await tx.query(
					'update debug_sessions set "stopsAt"=clock_timestamp() + (3600000) * interval \'1 millisecond\',"enabledBy"=$2 where id=$1',
					[id, actor.userId],
				);
				return { ok: true };
			});
		},
		async stop(actor: DebugActor, id: string) {
			await authorize(actor, undefined, pool);
			return transaction(actor, async (tx) => {
				await session(actor, id, tx);
				await tx.query(
					'update debug_sessions set "stoppedAt"=clock_timestamp() where id=$1',
					[id],
				);
				return { ok: true };
			});
		},
		async payload(actor: DebugActor, id: string) {
			await authorize(actor, undefined, pool);
			const r = await retention();
			const {
				rows: [row],
			} = await pool.query<{
				encryptedPayload: string;
			}>(
				'select "encryptedPayload" from debug_payloads where id=$1 and "scopeId"=$2 and "expiresAt">clock_timestamp() and "createdAt">clock_timestamp() - $3::double precision * interval \'1 hour\'',
				[id, actor.scopeId, r.payloadRetentionHours],
			);
			if (!row) throw denied();
			return box.decrypt<{
				arguments: unknown;
				result: unknown;
				truncated: boolean;
			}>(row.encryptedPayload);
		},
		hook(
			actor: DebugActor,
			agentId: string,
			check: (
				executor: DebugSql,
				operation: import("./index").Operation,
			) => Promise<void>,
		): CaptureHook {
			return async (operation) => {
				if (operation.maintenance) return;
				const {
					rows: [row],
				} = await pool.query<SessionRow>(
					'select * from debug_sessions where "scopeId"=$1 and "stoppedAt" is null and "stopsAt">clock_timestamp() and $2 IN (SELECT value FROM jsonb_array_elements_text("agentIds")) and $3 IN (SELECT value FROM jsonb_array_elements_text("connectionIds")) order by "createdAt" desc limit 1',
					[actor.scopeId, agentId, operation.connectionId],
				);
				if (!row) return;
				const enabler = { userId: row.enabledBy, scopeId: actor.scopeId };
				await authorize(enabler, undefined, pool);
				await check(pool, operation);
				return async (payload) => {
					// Read committed: the host fence, then the session row lock, which serializes
					// this session's captures so the bound below is exact; everything is read after.
					await inTransaction(
						pool,
						async (tx) => {
							const fence = options.captureFence?.(actor.scopeId);
							if (fence)
								try {
									await holdSharedFence(tx, fence, 1000);
								} catch (error) {
									if (
										error &&
										typeof error === "object" &&
										"code" in error &&
										error.code === "55P03"
									)
										return;
									throw error;
								}
							await session(enabler, row.id, tx, true);
							await check(tx, operation);
							await authorize(enabler, undefined, tx);
							const {
								rows: [count],
							} = await tx.query<{
								count: number;
							}>(
								'select count(*) as count from debug_payloads where "sessionId"=$1',
								[row.id],
							);
							if (count.count >= 1000) return;
							const r = await retention(tx);
							await tx.query(
								'insert into debug_payloads(id,"scopeId","sessionId","agentId","connectionId","encryptedPayload","expiresAt") values($1,$2,$3,$4,$5,$6,now() + $7::double precision * interval \'1 hour\') on conflict(id) do nothing',
								[
									operation.id,
									actor.scopeId,
									row.id,
									agentId,
									operation.connectionId,
									box.encrypt(boundedDebugPayload(payload)),
									r.payloadRetentionHours,
								],
							);
						},
						{ isolation: "read committed", retries: 8 },
					);
				};
			};
		},
		async cleanup() {
			const r = await retention();
			await pool.query(
				'delete from debug_payloads where "expiresAt"<=clock_timestamp() or "createdAt"<=clock_timestamp() - $1::double precision * interval \'1 hour\'',
				[r.payloadRetentionHours],
			);
			await pool.query(
				'update debug_sessions set "stoppedAt"="stopsAt" where "stoppedAt" is null and "stopsAt"<=clock_timestamp()',
			);
			await pool.query(
				"delete from debug_sessions where \"createdAt\"<=clock_timestamp() - $1::double precision * interval '1 day'",
				[r.activityRetentionDays],
			);
			await pool.query(
				`delete from "${activityTable}" where "createdAt"<=clock_timestamp() - $1::double precision * interval '1 day'`,
				[r.activityRetentionDays],
			);
		},
	};
}
