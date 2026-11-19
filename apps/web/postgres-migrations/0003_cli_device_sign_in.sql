CREATE TABLE "cli_device_links" (
	"deviceCode" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"deviceId" text NOT NULL,
	"sessionId" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "device_code" (
	"id" text PRIMARY KEY NOT NULL,
	"deviceCode" text NOT NULL,
	"userCode" text NOT NULL,
	"userId" text,
	"expiresAt" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"lastPolledAt" timestamp with time zone,
	"pollingInterval" integer,
	"clientId" text,
	"scope" text,
	CONSTRAINT "device_code_deviceCode_unique" UNIQUE("deviceCode"),
	CONSTRAINT "device_code_userCode_unique" UNIQUE("userCode")
);
--> statement-breakpoint
ALTER TABLE "cli_device_links" ADD CONSTRAINT "cli_device_links_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cli_device_links" ADD CONSTRAINT "cli_device_links_deviceId_devices_id_fk" FOREIGN KEY ("deviceId") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cli_device_links" ADD CONSTRAINT "cli_device_links_sessionId_session_id_fk" FOREIGN KEY ("sessionId") REFERENCES "public"."session"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_code" ADD CONSTRAINT "device_code_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cli_device_links_session" ON "cli_device_links" USING btree ("sessionId");--> statement-breakpoint
CREATE INDEX "device_code_expires" ON "device_code" USING btree ("expiresAt");