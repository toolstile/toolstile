import {
	ArrowSquareOutIcon,
	CheckCircleIcon,
	KeyIcon,
	MagnifyingGlassIcon,
} from "@phosphor-icons/react";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useId, useRef, useState } from "react";
import { AgentMark, AppMark } from "./AgentMark";
import { AgentSteps } from "./AgentSteps";
import {
	type AgentApp,
	type AgentStep,
	agentAppGroups,
	agentApps,
} from "./agent-clients";
import { controls } from "./Control.styles";
import { ModalFrame } from "./ModalFrame";
import { Tabs } from "./Primitives";
import type { SetupClient } from "./setup-contract";
import { colors, geometry, space, text, typeScale } from "./tokens.stylex";

/**
 * A host's own way to set up every agent on a computer at once, such as a command-line tool.
 * It becomes the recommended tab for apps that run on a computer.
 */
export type ComputerSetup = {
	/** Tab label, such as the tool's name. */
	label: string;
	/** One line on what the method does. */
	description: string;
	steps: AgentStep[];
	/** The apps it sets up; others show only their own steps. */
	clients: readonly SetupClient[];
};

type Agent = { id: string; label: string; revoked: boolean };

/**
 * Choose an agent app, follow its steps, and see it arrive. Signing in from the app creates and
 * names its device and agent; the dialog reloads while it waits and then offers the access
 * editor for the new agent. Apps that cannot sign in through a browser use an agent token.
 */
export function ConnectAgentDialog({
	endpoint,
	agents,
	reload,
	computerSetup,
	onClose,
	onCreateToken,
	onGrantAccess,
}: {
	endpoint: string;
	/** The current agents; one that appears after the dialog opens is the new agent. */
	agents: Agent[];
	/** Reloads `agents`; called every few seconds while the dialog waits for a sign-in. */
	reload(): Promise<void>;
	computerSetup?: ComputerSetup;
	onClose(): void;
	/** Opens the token dialog for an agent that cannot sign in through a browser. */
	onCreateToken?(): void;
	/** Opens the access editor for the new agent. */
	onGrantAccess(agentId: string): void;
}) {
	const id = useId();
	const apps = agentApps(endpoint);
	const [app, setApp] = useState<AgentApp | null>(null);
	const [method, setMethod] = useState<"host" | "app">("host");
	const [query, setQuery] = useState("");
	// Agents already shown; any other agent is the new one. Replaced, never mutated, so
	// accepting an arrival always re-renders.
	const [known, setKnown] = useState(
		() => new Set(agents.map((agent) => agent.id)),
	);
	const arrived = agents.find(
		(agent) => !agent.revoked && !known.has(agent.id),
	);
	const waiting = Boolean(app && app.signIn === "browser" && !arrived);
	useAgentArrival(waiting, reload);
	// After each change of view, move focus to the new view so keyboard and screen reader users
	// follow along: the search field on the picker, the heading elsewhere. The dialog's own
	// autofocus handles the first view.
	const heading = useRef<HTMLHeadingElement>(null);
	const search = useRef<HTMLInputElement>(null);
	const view = arrived ? "arrived" : app ? app.id : "pick";
	const shownView = useRef(view);
	useEffect(() => {
		if (view === shownView.current) return;
		shownView.current = view;
		(view === "pick" ? search.current : heading.current)?.focus();
	}, [view]);

	const choose = (next: AgentApp | null) => {
		setApp(next);
		setMethod("host");
	};
	const connectAnother = () => {
		setKnown(new Set([...known, ...agents.map((agent) => agent.id)]));
		choose(null);
	};

	if (arrived)
		return (
			<ModalFrame title="Connect an agent" onClose={onClose}>
				<div {...stylex.props(styles.body)}>
					<div {...stylex.props(styles.arrived)}>
						<AgentMark label={arrived.label} size={36} />
						<div {...stylex.props(styles.appText)}>
							<h3 ref={heading} tabIndex={-1} {...stylex.props(styles.heading)}>
								<CheckCircleIcon
									size={16}
									weight="fill"
									aria-hidden="true"
									{...stylex.props(styles.good)}
								/>
								{arrived.label} is connected
							</h3>
							<p {...stylex.props(styles.muted)}>
								It can't use any MCP connections until you give it access.
							</p>
						</div>
					</div>
				</div>
				<footer {...stylex.props(styles.footer)}>
					<button
						type="button"
						{...stylex.props(controls.button, controls.quiet)}
						onClick={connectAnother}
					>
						Connect another agent
					</button>
					<button
						type="button"
						data-autofocus
						{...stylex.props(controls.button, controls.primary)}
						onClick={() => onGrantAccess(arrived.id)}
					>
						Choose what it can use
					</button>
				</footer>
			</ModalFrame>
		);

	if (!app) {
		const needle = query.trim().toLowerCase();
		const matches = apps.filter((candidate) =>
			candidate.label.toLowerCase().includes(needle),
		);
		return (
			<ModalFrame
				title="Connect an agent"
				description="Choose the AI app or automation that will use your MCP connections."
				onClose={onClose}
			>
				<div {...stylex.props(styles.body)}>
					<div {...stylex.props(styles.search)}>
						<MagnifyingGlassIcon
							size={16}
							aria-hidden="true"
							{...stylex.props(styles.searchIcon)}
						/>
						<input
							ref={search}
							id={`${id}-search`}
							type="search"
							aria-label="Search apps"
							placeholder={`Search ${apps.length} apps`}
							autoComplete="off"
							data-autofocus
							value={query}
							onChange={(event) => setQuery(event.target.value)}
							{...stylex.props(controls.input, styles.searchInput)}
						/>
					</div>
					{agentAppGroups.map((group) => {
						const items = matches.filter(
							(candidate) => candidate.group === group.id,
						);
						if (!items.length) return null;
						return (
							<section
								key={group.id}
								aria-labelledby={`${id}-${group.id}`}
								{...stylex.props(styles.group)}
							>
								<h3
									id={`${id}-${group.id}`}
									{...stylex.props(styles.groupLabel)}
								>
									{group.label}
								</h3>
								<ul {...stylex.props(styles.tiles)}>
									{items.map((candidate) => (
										<li key={candidate.id} {...stylex.props(styles.tileItem)}>
											<button
												type="button"
												{...stylex.props(styles.tile)}
												onClick={() => choose(candidate)}
											>
												<AppMark client={candidate.id} size={24} />
												<span {...stylex.props(styles.tileLabel)}>
													{candidate.label}
												</span>
											</button>
										</li>
									))}
								</ul>
							</section>
						);
					})}
					{matches.length === 0 ? (
						<p {...stylex.props(styles.muted)}>
							No app matches “{query.trim()}”. Any other MCP client can connect
							with an agent token.
						</p>
					) : null}
					{onCreateToken ? (
						<div {...stylex.props(styles.alternative)}>
							<p {...stylex.props(styles.text, styles.alternativeText)}>
								Using another app or your own script? Create an agent token and
								paste it into the app instead.
							</p>
							<button
								type="button"
								{...stylex.props(controls.button, styles.alternativeAction)}
								onClick={onCreateToken}
							>
								<KeyIcon size={16} aria-hidden="true" />
								Create an agent token
							</button>
						</div>
					) : null}
				</div>
				<footer {...stylex.props(styles.footer)}>
					<button
						type="button"
						{...stylex.props(controls.button, controls.quiet)}
						onClick={onClose}
					>
						Cancel
					</button>
				</footer>
			</ModalFrame>
		);
	}

	const hostMethod = computerSetup?.clients.includes(app.id)
		? computerSetup
		: undefined;
	const showHost = hostMethod && method === "host";
	return (
		<ModalFrame title="Connect an agent" onClose={onClose}>
			<div {...stylex.props(styles.body)}>
				<div {...stylex.props(styles.app)}>
					<AppMark client={app.id} size={36} />
					<div {...stylex.props(styles.appText)}>
						<h3 ref={heading} tabIndex={-1} {...stylex.props(styles.heading)}>
							{app.label}
						</h3>
						<p {...stylex.props(styles.meta)}>
							{app.requires
								? `Needs ${app.requires}`
								: app.signIn === "token"
									? "Connects with an agent token"
									: app.group === "computer"
										? "Runs on your computer or one you reach over SSH"
										: "Signs in from the app, nothing to install"}
						</p>
					</div>
				</div>
				{hostMethod ? (
					<Tabs
						label="Setup method"
						value={method}
						onChange={setMethod}
						items={[
							{ id: "host", label: `${hostMethod.label} (recommended)` },
							{ id: "app", label: `${app.label} only` },
						]}
					/>
				) : null}
				{showHost ? (
					<>
						<p {...stylex.props(styles.muted)}>{hostMethod.description}</p>
						<AgentSteps steps={hostMethod.steps} autoFocus />
					</>
				) : (
					<>
						{app.install ? (
							<div>
								<a
									href={app.install.href}
									{...stylex.props(controls.button, controls.primary)}
								>
									<ArrowSquareOutIcon size={16} aria-hidden="true" />
									{app.install.label}
								</a>
							</div>
						) : null}
						<AgentSteps steps={app.steps} autoFocus={!hostMethod} />
						{app.remote ? (
							<p {...stylex.props(styles.muted)}>{app.remote}</p>
						) : null}
						<p {...stylex.props(styles.muted)}>
							<a href={app.source} target="_blank" rel="noreferrer">
								{app.sourceLabel}
							</a>
						</p>
					</>
				)}
				{app.signIn === "browser" ? (
					<p role="status" {...stylex.props(styles.waiting)}>
						<span aria-hidden="true" {...stylex.props(styles.pulse)} />
						Waiting for {app.label} to sign in. This updates on its own.
					</p>
				) : onCreateToken ? (
					<div {...stylex.props(styles.alternative)}>
						<p {...stylex.props(styles.text, styles.alternativeText)}>
							Create a token for {app.label}. It is shown once, and the agent
							can't use anything until you give it access.
						</p>
						<button
							type="button"
							{...stylex.props(
								controls.button,
								controls.primary,
								styles.alternativeAction,
							)}
							onClick={onCreateToken}
						>
							<KeyIcon size={16} aria-hidden="true" />
							Create an agent token
						</button>
					</div>
				) : null}
			</div>
			<footer {...stylex.props(styles.footer, styles.footerSplit)}>
				<button
					type="button"
					{...stylex.props(controls.button, controls.quiet)}
					onClick={() => choose(null)}
				>
					Back
				</button>
				<button
					type="button"
					{...stylex.props(controls.button, controls.quiet)}
					onClick={onClose}
				>
					Close
				</button>
			</footer>
		</ModalFrame>
	);
}

/**
 * While `active`, reloads every few seconds when the page is visible and at once when it
 * becomes visible again, one request at a time.
 */
function useAgentArrival(active: boolean, reload: () => Promise<void>) {
	const latest = useRef(reload);
	latest.current = reload;
	useEffect(() => {
		if (!active) return;
		let inFlight = false;
		const refresh = () => {
			if (inFlight || document.visibilityState === "hidden") return;
			inFlight = true;
			latest
				.current()
				.catch(() => undefined)
				.finally(() => {
					inFlight = false;
				});
		};
		const timer = setInterval(refresh, 5000);
		window.addEventListener("focus", refresh);
		document.addEventListener("visibilitychange", refresh);
		return () => {
			clearInterval(timer);
			window.removeEventListener("focus", refresh);
			document.removeEventListener("visibilitychange", refresh);
		};
	}, [active]);
}

const coarse = "@media (pointer: coarse)";

const styles = stylex.create({
	body: { display: "grid", gap: space.s4, minWidth: 0 },
	text: { margin: 0, fontSize: text.body, lineHeight: text.bodyLeading },
	muted: {
		margin: 0,
		color: colors.muted,
		fontSize: text.body,
		lineHeight: typeScale.leading13,
	},
	meta: {
		margin: 0,
		color: colors.muted,
		fontSize: text.meta,
		lineHeight: typeScale.leading12,
	},
	heading: {
		margin: 0,
		display: "flex",
		alignItems: "center",
		gap: space.s2,
		fontSize: typeScale.size14,
		lineHeight: typeScale.leading14,
		fontWeight: 500,
		outline: "none",
	},
	good: { color: colors.good, flexShrink: 0 },
	search: { position: "relative" },
	searchIcon: {
		position: "absolute",
		insetInlineStart: 10,
		top: "50%",
		transform: "translateY(-50%)",
		color: colors.muted,
		pointerEvents: "none",
	},
	searchInput: { width: "100%", paddingInlineStart: 32 },
	group: { display: "grid", gap: space.s2, minWidth: 0 },
	groupLabel: {
		margin: 0,
		color: colors.muted,
		fontSize: text.meta,
		lineHeight: typeScale.leading12,
		fontWeight: 500,
	},
	tiles: {
		listStyle: "none",
		margin: 0,
		padding: 0,
		display: "grid",
		gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))",
		gap: space.s2,
	},
	tileItem: { minWidth: 0, display: "flex" },
	tile: {
		flex: 1,
		minWidth: 0,
		display: "flex",
		alignItems: "center",
		gap: space.s2,
		minHeight: { default: 40, [coarse]: 44 },
		paddingBlock: space.s1,
		paddingInline: space.s2,
		borderWidth: 1,
		borderStyle: "solid",
		borderColor: {
			default: colors.line,
			":hover": colors.lineStrong,
			":focus-visible": colors.lineStrong,
		},
		borderRadius: geometry.corner,
		backgroundColor: {
			default: colors.surface,
			":hover": colors.hover,
			":focus-visible": colors.hover,
		},
		outline: "none",
		color: colors.text,
		fontFamily: geometry.fontSans,
		fontSize: text.body,
		lineHeight: typeScale.leading13,
		textAlign: "start",
		cursor: "pointer",
	},
	tileLabel: {
		minWidth: 0,
		overflow: "hidden",
		textOverflow: "ellipsis",
		whiteSpace: "nowrap",
	},
	app: { display: "flex", alignItems: "center", gap: space.s3, minWidth: 0 },
	arrived: {
		display: "flex",
		alignItems: "center",
		gap: space.s3,
		minWidth: 0,
		paddingBlock: space.s2,
	},
	appText: { display: "grid", gap: 2, minWidth: 0 },
	waiting: {
		margin: 0,
		display: "flex",
		alignItems: "center",
		gap: space.s2,
		paddingBlock: space.s2,
		paddingInline: space.s3,
		borderRadius: geometry.corner,
		backgroundColor: colors.insetTint,
		color: colors.muted,
		fontSize: text.body,
		lineHeight: typeScale.leading13,
	},
	pulse: {
		width: 8,
		height: 8,
		flexShrink: 0,
		borderRadius: "50%",
		backgroundColor: colors.action,
		animationName: stylex.keyframes({
			"0%": { opacity: 1 },
			"50%": { opacity: 0.35 },
			"100%": { opacity: 1 },
		}),
		animationDuration: "1.6s",
		animationIterationCount: "infinite",
		"@media (prefers-reduced-motion: reduce)": { animationName: "none" },
	},
	// The token path sits apart from the app steps as the second way to connect.
	alternative: {
		display: "flex",
		flexWrap: "wrap",
		alignItems: "center",
		justifyContent: "space-between",
		gap: space.s2,
		paddingBlock: space.s2,
		paddingInline: space.s3,
		borderRadius: geometry.corner,
		backgroundColor: colors.insetTint,
	},
	alternativeText: { flex: "1 1 240px", minWidth: 0 },
	alternativeAction: { flexShrink: 0 },
	// Spacing alone separates the actions; no rule.
	footer: { display: "flex", justifyContent: "flex-end", gap: space.s2 },
	footerSplit: { justifyContent: "space-between" },
});
