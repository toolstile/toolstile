import type { SessionIssuanceOptions } from "@toolstile/auth";
import type { Pool } from "@toolstile/database/sql";
import type { Fence } from "@toolstile/database/transaction";

/**
 * Concurrency for this instance (one place). Transactions are serializable with bounded retry
 * (PostgreSQL detects read/write dependencies between them), except idempotent work queues and
 * the auth library's own transactions. Fences are advisory locks taken before the snapshot, in
 * this order:
 *   0. the operators fence, exclusive for every operator change and telemetry delivery: the
 *      last active operator, settings and telemetry opt-out span rows with no single row;
 *   1. an account fence, exclusive for any change to that account's lifecycle, recovery,
 *      credentials, connections, grants, devices, agents, tool review or capture; shared for
 *      approvals, which read what those changes write.
 * A person's request also checks its session row with a share lock, so a sign-out or revocation
 * committed first is always seen.
 */
export const operatorsFence: Fence = { rank: 0, key: "toolstile:operators" };
export const accountFence = (userId: string, shared = false): Fence => ({
	rank: 1,
	key: `user:${userId}`,
	shared,
});
/** Account changes that revoke sessions, each audited in the transaction that makes it. */
const REVOKING = [
	"account-recovered",
	"emergency-reset",
	"account-suspended",
	"account-deletion-requested",
	"account-purged",
];
/** Sign-ins are ordered with those changes by the account fence (session-issuance.ts). */
export function accountSessionIssuance(pool: Pool): SessionIssuanceOptions {
	return {
		pool,
		fence: (userId) => accountFence(userId),
		async revokedSince(executor, userId, since) {
			const { rowCount } = await executor.query(
				`select 1 from account_audit where "subjectId"=$1 and "createdAt">$2::timestamptz
				and action in (select jsonb_array_elements_text($3::jsonb))`,
				[userId, since, JSON.stringify(REVOKING)],
			);
			return !!rowCount;
		},
	};
}
