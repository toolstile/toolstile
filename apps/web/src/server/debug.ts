import type { Actor } from "@toolstile/api/contract";
import {
	createDebugStore,
	type DebugBox,
	type DebugPool,
	type DebugSelection,
	type DebugSql,
	type Operation,
	operationCapability,
	permitted,
} from "@toolstile/gateway";
import { accountFence } from "./fences";

export function createInstanceDebug(options: {
	pool: DebugPool;
	box: DebugBox;
	active(userId: string, executor: DebugSql): Promise<unknown>;
	ownAgent(actor: Actor, id: string, executor: DebugSql): Promise<unknown>;
	ownConnection(actor: Actor, id: string, executor: DebugSql): Promise<unknown>;
}) {
	const store = createDebugStore({
		pool: options.pool,
		box: options.box,
		// A capture change is an account change (fences.ts).
		fences: (actor) => [accountFence(actor.userId)],
		captureFence: (scopeId) => accountFence(scopeId, true),
		async authorize(actor, selection: DebugSelection | undefined, executor) {
			if (actor.scopeId !== actor.userId)
				throw new Error("Capture access denied");
			await options.active(actor.userId, executor);
			for (const id of selection?.agentIds ?? [])
				await options.ownAgent(actor, id, executor);
			for (const id of selection?.connectionIds ?? [])
				await options.ownConnection(actor, id, executor);
		},
		async retention(executor) {
			const {
				rows: [row],
			} = await executor.query<{
				activityRetentionDays: number;
				payloadRetentionHours: number;
			}>(
				'select "activityRetentionDays","payloadRetentionHours" from instance_settings where id=$1',
				["instance"],
			);
			return row ?? { activityRetentionDays: 30, payloadRetentionHours: 24 };
		},
	});
	return {
		...store,
		async checkAgent(
			actor: Actor,
			agentId: string,
			executor: DebugSql,
			operation: Operation,
		) {
			await options.active(actor.userId, executor);
			const {
				rows: [authorization],
			} = await executor.query(
				'select a.id from agents a join authorizations au on au."agentId"=a.id join devices d on d.id=a."deviceId" where a.id=$1 and a."ownerId"=$2 and d."revokedAt" is null and au."revokedAt" is null and (au."expiresAt" is null or au."expiresAt">clock_timestamp())',
				[agentId, actor.userId],
			);
			if (!authorization) throw new Error("Agent authorization unavailable");
			const {
				rows: [grant],
			} = await executor.query<{
				specific: import("@toolstile/api/contract").Rules | null;
				all: import("@toolstile/api/contract").Rules | null;
			}>(
				'select g.rules as specific,ag.rules as "all" from connections c left join grants g on g."connectionId"=c.id and g."agentId"=$1 left join all_agent_grants ag on ag."connectionId"=c.id and ag."ownerId"=$2 where c.id=$3 and c."ownerId"=$2',
				[agentId, actor.userId, operation.connectionId],
			);
			const rules = [grant?.specific, grant?.all].filter(
				(value): value is import("@toolstile/api/contract").Rules => !!value,
			);
			const kind = operationCapability(operation);
			if (
				!kind ||
				!rules.length ||
				(operation.target
					? !permitted(rules, kind, operation.target)
					: !rules.some(
							(rule) =>
								rule.full ||
								rule.allow[kind].length ||
								(kind === "tools" && rule.requireApproval?.length),
						))
			)
				throw new Error("Agent permission unavailable");
		},
	};
}
