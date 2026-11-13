import type { ConnectionPreview } from "@toolstile/api/contract";
import { Notice } from "./Primitives";

export const transportLabel = {
	http: "Streamable HTTP",
	sse: "Legacy HTTP + SSE",
} as const;

/**
 * What the check before confirmation found at an address. The address itself is shown in the
 * editable field above this note; the person confirms it or edits it and checks again.
 */
export function ConnectionCheckNote({
	preview,
}: {
	preview: ConnectionPreview;
}) {
	if (preview.status === "needs attention")
		return (
			<Notice tone="warning">
				Toolstile could not reach an MCP server at this address. Check it, edit
				it if needed, and try again. Nothing is saved until the server answers.
			</Notice>
		);
	return (
		<Notice tone="success">
			{preview.authentication === "oauth"
				? "Found an MCP server that asks you to sign in"
				: "Found an MCP server"}{" "}
			({transportLabel[preview.transport]}). Confirm the address, or edit it and
			check again.
		</Notice>
	);
}
