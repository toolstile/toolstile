import { createHash, randomBytes, randomUUID } from "node:crypto";
import { liveSession, SESSION_FRESH_AGE_SECONDS } from "@toolstile/auth";
import type { Pool } from "@toolstile/database/sql";
import {
	transaction as inTransaction,
	type Transaction,
} from "@toolstile/database/transaction";
import { hashPassword } from "better-auth/crypto";
import { accountFence } from "./fences";

const hash = (value: string) =>
	createHash("sha256").update(value).digest("hex");
const newCode = () => `tsr_${randomBytes(24).toString("base64url")}`;
const unavailable = () =>
	new Error("Account recovery is unavailable or the code is invalid");
/** Each lifecycle change is a serializable transaction holding the account fence (fences.ts),
 * which checks identity, session and recovery predicates and changes credentials. */
export function createAccountService(
	pool: Pool,
	options: {
		enqueueRecovery?: (
			tx: Transaction,
			userId: string,
			email: string,
			code: string,
		) => Promise<void>;
	} = {},
) {
	// A supplied transaction belongs to the caller. Its authorization reads, audit and
	// credential revocation commit together.
	async function transaction<T>(
		userId: string,
		run: (tx: Transaction) => Promise<T>,
		skipMissing = false,
		executor?: Transaction,
	) {
		const work = async (tx: Transaction) => {
			const row = await tx.query('select id from "user" where id=$1', [userId]);
			if (!row.rowCount) {
				if (skipMissing) return undefined as T;
				throw unavailable();
			}
			return run(tx);
		};
		return executor
			? work(executor)
			: inTransaction(pool, work, { fences: [accountFence(userId)] });
	}
	async function audit(
		tx: Transaction,
		userId: string,
		actor: string,
		action: string,
		reason?: string,
	) {
		await tx.query(
			'insert into account_audit(id,"subjectId",actor,action,reason) values($1,$2,$3,$4,$5)',
			[randomUUID(), userId, actor, action, reason ?? null],
		);
	}
	async function revoke(tx: Transaction, userId: string) {
		await tx.query(
			'update authorizations set "revokedAt"=clock_timestamp() where "agentId" in (select id from agents where "ownerId"=$1) and "revokedAt" is null',
			[userId],
		);
		await tx.query(
			'update "oauthAccessToken" set revoked=clock_timestamp() where "userId"=$1 and revoked is null',
			[userId],
		);
		await tx.query(
			'update "oauthRefreshToken" set revoked=clock_timestamp() where "userId"=$1 and revoked is null',
			[userId],
		);
		await tx.query('delete from session where "userId"=$1', [userId]);
	}
	async function assertActive(tx: Transaction, userId: string) {
		const {
			rows: [profile],
		} = await tx.query('select * from profiles where "userId"=$1', [userId]);
		if (profile?.suspended || profile?.deletedAt) throw unavailable();
	}
	async function assertFresh(
		tx: Transaction,
		userId: string,
		sessionId?: string,
	) {
		if (!sessionId) return;
		if (
			!(await liveSession(
				tx,
				{ userId, sessionId },
				{ freshSeconds: SESSION_FRESH_AGE_SECONDS },
			))
		)
			throw new Error("Sign in again before changing account security");
	}
	return {
		async consumeInvitation(
			email: string,
			token: string,
			verified: boolean,
			social: boolean,
		) {
			if (!token || (social && !verified)) return false;
			const result = await pool.query(
				'delete from invitations where id=$1 and (email is null or lower(email)=$2) and "expiresAt">clock_timestamp() returning id',
				[hash(token), email.toLowerCase()],
			);
			return result.rowCount === 1;
		},
		async requestEmailRecovery(identifier: string) {
			const enqueueRecovery = options.enqueueRecovery;
			if (!enqueueRecovery) return;
			const {
				rows: [person],
			} = await pool.query(
				'select id,email from "user" where lower(email)=lower($1) and "emailVerified"=true',
				[identifier],
			);
			if (!person) return;
			await transaction(person.id, async (tx) => {
				const {
					rows: [profile],
				} = await tx.query('select * from profiles where "userId"=$1', [
					person.id,
				]);
				if (
					profile?.suspended ||
					(profile?.deletedAt &&
						(!profile.purgeAfter || profile.purgeAfter <= new Date()))
				)
					return;
				const recent = await tx.query(
					`select 1 from recovery_codes where "userId"=$1 and purpose='email' and "createdAt">clock_timestamp() - (60000) * interval '1 millisecond'`,
					[person.id],
				);
				if (recent.rowCount) return;
				const code = newCode();
				await tx.query(
					`insert into recovery_codes(hash,"userId",purpose,"expiresAt") values($1,$2,'email',clock_timestamp() + (900000) * interval '1 millisecond')`,
					[hash(code), person.id],
				);
				await enqueueRecovery(tx, person.id, person.email, code);
				await audit(tx, person.id, person.id, "email-recovery-requested");
			});
		},
		async rotateCodes(userId: string, sessionId?: string) {
			return transaction(userId, async (tx) => {
				await assertActive(tx, userId);
				await assertFresh(tx, userId, sessionId);
				const codes = Array.from({ length: 10 }, newCode);
				await tx.query(
					'delete from account_email_outbox where id in (select hash from recovery_codes where "userId"=$1)',
					[userId],
				);
				await tx.query('delete from recovery_codes where "userId"=$1', [
					userId,
				]);
				for (const code of codes)
					await tx.query(
						'insert into recovery_codes(hash,"userId") values($1,$2)',
						[hash(code), userId],
					);
				await audit(tx, userId, userId, "recovery-codes-rotated");
				return codes;
			});
		},
		async recover(identifier: string, code: string, password: string) {
			identifier = identifier.trim();
			code = code.trim();
			if (password.length < 12 || password.length > 128 || code.length > 200)
				throw unavailable();
			const {
				rows: [person],
			} = await pool.query(
				'select id from "user" where lower(email)=lower($1)',
				[identifier],
			);
			if (!person) throw unavailable();
			// Compute outside the transaction to keep locks short; all codes have 192 bits of entropy.
			const candidate = await pool.query(
				'select 1 from recovery_codes where hash=$1 and "userId"=$2 and ("expiresAt" is null or "expiresAt">clock_timestamp())',
				[hash(code), person.id],
			);
			if (!candidate.rowCount) throw unavailable();
			const passwordHash = await hashPassword(password);
			return transaction(person.id, async (tx) => {
				const {
					rows: [profile],
				} = await tx.query('select * from profiles where "userId"=$1', [
					person.id,
				]);
				if (
					profile?.suspended ||
					(profile?.deletedAt &&
						(!profile.purgeAfter || profile.purgeAfter <= new Date()))
				)
					throw unavailable();
				const usable = await tx.query(
					'select hash from recovery_codes where hash=$1 and "userId"=$2 and ("expiresAt" is null or "expiresAt">clock_timestamp())',
					[hash(code), person.id],
				);
				if (!usable.rowCount) throw unavailable();
				const credential = await tx.query(
					'select id from account where "userId"=$1 and "providerId"=\'credential\'',
					[person.id],
				);
				await tx.query(
					'delete from recovery_codes where hash=$1 and "userId"=$2',
					[hash(code), person.id],
				);
				await revoke(tx, person.id);
				await tx.query(
					`delete from account_email_outbox where id in (select hash from recovery_codes where "userId"=$1 and purpose in ('email','emergency'))`,
					[person.id],
				);
				await tx.query(
					`delete from recovery_codes where "userId"=$1 and purpose in ('email','emergency')`,
					[person.id],
				);
				await tx.query(
					'update profiles set "deletedAt"=null,"purgeAfter"=null where "userId"=$1',
					[person.id],
				);
				if (credential.rowCount) {
					await tx.query(
						'update account set password=$2,"updatedAt"=clock_timestamp() where "userId"=$1 and "providerId"=\'credential\'',
						[person.id, passwordHash],
					);
				} else {
					await tx.query(
						'insert into account(id,"accountId","providerId","userId",password) values($1,$2,\'credential\',$2,$3)',
						[randomUUID(), person.id, passwordHash],
					);
				}
				await audit(tx, person.id, person.id, "account-recovered");
			});
		},
		async emergencyReset(userId: string, actor: string, reason: string) {
			if (!actor.trim() || reason.trim().length < 10)
				throw new Error(
					"An operator identity and a meaningful reason are required",
				);
			return transaction(userId, async (tx) => {
				await assertActive(tx, userId);
				await revoke(tx, userId);
				await tx.query('delete from account where "userId"=$1', [userId]);
				await tx.query(
					'delete from account_email_outbox where id in (select hash from recovery_codes where "userId"=$1)',
					[userId],
				);
				await tx.query('delete from recovery_codes where "userId"=$1', [
					userId,
				]);
				const code = newCode();
				await tx.query(
					`insert into recovery_codes(hash,"userId",purpose,"expiresAt") values($1,$2,'emergency',clock_timestamp() + (86400000) * interval '1 millisecond')`,
					[hash(code), userId],
				);
				await audit(tx, userId, actor, "emergency-reset", reason);
				return code;
			});
		},
		async suspend(
			userId: string,
			actor: string,
			suspended: boolean,
			executor?: Transaction,
		) {
			return transaction(
				userId,
				async (tx) => {
					await tx.query(
						'insert into profiles("userId",suspended) values($1,$2) on conflict("userId") do update set suspended=$2',
						[userId, suspended],
					);
					if (suspended) await revoke(tx, userId);
					await audit(
						tx,
						userId,
						actor,
						suspended ? "account-suspended" : "account-unsuspended",
					);
				},
				false,
				executor,
			);
		},
		async deleteAccount(
			userId: string,
			actor: string,
			sessionId?: string,
			executor?: Transaction,
		) {
			return transaction(
				userId,
				async (tx) => {
					if (actor === userId) await assertFresh(tx, userId, sessionId);
					const {
						rows: [profile],
					} = await tx.query('select * from profiles where "userId"=$1', [
						userId,
					]);
					if (actor !== userId && !profile?.suspended)
						throw new Error("Suspend the account before deleting it");
					if (profile?.deletedAt)
						return { purgeAfter: new Date(profile.purgeAfter).toISOString() };
					const {
						rows: [settings],
					} = await tx.query(
						"select \"recoveryWindowDays\" from instance_settings where id='instance'",
					);
					const days = settings?.recoveryWindowDays ?? 7;
					const purgeAfter = new Date(Date.now() + days * 86400000);
					await tx.query(
						'insert into profiles("userId","deletedAt","purgeAfter") values($1,clock_timestamp(),$2) on conflict("userId") do update set "deletedAt"=clock_timestamp(),"purgeAfter"=$2',
						[userId, purgeAfter],
					);
					await revoke(tx, userId);
					await audit(tx, userId, actor, "account-deletion-requested");
					return { purgeAfter: purgeAfter.toISOString() };
				},
				false,
				executor,
			);
		},
		async purgeExpired() {
			const { rows } = await pool.query(
				'select "userId" from profiles where "purgeAfter"<=clock_timestamp()',
			);
			let count = 0;
			for (const { userId } of rows)
				await transaction(
					userId,
					async (tx) => {
						const due = await tx.query(
							'select 1 from profiles where "userId"=$1 and "purgeAfter"<=clock_timestamp()',
							[userId],
						);
						if (!due.rowCount) return;
						await revoke(tx, userId);
						await tx.query(
							'delete from grants where "agentId" in (select id from agents where "ownerId"=$1)',
							[userId],
						);
						await tx.query('delete from all_agent_grants where "ownerId"=$1', [
							userId,
						]);
						await tx.query(
							'delete from authorizations where "agentId" in (select id from agents where "ownerId"=$1)',
							[userId],
						);
						for (const table of [
							"agents",
							"devices",
							"connections",
							"activity",
						])
							await tx.query(`delete from "${table}" where "ownerId"=$1`, [
								userId,
							]);
						for (const table of [
							"oauthAccessToken",
							"oauthRefreshToken",
							"oauthConsent",
						])
							await tx.query(`delete from "${table}" where "userId"=$1`, [
								userId,
							]);
						await tx.query(
							'update "oauthClient" set "userId"=null where "userId"=$1',
							[userId],
						);
						await tx.query('delete from profiles where "userId"=$1', [userId]);
						await tx.query('delete from "user" where id=$1', [userId]);
						await tx.query(
							'delete from upstream_oauth_grants AS g where not exists(select 1 from connection_oauth c where c."grantId"=g.id)',
						);
						await audit(tx, userId, "server", "account-purged");
						count++;
					},
					true,
				);
			return count;
		},
	};
}
