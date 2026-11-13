import { SidebarSimpleIcon } from "@phosphor-icons/react";
import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";
import { Brand } from "./Brand";
import { dashboardStyles as styles } from "./Dashboard.styles";
import { layout } from "./Layout.styles";
import { SidebarCompact, useSidebarMode } from "./SidebarMode";
import { Tooltip, TooltipProvider } from "./Tooltip";

/**
 * The dashboard layout: sidebar (brand, account, navigation, bottom links) beside the page.
 * Keeps the page surface, width, padding and brand position consistent across dashboard views.
 * Wide screens can collapse the sidebar to an icon rail; the choice is kept per browser.
 */
export function DashboardFrame({
	account,
	navigation,
	bottom,
	status,
	pagePending = false,
	home,
	children,
}: {
	account: ReactNode;
	navigation: ReactNode;
	bottom: ReactNode;
	/** Loading announcement; marks the page as busy. */
	status?: string;
	/** Makes the page inert and dims it while newer data loads; the sidebar stays usable. */
	pagePending?: boolean;
	/** Renders the app's router link around the brand; without it the brand is static. */
	home?(link: { className: string; children: ReactNode }): ReactNode;
	children: ReactNode;
}) {
	const [compact, setCompact] = useSidebarMode();
	const brand = <Brand size={compact ? "mark" : "sidebar"} />;
	return (
		<SidebarCompact value={compact}>
			<TooltipProvider delay={300}>
				<div {...stylex.props(styles.layout, compact && styles.layoutCompact)}>
					{status ? (
						<p role="status" {...stylex.props(layout.visuallyHidden)}>
							{status}
						</p>
					) : null}
					<aside
						{...stylex.props(styles.sidebar, compact && styles.sidebarCompact)}
					>
						<div
							{...stylex.props(styles.brand, compact && styles.brandCompact)}
						>
							{home
								? home({
										className:
											stylex.props(styles.brandLink, frame.brandTarget)
												.className ?? "",
										children: brand,
									})
								: brand}
							<Tooltip
								label={compact ? "Expand sidebar" : "Collapse sidebar"}
								side={compact ? "right" : "bottom"}
								anchorStyle={[
									styles.sidebarToggle,
									compact && styles.sidebarToggleCompact,
								]}
							>
								<button
									type="button"
									aria-label={compact ? "Expand sidebar" : "Collapse sidebar"}
									aria-expanded={!compact}
									onClick={() => setCompact(!compact)}
									{...stylex.props(styles.navIconButton, styles.toggleButton)}
								>
									<SidebarSimpleIcon size={16} aria-hidden="true" />
								</button>
							</Tooltip>
						</div>
						<div
							{...stylex.props(
								styles.sidebarAccount,
								compact && styles.sidebarAccountCompact,
							)}
						>
							{account}
						</div>
						{navigation}
						<div
							{...stylex.props(
								styles.sidebarBottom,
								compact && styles.sidebarBottomCompact,
							)}
						>
							{bottom}
						</div>
					</aside>
					<main
						aria-busy={status ? true : undefined}
						inert={pagePending}
						{...stylex.props(styles.main, pagePending && styles.mainPending)}
					>
						{children}
					</main>
				</div>
			</TooltipProvider>
		</SidebarCompact>
	);
}

const frame = stylex.create({
	// Phones: an invisible 44px-tall hit area around the short lockup, inside the row's spacing.
	brandTarget: {
		position: "relative",
		"::before": {
			content: '""',
			position: "absolute",
			insetInline: 0,
			insetBlock: { default: 0, "@media (max-width: 760px)": -15 },
		},
	},
});
