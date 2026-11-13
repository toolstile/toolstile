# Tool review

A remote MCP server can add tools or change a tool's description, inputs, outputs or hints at any time. Agents read those definitions to decide what to call, so a changed definition can change what an agent does with a tool you already allowed.

Open **Tool reviews**, choose a connection and turn on review. Turning it on accepts the tools the connection has at that moment. After that:

- A new tool, or a tool whose definition differs from the accepted version, is hidden from agents' tool lists and refused if an agent calls it. The agent is told the tool is waiting for review. This also applies to tools allowed through **All, including new**: they are available once reviewed.
- The definition is checked again on every call, so a change made after an agent listed its tools cannot run before review.
- The change appears under the connection with a line diff against the accepted version. **Accept** makes that exact version available; a later change waits again. Accepting a version that has since changed again is refused.
- Changes are noticed when an agent lists or calls tools, or when you refresh the connection's tools. Toolstile does not poll servers in the background.
- Activity records a held call as **Held for review**.

Turning review off forgets every accepted version, and all granted tools become available as the server reports them. Turning it on again takes a new snapshot.

## What counts as a change

Every field passed on to agents is compared: name, title, description, input and output schemas, annotations, icons, execution hints and `_meta`. They are compared after sorting object keys and trimming surrounding whitespace in text. Any other difference is a change. A removed tool keeps its accepted version: if it returns unchanged it is available again, and if it returns changed it waits. A renamed tool is a new tool.

Definitions larger than 32 KiB keep only their digest, so the diff cannot be shown; accept them only if you trust the server. Toolstile keeps the accepted and the latest version of each tool, and at most 1,000 waiting versions per connection; beyond that the oldest waiting ones are dropped (those tools stay hidden and reappear for review when next seen). The review page shows the 100 most recent changes at a time.

## Limits

Review compares the definition the server reports. It cannot detect a change in what a tool does behind an unchanged definition, and it cannot see a change before the next list, call or refresh.

## Approvals

An approval-gated call is bound to the accepted version of its tool. Accepting a new version invalidates approvals made for the previous one, so the agent has to ask again.
