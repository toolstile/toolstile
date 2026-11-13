import { jsonb, timestamp } from "drizzle-orm/pg-core";

export {
	bigint,
	boolean,
	check,
	customType,
	index,
	integer,
	jsonb,
	pgTable,
	primaryKey,
	text,
	timestamp,
	uniqueIndex,
} from "drizzle-orm/pg-core";
export const dateTime = (name?: string) =>
	name === undefined
		? timestamp({ withTimezone: true })
		: timestamp(name, { withTimezone: true });
export const json = jsonb;
