import { createHmac, randomUUID } from "node:crypto";
import { ORPCError, os } from "@orpc/server";
import type { Pool } from "@toolstile/database/sql";
import {
	advisoryLock,
	type Fence,
	transaction as inTransaction,
} from "@toolstile/database/transaction";
import type {
	ApprovalBegin,
	ApprovalParameters,
	ApprovalRequest,
	DebugSql,
	RuntimeApprovals,
} from "@toolstile/gateway";
import { z } from "zod";
import {
	APPROVAL_PAGE_SIZE,
	type ApprovalDetail,
	type ApprovalList,
	type ApprovalListInput,
	type ApprovalStatus,
	type ApprovalSummary,
	approvalDecisionInput,
	approvalDetail,
	approvalListInput,
	approvalListView,
} from "./approval-contract.js";
import type { Actor } from "./contract.js";
import { mutationView } from "./contract.js";
export type ApprovalSql = DebugSql;
export type ApprovalPool = Pool;
export const APPROVAL_PENDING_MINUTES = 15;
export const APPROVAL_APPROVED_MINUTES = 10;
export const APPROVAL_PENDING_LIMIT = 20;
/** Host table: `id`, `scopeId`, `requesterId`, `agentId` plus approvalColumns(). */
export interface ApprovalRow extends Record<string, unknown> {
	id: string;
	scopeId: string;
	requesterId: string;
	agentId: string;
	connectionId: string;
	connectionLabel: string;
	agentLabel: string;
	tool: string;
	fingerprint: string;
	encryptedRequest: string | null;
	status: ApprovalStatus;
	expiresAt: Date;
	decidedBy: string | null;
	decidedAt: Date | null;
	claimedOperationId: string | null;
	claimedAt: Date | null;
	settledAt: Date | null;
	createdAt: Date;
}
/** Who is asking: fixed by the host from its authenticated agent, never from the request. */
export interface ApprovalRequester {
	scopeId: string;
	requesterId: string;
	agentId: string;
	agentLabel: string;
}
export interface ApprovalStoreOptions<A extends Actor = Actor> {
	pool: ApprovalPool;
	/** Host-owned table name. */
	table: string;
	/** The host's existing secret box for ENCRYPTION_KEY. */
	box: {
		encrypt(value: unknown): string;
		decrypt<T>(value: string): T;
	};
	/** The host's existing ENCRYPTION_KEY (hex); a derived subkey keys fingerprints. */
	secret: string;
	/**
	 * Live reviewer authorization for actor.scopeId, run on the given executor (inside the
	 * decision transaction when deciding). Never check out another pool connection here.
	 */
	canReview(
		executor: ApprovalSql,
		actor: A,
		row?: ApprovalRow,
	): Promise<boolean>;
	/**
	 * Live binding at decision and at claim, on the given executor: rebuild the requester's
	 * current upstream (account/credential and rules) and return approvalRequest(upstream,
	 * parameters), or false. At claim also recheck that row.decidedBy is still a reviewer.
	 * The store compares the keyed fingerprint itself.
	 */
	validate(
		executor: ApprovalSql,
		row: ApprovalRow,
		parameters: ApprovalParameters,
	): Promise<ApprovalRequest | false>;
	/**
	 * Fences the store's own transactions hold (before their snapshot): those that order this
	 * scope's approvals with the host's writers of what canReview and validate read. `actor` is
	 * the reviewer for decisions. A consumption inside the host's transaction takes none.
	 */
	fences?(scopeId: string, actor?: A): readonly Fence[];
	/** Trusted, host-built dashboard link for a request. */
	reviewUrl?(
		row: Pick<ApprovalRow, "id" | "scopeId">,
		executor: ApprovalSql,
	): string | undefined | Promise<string | undefined>;
}
export interface ApprovalServices {
	listApprovals(actor: Actor, input: ApprovalListInput): Promise<ApprovalList>;
	approvalDetail(actor: Actor, id: string): Promise<ApprovalDetail>;
	decideApproval(
		actor: Actor,
		input: z.infer<typeof approvalDecisionInput>,
	): Promise<{
		ok: boolean;
	}>;
}
export class ApprovalLimitError extends Error {
	constructor() {
		super(
			"Too many tool calls are waiting for approval; ask a reviewer to decide them first",
		);
	}
}
/** The claim is no longer this operation's to forward; nothing may be sent. */
export class ApprovalUnavailableError extends Error {
	constructor() {
		super(
			"The approved tool call is no longer available; request approval again",
		);
	}
}
type Stored = {
	v: 1;
	id: string;
	scopeId: string;
	agentId: string;
	connectionId: string;
	tool: string;
	parameters: ApprovalParameters;
};
const active = "('pending','approved','claimed')";
const notFound = () =>
	new ORPCError("NOT_FOUND", { message: "Approval request not found" });
const conflict = (message: string) => new ORPCError("CONFLICT", { message });
export function createApprovalStore<A extends Actor = Actor>(
	options: ApprovalStoreOptions<A>,
) {
	if (!/^[a-z_][a-z0-9_]*$/.test(options.table))
		throw new Error("Invalid approval table name");
	const table = `"${options.table}"`;
	const key = createHmac("sha256", Buffer.from(options.secret, "hex"))
		.update("toolstile/approval-fingerprint/v1")
		.digest();
	const fingerprint = (binding: string) =>
		createHmac("sha256", key).update(binding).digest("base64url");
	const { pool } = options;
	// Read committed: each action locks the approval row it changes (or, for a new request,
	// the requester's approval key) before reading the state it decides on.
	// Serializable (the default): binding reads conflict with the host's configuration changes.
	const transaction = <T>(
		fences: readonly Fence[] | undefined,
		work: (tx: ApprovalSql) => Promise<T>,
	) => inTransaction(pool, work, { fences });
	/**
	 * Opportunistic expiry: no scheduler. Payloads never outlive a terminal state. Time running out
	 * is always `expired`, whatever the active state; `invalidated` means access or binding changed.
	 */
	async function sweep(executor: ApprovalSql, scopeId: string) {
		await executor.query(
			`update ${table} set status = 'expired', "encryptedRequest" = null, "settledAt" = clock_timestamp()
\t\t\twhere "scopeId" = $1 and status in ${active} and "expiresAt" <= clock_timestamp()`,
			[scopeId],
		);
	}
	function decrypt(row: ApprovalRow): ApprovalParameters | undefined {
		if (!row.encryptedRequest) return undefined;
		const stored = options.box.decrypt<Stored>(row.encryptedRequest);
		if (
			stored.v !== 1 ||
			stored.id !== row.id ||
			stored.scopeId !== row.scopeId ||
			stored.agentId !== row.agentId ||
			stored.connectionId !== row.connectionId ||
			stored.tool !== row.tool
		)
			throw new Error("Approval payload does not match its request");
		return stored.parameters;
	}
	async function bound(tx: ApprovalSql, row: ApprovalRow) {
		const parameters = decrypt(row);
		if (!parameters) return false;
		const current = await options.validate(tx, row, parameters);
		return !!current && fingerprint(current.binding) === row.fingerprint;
	}
	async function expire(tx: ApprovalSql, id: string) {
		await tx.query(
			`update ${table} set status = 'expired', "encryptedRequest" = null, "settledAt" = clock_timestamp()
\t\t\twhere id = $1 and status in ${active}`,
			[id],
		);
	}
	async function invalidate(tx: ApprovalSql, id: string) {
		await tx.query(
			`update ${table} set status = 'invalidated', "encryptedRequest" = null, "settledAt" = clock_timestamp()
\t\t\twhere id = $1 and status in ${active}`,
			[id],
		);
	}
	const reference = async (
		tx: ApprovalSql,
		row: Pick<ApprovalRow, "id" | "scopeId" | "expiresAt">,
		kind: "pending" | "denied" | "busy",
	) => ({
		kind,
		id: row.id,
		expiresAt: row.expiresAt,
		reviewUrl: await options.reviewUrl?.(row, tx),
	});
	/**
	 * Wall-clock validity of a row this transaction already locked. A separate statement after
	 * the lock: a value computed by the locking statement would predate any wait for the lock.
	 */
	async function live(tx: ApprovalSql, row: ApprovalRow) {
		const {
			rows: [now],
		} = await tx.query<{ live: boolean }>(
			`select "expiresAt" > clock_timestamp() as live from ${table} where id = $1`,
			[row.id],
		);
		return { ...row, live: !!now?.live };
	}
	/** Locks this operation's approval row, whatever its status, before it is inspected. */
	async function held(
		tx: ApprovalSql,
		requester: ApprovalRequester,
		id: string,
		operationId: string,
	) {
		const {
			rows: [row],
		} = await tx.query<ApprovalRow>(
			`select * from ${table}
			where id = $1 and "scopeId" = $2 and "agentId" = $3 and "claimedOperationId" = $4
			for update`,
			[id, requester.scopeId, requester.agentId, operationId],
		);
		return row && live(tx, row);
	}
	async function claimed(
		tx: ApprovalSql,
		requester: ApprovalRequester,
		id: string,
		operationId: string,
	) {
		const row = await held(tx, requester, id, operationId);
		return row?.status === "claimed" ? row : undefined;
	}
	async function consumeIn(
		tx: ApprovalSql,
		requester: ApprovalRequester,
		id: string,
		operationId: string,
	) {
		// A concurrent consumption of the same operation waits on the row lock, then sees it done.
		const row = await held(tx, requester, id, operationId);
		if (row?.status === "consumed") return true;
		if (row?.status !== "claimed") return false;
		if (!row.live) {
			await expire(tx, id);
			return false;
		}
		if (!(await bound(tx, row))) {
			await invalidate(tx, id);
			return false;
		}
		// Validity is judged again by this statement, after binding validation took its time.
		const consumed = await tx.query(
			`update ${table} set status='consumed',"encryptedRequest"=null,"settledAt"=clock_timestamp()
			where id=$1 and status='claimed' and "expiresAt">clock_timestamp() returning id`,
			[id],
		);
		if (consumed.rowCount) return true;
		await expire(tx, id);
		return false;
	}

	/**
	 * Atomically re-binds and consumes exactly this operation's claim; idempotent for the same
	 * operation. Pass the host's admission transaction so consumption commits with metering.
	 *
	 * With a host transaction, a refusal's expiry/invalidation is written in that transaction and
	 * rolls back with it (the claim row is locked there, so no other connection could record it).
	 * The claim then stays `claimed`: the host must call runtime release() for this operation after
	 * rolling back, as the gateway does when admission fails; release re-checks expiry and binding
	 * and settles the claim. Without an executor the refusal commits on its own.
	 */
	async function consume(
		requester: ApprovalRequester,
		id: string,
		operationId: string,
		executor?: ApprovalSql,
	) {
		const ok = executor
			? await consumeIn(executor, requester, id, operationId)
			: await transaction(options.fences?.(requester.scopeId), (tx) =>
					consumeIn(tx, requester, id, operationId),
				);
		if (!ok) throw new ApprovalUnavailableError();
	}
	function runtime(requester: ApprovalRequester): RuntimeApprovals {
		const owner = [requester.scopeId, requester.agentId];
		return {
			begin: (request: ApprovalRequest, operationId: string) =>
				transaction<ApprovalBegin>(
					options.fences?.(requester.scopeId),
					async (tx) => {
						// Serializes one requester's approvals (across all their agents) so dedupe and
						// the pending bound cannot race; no row exists yet for a new request.
						await advisoryLock(
							tx,
							`${options.table}:${requester.scopeId}:${requester.requesterId}`,
						);
						const print = fingerprint(request.binding);
						const {
							rows: [locked],
						} = await tx.query<ApprovalRow>(
							`select * from ${table}
                    where "scopeId"=$1 and "agentId"=$2 and fingerprint=$3 and status in ('pending','approved','claimed','denied')
                    order by case when status='denied' then 1 else 0 end,"createdAt" desc,id desc limit 1 for update`,
							[...owner, print],
						);
						const row = locked && (await live(tx, locked));
						let invalid = false;
						if (row?.live) {
							if (row.status === "approved") {
								if (await bound(tx, row)) {
									const claimed = await tx.query(
										`update ${table} set status='claimed',"claimedOperationId"=$2,"claimedAt"=clock_timestamp()
									where id=$1 and status='approved' and "expiresAt">clock_timestamp() returning id`,
										[row.id, operationId],
									);
									if (claimed.rowCount) return { kind: "permit", id: row.id };
									// It lapsed while being re-bound: a new request follows.
									await expire(tx, row.id);
								} else invalid = true;
							} else
								return reference(
									tx,
									row,
									row.status === "claimed"
										? "busy"
										: row.status === "denied"
											? "denied"
											: "pending",
								);
						}
						const {
							rows: [count],
						} = await tx.query<{ count: number }>(
							`select count(*) as count from ${table} where "scopeId"=$1 and "requesterId"=$2 and status='pending' and "expiresAt">clock_timestamp()`,
							[requester.scopeId, requester.requesterId],
						);
						if (count.count >= APPROVAL_PENDING_LIMIT)
							throw new ApprovalLimitError();
						const id = randomUUID();
						const expiresAt = new Date(
							Date.now() + APPROVAL_PENDING_MINUTES * 60000,
						);
						const pending = await reference(
							tx,
							{ id, scopeId: requester.scopeId, expiresAt },
							"pending",
						);
						const stored: Stored = {
							v: 1,
							id,
							scopeId: requester.scopeId,
							agentId: requester.agentId,
							connectionId: request.connectionId,
							tool: request.tool,
							parameters: request.parameters,
						};
						if (
							row &&
							!row.live &&
							["pending", "approved", "claimed"].includes(row.status)
						)
							await expire(tx, row.id);
						else if (row && invalid) await invalidate(tx, row.id);
						await tx.query(
							`insert into ${table} (id,"scopeId","requesterId","agentId","connectionId","connectionLabel","agentLabel",tool,fingerprint,"encryptedRequest",status,"expiresAt") values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending',$11)`,
							[
								id,
								requester.scopeId,
								requester.requesterId,
								requester.agentId,
								request.connectionId,
								request.connectionLabel,
								requester.agentLabel,
								request.tool,
								print,
								options.box.encrypt(stored),
								expiresAt,
							],
						);
						return pending;
					},
				),
			async release(id, operationId) {
				await transaction(options.fences?.(requester.scopeId), async (tx) => {
					const row = await claimed(tx, requester, id, operationId);
					if (!row) return;
					if (!row.live) return expire(tx, id);
					// A refused account or rule revision must not restore a usable approval.
					if (!(await bound(tx, row))) return invalidate(tx, id);
					await tx.query(
						`update ${table} set status = 'approved', "claimedOperationId" = null, "claimedAt" = null
\t\t\t\t\t\twhere id = $1 and status = 'claimed'`,
						[id],
					);
				});
			},
			async settle(id, operationId, outcome) {
				if (outcome === "consumed") return consume(requester, id, operationId);
				await pool.query(
					`update ${table} set status = 'invalidated', "encryptedRequest" = null, "settledAt" = clock_timestamp()
\t\t\t\t\twhere id = $1 and "scopeId" = $2 and "agentId" = $3
\t\t\t\t\t\tand status = 'claimed' and "claimedOperationId" = $4`,
					[id, ...owner, operationId],
				);
			},
		};
	}
	function summary(row: ApprovalRow, canDecide: boolean): ApprovalSummary {
		return {
			id: row.id,
			connectionId: row.connectionId,
			connectionLabel: row.connectionLabel,
			agentId: row.agentId,
			agentLabel: row.agentLabel,
			tool: row.tool,
			status: row.status,
			createdAt: row.createdAt.toISOString(),
			expiresAt: row.expiresAt.toISOString(),
			decidedAt: row.decidedAt?.toISOString() ?? null,
			canDecide:
				canDecide && row.status === "pending" && row.expiresAt > new Date(),
		};
	}
	const filters = {
		pending: "status = 'pending'",
		approved: "status in ('approved','claimed')",
		history: "status in ('consumed','denied','expired','invalidated')",
		all: "true",
	} as const;
	const services: ApprovalServices = {
		async listApprovals(actor, input) {
			await sweep(pool, actor.scopeId);
			const reviewer = await options.canReview(pool, actor as A);
			const values: unknown[] = [actor.scopeId];
			const where = [`"scopeId" = $1`, filters[input.status ?? "pending"]];
			if (!reviewer) {
				values.push(actor.userId);
				where.push(`"requesterId" = $${values.length}`);
			}
			if (input.query) {
				values.push(`%${input.query.replace(/[\\%_]/g, "\\$&")}%`);
				const at = `$${values.length}`;
				where.push(
					`(tool LIKE ${at} or "connectionLabel" LIKE ${at} or "agentLabel" LIKE ${at})`,
				);
			}
			const clause = where.join(" and ");
			const {
				rows: [count],
			} = await pool.query<{
				count: number;
			}>(`select count(*) as count from ${table} where ${clause}`, values);
			const page = input.page ?? 1;
			const { rows } = await pool.query<ApprovalRow>(
				`select * from ${table} where ${clause} order by "createdAt" desc, id
\t\t\t\tlimit ${APPROVAL_PAGE_SIZE} offset ${(page - 1) * APPROVAL_PAGE_SIZE}`,
				values,
			);
			return {
				requests: rows.map((row) => summary(row, reviewer)),
				total: count?.count ?? 0,
			};
		},
		async approvalDetail(actor, id) {
			// Active requests are re-bound before exposure: a switched account or rule revision
			// invalidates and clears the payload now, so reviewers never see a stale call.
			await sweep(pool, actor.scopeId);
			const found = await transaction(
				options.fences?.(actor.scopeId, actor as A),
				async (tx) => {
					const {
						rows: [row],
					} = await tx.query<ApprovalRow>(
						`select * from ${table} where id = $1 and "scopeId" = $2 for update`,
						[id, actor.scopeId],
					);
					if (!row) return undefined;
					const reviewer = await options.canReview(tx, actor as A, row);
					if (!reviewer && row.requesterId !== actor.userId) return undefined;
					if (
						["pending", "approved"].includes(row.status) &&
						!(await bound(tx, row))
					) {
						await invalidate(tx, row.id);
						return {
							row: {
								...row,
								status: "invalidated" as const,
								encryptedRequest: null,
							},
							reviewer,
						};
					}
					return { row, reviewer };
				},
			);
			if (!found) throw notFound();
			const { row, reviewer } = found;
			const parameters = reviewer ? decrypt(row) : undefined;
			return {
				...summary(row, reviewer),
				decidedBy: row.decidedBy,
				...(parameters ? { parameters: { ...parameters } } : {}),
			};
		},
		async decideApproval(actor, input) {
			// Status changes commit first; refusals are raised after the transaction.
			const outcome = await transaction(
				options.fences?.(actor.scopeId, actor as A),
				async (tx) => {
					const {
						rows: [locked],
					} = await tx.query<ApprovalRow>(
						`select * from ${table} where id = $1 and "scopeId" = $2 for update`,
						[input.id, actor.scopeId],
					);
					if (!locked) return "missing" as const;
					const row = await live(tx, locked);
					if (!(await options.canReview(tx, actor as A, row)))
						return row.requesterId === actor.userId
							? ("forbidden" as const)
							: ("missing" as const);
					if (row.status !== "pending") return "decided" as const;
					if (!row.live) {
						await expire(tx, row.id);
						return "expired" as const;
					}
					if (input.decision === "deny") {
						await tx.query(
							`update ${table} set status = 'denied', "encryptedRequest" = null,
\t\t\t\t\t\t\t"decidedBy" = $2, "decidedAt" = clock_timestamp(), "settledAt" = clock_timestamp()
\t\t\t\t\t\twhere id = $1 and status = 'pending'`,
							[row.id, actor.userId],
						);
						return "ok" as const;
					}
					if (!(await bound(tx, row))) {
						await invalidate(tx, row.id);
						return "changed" as const;
					}
					const approved = await tx.query(
						`update ${table} set status='approved',"decidedBy"=$2,"decidedAt"=clock_timestamp(),"expiresAt"=least("expiresAt",clock_timestamp() + $3::double precision * interval '1 minute')
					where id=$1 and status='pending' and "expiresAt">clock_timestamp() returning id`,
						[row.id, actor.userId, APPROVAL_APPROVED_MINUTES],
					);
					if (approved.rowCount) return "ok" as const;
					await expire(tx, row.id);
					return "expired" as const;
				},
			);
			if (outcome === "missing") throw notFound();
			if (outcome === "forbidden")
				throw new ORPCError("FORBIDDEN", {
					message: "Only a reviewer can decide this request",
				});
			if (outcome === "decided")
				throw conflict("This request has already been decided");
			if (outcome === "expired") throw conflict("This request has expired");
			if (outcome === "changed")
				throw conflict(
					"The connection's account or access rules changed; the agent must request again",
				);
			return { ok: true };
		},
	};
	/**
	 * Host maintenance: expire every scope's lapsed requests, clear any terminal payload, then
	 * delete terminal metadata older than the host's retention.
	 */
	async function cleanup(historyDays = 30) {
		if (!Number.isInteger(historyDays) || historyDays < 1 || historyDays > 3650)
			throw new Error("Approval history retention must be 1 to 3650 days");
		const { rowCount } =
			await pool.query(`update ${table} set status = 'expired', "encryptedRequest" = null, "settledAt" = clock_timestamp()
\t\t\twhere status in ${active} and "expiresAt" <= clock_timestamp()`);
		// Defensive: no terminal row may keep a payload.
		await pool.query(`update ${table} set "encryptedRequest" = null
\t\t\twhere "encryptedRequest" is not null and status not in ${active}`);
		const { rowCount: deleted } = await pool.query(
			`delete from ${table} where status not in ${active}
\t\t\t\tand coalesce("settledAt", "createdAt") < clock_timestamp() - $1::double precision * interval '1 day'`,
			[historyDays],
		);
		return { expired: rowCount ?? 0, deleted: deleted ?? 0 };
	}
	return { runtime, services, cleanup, consume };
}
/** Reviewer procedures. Hosts set dashboardSession only for cookie-authenticated dashboard requests. */
export interface ApprovalContext {
	actor: Actor;
	services: ApprovalServices;
	/** Optional for unrelated router fixtures; anything but true is refused. */
	dashboardSession?: boolean;
}
export function createApprovalRouter() {
	const procedure = os.$context<ApprovalContext>().use(({ context, next }) => {
		if (context.dashboardSession !== true || !context.actor.sessionId)
			throw new ORPCError("UNAUTHORIZED");
		return next();
	});
	return {
		listApprovals: procedure
			.input(approvalListInput)
			.output(approvalListView)
			.handler(({ context, input }) =>
				context.services.listApprovals(context.actor, input),
			),
		approvalDetail: procedure
			.input(z.object({ id: z.string().min(1).max(200) }))
			.output(approvalDetail)
			.handler(({ context, input }) =>
				context.services.approvalDetail(context.actor, input.id),
			),
		decideApproval: procedure
			.input(approvalDecisionInput)
			.output(mutationView)
			.handler(({ context, input }) =>
				context.services.decideApproval(context.actor, input),
			),
	};
}
export type ApprovalRouter = ReturnType<typeof createApprovalRouter>;
