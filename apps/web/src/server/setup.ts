import type { Actor } from "@toolstile/api/contract";
import {
	type SetupDependencies,
	type SetupRow,
	createSetupRouter as sharedRouter,
	createSetupService as sharedService,
} from "@toolstile/api/setup-server";
import type { Pool } from "@toolstile/database/sql";

type Dependencies = Pick<SetupDependencies, "services" | "runtime"> & {
	pool: Pool;
	authorize(actor: Actor): Promise<unknown>;
};
function adapt(deps: Dependencies): SetupDependencies {
	return {
		...deps,
		isConnectionReady: () => true,
		async read(actor) {
			await deps.authorize(actor);
			const { rows } = await deps.pool.query<SetupRow>(
				'SELECT * FROM setup_progress WHERE "userId"=$1',
				[actor.userId],
			);
			return rows[0];
		},
		// Callers have already authorized the actor (snapshot or read); served by the
		// partial "activity_first_call" index.
		async firstCall(actor, input) {
			const { rows } = await deps.pool.query<{
				id: string;
				target: string | null;
				createdAt: Date | string;
			}>(
				`SELECT id,target,"createdAt" FROM activity WHERE "ownerId"=$1 AND "agentId"=$2 AND "connectionId"=$3 AND origin='agent' AND method='tools/call' AND outcome='forwarded' ORDER BY "createdAt",id LIMIT 1`,
				[actor.userId, input.agentId, input.connectionId],
			);
			const row = rows[0];
			return row && { ...row, createdAt: new Date(row.createdAt) };
		},
		async persist(actor, row) {
			await deps.authorize(actor);
			await deps.pool.query(
				`INSERT INTO setup_progress ("userId",status,step,client,"connectionId","agentId","verificationKey","verifiedAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT ("userId") DO UPDATE SET status=excluded.status,step=excluded.step,client=excluded.client,"connectionId"=excluded."connectionId","agentId"=excluded."agentId","verificationKey"=excluded."verificationKey","verifiedAt"=excluded."verifiedAt","updatedAt"=clock_timestamp()`,
				[
					...[actor.userId],
					row.status,
					row.step,
					row.client,
					row.connectionId,
					row.agentId,
					row.verificationKey,
					row.verifiedAt,
				],
			);
		},
	};
}
export const createSetupService = (deps: Dependencies) =>
	sharedService(adapt(deps));
export const createSetupRouter = (deps: Dependencies) =>
	sharedRouter(adapt(deps));
export type SetupRouter = ReturnType<typeof createSetupRouter>;
