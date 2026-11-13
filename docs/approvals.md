# Tool-call approvals

In Access, choose **Require approval** for the specific tools an agent may use only after you review each call. Toolstile does not infer whether a tool reads or writes from its name or annotations. Resources and prompts keep their existing access settings.

A block always wins. Otherwise Require approval wins over Allow or full access, including an All-agent rule. Saving access settings is separate from approving a call.

When an agent invokes a gated tool, it receives an approval-required tool result containing a request identifier, expiry and review link. Open **Approvals**, inspect the agent, connection, account, destination and exact parameters, then choose **Approve once** or **Deny**. Only the connection owner can review arguments and decide. An agent credential cannot use the review API.

Approving does not run anything. The agent must retry the identical call. Changed arguments require a different approval; changing the selected account, credentials or rules invalidates the previous binding, and so does accepting a new definition of the tool when [tool review](tool-review.md) is on. Revoked or expired agents cannot use approvals.

## Expiry and storage

Pending requests last 15 minutes. Approval permits last at most 10 minutes after the decision, capped by the original request expiry. At most 20 pending requests are allowed per requesting user. Parameters must be plain JSON, at most 64 KiB and 32 levels deep; oversized input is refused rather than truncated.

Parameters are encrypted with the instance encryption key. Persisted fingerprints use a derived HMAC key. Arguments are cleared when a request is denied, consumed or invalidated. Reads and decisions enforce expiry immediately; maintenance clears lapsed stored payloads and retains terminal metadata according to the configured activity-retention period, 30 days by default. Cleanup resumes after an outage.

Hidden, direction-changing and unusual spacing characters are displayed as explicit Unicode escapes with a warning, so they cannot silently change how the JSON reads. The displayed JSON decodes to the original arguments. The approval panel marks review parameters so that analytics or session-replay tools an operator adds do not record them. Approval-required calls do not enter debug capture. Existing debug capture settings apply to an approved execution.

## Dispatch limits

Each approval permits one logical tool call. Concurrent agent retries cannot share it. A refusal before admission can return an unexpired approval to the approved state. A provider authentication refusal may use the SDK's same-wire authentication retry; an ambiguous network failure after dispatch leaves the approval spent and is never retried automatically. Toolstile cannot guarantee that a remote service applied an effect exactly once.

This version refuses approval-gated task calls and interaction continuations that add new inputs, including elicitation responses. They cannot reuse an approval for arguments the reviewer never saw. Ordinary allowed calls retain their existing interaction behavior.

## Version and key changes

Changing the encryption key invalidates outstanding approvals; encrypted payloads from the previous key cannot be recovered without it. Preserve the matching application and database versions when restoring a backup. An older version that does not understand approval rules must not serve saved approval-protected grants.
