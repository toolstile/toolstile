import * as stylex from "@stylexjs/stylex";
import { useContext } from "react";
import type { ConnectorCatalogProps } from "./ConnectorCatalog";
import { DashboardContext } from "./DashboardContext";
import { colors, geometry, size, space, typeScale } from "./tokens.stylex";

/** The Connected / Browse catalog switch above the connection list and the catalog. */
export function ConnectionsCatalogNavigation({
	basePath,
	browsing,
	renderLink,
}: Pick<ConnectorCatalogProps, "basePath" | "renderLink"> & {
	browsing: boolean;
}) {
	// Both views render inside the dashboard, which knows how many connections there are.
	const count = useContext(DashboardContext)?.data.connections.length;
	return (
		<nav aria-label="Connection views" {...stylex.props(s.tabs)}>
			{renderLink({
				to: basePath,
				"aria-current": !browsing ? "page" : undefined,
				...stylex.props(s.tab, !browsing && s.activeTab),
				children: (
					<>
						Connected
						{count ? <span {...stylex.props(s.count)}>{count}</span> : null}
					</>
				),
			})}
			{renderLink({
				to: `${basePath}/catalog`,
				"aria-current": browsing ? "page" : undefined,
				...stylex.props(s.tab, browsing && s.activeTab),
				children: "Browse catalog",
			})}
		</nav>
	);
}

const s = stylex.create({
	// Underlined view tabs, the same treatment as `Tabs` on every other page.
	tabs: {
		display: "flex",
		alignItems: "stretch",
		gap: space.s1,
		marginBottom: space.s4,
		overflowX: "auto",
		scrollbarWidth: "none",
		boxShadow: `inset 0 -1px 0 ${colors.line}`,
	},
	tab: {
		display: "inline-flex",
		alignItems: "center",
		minHeight: size.tab,
		paddingInline: 10,
		borderBottomWidth: 2,
		borderBottomStyle: "solid",
		borderBottomColor: "transparent",
		borderRadius: `${geometry.corner} ${geometry.corner} 0 0`,
		backgroundColor: {
			default: "transparent",
			":hover": colors.hoverOverlay,
			":focus-visible": colors.hoverOverlay,
		},
		color: {
			default: colors.muted,
			":hover": colors.text,
			":focus-visible": colors.text,
		},
		fontSize: typeScale.size13,
		lineHeight: typeScale.leading13,
		fontWeight: 400,
		textDecoration: "none",
		whiteSpace: "nowrap",
		outline: "none",
	},
	count: {
		marginInlineStart: 6,
		color: colors.muted,
		fontWeight: 400,
		fontSize: 12,
		fontVariantNumeric: "tabular-nums",
	},
	activeTab: {
		color: {
			default: colors.text,
			":hover": colors.text,
			":focus-visible": colors.text,
		},
		borderBottomColor: colors.action,
		fontWeight: 500,
	},
});
