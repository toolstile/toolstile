/**
 * The read-only tools every connected agent gets beside its granted connection tools, in the
 * order the gateway lists them. Browser-safe: `reads` tells the account owner what each one
 * can read. Agent-facing descriptions and schemas live in agent-tools.ts.
 */
export const builtInTools = [
	{
		name: "search_catalog",
		title: "Search the Toolstile catalog",
		reads:
			"Searches the connector catalog. Reads nothing from your connections.",
	},
	{
		name: "get_catalog_entry",
		title: "Get a Toolstile catalog entry",
		reads:
			"Reads one connector catalog entry, including its last observed tool list. Reads nothing from your connections.",
	},
	{
		name: "get_my_access",
		title: "Show this agent's access",
		reads:
			"Lists the connections and tools this agent is allowed to use, and which need approval. Reads nothing from those connections.",
	},
] as const;
