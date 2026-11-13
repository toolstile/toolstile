import { randomUUID } from "node:crypto";
import type { Pool } from "@toolstile/database/sql";
import type { Transaction } from "@toolstile/database/transaction";

type Message = {
	to: string;
	subject: string;
	text: string;
};
export function createAccountEmail(
	pool: Pool,
	box: {
		encrypt(value: unknown): string;
		decrypt<T>(value: string): T;
	},
	deliver: ((message: Message) => Promise<void>) | undefined,
) {
	return {
		enabled: !!deliver,
		async enqueue(
			tx: Transaction,
			userId: string,
			id: string,
			message: Message,
			expiresAt: Date,
		) {
			if (!deliver) throw new Error("Email delivery is not configured");
			await tx.query(
				'insert into account_email_outbox(id,"userId","encryptedMessage","expiresAt") values($1,$2,$3,$4) on conflict(id) do nothing',
				[id, userId, box.encrypt(message), expiresAt],
			);
		},
		async flush() {
			await pool.query(
				'delete from account_email_outbox where "expiresAt"<=clock_timestamp()',
			);
			await pool.query(
				'delete from recovery_codes where "expiresAt"<=clock_timestamp()',
			);
			if (!deliver) return;
			// Claim before delivery. Expiry recovers abandoned attempts; SMTP is
			// at-least-once and a crash after sending can cause a duplicate message.
			for (let batch = 0; batch < 20; batch++) {
				const token = randomUUID();
				const {
					rows: [row],
				} = await pool.query(
					`update account_email_outbox
                    set "claimToken"=$1,"claimedUntil"=clock_timestamp() + (120000) * interval '1 millisecond'
                    where id=(select id from account_email_outbox
                      where "availableAt"<=clock_timestamp()
                      and "expiresAt">clock_timestamp()
                      and ("claimedUntil" is null or "claimedUntil"<=clock_timestamp())
                      order by "availableAt",id limit 1 FOR UPDATE SKIP LOCKED) returning *`,
					[token],
				);
				if (!row) break;
				try {
					await deliver(box.decrypt<Message>(row.encryptedMessage));
					await pool.query(
						'delete from account_email_outbox where id=$1 and "claimToken"=$2',
						[row.id, token],
					);
				} catch {
					await pool.query(
						`update account_email_outbox set attempts=attempts+1,
                        "claimToken"=null,"claimedUntil"=null,
                        "availableAt"=clock_timestamp() + $3::double precision * interval '1 second'
                        where id=$1 and "claimToken"=$2`,
						[
							row.id,
							token,
							Math.min(3600, 30 * 2 ** Math.min(row.attempts, 7)),
						],
					);
				}
			}
		},
	};
}
