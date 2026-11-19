ALTER TABLE "activity" ADD COLUMN "agentId" text;--> statement-breakpoint
ALTER TABLE "activity" ADD COLUMN "connectionId" text;--> statement-breakpoint
ALTER TABLE "activity" ADD COLUMN "origin" text;--> statement-breakpoint
CREATE INDEX "activity_first_call" ON "activity" USING btree ("ownerId","agentId","connectionId","createdAt") WHERE "activity"."origin" = 'agent' and "activity"."method" = 'tools/call';