import {
	dateTime,
	integer,
	json,
	pgTable,
	text,
} from "@toolstile/database/pg-columns";
import { sql } from "drizzle-orm";
export const telemetryDaily = pgTable("telemetry_daily", {
	day: text().primaryKey(),
});
export const telemetryOutbox = pgTable("telemetry_outbox", {
	day: text().primaryKey(),
	payload: json().notNull(),
	claimToken: text(),
	claimedUntil: dateTime(),
	attempts: integer().notNull().default(0),
	availableAt: dateTime().notNull().default(sql`now()`),
});
export const telemetrySchema = { telemetryDaily, telemetryOutbox };
