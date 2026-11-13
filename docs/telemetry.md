# Anonymous product telemetry

Anonymous telemetry is on by default but has no destination: nothing is sent until an operator sets `TOOLSTILE_TELEMETRY_URL` (below). An instance operator can disable it in **Instance administration → Instance settings**, then select **Save settings**. Saving opt-out deletes pending reports and prevents further attempts. A request already in flight finishes before that settings save completes. Local activity and opt-in debug captures have their own retention controls and are never sent as telemetry.

No collection endpoint is selected in this release. Set `TOOLSTILE_TELEMETRY_URL` on the server to an explicitly chosen HTTPS receiver, then restart. The URL must contain no credentials, query or fragment. With this variable unset, no report is queued or delivered. There is no default public destination.

The complete JSON payload has this shape, with no additional fields:

```json
{
  "schemaVersion": 1,
  "period": "day",
  "counts": {
    "users": "1-9",
    "connections": "1-9",
    "agents": "1-9",
    "operations": "10-99",
    "errors": "0"
  }
}
```

Each count is one of `0`, `1-9`, `10-99`, `100-999`, `1000-9999`, or `10000+`. Users, connections and agents are current instance totals; deleted users are excluded from the user count. Operations and errors count activity rows from the preceding complete UTC day. Only rows whose outcome is `error` or `upstream_error` contribute to errors. Reports contain no date, version fingerprint, installation identifier, stable user identifier, names, emails, server/tool URLs or names, arguments, results, credentials or tokens. No cookies or authorization headers are sent. The receiver and network infrastructure can observe the request's source address; the payload provides no transport anonymity.

A database marker permits one aggregate per UTC day, across restarts and concurrent workers. Pending reports retry with exponential backoff capped at one day, and expire after seven days. Failed attempts never persist the response or error text. Successful delivery removes the pending row. A crash after delivery but before recording success may repeat the same anonymous aggregate; no identifying deduplication token is transmitted. Disabling and re-enabling collection cannot regenerate a report already aggregated that day. Maintenance runs approximately once a minute; these are anonymous aggregate reports, not request-by-request events.

The report uses a bounded fixed vocabulary and cannot attach arbitrary metadata. Automated tests inject a local delivery function and never contact an external receiver.
