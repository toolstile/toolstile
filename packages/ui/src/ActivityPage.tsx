import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";
import { ActivityPanel } from "./ActivityPanel";
import { useDashboard } from "./DashboardContext";
import { colors, space, text } from "./tokens.stylex";

/** The activity page: recent requests through the gateway. */
export function ActivityPage({
	note,
}: {
	/** The host's own explanation, in muted text above the requests. */
	note?: ReactNode;
}) {
	const { data, api, activity, onNavigate } = useDashboard();
	const panel = (
		<ActivityPanel
			data={data}
			api={api}
			view={activity?.view ?? {}}
			onViewChange={(view, replace) => activity?.onViewChange(view, replace)}
			debug={activity?.debug}
			onNavigate={onNavigate}
		/>
	);
	if (!note) return panel;
	return (
		<div {...stylex.props(styles.root)}>
			<p {...stylex.props(styles.note)}>{note}</p>
			{panel}
		</div>
	);
}

const styles = stylex.create({
	root: { display: "grid", gap: space.s4, minWidth: 0 },
	note: {
		margin: 0,
		maxWidth: 760,
		color: colors.muted,
		fontSize: text.body,
		lineHeight: text.bodyLeading,
	},
});
