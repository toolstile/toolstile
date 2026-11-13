import { randomUUID } from "node:crypto";
import { afterEach, expect, test } from "vitest";
import { createAccountTestDatabase } from "../../../tests/account-database";
import { createGrantCoordinator, markGrantReconnect } from "../src/upstream-coordination";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); });
async function fixture() {
	const storage = await createAccountTestDatabase();
	cleanups.push(storage.close);
	const id = randomUUID();
	await storage.pool.query(`INSERT INTO "user"(id,name,email) VALUES($1,'Fixture',$2)`, [id, `${id}@example.test`]);
	for (const connection of ["first", "second"])
		await storage.pool.query(`INSERT INTO connections(id,"ownerId",label,url,"encryptedHeaders",status) VALUES($1,$2,$1,'https://example.com/mcp','opaque','authenticated')`, [connection, id]);
	await storage.pool.query(`INSERT INTO upstream_oauth_grants(id,"encryptedData") VALUES('grant','old')`);
	for (const connection of ["first", "second"])
		await storage.pool.query(`INSERT INTO connection_oauth("connectionId","grantId") VALUES($1,'grant')`, [connection]);
	return storage;
}

test("different bindings share a durable grant owner and observe the rotated snapshot", async () => {
	const storage = await fixture();
	const first = createGrantCoordinator(storage.pool);
	const second = createGrantCoordinator(storage.pool);
	let release!: () => void;
	let entered!: () => void;
	const ready = new Promise<void>((resolve) => { entered = resolve; });
	const blocked = new Promise<void>((resolve) => { release = resolve; });
	const rotating = first("first", async (lease) => {
		expect(lease.encryptedData).toBe("old");
		await lease.beginRefresh();
		entered();
		await blocked;
		await lease.persist("rotated");
	});
	await ready;
	const waiting = second("second", async (lease) => lease.encryptedData);
	// Database work remains available while the exchange is in flight.
	expect((await storage.pool.query("SELECT count(*) AS n FROM connections")).rows[0].n).toBe(2);
	release();
	await rotating;
	expect(await waiting).toBe("rotated");
});

test("a lost refresh response prevents replay for every binding of the grant", async () => {
	const storage = await fixture();
	const coordinate = createGrantCoordinator(storage.pool);
	await expect(coordinate("first", async (lease) => {
		await lease.beginRefresh();
		throw new Error("response lost after upstream exchange");
	})).rejects.toThrow();
	let attempted = false;
	await expect(coordinate("second", async () => { attempted = true; })).rejects.toThrow();
	expect(attempted).toBe(false);
	expect((await storage.pool.query("SELECT status FROM connections")).rows.map((row) => row.status)).toEqual(["needs reconnection", "needs reconnection"]);
});

test("evicted or expired refresh owners require reconnection, while unused leases recover", async () => {
	const storage = await fixture();
	const coordinate = createGrantCoordinator(storage.pool);
	await storage.pool.query(`UPDATE upstream_oauth_grants SET "leaseId"='dead',"leaseUntil"=$1,"refreshPending"=true`, [new Date(0)]);
	await expect(coordinate("first", async () => "unsafe replay")).rejects.toThrow();
	await storage.pool.query(`UPDATE upstream_oauth_grants SET "refreshPending"=false`);
	expect(await coordinate("first", async (lease) => lease.encryptedData)).toBe("old");
});

test("an abandoned refresh marks the grant's connections for sign-in", async () => {
	const storage = await fixture();
	const coordinate = createGrantCoordinator(storage.pool);
	await storage.pool.query(`UPDATE upstream_oauth_grants SET "leaseId"=NULL,"refreshPending"=true`);
	await expect(coordinate("first", async () => "unsafe replay")).rejects.toThrow();
	expect((await storage.pool.query("SELECT status FROM connections ORDER BY id")).rows.map((row) => row.status)).toEqual(["needs reconnection", "needs reconnection"]);
});

test("a late refresh failure leaves a connection that signed in again on its new grant", async () => {
	const storage = await fixture();
	const coordinate = createGrantCoordinator(storage.pool);
	await expect(coordinate("first", async (lease) => {
		await lease.beginRefresh();
		// The user completes a fresh sign-in for "first" while the old exchange is in flight.
		await storage.pool.query(`INSERT INTO upstream_oauth_grants(id,"encryptedData") VALUES('fresh','new')`);
		await storage.pool.query(`UPDATE connection_oauth SET "grantId"='fresh' WHERE "connectionId"='first'`);
		throw new Error("response lost after upstream exchange");
	})).rejects.toThrow();
	expect((await storage.pool.query("SELECT id,status FROM connections ORDER BY id")).rows).toEqual([
		{ id: "first", status: "authenticated" },
		{ id: "second", status: "needs reconnection" },
	]);
});

test("a refresh that outlives its lease cannot store tokens", async () => {
	const storage = await fixture();
	const coordinate = createGrantCoordinator(storage.pool);
	await expect(coordinate("first", async (lease) => {
		await lease.beginRefresh();
		await storage.pool.query(`UPDATE upstream_oauth_grants SET "leaseUntil"=$1`, [new Date(0)]);
		await lease.persist("late");
	})).rejects.toThrow();
	expect((await storage.pool.query(`SELECT "encryptedData" FROM upstream_oauth_grants WHERE id='grant'`)).rows[0].encryptedData).toBe("old");
});

// Needs concurrent server connections; embedded PGlite runs one statement at a time.
test.skipIf(!process.env.TEST_DATABASE_URL?.startsWith("postgres"))("a failure marked during an uncommitted sign-in leaves the fresh grant signed in", async () => {
	const storage = await fixture();
	const signIn = await storage.pool.connect();
	try {
		// The same writes, in the same order, as completing a browser sign-in.
		await signIn.query("BEGIN");
		await signIn.query(`INSERT INTO upstream_oauth_grants(id,"encryptedData") VALUES('fresh','new')`);
		await signIn.query(`UPDATE connection_oauth SET "grantId"='fresh' WHERE "connectionId"='first'`);
		await signIn.query(`UPDATE connections SET status='authenticated' WHERE id='first'`);
		const marking = markGrantReconnect(storage.pool, "grant");
		await new Promise((resolve) => setTimeout(resolve, 200));
		await signIn.query("COMMIT");
		await marking;
	} finally {
		signIn.release(true);
	}
	expect((await storage.pool.query("SELECT id,status FROM connections ORDER BY id")).rows).toEqual([
		{ id: "first", status: "authenticated" },
		{ id: "second", status: "needs reconnection" },
	]);
});
