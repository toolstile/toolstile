import { openDatabase } from "@toolstile/database";
import { createAccountService } from "./accounts";

// Run with tsx --env-file-if-exists=.env src/server/account-cli.ts from apps/web.
const databaseURL = process.env.DATABASE_URL;
if (!databaseURL)
    throw new Error("DATABASE_URL is required");
const { pool } = openDatabase(databaseURL);
const accounts = createAccountService(pool);
try {
    const [command, userId, actor, ...reason] = process.argv.slice(2);
    if (command === "purge")
        console.log(`Purged ${await accounts.purgeExpired()} expired accounts`);
    else if (command === "emergency-reset" && userId && actor) {
        const code = await accounts.emergencyReset(userId, actor, reason.join(" "));
        console.log(`Deliver this one-use recovery code after verifying the account holder's identity: ${code}`);
    }
    else
        throw new Error("Usage: account-cli.ts purge | emergency-reset USER_ID OPERATOR_ID REASON");
}
finally {
    await pool.end();
}
