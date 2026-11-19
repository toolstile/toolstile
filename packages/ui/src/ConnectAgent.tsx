import {
	ArrowSquareOutIcon,
	CaretDownIcon,
	CaretRightIcon,
	CaretUpIcon,
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
	popularAgentApps,
} from "./agent-clients";
import { controls } from "./Control.styles";
import { ModalFrame } from "./ModalFrame";
import { Tabs } from "./Primitives";
import type { SetupClient } from "./setup-contract";
import {
	colors,
	geometry,
	motion,
	space,
	text,
	typeScale,
} from "./tokens.stylex";

/**
 * A host's own way to set up agents on a computer, such as a command-line tool that signs the
 * computer in once and then configures each app. It becomes the recommended tab for the apps
 * it lists.
 */
export type ComputerSetup = {
	/** Tab label, such as the tool's name. */
	label: string;
	/** One line on what the method does, true for every app it lists. */
	description: string;
	/** The steps for one chosen app, so commands and wording can name it. */
	steps(app: { id: SetupClient; label: string }): AgentStep[];
	/** The apps it sets up; others show only their own steps. */
	clients: readonly SetupClient[];
};

type Agent = {
	id: string;
	label: string;
	/** The device it runs on, named on arrival when known. */
	deviceId?: string;
	revoked: boolean;
};
type Device = { id: string; label: string; revoked: boolean };

/**
 * Choose an agent app, follow its steps, and see it arrive. Signing in from the app creates and
 * names its device and agent; with the host's setup the computer signs in first and the agent
 * follows. The dialog reloads while it waits and then offers the access editor for the new
 * agent. Apps that cannot sign in through a browser use an agent token.
 */
export function ConnectAgentDialog({
	endpoint,
	agents,
	devices = [],
	reload,
	computerSetup,
	onClose,
	onCreateToken,
	onGrantAccess,
}: {
	endpoint: string;
	/** The current agents; one that appears after the dialog opens is the new agent. */
	agents: Agent[];
	/** The current devices; one that appears after the dialog opens has just signed in. */
	devices?: Device[];
	/** Reloads `agents` and `devices`; called every few seconds while the dialog waits. */
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
	const [showAll, setShowAll] = useState(false);
	const [sshOpen, setSshOpen] = useState(false);
	// Agents and devices already shown; any other one is new. Replaced, never mutated, so
	// accepting an arrival always re-renders.
	const [known, setKnown] = useState(
		() => new Set(agents.map((agent) => agent.id)),
	);
	const [knownDevices, setKnownDevices] = useState(
		() => new Set(devices.map((device) => device.id)),
	);
	const arrived = agents.find(
		(agent) => !agent.revoked && !known.has(agent.id),
	);
	const newDevice = devices.find(
		(device) => !device.revoked && !knownDevices.has(device.id),
	);
	const hostMethod =
		app && computerSetup?.clients.includes(app.id) ? computerSetup : undefined;
	const showHost = Boolean(hostMethod && method === "host");
	const waiting = Boolean(
		app && !arrived && (showHost || app.signIn === "browser"),
	);
	useAgentArrival(waiting, reload);
	// After each change of view, move focus to the new view so keyboard and screen reader users
	// follow along: the search field on the picker, the heading elsewhere. The dialog's own
	// autofocus handles the first view.
	const heading = useRef<HTMLHeadingElement>(null);
	const search = useRef<HTMLInputElement>(null);
	const appList = useRef<HTMLDivElement>(null);
	const view = arrived ? "arrived" : app ? app.id : "pick";
	const shownView = useRef(view);
	useEffect(() => {
		if (view === shownView.current) return;
		shownView.current = view;
		(view === "pick" ? search.current : heading.current)?.focus();
	}, [view]);

	// The full list opens above its toggle, so focus moves to its first app; otherwise the next
	// Tab would skip every app just revealed.
	useEffect(() => {
		if (showAll) appList.current?.querySelector("button")?.focus();
	}, [showAll]);

	const choose = (next: AgentApp | null) => {
		setApp(next);
		setMethod("host");
		setSshOpen(false);
	};
	const connectAnother = () => {
		setKnown(new Set([...known, ...agents.map((agent) => agent.id)]));
		setKnownDevices(
			new Set([...knownDevices, ...devices.map((device) => device.id)]),
		);
		choose(null);
	};

	if (arrived) {
		// Say only what is known: the host's setup configured the agent on a computer, the app
		// signed itself in, or an agent appeared with no app chosen.
		const deviceLabel = devices.find(
			(device) => device.id === arrived.deviceId,
		)?.label;
		const title = showHost
			? `${arrived.label} is set up on ${deviceLabel ?? "this computer"}`
			: app
				? `${arrived.label} signed in`
				: `${arrived.label} was added`;
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
								{title}
							</h3>
							<p {...stylex.props(styles.muted)}>
								{showHost
									? `Restart ${arrived.label} if it is running. It can't use any MCP connections until you give it access.`
									: "It can't use any MCP connections until you give it access."}
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
	}

	if (!app) {
		const needle = query.trim().toLowerCase();
		const matches = apps.filter((candidate) =>
			candidate.label.toLowerCase().includes(needle),
		);
		// With no search, the common apps come first and the rest are one step away.
		const sections: { id: string; label: string; items: AgentApp[] }[] =
			!needle && !showAll
				? [
						{
							id: "popular",
							label: "Popular",
							items: popularAgentApps.flatMap(
								(client) =>
									apps.find((candidate) => candidate.id === client) ?? [],
							),
						},
					]
				: agentAppGroups.map((group) => ({
						id: group.id,
						label: group.label,
						items: matches.filter((candidate) => candidate.group === group.id),
					}));
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
					{sections.some((section) => section.items.length) ? (
						<div ref={appList} id={`${id}-apps`} {...stylex.props(styles.body)}>
							{sections.map(({ id: groupId, label, items }) =>
								items.length ? (
									<section
										key={groupId}
										aria-labelledby={`${id}-${groupId}`}
										{...stylex.props(styles.group)}
									>
										<h3
											id={`${id}-${groupId}`}
											{...stylex.props(styles.groupLabel)}
										>
											{label}
										</h3>
										<ul {...stylex.props(styles.tiles)}>
											{items.map((candidate) => (
												<li
													key={candidate.id}
													{...stylex.props(styles.tileItem)}
												>
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
								) : null,
							)}
						</div>
					) : null}
					{needle ? null : (
						<button
							type="button"
							aria-expanded={showAll}
							aria-controls={`${id}-apps`}
							{...stylex.props(
								controls.button,
								controls.quiet,
								controls.small,
								styles.textToggle,
							)}
							onClick={() => setShowAll(!showAll)}
						>
							{showAll ? (
								<CaretUpIcon size={16} aria-hidden="true" />
							) : (
								<CaretDownIcon size={16} aria-hidden="true" />
							)}
							{showAll ? "Show fewer" : `Show all ${apps.length} apps`}
						</button>
					)}
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
				{hostMethod && showHost ? (
					<>
						<p {...stylex.props(styles.muted)}>{hostMethod.description}</p>
						<AgentSteps
							steps={hostMethod.steps({ id: app.id, label: app.label })}
							autoFocus
						/>
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
							<div {...stylex.props(styles.disclosure)}>
								<button
									type="button"
									aria-expanded={sshOpen}
									aria-controls={`${id}-ssh`}
									{...stylex.props(
										controls.button,
										controls.quiet,
										controls.small,
										styles.textToggle,
									)}
									onClick={() => setSshOpen(!sshOpen)}
								>
									<CaretRightIcon
										size={16}
										aria-hidden="true"
										{...stylex.props(styles.caret, sshOpen && styles.caretOpen)}
									/>
									Connecting from a machine you reach over SSH?
								</button>
								{sshOpen ? (
									<p
										id={`${id}-ssh`}
										{...stylex.props(styles.muted, styles.disclosed)}
									>
										{app.remote}
									</p>
								) : null}
							</div>
						) : null}
						<p {...stylex.props(styles.muted)}>
							<a href={app.source} target="_blank" rel="noreferrer">
								{app.sourceLabel}
							</a>
						</p>
					</>
				)}
				{showHost ? (
					// The computer signs in first; the agent appears only once it is set up. A computer
					// that signed in before shows no new device, so with earlier devices only the
					// agent is awaited.
					<p role="status" {...stylex.props(styles.waiting)}>
						{newDevice ? (
							<CheckCircleIcon
								size={16}
								weight="fill"
								aria-hidden="true"
								{...stylex.props(styles.good)}
							/>
						) : (
							<span aria-hidden="true" {...stylex.props(styles.pulse)} />
						)}
						{newDevice
							? `${newDevice.label} is signed in. Waiting for ${app.label} to be set up.`
							: knownDevices.size
								? `Waiting for ${app.label} to be set up. This updates on its own.`
								: "Waiting for this computer to sign in. This updates on its own."}
					</p>
				) : app.signIn === "browser" ? (
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
const reducedMotion = "@media (prefers-reduced-motion: reduce)";

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
	// Muted text that reads as a quiet control; the shared quiet ring and wash mark hover and
	// focus alike, and the text darkens with them. The negative margin aligns the icon with
	// the text above.
	textToggle: {
		justifySelf: "start",
		marginInlineStart: `calc(-1 * ${space.s2})`,
		color: {
			default: colors.muted,
			":hover": colors.text,
			":focus-visible": colors.text,
		},
		fontWeight: 400,
		textAlign: "start",
	},
	disclosure: { display: "grid", gap: space.s1, minWidth: 0 },
	disclosed: { paddingInlineStart: space.s5 },
	caret: {
		flexShrink: 0,
		transitionProperty: { default: "transform", [reducedMotion]: "none" },
		transitionDuration: motion.base,
		transitionTimingFunction: motion.easeOut,
	},
	caretOpen: { transform: "rotate(90deg)" },
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
