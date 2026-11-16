# Authentication and account recovery

Server-only authentication utilities wrap Better Auth. The HTTP/account contracts below describe the self-hosted application adapter in `apps/web`; the package supplies reusable authentication helpers. Database hooks gate registration and session creation. Provider credentials are encrypted at rest. Social identities are linked explicitly by an authenticated account holder; matching email addresses do not implicitly link accounts.

GitHub sign-in is enabled by `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`; its callback is `<BETTER_AUTH_URL>/api/auth/callback/github`. Google uses `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, with callback `<BETTER_AUTH_URL>/api/auth/callback/google`. Configure only the providers you want to offer. The application passes these credentials through `createAuth({socialProviders})`; the package does not read provider environment variables.

## Invitation and recovery HTTP contracts

The application exposes these endpoints under `/api/auth`. POST requests require an `Origin` header matching `BETTER_AUTH_URL`.

| Endpoint | Input | Response |
| --- | --- | --- |
| `GET account-options` | Invitation cookie, when present | `{providers, emailRecovery, invitation}`; `invitation` is `null` or `{email: string \| null}` |
| `GET accept-invitation/<token>` | Operator-issued link | Stores an HttpOnly, SameSite=Lax invitation cookie and redirects to `/auth/sign-up`; unavailable links return 400 |
| `POST sign-up/email` | `{name, password, email?}` with invitation cookie, or `invitationToken` in the body | Better Auth signup response; email-free signup returns a generated `user.email` login identifier that the user must save |
| `POST sign-in/social` | `{provider, callbackURL, additionalData?: {invitationToken}}` | Better Auth authorization URL; an invitation cookie is forwarded into protected OAuth state |
| `POST link-social` | Better Auth `{provider, callbackURL}`, authenticated | Links a configured provider to the current account |
| `POST recover-account` | `{identifier, code, password}` | `{ok:true}` or status 400 with `{message}` |
| `POST request-account-recovery` | `{identifier}` | Always `{ok:true}`; queues recovery only for an eligible account with a verified email and configured delivery |

Passwords contain 12–128 characters. Invitations expire and are consumed once. A social registration requires a provider-verified email; an invitation addressed to an email must match that identity. Returning linked social identities need no further invitation.

Recovery codes contain 192 random bits, are stored as digests, and can each be redeemed once. Rotating codes requires a session created in the preceding ten minutes and invalidates previous codes. Recovery changes the password, revokes dashboard sessions and agent bearer/OAuth credentials, and can restore a deletion request before its deadline. It does not restore revoked agent access or bypass suspension. Sign in again after recovery.

## Optional email

Configure `SMTP_HOST`, `SMTP_FROM`, and optionally `SMTP_PORT` (default 465), `SMTP_USER`, and `SMTP_PASSWORD`. Port 465 uses TLS; other ports require STARTTLS with normal certificate validation. Without the required configuration, email recovery and verification delivery are disabled.

Signup email verification and recovery messages use an encrypted outbox in the application database. A server maintenance scan retries delivery with backoff and expires pending messages; conditional leases prevent ordinary concurrent duplicate attempts. Delivery is at least once if a process stops after sending but before committing. Recovery emails contain a one-use code valid for 15 minutes, to paste into the recovery form; recovery secrets do not enter application navigation parameters. Requesting another code is throttled to one per account per minute. SMTP integration still requires verification against the operator's configured mail service.

## Account lifecycle and operator controls

`accountStatus`, `rotateRecoveryCodes`, and `deleteAccount` are management RPC methods. Deletion requires `{confirmation:"DELETE"}` and a session created within ten minutes. It immediately revokes sessions and agent credentials. The recovery window defaults to seven days; operators can set 0–365 days through `instanceSettings`/`saveInstanceSettings`. A settings change affects subsequent deletion requests. Server maintenance scans purge expired accounts, owned configuration, credentials and activity; audit records retain action metadata without secrets.

Operators can list account administration fields, invite users, suspend accounts and request deletion of suspended accounts through `operatorUsers`, `inviteUser`, `suspendUser`, and `operatorDeleteUser`. These methods expose no other account's connections, credentials or gateway activity. Emergency reset has no dashboard endpoint.

With Node.js 24.17.0 selected, run the audited emergency procedure from `apps/web`, after verifying the account holder's identity through a trusted channel:

```sh
vp exec tsx --env-file-if-exists=.env src/server/account-cli.ts emergency-reset USER_ID OPERATOR_ID 'Reason for the verified reset'
```

The command revokes sessions and agent credentials, removes existing sign-in methods and recovery codes, records the operator identity and reason, and prints one recovery code valid for 24 hours. Deliver it only to the verified account holder. Suspended/deleted accounts must first follow their normal administration/recovery process.

An explicit purge scan is also available:

```sh
vp exec tsx --env-file-if-exists=.env src/server/account-cli.ts purge
```

## All-agent grants

`saveAllAgentGrant({connectionId,rules})` grants one owned connection to all current and future agents of the same user. `removeAllAgentGrant({connectionId})` removes that grant. Snapshots expose these rules in `allAgentGrants`; they are resolved during discovery and each admission, without copying grants into future agent records. A block in either a per-agent rule or an all-agent rule defeats every allow/full-access rule. Changes invalidate active sessions for the affected agents so cached streams cannot keep stale access.

## Upstream refresh coordination

`createUpstreamOAuthService` coordinates refresh by the shared grant identity, including connections that reference the same rotating token family. The database holds encrypted credentials, conditional ownership leases and the durable `refreshPending` marker. No separate `lockPool` or PostgreSQL advisory lock is used.

The pending marker is committed before the external token exchange. Successful persistence is fenced by ownership; an interrupted or ambiguous refresh requires reconnection rather than retrying a potentially consumed refresh token. Lease expiry alone never authorizes replay. No database transaction spans the provider request.
