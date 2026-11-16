import { user } from "@toolstile/database";
import { eq } from "drizzle-orm";
import { db, pool } from "../src/server/runtime";
import { profiles } from "../src/server/schema";

const email = process.argv[2]?.toLowerCase();
if (!email)
	throw new Error("Usage: vp run -F @toolstile/web operator email@example.com");
try {
	const [person] = await db.select().from(user).where(eq(user.email, email));
	if (!person) throw new Error("Create the invited account first");
	await db
		.insert(profiles)
		.values({ userId: person.id, operator: true })
		.onConflictDoUpdate({ target: profiles.userId, set: { operator: true } });
	console.log("Operator access granted to the selected account");
} finally {
	await pool.end();
}
