import { expect, it } from "vitest";
import {
	createDebugStore,
	type DebugPool,
} from "../packages/gateway/src/index";

const actor = { userId: "user", scopeId: "user" };
function fakePool(failRollback: boolean) {
	const statements: string[] = [];
	const released: (Error | undefined)[] = [];
	const query = async (text: string) => {
		statements.push(text);
		if (text === "rollback" && failRollback)
			throw new Error("connection terminated");
		return { rows: [], rowCount: 0 };
	};
	const pool = {
		query,
        raw: async () => ({rows:[],values:[],columns:[],changes:0}),
		connect: async () => ({
			query,
			release: (error?: Error) => released.push(error),
		}),
	} as unknown as DebugPool;
	return { pool, statements, released };
}
function store(pool: DebugPool, activityTable?: string) {
	return createDebugStore({
		pool,
		box: { encrypt: () => "", decrypt: <T>() => ({}) as T },
		async authorize() {
			throw new Error("authorization refused");
		},
		retention: async () => ({
			activityRetentionDays: 30,
			payloadRetentionHours: 24,
		}),
		activityTable,
	});
}

it("refuses preparation without executing any writes or checking out a connection", async () => {
 const failing = fakePool(true);
 await expect(store(failing.pool).stop(actor,"id")).rejects.toThrow("authorization refused");
 expect(failing.statements).toEqual([]);
 expect(failing.released).toEqual([]);
});

it("purges the host's activity table", async () => {
	const { pool, statements } = fakePool(false);
	await store(pool, "workspace_activity").cleanup();
	expect(statements.at(-1)).toMatch(/^delete from "workspace_activity" where/);
	await store(pool).cleanup();
	expect(statements.at(-1)).toMatch(/^delete from "activity" where/);
	expect(() => store(pool, 'activity"; drop table x;--')).toThrow(
		"Invalid activity table name",
	);
});
