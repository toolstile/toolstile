CREATE TABLE "account_audit" (
	"id" text PRIMARY KEY NOT NULL,
	"subjectId" text NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"reason" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "account_email_outbox" (
	"claimToken" text,
	"claimedUntil" timestamp with time zone,
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"encryptedMessage" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"availableAt" timestamp with time zone DEFAULT now() NOT NULL,
	"expiresAt" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "activity" (
	"id" text PRIMARY KEY NOT NULL,
	"ownerId" text NOT NULL,
	"agent" text NOT NULL,
	"connection" text NOT NULL,
	"method" text NOT NULL,
	"target" text,
	"outcome" text NOT NULL,
	"durationMs" integer NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "all_agent_grants" (
	"id" text PRIMARY KEY NOT NULL,
	"ownerId" text NOT NULL,
	"connectionId" text NOT NULL,
	"rules" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "authorizations" (
	"id" text PRIMARY KEY NOT NULL,
	"agentId" text NOT NULL,
	"tokenHash" text NOT NULL,
	"expiresAt" timestamp with time zone,
	"revokedAt" timestamp with time zone,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "authorizations_agentId_unique" UNIQUE("agentId"),
	CONSTRAINT "authorizations_tokenHash_unique" UNIQUE("tokenHash")
);
--> statement-breakpoint
CREATE TABLE "debug_payloads" (
	"id" text PRIMARY KEY NOT NULL,
	"scopeId" text NOT NULL,
	"sessionId" text NOT NULL,
	"agentId" text NOT NULL,
	"connectionId" text NOT NULL,
	"encryptedPayload" text NOT NULL,
	"expiresAt" timestamp with time zone NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "debug_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"scopeId" text NOT NULL,
	"enabledBy" text NOT NULL,
	"agentIds" jsonb NOT NULL,
	"connectionIds" jsonb NOT NULL,
	"stopsAt" timestamp with time zone NOT NULL,
	"stoppedAt" timestamp with time zone,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "grants" (
	"id" text PRIMARY KEY NOT NULL,
	"agentId" text NOT NULL,
	"connectionId" text NOT NULL,
	"rules" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "instance_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"recoveryWindowDays" integer DEFAULT 7 NOT NULL,
	"registrationPolicy" text DEFAULT 'invite-only' NOT NULL,
	"allowPrivateNetwork" boolean DEFAULT true NOT NULL,
	"telemetryEnabled" boolean DEFAULT true NOT NULL,
	"activityRetentionDays" integer DEFAULT 30 NOT NULL,
	"payloadRetentionHours" integer DEFAULT 24 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invitations" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text,
	"expiresAt" timestamp with time zone NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invitations_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "profiles" (
	"userId" text PRIMARY KEY NOT NULL,
	"operator" boolean DEFAULT false NOT NULL,
	"suspended" boolean DEFAULT false NOT NULL,
	"deletedAt" timestamp with time zone,
	"purgeAfter" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "recovery_codes" (
	"hash" text PRIMARY KEY NOT NULL,
	"purpose" text DEFAULT 'recovery' NOT NULL,
	"expiresAt" timestamp with time zone,
	"userId" text NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "setup_progress" (
	"userId" text PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"step" text DEFAULT 'connect' NOT NULL,
	"client" text DEFAULT 'claude-code' NOT NULL,
	"connectionId" text,
	"agentId" text,
	"verificationKey" text,
	"verifiedAt" timestamp with time zone,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "telemetry_daily" (
	"day" text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TABLE "telemetry_outbox" (
	"day" text PRIMARY KEY NOT NULL,
	"payload" jsonb NOT NULL,
	"claimToken" text,
	"claimedUntil" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"availableAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tool_approvals" (
	"id" text PRIMARY KEY NOT NULL,
	"scopeId" text NOT NULL,
	"requesterId" text NOT NULL,
	"agentId" text NOT NULL,
	"connectionId" text NOT NULL,
	"connectionLabel" text NOT NULL,
	"agentLabel" text NOT NULL,
	"tool" text NOT NULL,
	"fingerprint" text NOT NULL,
	"encryptedRequest" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"expiresAt" timestamp with time zone NOT NULL,
	"decidedBy" text,
	"decidedAt" timestamp with time zone,
	"claimedOperationId" text,
	"claimedAt" timestamp with time zone,
	"settledAt" timestamp with time zone,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tool_definitions" (
	"id" text PRIMARY KEY NOT NULL,
	"scopeId" text NOT NULL,
	"connectionId" text NOT NULL,
	"name" text NOT NULL,
	"digest" text NOT NULL,
	"snapshot" text,
	"observedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tool_review_settings" (
	"connectionId" text PRIMARY KEY NOT NULL,
	"scopeId" text NOT NULL,
	"enabledBy" text NOT NULL,
	"enabledAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tool_reviews" (
	"scopeId" text NOT NULL,
	"connectionId" text NOT NULL,
	"name" text NOT NULL,
	"digest" text NOT NULL,
	"reviewedBy" text NOT NULL,
	"reviewedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tool_reviews_connectionId_name_pk" PRIMARY KEY("connectionId","name")
);
--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"accountId" text NOT NULL,
	"providerId" text NOT NULL,
	"userId" text NOT NULL,
	"accessToken" text,
	"refreshToken" text,
	"idToken" text,
	"accessTokenExpiresAt" timestamp with time zone,
	"refreshTokenExpiresAt" timestamp with time zone,
	"scope" text,
	"password" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agents" (
	"id" text PRIMARY KEY NOT NULL,
	"ownerId" text NOT NULL,
	"deviceId" text NOT NULL,
	"label" text NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "_atomic_plan_guard" (
	"id" text PRIMARY KEY NOT NULL,
	"valid" integer NOT NULL,
	CONSTRAINT "atomic_plan_valid" CHECK ("_atomic_plan_guard"."valid" = 1)
);
--> statement-breakpoint
CREATE TABLE "connection_oauth" (
	"connectionId" text PRIMARY KEY NOT NULL,
	"grantId" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connections" (
	"id" text PRIMARY KEY NOT NULL,
	"ownerId" text NOT NULL,
	"label" text NOT NULL,
	"url" text NOT NULL,
	"transport" text DEFAULT 'http' NOT NULL,
	"authentication" text DEFAULT 'headers' NOT NULL,
	"encryptedHeaders" text NOT NULL,
	"status" text DEFAULT 'configured' NOT NULL,
	"connectorId" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connector_requests" (
	"owner_id" text NOT NULL,
	"scope_id" text NOT NULL,
	"request_id" text NOT NULL,
	"fingerprint" text NOT NULL,
	"response" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connector_requests_owner_id_scope_id_request_id_pk" PRIMARY KEY("owner_id","scope_id","request_id")
);
--> statement-breakpoint
CREATE TABLE "devices" (
	"browserKeyHash" text,
	"id" text PRIMARY KEY NOT NULL,
	"ownerId" text NOT NULL,
	"label" text NOT NULL,
	"revokedAt" timestamp with time zone,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jwks" (
	"id" text PRIMARY KEY NOT NULL,
	"publicKey" text NOT NULL,
	"privateKey" text NOT NULL,
	"createdAt" timestamp with time zone NOT NULL,
	"expiresAt" timestamp with time zone,
	"alg" text,
	"crv" text
);
--> statement-breakpoint
CREATE TABLE "mcp_owner_rates" (
	"keyHash" text PRIMARY KEY NOT NULL,
	"count" integer NOT NULL,
	"resetsAt" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mcp_owners" (
	"id" text PRIMARY KEY NOT NULL,
	"keyHash" text NOT NULL,
	"ownerHash" text NOT NULL,
	"expiresAt" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauthAccessToken" (
	"id" text PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"clientId" text NOT NULL,
	"sessionId" text,
	"userId" text,
	"referenceId" text,
	"authorizationCodeId" text,
	"resources" jsonb,
	"requestedUserInfoClaims" jsonb,
	"refreshId" text,
	"expiresAt" timestamp with time zone NOT NULL,
	"createdAt" timestamp with time zone NOT NULL,
	"revoked" timestamp with time zone,
	"confirmation" jsonb,
	"scopes" jsonb NOT NULL,
	CONSTRAINT "oauthAccessToken_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "oauthClient" (
	"id" text PRIMARY KEY NOT NULL,
	"clientId" text NOT NULL,
	"clientSecret" text,
	"clientDiscoveryId" text,
	"disabled" boolean DEFAULT false,
	"skipConsent" boolean,
	"enableEndSession" boolean,
	"subjectType" text,
	"scopes" jsonb,
	"clientCredentialsScopes" jsonb DEFAULT '[]'::jsonb,
	"userId" text,
	"createdAt" timestamp with time zone,
	"updatedAt" timestamp with time zone,
	"name" text,
	"uri" text,
	"icon" text,
	"contacts" jsonb,
	"tos" text,
	"policy" text,
	"softwareId" text,
	"softwareVersion" text,
	"softwareStatement" text,
	"redirectUris" jsonb NOT NULL,
	"postLogoutRedirectUris" jsonb,
	"backchannelLogoutUri" text,
	"backchannelLogoutSessionRequired" boolean,
	"tokenEndpointAuthMethod" text,
	"applicationType" text,
	"jwks" text,
	"jwksUri" text,
	"grantTypes" jsonb,
	"responseTypes" jsonb,
	"requirePKCE" boolean,
	"dpopBoundAccessTokens" boolean DEFAULT false,
	"referenceId" text,
	"metadata" jsonb,
	CONSTRAINT "oauthClient_clientId_unique" UNIQUE("clientId")
);
--> statement-breakpoint
CREATE TABLE "oauthClientAssertion" (
	"id" text PRIMARY KEY NOT NULL,
	"expiresAt" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauthClientResource" (
	"id" text PRIMARY KEY NOT NULL,
	"clientId" text NOT NULL,
	"resourceId" text NOT NULL,
	"metadata" jsonb,
	"createdAt" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "oauthConsent" (
	"id" text PRIMARY KEY NOT NULL,
	"clientId" text NOT NULL,
	"userId" text,
	"referenceId" text,
	"resources" jsonb,
	"requestedUserInfoClaims" jsonb,
	"scopes" jsonb NOT NULL,
	"createdAt" timestamp with time zone NOT NULL,
	"updatedAt" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_flow_selection" (
	"id" text PRIMARY KEY NOT NULL,
	"sessionId" text NOT NULL,
	"userId" text NOT NULL,
	"referenceId" text NOT NULL,
	"expiresAt" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauthRefreshToken" (
	"id" text PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"clientId" text NOT NULL,
	"sessionId" text,
	"userId" text NOT NULL,
	"referenceId" text,
	"authorizationCodeId" text,
	"resources" jsonb,
	"requestedUserInfoClaims" jsonb,
	"expiresAt" timestamp with time zone NOT NULL,
	"createdAt" timestamp with time zone NOT NULL,
	"revoked" timestamp with time zone,
	"rotatedAt" timestamp with time zone,
	"rotationReplayResponse" text,
	"rotationReplayExpiresAt" timestamp with time zone,
	"authTime" timestamp with time zone,
	"confirmation" jsonb,
	"scopes" jsonb NOT NULL,
	CONSTRAINT "oauthRefreshToken_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "oauthResource" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"name" text NOT NULL,
	"accessTokenTtl" integer,
	"refreshTokenTtl" integer,
	"signingAlgorithm" text,
	"signingKeyId" text,
	"allowedScopes" jsonb,
	"customClaims" jsonb,
	"dpopBoundAccessTokensRequired" boolean DEFAULT false,
	"disabled" boolean DEFAULT false,
	"createdAt" timestamp with time zone,
	"updatedAt" timestamp with time zone,
	"policyVersion" integer DEFAULT 1,
	"metadata" jsonb,
	CONSTRAINT "oauthResource_identifier_unique" UNIQUE("identifier")
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"expiresAt" timestamp with time zone NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	"ipAddress" text,
	"userAgent" text,
	"userId" text NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "upstream_oauth_flows" (
	"id" text PRIMARY KEY NOT NULL,
	"connectionId" text NOT NULL,
	"userId" text NOT NULL,
	"sessionId" text NOT NULL,
	"serverUrl" text NOT NULL,
	"encryptedData" text NOT NULL,
	"expiresAt" timestamp with time zone NOT NULL,
	"consumedAt" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "upstream_oauth_grants" (
	"leaseId" text,
	"leaseUntil" timestamp with time zone,
	"refreshPending" boolean DEFAULT false NOT NULL,
	"id" text PRIMARY KEY NOT NULL,
	"encryptedData" text NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"emailVerified" boolean DEFAULT false NOT NULL,
	"image" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expiresAt" timestamp with time zone NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account_email_outbox" ADD CONSTRAINT "account_email_outbox_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity" ADD CONSTRAINT "activity_ownerId_user_id_fk" FOREIGN KEY ("ownerId") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "all_agent_grants" ADD CONSTRAINT "all_agent_grants_ownerId_user_id_fk" FOREIGN KEY ("ownerId") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "all_agent_grants" ADD CONSTRAINT "all_agent_grants_connectionId_connections_id_fk" FOREIGN KEY ("connectionId") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authorizations" ADD CONSTRAINT "authorizations_agentId_agents_id_fk" FOREIGN KEY ("agentId") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debug_payloads" ADD CONSTRAINT "debug_payloads_scopeId_user_id_fk" FOREIGN KEY ("scopeId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debug_payloads" ADD CONSTRAINT "debug_payloads_sessionId_debug_sessions_id_fk" FOREIGN KEY ("sessionId") REFERENCES "public"."debug_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debug_sessions" ADD CONSTRAINT "debug_sessions_scopeId_user_id_fk" FOREIGN KEY ("scopeId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debug_sessions" ADD CONSTRAINT "debug_sessions_enabledBy_user_id_fk" FOREIGN KEY ("enabledBy") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grants" ADD CONSTRAINT "grants_agentId_agents_id_fk" FOREIGN KEY ("agentId") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grants" ADD CONSTRAINT "grants_connectionId_connections_id_fk" FOREIGN KEY ("connectionId") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_codes" ADD CONSTRAINT "recovery_codes_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "setup_progress" ADD CONSTRAINT "setup_progress_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_approvals" ADD CONSTRAINT "tool_approvals_scopeId_user_id_fk" FOREIGN KEY ("scopeId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_approvals" ADD CONSTRAINT "tool_approvals_requesterId_user_id_fk" FOREIGN KEY ("requesterId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_approvals" ADD CONSTRAINT "tool_approvals_agentId_agents_id_fk" FOREIGN KEY ("agentId") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_definitions" ADD CONSTRAINT "tool_definitions_scopeId_user_id_fk" FOREIGN KEY ("scopeId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_definitions" ADD CONSTRAINT "tool_definitions_connectionId_connections_id_fk" FOREIGN KEY ("connectionId") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_review_settings" ADD CONSTRAINT "tool_review_settings_connectionId_connections_id_fk" FOREIGN KEY ("connectionId") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_review_settings" ADD CONSTRAINT "tool_review_settings_scopeId_user_id_fk" FOREIGN KEY ("scopeId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_reviews" ADD CONSTRAINT "tool_reviews_scopeId_user_id_fk" FOREIGN KEY ("scopeId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_reviews" ADD CONSTRAINT "tool_reviews_connectionId_connections_id_fk" FOREIGN KEY ("connectionId") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_ownerId_user_id_fk" FOREIGN KEY ("ownerId") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_deviceId_devices_id_fk" FOREIGN KEY ("deviceId") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_oauth" ADD CONSTRAINT "connection_oauth_connectionId_connections_id_fk" FOREIGN KEY ("connectionId") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_oauth" ADD CONSTRAINT "connection_oauth_grantId_upstream_oauth_grants_id_fk" FOREIGN KEY ("grantId") REFERENCES "public"."upstream_oauth_grants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_ownerId_user_id_fk" FOREIGN KEY ("ownerId") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_ownerId_user_id_fk" FOREIGN KEY ("ownerId") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauthAccessToken" ADD CONSTRAINT "oauthAccessToken_clientId_oauthClient_clientId_fk" FOREIGN KEY ("clientId") REFERENCES "public"."oauthClient"("clientId") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauthAccessToken" ADD CONSTRAINT "oauthAccessToken_sessionId_session_id_fk" FOREIGN KEY ("sessionId") REFERENCES "public"."session"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauthAccessToken" ADD CONSTRAINT "oauthAccessToken_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauthAccessToken" ADD CONSTRAINT "oauthAccessToken_refreshId_oauthRefreshToken_id_fk" FOREIGN KEY ("refreshId") REFERENCES "public"."oauthRefreshToken"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauthClient" ADD CONSTRAINT "oauthClient_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauthClientResource" ADD CONSTRAINT "oauthClientResource_clientId_oauthClient_clientId_fk" FOREIGN KEY ("clientId") REFERENCES "public"."oauthClient"("clientId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauthClientResource" ADD CONSTRAINT "oauthClientResource_resourceId_oauthResource_identifier_fk" FOREIGN KEY ("resourceId") REFERENCES "public"."oauthResource"("identifier") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauthConsent" ADD CONSTRAINT "oauthConsent_clientId_oauthClient_clientId_fk" FOREIGN KEY ("clientId") REFERENCES "public"."oauthClient"("clientId") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauthConsent" ADD CONSTRAINT "oauthConsent_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_flow_selection" ADD CONSTRAINT "oauth_flow_selection_sessionId_session_id_fk" FOREIGN KEY ("sessionId") REFERENCES "public"."session"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_flow_selection" ADD CONSTRAINT "oauth_flow_selection_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauthRefreshToken" ADD CONSTRAINT "oauthRefreshToken_clientId_oauthClient_clientId_fk" FOREIGN KEY ("clientId") REFERENCES "public"."oauthClient"("clientId") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauthRefreshToken" ADD CONSTRAINT "oauthRefreshToken_sessionId_session_id_fk" FOREIGN KEY ("sessionId") REFERENCES "public"."session"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauthRefreshToken" ADD CONSTRAINT "oauthRefreshToken_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upstream_oauth_flows" ADD CONSTRAINT "upstream_oauth_flows_connectionId_connections_id_fk" FOREIGN KEY ("connectionId") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upstream_oauth_flows" ADD CONSTRAINT "upstream_oauth_flows_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upstream_oauth_flows" ADD CONSTRAINT "upstream_oauth_flows_sessionId_session_id_fk" FOREIGN KEY ("sessionId") REFERENCES "public"."session"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "activity_owner_created_at" ON "activity" USING btree ("ownerId","createdAt");--> statement-breakpoint
CREATE INDEX "activity_created_at" ON "activity" USING btree ("createdAt");--> statement-breakpoint
CREATE UNIQUE INDEX "all_agent_grant_pair" ON "all_agent_grants" USING btree ("ownerId","connectionId");--> statement-breakpoint
CREATE INDEX "debug_payload_session" ON "debug_payloads" USING btree ("sessionId");--> statement-breakpoint
CREATE INDEX "debug_payload_expiry" ON "debug_payloads" USING btree ("expiresAt");--> statement-breakpoint
CREATE INDEX "debug_session_scope" ON "debug_sessions" USING btree ("scopeId");--> statement-breakpoint
CREATE UNIQUE INDEX "grant_pair" ON "grants" USING btree ("agentId","connectionId");--> statement-breakpoint
CREATE INDEX "recovery_code_user" ON "recovery_codes" USING btree ("userId");--> statement-breakpoint
CREATE UNIQUE INDEX "tool_approval_active_call" ON "tool_approvals" USING btree ("scopeId","agentId","fingerprint") WHERE "tool_approvals"."status" in ('pending','approved','claimed');--> statement-breakpoint
CREATE INDEX "tool_approval_scope_status" ON "tool_approvals" USING btree ("scopeId","status","createdAt");--> statement-breakpoint
CREATE INDEX "tool_approval_expiry" ON "tool_approvals" USING btree ("expiresAt");--> statement-breakpoint
CREATE UNIQUE INDEX "tool_definition_version" ON "tool_definitions" USING btree ("connectionId","name","digest");--> statement-breakpoint
CREATE INDEX "account_user" ON "account" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "agent_owner" ON "agents" USING btree ("ownerId");--> statement-breakpoint
CREATE INDEX "agent_device" ON "agents" USING btree ("deviceId");--> statement-breakpoint
CREATE INDEX "connection_owner" ON "connections" USING btree ("ownerId");--> statement-breakpoint
CREATE INDEX "connector_requests_created_at" ON "connector_requests" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "device_owner" ON "devices" USING btree ("ownerId");--> statement-breakpoint
CREATE INDEX "mcp_owner_agent" ON "mcp_owners" USING btree ("keyHash","expiresAt");--> statement-breakpoint
CREATE INDEX "mcp_owner_user" ON "mcp_owners" USING btree ("ownerHash","expiresAt");--> statement-breakpoint
CREATE INDEX "mcp_owner_expiry" ON "mcp_owners" USING btree ("expiresAt");--> statement-breakpoint
CREATE INDEX "session_expiry" ON "session" USING btree ("expiresAt");--> statement-breakpoint
CREATE INDEX "session_user" ON "session" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "user_email_lower" ON "user" USING btree (lower("email"));