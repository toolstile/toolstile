import { ORPCError } from "@orpc/server";
import {
	type ApprovalPool,
	type ApprovalRow,
	type ApprovalSql,
	createApprovalStore,
} from "@toolstile/api/approval-server";
import type { Actor, Rules } from "@toolstile/api/contract";
import { liveSession } from "@toolstile/auth";
import type { connections } from "@toolstile/database";
import {
	approvalRequest,
	type ToolReview,
	toolDecision,
} from "@toolstile/gateway";
import { accountFence } from "./fences";

type Box = {
	encrypt(value: unknown): string;
	decrypt<T>(value: string): T;
};
/** Uses only the supplied executor, including during one-connection decision transactions. */
async function sessionActive(executor: ApprovalSql, actor: Actor) {
	if (!(await liveSession(executor, actor)))
		throw new ORPCError("UNAUTHORIZED");
	const result = await executor.query(
		`select 1 from "user" u left join profiles p on p."userId"=u.id
		where u.id=$1 and coalesce(p.suspended,false)=false and p."deletedAt" is null`,
		[actor.userId],
	);
	if (!result.rowCount) throw new ORPCError("UNAUTHORIZED");
}
export function createInstanceApprovals(options: {
	pool: ApprovalPool;
	box: Box;
	secret: string;
	baseURL: string;
	/** Reviewed tool definitions, read on the decision's own executor. */
	toolReviews(
		executor: ApprovalSql,
		scopeId: string,
		connectionIds: string[],
	): Promise<Map<string, ToolReview>>;
}) {
	const store = createApprovalStore({
		...options,
		table: "tool_approvals",
		// Grant, connection and account changes hold the account fence exclusively.
		fences: (scopeId) => [accountFence(scopeId, true)],
		async canReview(executor, actor, row) {
			await sessionActive(executor, actor);
			return (
				actor.scopeId === actor.userId && (!row || row.scopeId === actor.userId)
			);
		},
		async validate(executor, row: ApprovalRow, parameters) {
			if (
				row.scopeId !== row.requesterId ||
				(row.decidedBy && row.decidedBy !== row.scopeId)
			)
				return false;
			const {
				rows: [current],
			} = await executor.query<
				{
					specific: Rules | null;
					everyone: Rules | null;
					grantId: string | null;
				} & typeof connections.$inferSelect
			>(
				`select c.*,g.rules as specific,ag.rules as everyone,
				o."grantId" as "grantId" from agents a
				join devices d on d.id=a."deviceId"
				join authorizations au on au."agentId"=a.id
				join "user" u on u.id=a."ownerId"
				left join profiles p on p."userId"=u.id
				join connections c on c.id=$3 and c."ownerId"=u.id
				left join grants g on g."agentId"=a.id and g."connectionId"=c.id
				left join all_agent_grants ag on ag."ownerId"=u.id and ag."connectionId"=c.id
				left join connection_oauth o on o."connectionId"=c.id
				where a.id=$1 and a."ownerId"=$2 and d."ownerId"=u.id
				and d."revokedAt" is null and au."revokedAt" is null
				and (au."expiresAt" is null or au."expiresAt">clock_timestamp())
				and coalesce(p.suspended,false)=false and p."deletedAt" is null`,
				[row.agentId, row.requesterId, row.connectionId],
			);
			if (!current) return false;
			const rules = [current.specific, current.everyone].filter(
				(r): r is Rules => !!r,
			);
			if (toolDecision(rules, row.tool) !== "approval") return false;
			const reviews = await options.toolReviews(executor, row.scopeId, [
				row.connectionId,
			]);
			return approvalRequest(
				{
					...current,
					toolReview: reviews.get(row.connectionId),
					identityKey: current.grantId ?? current.encryptedHeaders,
					headers: options.box.decrypt<Record<string, string>>(
						current.encryptedHeaders,
					),
					rules,
				},
				parameters,
			);
		},
		reviewUrl(row) {
			const url = new URL("/app/approvals", options.baseURL);
			url.searchParams.set("approvalId", row.id);
			return url.toString();
		},
	});
	return {
		...store,
		services: {
			...store.services,
			async approvalDetail(actor: Actor, id: string) {
				const detail = await store.services.approvalDetail(actor, id);
				if (!detail.parameters) return detail;
				const {
					rows: [context],
				} = await options.pool.query<{
					url: string;
					label: string;
					name: string;
				}>(
					`select c.url,c.label,u.name from connections c join "user" u on u.id=c."ownerId"
					where c.id=$1 and c."ownerId"=$2`,
					[detail.connectionId, actor.userId],
				);
				return context
					? {
							...detail,
							// A local command has no network destination.
							...(URL.canParse(context.url)
								? { destination: new URL(context.url).origin }
								: {}),
							accountLabel: `${context.label} \u00B7 ${context.name}`,
							requesterLabel: context.name,
						}
					: detail;
			},
		},
		forAgent(actor: Actor, agentId: string, agentLabel: string) {
			return store.runtime({
				scopeId: actor.scopeId,
				requesterId: actor.userId,
				agentId,
				agentLabel,
			});
		},
	};
}
