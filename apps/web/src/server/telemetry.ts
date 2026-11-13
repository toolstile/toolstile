import { randomUUID } from "node:crypto";
import type { Pool } from "@toolstile/database/sql";
import { transaction } from "@toolstile/database/transaction";
import { z } from "zod";
import { operatorsFence } from "./fences";

export const countBucket = z.enum([
	"0",
	"1-9",
	"10-99",
	"100-999",
	"1000-9999",
	"10000+",
]);
export const telemetryPayload = z
	.object({
		schemaVersion: z.literal(1),
		period: z.literal("day"),
		counts: z
			.object({
				users: countBucket,
				connections: countBucket,
				agents: countBucket,
				operations: countBucket,
				errors: countBucket,
			})
			.strict(),
	})
	.strict();
export type TelemetryPayload = z.infer<typeof telemetryPayload>;
export function bucketCount(n: number): z.infer<typeof countBucket> {
	if (!Number.isFinite(n) || n <= 0) return "0";
	return n < 10
		? "1-9"
		: n < 100
			? "10-99"
			: n < 1000
				? "100-999"
				: n < 10000
					? "1000-9999"
					: "10000+";
}
export function telemetryDestination(value: string | undefined) {
	if (!value?.trim()) return undefined;
	const url = new URL(value);
	if (
		url.protocol !== "https:" ||
		url.username ||
		url.password ||
		url.search ||
		url.hash
	)
		throw new Error(
			"Telemetry destination must be HTTPS without credentials, query or fragment",
		);
	return url.href;
}
/** No installation/user IDs, dates, names, paths or error text enter the payload. */
export function createTelemetryService(
	pool: Pool,
	options: {
		destination?: string;
		// Injection keeps tests entirely local. Implementations must not add identity headers.
		deliver?: (destination: string, payload: TelemetryPayload) => Promise<void>;
	} = {},
) {
	const destination = telemetryDestination(options.destination);
	const deliver =
		options.deliver ??
		(async (url, payload) => {
			const response = await fetch(url, {
				method: "POST",
				redirect: "manual",
				signal: AbortSignal.timeout(5000),
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(payload),
			});
			if (!response.ok) throw new Error("Telemetry delivery failed");
			await response.body?.cancel();
		});
	return {
		configured: !!destination,
		async tick() {
			// The operators fence orders this against a concurrent opt-out and another tick.
			await transaction(
				pool,
				async (tx) => {
					const {
						rows: [settings],
					} = await tx.query(
						"select \"telemetryEnabled\" from instance_settings where id='instance'",
					);
					if (settings?.telemetryEnabled === false) {
						await tx.query("delete from telemetry_outbox");
						return;
					}
					const {
						rows: [daily],
					} = destination
						? await tx.query(
								"select day from telemetry_daily where day=to_char(clock_timestamp(),'YYYY-MM-DD')",
							)
						: { rows: [] };
					let payload: TelemetryPayload | undefined;
					if (destination && !daily) {
						const {
							rows: [row],
						} = await tx.query(`select
                        (select count(*) from "user" u left join profiles p on p."userId"=u.id where p."deletedAt" is null) users,
                        (select count(*) from connections) connections, (select count(*) from agents) agents,
                        (select count(*) from activity where "createdAt">=date_trunc('day',clock_timestamp()) - interval '1 day' and "createdAt"<date_trunc('day',clock_timestamp())) operations,
                        (select count(*) from activity where outcome in ('error','upstream_error') and "createdAt">=date_trunc('day',clock_timestamp()) - interval '1 day' and "createdAt"<date_trunc('day',clock_timestamp())) errors`);
						payload = telemetryPayload.parse({
							schemaVersion: 1,
							period: "day",
							counts: Object.fromEntries(
								Object.entries(row).map(([key, value]) => [
									key,
									bucketCount(Number(value)),
								]),
							),
						});
					}
					await tx.query(
						"delete from telemetry_outbox where day < to_char(clock_timestamp()-interval '7 days','YYYY-MM-DD')",
					);
					await tx.query(
						"delete from telemetry_daily where day < to_char(clock_timestamp()-interval '8 days','YYYY-MM-DD')",
					);
					if (payload) {
						await tx.query(
							"insert into telemetry_daily(day) values(to_char(clock_timestamp(),'YYYY-MM-DD'))",
						);
						await tx.query(
							"insert into telemetry_outbox(day,payload) values(to_char(clock_timestamp(),'YYYY-MM-DD'),$1)",
							[payload],
						);
					}
				},
				{ fences: [operatorsFence] },
			);
			if (!destination) return;
			// Claim is the opt-out boundary. A delivery already in flight may finish.
			// SMTP/HTTP success followed by a crash is at-least-once, without identity.
			const claim = randomUUID();
			const {
				rows: [pending],
			} = await pool.query(
				`update telemetry_outbox set "claimToken"=$1,"claimedUntil"=$2
                where day=(select day from telemetry_outbox where "availableAt"<=clock_timestamp()
                    and ("claimedUntil" is null or "claimedUntil"<=clock_timestamp()) order by day limit 1 FOR UPDATE SKIP LOCKED)
                and exists(select 1 from instance_settings where id='instance' and "telemetryEnabled"=true)
                returning *`,
				[claim, new Date(Date.now() + 30000)],
			);
			if (!pending) return;
			try {
				await deliver(destination, telemetryPayload.parse(pending.payload));
				await pool.query(
					'delete from telemetry_outbox where day=$1 and "claimToken"=$2',
					[pending.day, claim],
				);
			} catch {
				await pool.query(
					`update telemetry_outbox set attempts=attempts+1,"availableAt"=$3,"claimToken"=null,"claimedUntil"=null where day=$1 and "claimToken"=$2`,
					[
						pending.day,
						claim,
						new Date(
							Date.now() +
								Math.min(86400, 60 * 2 ** Math.min(pending.attempts, 11)) *
									1000,
						),
					],
				);
			}
		},
	};
}
