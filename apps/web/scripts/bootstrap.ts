import { digest, issueToken } from "@toolstile/auth";
import { db, pool } from "../src/server/runtime";
import { invitations } from "../src/server/schema";

const email = process.argv[2]?.toLowerCase();
if (!email?.includes("@"))
	throw new Error("Usage: vp run bootstrap email@example.com");
const token = issueToken();
try {
	await db
		.insert(invitations)
		.values({
			id: digest(token),
			email,
			expiresAt: new Date(Date.now() + 86400000),
		})
		.onConflictDoUpdate({
			target: invitations.email,
			set: { id: digest(token), expiresAt: new Date(Date.now() + 86400000) },
		});
	console.log(
		`Invitation (valid 24 hours): ${process.env.BETTER_AUTH_URL}/api/auth/accept-invitation/${token}`,
	);
} finally {
	await pool.end();
}
