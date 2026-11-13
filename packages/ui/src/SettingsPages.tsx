import * as stylex from "@stylexjs/stylex";
import { useState } from "react";
import { CopyValue } from "./CopyValue";
import { dashboardStyles as styles } from "./Dashboard.styles";
import { SettingsRow, SettingsSection } from "./Settings";
import { colors } from "./tokens.stylex";
import { UrlText } from "./UrlText";

/** The gateway MCP endpoint with a copy action and the authentication note. */
export function EndpointSettings({ endpoint }: { endpoint: string }) {
	const [error, setError] = useState("");
	return (
		<SettingsSection title="Gateway endpoint" titleHidden>
			<SettingsRow label="Endpoint">
				<CopyValue
					value={endpoint}
					display={<UrlText url={endpoint} />}
					onCopied={() => setError("")}
					onCopyFailed={() => setError("Select and copy the endpoint manually")}
				/>
				{error ? (
					<p role="alert" {...stylex.props(styles.settingsText, local.error)}>
						{error}
					</p>
				) : null}
			</SettingsRow>
			<SettingsRow label="Authentication">
				<p {...stylex.props(styles.settingsText)}>
					Each agent sends its own token in the Authorization header. Remove an
					agent in Devices &amp; agents to stop its token.
				</p>
			</SettingsRow>
		</SettingsSection>
	);
}

const local = stylex.create({
	error: { color: colors.bad },
});
