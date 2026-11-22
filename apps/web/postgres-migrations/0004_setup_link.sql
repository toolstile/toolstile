CREATE TABLE "setup_link" (
	"id" text PRIMARY KEY NOT NULL,
	"tokenHash" text NOT NULL,
	"expiresAt" timestamp with time zone NOT NULL
);
