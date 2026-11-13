import { setupProgressColumns, user } from "@toolstile/database";
import { pgTable, text } from "@toolstile/database/pg-columns";
export const setupProgress = pgTable("setup_progress", {
	userId: text()
		.primaryKey()
		.references(() => user.id, { onDelete: "cascade" }),
	...setupProgressColumns(),
});
