CREATE TABLE "local_commands" (
	"connectionId" text PRIMARY KEY NOT NULL,
	"command" text NOT NULL,
	"args" jsonb NOT NULL,
	"encryptedEnv" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "local_commands" ADD CONSTRAINT "local_commands_connectionId_connections_id_fk" FOREIGN KEY ("connectionId") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;