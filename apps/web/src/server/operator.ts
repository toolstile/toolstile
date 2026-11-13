import { randomBytes, randomUUID } from "node:crypto";
import { ORPCError, os } from "@orpc/server";
import type { Actor } from "@toolstile/api/contract";
import {
	digest,
	liveSession,
	SESSION_FRESH_AGE_SECONDS,
} from "@toolstile/auth";
import type { Pool } from "@toolstile/database/sql";
import { type Transaction, transaction } from "@toolstile/database/transaction";
import { z } from "zod";
import type { createAccountService } from "./accounts";
import { accountFence, operatorsFence } from "./fences";
import {
	defaultOperatorSettings,
	invitationInput,
	type OperatorSettings,
	operatorSettingsInput,
} from "./operator-schema";

const forbidden = (message = "Instance operator access required") =>
	new ORPCError("FORBIDDEN", { message });
export function createOperatorService(
	pool: Pool,
	options: {
		accounts: Pick<
			ReturnType<typeof createAccountService>,
			"suspend" | "deleteAccount" | "consumeInvitation"
		>;
		baseURL: string;
		revokeUserConnections: (id: string) => Promise<void>;
	},
) {
	async function authorize(tx: Transaction, actor: Actor, fresh: boolean) {
		if (!(await liveSession(tx, actor))) throw forbidden();
		const {
			rows: [row],
		} = await tx.query(
			'select operator,suspended,"deletedAt" from profiles where "userId"=$1',
			[actor.userId],
		);
		if (!row?.operator || row.suspended || row.deletedAt) throw forbidden();
		if (
			fresh &&
			!(await liveSession(tx, actor, {
				freshSeconds: SESSION_FRESH_AGE_SECONDS,
			}))
		)
			throw forbidden("Sign in again before changing instance security");
	}
	/** Serializable; a change holds the operators fence, the operator's account fence and the
	 * fences of the accounts it changes (fences.ts). */
	async function run<T>(
		actor: Actor,
		mutation: boolean,
		action: (tx: Transaction) => Promise<T>,
		targets: string[] = [],
	) {
		return transaction(
			pool,
			async (tx: Transaction) => {
				await authorize(tx, actor, mutation);
				return action(tx);
			},
			{
				fences: mutation
					? [
							operatorsFence,
							accountFence(actor.userId, true),
							...targets.map((id) => accountFence(id)),
						]
					: undefined,
			},
		);
	}
	async function audit(
		tx: Transaction,
		actor: Actor,
		action: string,
		subject = "instance",
	) {
		await tx.query(
			'insert into account_audit(id,"subjectId",actor,action) values($1,$2,$3,$4)',
			[randomUUID(), subject, actor.userId, action],
		);
	}
	async function protectTarget(tx: Transaction, actor: Actor, id: string) {
		if (id === actor.userId)
			throw forbidden(
				"Operators cannot suspend or delete their own account here",
			);
		const {
			rows: [target],
		} = await tx.query('select operator from profiles where "userId"=$1', [id]);
		if (target?.operator) {
			const {
				rows: [count],
			} = await tx.query(
				'select count(*) as n from profiles where operator=true and suspended=false and "deletedAt" is null',
			);
			if (count.n <= 1)
				throw forbidden("The last active operator cannot be removed");
		}
	}
	return {
		async canRegister(
			email: string,
			token: string,
			verified: boolean,
			social: boolean,
		) {
			const {
				rows: [settings],
			} = await pool.query(
				"select \"registrationPolicy\" from instance_settings where id='instance'",
			);
			if (settings?.registrationPolicy === "open" && !token)
				return !social || verified;
			return options.accounts.consumeInvitation(email, token, verified, social);
		},
		settings: (actor: Actor) =>
			run(actor, false, async (tx): Promise<OperatorSettings> => {
				const {
					rows: [row],
				} = await tx.query(
					"select * from instance_settings where id='instance'",
				);
				return operatorSettingsInput.parse({
					...defaultOperatorSettings,
					...Object.fromEntries(
						Object.keys(defaultOperatorSettings)
							.filter((k) => row?.[k] !== undefined)
							.map((k) => [k, row[k]]),
					),
				});
			}),
		saveSettings: (actor: Actor, raw: OperatorSettings) =>
			run(actor, true, async (tx) => {
				const input = operatorSettingsInput.parse(raw);
				await tx.query(
					`insert into instance_settings(id,"registrationPolicy","recoveryWindowDays","allowPrivateNetwork","activityRetentionDays","payloadRetentionHours","telemetryEnabled")
				values('instance',$1,$2,$3,$4,$5,$6) on conflict(id) do update set "registrationPolicy"=$1,"recoveryWindowDays"=$2,"allowPrivateNetwork"=$3,"activityRetentionDays"=$4,"payloadRetentionHours"=$5,"telemetryEnabled"=$6`,
					[
						input.registrationPolicy,
						input.recoveryWindowDays,
						input.allowPrivateNetwork,
						input.activityRetentionDays,
						input.payloadRetentionHours,
						input.telemetryEnabled,
					],
				);
				if (!input.telemetryEnabled)
					await tx.query("delete from telemetry_outbox");
				await audit(tx, actor, "instance-settings-updated");
				return { ok: true };
			}),
		users: (actor: Actor) =>
			run(
				actor,
				false,
				async (tx) =>
					(
						await tx.query(
							`select u.id,u.name,u.email,coalesce(p.suspended,false) suspended,coalesce(p.operator,false) operator,p."deletedAt",p."purgeAfter" from "user" u left join profiles p on p."userId"=u.id order by u."createdAt" limit 1000`,
						)
					).rows,
			),
		invitations: (actor: Actor) =>
			run(
				actor,
				false,
				async (tx) =>
					(
						await tx.query(
							'select id,email,"expiresAt","createdAt" from invitations where "expiresAt">clock_timestamp() order by "createdAt" desc limit 100',
						)
					).rows,
			),
		invite: (actor: Actor, raw: z.input<typeof invitationInput>) =>
			run(actor, true, async (tx) => {
				const input = invitationInput.parse(raw),
					token = randomBytes(32).toString("base64url");
				const expiresAt = new Date(Date.now() + input.expiresInHours * 3600000);
				await tx.query(
					'insert into invitations(id,email,"expiresAt") values($1,$2,$3) on conflict(email) do update set id=$1,"expiresAt"=$3,"createdAt"=clock_timestamp()',
					[digest(token), input.email?.toLowerCase() ?? null, expiresAt],
				);
				await audit(tx, actor, "invitation-created");
				return {
					url: `${new URL(options.baseURL).origin}/api/auth/accept-invitation/${token}`,
					expiresAt: expiresAt.toISOString(),
				};
			}),
		revokeInvitation: (actor: Actor, id: string) =>
			run(actor, true, async (tx) => {
				await tx.query("delete from invitations where id=$1", [id]);
				await audit(tx, actor, "invitation-revoked");
				return { ok: true };
			}),
		suspend: async (actor: Actor, id: string, suspended: boolean) => {
			await run(
				actor,
				true,
				async (tx) => {
					await protectTarget(tx, actor, id);
					const {
						rows: [profile],
					} = await tx.query(
						'select "deletedAt" from profiles where "userId"=$1',
						[id],
					);
					if (profile?.deletedAt)
						throw forbidden("Deleted accounts require account-holder recovery");
					await options.accounts.suspend(id, actor.userId, suspended, tx);
				},
				[id],
			);
			if (suspended) await options.revokeUserConnections(id);
			return { ok: true };
		},
		deleteUser: async (actor: Actor, id: string) => {
			const result = await run(
				actor,
				true,
				async (tx) => {
					await protectTarget(tx, actor, id);
					return options.accounts.deleteAccount(
						id,
						actor.userId,
						undefined,
						tx,
					);
				},
				[id],
			);
			await options.revokeUserConnections(id);
			return result;
		},
	};
}
export function createOperatorRouter(
	service: ReturnType<typeof createOperatorService>,
) {
	const procedure = os.$context<{
		actor: Actor;
	}>();
	return {
		instanceSettings: procedure.handler(({ context: { actor } }) =>
			service.settings(actor),
		),
		saveInstanceSettings: procedure
			.input(operatorSettingsInput)
			.handler(({ context: { actor }, input }) =>
				service.saveSettings(actor, input),
			),
		operatorUsers: procedure.handler(({ context: { actor } }) =>
			service.users(actor),
		),
		operatorInvitations: procedure.handler(({ context: { actor } }) =>
			service.invitations(actor),
		),
		inviteUser: procedure
			.input(invitationInput)
			.handler(({ context: { actor }, input }) => service.invite(actor, input)),
		revokeInvitation: procedure
			.input(z.object({ id: z.string().min(1).max(200) }))
			.handler(({ context: { actor }, input }) =>
				service.revokeInvitation(actor, input.id),
			),
		suspendUser: procedure
			.input(z.object({ id: z.string().min(1), suspended: z.boolean() }))
			.handler(({ context: { actor }, input }) =>
				service.suspend(actor, input.id, input.suspended),
			),
		operatorDeleteUser: procedure
			.input(
				z.object({ id: z.string().min(1), confirmation: z.literal("DELETE") }),
			)
			.handler(({ context: { actor }, input }) =>
				service.deleteUser(actor, input.id),
			),
	};
}
