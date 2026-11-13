const legacyDialogParams = new Set([
	"dialog",
	"agentId",
	"connectionId",
	"toolName",
	"accountAction",
	"accessScope",
	"setupStep",
	"setupClient",
	"setupConnectionId",
	"setupAgentId",
]);

// Keep unrelated query values byte-for-byte intact, including auth protocol state.
// This is only applied by the dashboard route, never by OAuth endpoints.
export function discardLegacyDialogSearch(search: string): string {
	const entries = search.replace(/^\?/, "").split("&");
	const retained = entries.filter((entry) => {
		const key = new URLSearchParams(entry).keys().next().value;
		return !key || !legacyDialogParams.has(key);
	});
	if (entries.length === retained.length) return search;
	const result = retained.join("&");
	return result ? `?${result}` : "";
}
