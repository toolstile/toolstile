import {
	ArrowRightIcon,
	CaretDownIcon,
	CaretUpIcon,
	CheckCircleIcon,
	KeyIcon,
	ListChecksIcon,
	WarningCircleIcon,
	XIcon,
} from "@phosphor-icons/react";
import * as stylex from "@stylexjs/stylex";
import type { DashboardDialog, Snapshot } from "@toolstile/api/contract";
import { SelectField } from "@toolstile/ui/select";
import { useContext, useEffect, useId, useMemo, useRef, useState } from "react";
import { AgentSteps } from "./AgentSteps";
import {
	agentApp,
	agentApps,
	agentClientLabels,
	detectAgentClient,
} from "./agent-clients";
import { controls } from "./Control.styles";
import { layout } from "./Layout.styles";
import { ModalFrame } from "./ModalFrame";
import { SidebarCompact } from "./SidebarMode";
import type {
	SetupApi,
	SetupClient,
	SetupState,
	SetupStep,
} from "./setup-contract";
import { connectionUnreachable, statusLabel } from "./status";
import {
	colors,
	elevation,
	geometry,
	motion,
	size,
	space,
	text,
	typeScale,
} from "./tokens.stylex";

/**
 * Persisted steps stay connect | agent | access | verify. Access and verify share step 3 until
 * the server reports the access verified; then the guide shows step 4, which waits for the
 * agent's first tool call. That call is read from activity, never saved as a step, and Finish
 * waits for it. If verification lapses, the guide returns to step 3 and checks again.
 */
const visibleSteps = [
	{ step: "connect", title: "Add an MCP connection" },
	{ step: "agent", title: "Connect your agent" },
	{ step: "access", title: "Give access" },
	{ step: "verify", title: "Make your first call" },
] as const;
/** The step that waits for the first call; it is shown only once access is verified. */
const callPosition = 3;
/** How often step 4 asks whether the first call has arrived, while the page is visible. */
const firstCallPollMs = 4000;
type SetupNavigation = {
	setupStep?: SetupStep;
	setupClient?: SetupClient;
	setupConnectionId?: string;
	setupAgentId?: string;
};
type Agent = Snapshot["agents"][number];
function usable(agent: Agent) {
	return (
		!agent.revoked &&
		agent.canTest &&
		(!agent.expiresAt || new Date(agent.expiresAt) > new Date())
	);
}
/**
 * The one selection the guide saves on its own, if any. In step 1 a connection Toolstile can
 * reach replaces one it can't: the newest one added while the guide is open, else the only
 * reachable one; a single connection is selected even when unreachable, so step 1 can say what
 * is wrong with it. Once the server confirms a selected connection Toolstile can reach and use
 * (signed in, where it needs sign-in), step 1 moves on to step 2, unless the user went back to
 * step 1. A token created from step 2 selects its new agent and moves on to access; an agent that
 * signs in during step 2 is selected and moves on to access; a single agent that already existed
 * is selected. In the later steps a missing selection is filled only when there is a single
 * candidate. Finishing is never automatic: the user confirms it.
 */
export function automaticSelection({
	step,
	connections,
	agentIds,
	connectionId,
	agentId,
	knownConnectionIds,
	knownAgentIds,
	tokenBaseline,
	connectReady,
	stayOnConnect,
}: {
	step: SetupStep;
	/** Connections in snapshot order, oldest first. */
	connections: { id: string; status: string }[];
	/** Connections that already existed when the guide was first shown. */
	knownConnectionIds?: ReadonlySet<string>;
	/** The server's `completed.connect` for the saved selection. */
	connectReady?: boolean;
	/** The user went back to step 1, so it waits for Continue. */
	stayOnConnect?: boolean;
	/** Usable agents, in snapshot order. */
	agentIds: string[];
	connectionId?: string;
	agentId?: string;
	/** Agents that already existed when step 2 was first shown. */
	knownAgentIds?: ReadonlySet<string>;
	/** Agents that existed when the user asked for a token from step 2. */
	tokenBaseline?: ReadonlySet<string> | null;
}): SetupNavigation | undefined {
	if (step === "connect") {
		const current = connections.find((entry) => entry.id === connectionId);
		if (current && !connectionUnreachable(current.status))
			return connectReady &&
				!stayOnConnect &&
				current.status.trim().toLowerCase() !== "authentication required"
				? { setupStep: "agent" }
				: undefined;
		const reachable = connections.filter(
			(entry) => !connectionUnreachable(entry.status),
		);
		const choice =
			(knownConnectionIds
				? [...reachable]
						.reverse()
						.find((entry) => !knownConnectionIds.has(entry.id))
				: undefined) ??
			(reachable.length === 1 ? reachable[0] : undefined) ??
			(!current && connections.length === 1 ? connections[0] : undefined);
		return choice && choice.id !== connectionId
			? { setupConnectionId: choice.id }
			: undefined;
	}
	if (step !== "agent") {
		// A selection that was removed after its step (the agent was revoked and connected again,
		// say) leaves the access step with nothing to give access to: take the only candidate.
		const only: SetupNavigation = {};
		if (!connectionId && connections.length === 1)
			only.setupConnectionId = connections[0]?.id;
		if (!agentId && agentIds.length === 1) only.setupAgentId = agentIds[0];
		return only.setupConnectionId || only.setupAgentId ? only : undefined;
	}
	const created = tokenBaseline
		? agentIds.find((id) => !tokenBaseline.has(id))
		: undefined;
	if (created) return { setupAgentId: created, setupStep: "access" };
	const signedIn = knownAgentIds
		? [...agentIds].reverse().find((id) => !knownAgentIds.has(id))
		: undefined;
	if (signedIn)
		return signedIn === agentId
			? undefined
			: { setupAgentId: signedIn, setupStep: "access" };
	return agentIds.length === 1 && agentIds[0] !== agentId
		? { setupAgentId: agentIds[0] }
		: undefined;
}
/**
 * The host's setup progress updates. A dashboard reload also reads setup progress; one that
 * started before the guide's latest save would bring back older progress (an earlier step, or
 * the guide after Skip), so its result is dropped. Call `reloadStarted` as a reload begins and
 * apply its progress through the function it returns.
 */
export function useSetupProgress(setSetup: (state: SetupState | null) => void) {
	const saves = useRef(0);
	return useMemo(
		() => ({
			/** The guide's own saves, passed as its `onState`. */
			onState(state: SetupState) {
				saves.current += 1;
				setSetup(state);
			},
			reloadStarted() {
				const started = saves.current;
				return (progress: SetupState) => {
					if (started === saves.current) setSetup(progress);
				};
			},
		}),
		[setSetup],
	);
}
export function SetupGuide({
	state,
	api,
	data,
	endpoint,
	onState,
	onDialog,
	onConfigureAccess,
	onDone,
	canConfigureAccess = true,
	verificationNote,
	firstCallNote,
	onViewCall,
	reload,
	clientDocs,
	variant = "inline",
}: {
	state: SetupState;
	api: SetupApi;
	data: Snapshot;
	endpoint: string;
	onState(state: SetupState): void;
	onDialog(
		dialog: DashboardDialog,
		selection?: { agentId?: string; connectionId?: string },
	): void;
	/** Opens the access page for this server, with this agent's access open. */
	onConfigureAccess(connectionId: string, agentId?: string): void;
	onDone(): void;
	canConfigureAccess?: boolean;
	verificationNote?: string;
	/** The host's own sentence under step 4's waiting status. */
	firstCallNote?: string;
	/** Opens the activity log at this request; step 4 offers it once the first call arrives. */
	onViewCall?(activityId: string): void;
	/**
	 * Reloads the dashboard snapshot. An agent signs in through its own consent page, so while
	 * step 2 is open the guide reloads on focus, and while visible checks `setupAgents` every few
	 * seconds, reloading when a new agent appears. Step 4 checks `setupFirstCall` the same way and
	 * reloads once the first call arrives.
	 */
	reload?(): Promise<void>;
	/** The host's own agent app guide; each app links to `#<client>` on it before the vendor's page. */
	clientDocs?: string;
	/** `docked` renders a compact sidebar card; its details open in a dialog held in local state. */
	variant?: "inline" | "docked";
}) {
	const fieldId = useId();
	const panel = useRef<HTMLElement>(null);
	const stepHeading = useRef<HTMLHeadingElement>(null);
	const { step, client, connectionId, agentId } = state;
	const verified = state.completed.verify;
	const position =
		step === "access" || step === "verify"
			? verified
				? callPosition
				: 2
			: visibleSteps.findIndex((entry) => entry.step === step);
	/** The first call has arrived on step 4, so Finish is available. */
	const complete = position === callPosition && !!state.firstCall;
	const previous = useRef({ position, status: state.status });
	const automatic = useRef({ selection: "", verification: "" });
	const [collapsed, setCollapsed] = useState(false);
	const [leaving, setLeaving] = useState(false);
	const [detailsOpen, setDetailsOpen] = useState(false);
	// Content hidden under the sticky footer raises the footer as a scroll cue.
	const [moreBelow, setMoreBelow] = useState(false);
	// Set after Configure access, so a click on the page already open still says what to do.
	const [accessHint, setAccessHint] = useState(false);
	/** Connections present when the guide was first shown. */
	const knownConnections = useRef<Set<string> | null>(null);
	/** Agents present when step 2 was first shown, and when a token was requested from it. */
	const knownAgents = useRef<Set<string> | null>(null);
	const tokenBaseline = useRef<Set<string> | null>(null);
	/** Set by Back to step 1: the user returned on purpose, so step 1 waits for Continue. */
	const stayOnConnect = useRef(false);
	const docked = variant === "docked";
	// The compact sidebar rail has room only for the pill's icon and step count.
	const rail = useContext(SidebarCompact) && docked;
	const [busy, setBusy] = useState(false),
		[checking, setChecking] = useState(false),
		[error, setError] = useState(""),
		[checkError, setCheckError] = useState("");
	useEffect(() => {
		if (
			previous.current.position !== position ||
			previous.current.status !== state.status
		) {
			if (panel.current) panel.current.scrollTop = 0;
			stepHeading.current?.focus({ preventScroll: true });
		}
		previous.current = { position, status: state.status };
	}, [position, state.status]);
	useEffect(() => {
		if (state.status === "active") setLeaving(false);
	}, [state.status]);
	// The prompt's copy button goes away when the first call arrives; focus that was on it
	// moves to the step heading rather than to the page.
	const wasComplete = useRef(complete);
	useEffect(() => {
		if (
			complete &&
			!wasComplete.current &&
			document.activeElement === document.body
		)
			stepHeading.current?.focus({ preventScroll: true });
		wasComplete.current = complete;
	}, [complete]);
	// the step, collapse and dialog change which panel and content are measured.
	useEffect(() => {
		const element = panel.current;
		if (!element) return;
		const measure = () =>
			setMoreBelow(
				element.scrollHeight - element.scrollTop - element.clientHeight > 4,
			);
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		for (const child of element.children) observer.observe(child);
		element.addEventListener("scroll", measure, { passive: true });
		return () => {
			observer.disconnect();
			element.removeEventListener("scroll", measure);
		};
	}, [position, collapsed, detailsOpen, state.status]);
	const agents = data.agents.filter(usable);
	const activeAgent = agents.find((agent) => agent.id === agentId);
	const connection = data.connections.find(
		(entry) => entry.id === connectionId,
	);
	if (state.status === "active" && !knownConnections.current)
		knownConnections.current = new Set(data.connections.map(({ id }) => id));
	const unreachable = !!connection && connectionUnreachable(connection.status);
	if (position === 1 && state.status === "active" && !knownAgents.current)
		knownAgents.current = new Set(agents.map((agent) => agent.id));
	const rules = [
		...data.grants.filter(
			(grant) =>
				grant.agentId === agentId && grant.connectionId === connectionId,
		),
		...data.allAgentGrants.filter(
			(grant) => grant.connectionId === connectionId,
		),
	].map((grant) => grant.rules);
	// Step 2 also offers to connect another agent while one is selected, so it keeps reloading
	// until the step ends; only an agent that is new to step 2 moves it on.
	const waitingForAgent = state.status === "active" && position === 1;
	const reloadSnapshot = useRef(reload);
	reloadSnapshot.current = reload;
	const setupApi = useRef(api);
	setupApi.current = api;
	const shownAgents = useRef(agents);
	shownAgents.current = agents;
	/** Set while the guide saves or checks; polling waits so it cannot race the save. */
	const saving = useRef(false);
	/** Counts the guide's saves, so a poll can tell that one started after it did. */
	const saveCount = useRef(0);
	useEffect(() => {
		if (!waitingForAgent) return;
		// One request at a time; the interval runs only while the page is visible. Returning to
		// the page reloads the dashboard; the interval asks only for agent ids and reloads when
		// an agent the guide has not shown appears.
		let inFlight = false;
		let timer: ReturnType<typeof setInterval> | undefined;
		const refresh = (full: boolean) => {
			const current = reloadSnapshot.current;
			if (
				inFlight ||
				saving.current ||
				!current ||
				document.visibilityState === "hidden"
			)
				return;
			inFlight = true;
			(full
				? current()
				: setupApi.current.setupAgents().then(({ agentIds }) => {
						const shown = new Set(shownAgents.current.map(({ id }) => id));
						if (!saving.current && agentIds.some((id) => !shown.has(id)))
							return current();
					})
			)
				.catch(() => undefined)
				.finally(() => {
					inFlight = false;
				});
		};
		const poll = () => refresh(false);
		const returned = () => refresh(true);
		const schedule = () => {
			clearInterval(timer);
			timer =
				document.visibilityState === "hidden"
					? undefined
					: setInterval(poll, 5000);
		};
		const visibility = () => {
			schedule();
			returned();
		};
		schedule();
		window.addEventListener("focus", returned);
		document.addEventListener("visibilitychange", visibility);
		return () => {
			clearInterval(timer);
			window.removeEventListener("focus", returned);
			document.removeEventListener("visibilitychange", visibility);
		};
	}, [waitingForAgent]);
	const waitingForCall =
		state.status === "active" && position === callPosition && !state.firstCall;
	const reportState = useRef(onState);
	reportState.current = onState;
	useEffect(() => {
		if (!waitingForCall) return;
		// One request at a time, only while the page is visible, and never while the guide saves.
		// The interval and returning to the page ask only whether the first call exists; once it
		// does, the guide reads its full progress and the host reloads the dashboard, so activity
		// and plan usage show the call too. The poll never saves setup progress.
		let inFlight = false;
		// Set on cleanup (Skip, a step change, another workspace): a response that arrives
		// afterwards is dropped.
		let stopped = false;
		let timer: ReturnType<typeof setInterval> | undefined;
		const check = () => {
			if (inFlight || saving.current || document.visibilityState === "hidden")
				return;
			inFlight = true;
			const saves = saveCount.current;
			const stale = () => stopped || saves !== saveCount.current;
			setupApi.current
				.setupFirstCall()
				.then(async ({ firstCall }) => {
					if (!firstCall || stale()) return;
					// Progress first: it counts as the guide's own update, so a dashboard reload that
					// started earlier cannot bring back progress without the call.
					const progress = await setupApi.current.setupStatus();
					if (stale()) return;
					reportState.current(progress);
					await reloadSnapshot.current?.();
				})
				.catch(() => undefined)
				.finally(() => {
					inFlight = false;
				});
		};
		const schedule = () => {
			clearInterval(timer);
			timer =
				document.visibilityState === "hidden"
					? undefined
					: setInterval(check, firstCallPollMs);
		};
		const visibility = () => {
			schedule();
			check();
		};
		schedule();
		window.addEventListener("focus", check);
		document.addEventListener("visibilitychange", visibility);
		return () => {
			stopped = true;
			clearInterval(timer);
			window.removeEventListener("focus", check);
			document.removeEventListener("visibilitychange", visibility);
		};
	}, [waitingForCall]);
	// Celebrate only a verification or first call that happens while the guide is open, not one
	// restored on load.
	const verifiedOnMount = useRef(verified);
	const calledOnMount = useRef(!!state.firstCall);
	async function run(work: () => Promise<void>, report = setError) {
		if (busy) return;
		setBusy(true);
		saving.current = true;
		saveCount.current += 1;
		report("");
		try {
			await work();
		} catch (error) {
			report(
				error instanceof Error
					? error.message
					: "Setup could not be saved. Try again.",
			);
		} finally {
			saving.current = false;
			setBusy(false);
		}
	}
	async function save(
		next: SetupNavigation,
		action: "save" | "skip" | "resume" | "finish" = "save",
	) {
		const result = await api.saveSetup({
			client: next.setupClient ?? client,
			connectionId: next.setupConnectionId ?? connectionId,
			agentId: next.setupAgentId ?? agentId,
			step: next.setupStep ?? step,
			action,
		});
		if (action === "finish") {
			// Fade the card out once the server confirms, then hand back to the dashboard.
			setLeaving(true);
			if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches)
				await new Promise((resolve) => setTimeout(resolve, 200));
		}
		if (action !== "save") setDetailsOpen(false);
		onState(result);
		if (action === "skip" || action === "finish") onDone();
	}
	function verify() {
		// A removed agent or connection leaves a stale id until the server reports it unselected.
		if (!connection || !activeAgent) return;
		void run(async () => {
			setChecking(true);
			try {
				onState(
					await api.verifySetup({
						connectionId: connection.id,
						agentId: activeAgent.id,
					}),
				);
			} finally {
				setChecking(false);
			}
		}, setCheckError);
	}
	/** Gateway dialogs replace the setup details dialog rather than stacking on it. */
	function openDialog(
		dialog: DashboardDialog,
		selection?: { agentId?: string; connectionId?: string },
	) {
		setDetailsOpen(false);
		onDialog(dialog, selection);
	}
	/** Opens the token dialog; the agent it creates is selected and setup moves on to access. */
	function createToken() {
		tokenBaseline.current = new Set(data.agents.map((agent) => agent.id));
		openDialog("agent");
	}
	function configureAccess() {
		if (!connection) return;
		setDetailsOpen(false);
		setAccessHint(true);
		onConfigureAccess(connection.id, activeAgent?.id);
		// The access page may already be open, so navigating changes nothing visible: bring the
		// agent's column into view once it renders.
		if (!activeAgent) return;
		const id = `access-agent-${activeAgent.id}`;
		let attempts = 0;
		const reveal = () => {
			const column = document.getElementById(id);
			if (column) {
				column.scrollIntoView({ block: "nearest", inline: "nearest" });
				column.focus({ preventScroll: true });
			} else if (++attempts < 20) setTimeout(reveal, 100);
		};
		setTimeout(reveal, 50);
	}
	// Selections and the catalog check run once per change; the refs keep this idempotent across renders.
	useEffect(() => {
		if (state.status !== "active" || busy) return;
		if (step !== "agent") tokenBaseline.current = null;
		const only = automaticSelection({
			step,
			connections: data.connections,
			agentIds: agents.map((agent) => agent.id),
			connectionId,
			agentId,
			knownConnectionIds: knownConnections.current ?? undefined,
			knownAgentIds: knownAgents.current ?? undefined,
			tokenBaseline: tokenBaseline.current,
			connectReady: state.completed.connect,
			stayOnConnect: stayOnConnect.current,
		});
		const key = JSON.stringify(only);
		if (only && automatic.current.selection !== key) {
			automatic.current.selection = key;
			if (only.setupStep) tokenBaseline.current = null;
			void run(() => save(only));
			return;
		}
		const access = JSON.stringify([connectionId, agentId, rules]);
		// A verification that lapses later (the connection's status changed, say) is checked again.
		if (verified) automatic.current.verification = "";
		if (
			state.completed.access &&
			!verified &&
			automatic.current.verification !== access
		) {
			automatic.current.verification = access;
			verify();
		}
	});
	if (state.status !== "active") {
		if (state.status !== "skipped") return null;
		const resume = () => {
			setCollapsed(false);
			void run(() => save({ setupStep: state.step }, "resume"));
		};
		if (docked)
			return (
				<section aria-label="Guided setup" {...stylex.props(s.dockSlot)}>
					<p {...stylex.props(s.dock, s.dockPaused, rail && s.railHidden)}>
						<span>Setup paused</span>
						<span aria-hidden="true">·</span>
						<button
							type="button"
							{...stylex.props(s.dockLink)}
							disabled={busy}
							onClick={resume}
						>
							Resume
						</button>
					</p>
					<button
						type="button"
						aria-label="Resume setup"
						title="Resume setup"
						{...stylex.props(s.pill, rail && s.pillRail)}
						disabled={busy}
						onClick={resume}
					>
						{rail ? (
							<ListChecksIcon size={16} aria-hidden="true" />
						) : (
							"Resume setup"
						)}
					</button>
					{error && (
						<p role="alert" {...stylex.props(s.error, s.dockError)}>
							{error}
						</p>
					)}
				</section>
			);
		return (
			<section
				{...stylex.props(s.card, s.skippedCard, s.row)}
				aria-label="Guided setup"
			>
				<p {...stylex.props(s.muted)}>Setup paused.</p>
				<button
					type="button"
					{...stylex.props(controls.button, controls.small)}
					disabled={busy}
					onClick={resume}
				>
					Resume setup
				</button>
				{error && (
					<p role="alert" {...stylex.props(s.error)}>
						{error}
					</p>
				)}
			</section>
		);
	}
	const guide = agentApp(client, endpoint);
	const tools = toolSummary(rules);
	const target = visibleSteps[position] ?? visibleSteps[0];
	const next = () =>
		run(() => save({ setupStep: visibleSteps[position + 1]?.step }));
	const finish = () => run(() => save({}, "finish"));
	const skip = () => run(() => save({}, "skip"));
	const success =
		verified && activeAgent && connection
			? `${activeAgent.label} can use ${tools} on ${connection.label}.`
			: "";
	const accessSteps = activeAgent
		? `On the Access page, check the tools ${activeAgent.label} may use, then select Save changes.`
		: "";
	const agentName = activeAgent?.label ?? "your agent";
	const firstCall = state.firstCall;
	// The app to restart: the one the agent's name comes from, else the agent itself, such as a
	// token agent whose app the guide does not know.
	const detectedApp = activeAgent
		? detectAgentClient(activeAgent.label)
		: undefined;
	const appName = detectedApp ? agentClientLabels[detectedApp] : agentName;
	const callSteps = [
		{ text: `Restart ${appName} so it loads the Toolstile tools.` },
		{
			text: "Paste this prompt:",
			code: `List the ${connection ? `${connection.label} ` : ""}tools you have through Toolstile, then call one that only reads data and show me what it returns.`,
			codeKind: "prompt",
		},
	];
	const callTime = firstCall ? formatTime(firstCall.createdAt) : "";
	const callSummary = firstCall
		? `${agentName} ${firstCall.target ? `called ${firstCall.target}` : "called a tool"}${connection ? ` on ${connection.label}` : ""}`
		: `Waiting for ${activeAgent ? `${activeAgent.label}'s` : "your agent's"} first call`;
	const callMark = firstCall?.failed ? (
		<WarningCircleIcon aria-hidden="true" {...stylex.props(s.bad)} />
	) : calledOnMount.current ? (
		<CheckCircleIcon aria-hidden="true" {...stylex.props(s.good)} />
	) : (
		<VerifiedCheck />
	);
	const viewCall =
		firstCall && onViewCall
			? () => {
					setDetailsOpen(false);
					onViewCall(firstCall.id);
				}
			: undefined;
	// Why the footer's next action is unavailable, shown beside it.
	const waiting =
		position === 0
			? !connection
				? "Add an MCP connection first."
				: unreachable
					? "Choose a connection Toolstile can reach."
					: ""
			: position === 1
				? activeAgent
					? ""
					: "Waiting for your agent to sign in."
				: position === callPosition
					? complete
						? ""
						: "Waiting for the first call."
					: checking
						? "Waiting for the check."
						: checkError
							? "Retry the check to continue."
							: !state.completed.access
								? canConfigureAccess
									? "Give access to continue."
									: "Waiting for an administrator to give access."
								: "Waiting for the check.";
	const card = (inDialog: boolean) => (
		<section
			ref={panel}
			// oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- This labelled scroll region needs keyboard scrolling in browsers without automatic scroll-container focus.
			tabIndex={0}
			{...stylex.props(
				s.card,
				inDialog && s.dialogCard,
				s.fade,
				leaving && s.leaving,
			)}
			aria-labelledby={`${fieldId}-title ${fieldId}-step`}
		>
			<header {...stylex.props(s.header)}>
				<div {...stylex.props(s.headerTitle)}>
					<h2 id={`${fieldId}-title`} {...stylex.props(s.title)}>
						Guided setup
					</h2>
					<h3
						id={`${fieldId}-step`}
						ref={stepHeading}
						tabIndex={-1}
						data-autofocus={inDialog || undefined}
						{...stylex.props(s.progress)}
					>
						{complete
							? "Setup complete"
							: `Step ${position + 1} of ${visibleSteps.length} · ${target.title}`}
					</h3>
				</div>
				<div {...stylex.props(s.actions)}>
					<button
						type="button"
						{...stylex.props(controls.button, controls.quiet, controls.small)}
						disabled={busy}
						aria-label="Skip setup for now"
						onClick={skip}
					>
						Skip
					</button>
					{inDialog ? (
						<button
							type="button"
							{...stylex.props(
								controls.button,
								controls.quiet,
								controls.small,
								controls.iconOnly,
							)}
							aria-label="Close setup details"
							onClick={() => setDetailsOpen(false)}
						>
							<XIcon size={16} aria-hidden="true" />
						</button>
					) : (
						<button
							type="button"
							{...stylex.props(
								controls.button,
								controls.quiet,
								controls.small,
								controls.iconOnly,
							)}
							aria-label={
								collapsed ? "Expand guided setup" : "Collapse guided setup"
							}
							aria-expanded={!collapsed}
							aria-controls={`${fieldId}-details`}
							onClick={() => setCollapsed((value) => !value)}
						>
							{collapsed ? (
								<CaretDownIcon size={16} aria-hidden="true" />
							) : (
								<CaretUpIcon size={16} aria-hidden="true" />
							)}
						</button>
					)}
				</div>
			</header>
			<div id={`${fieldId}-details`} hidden={!inDialog && collapsed}>
				<div {...stylex.props(s.content)}>
					{position === 0 && (
						<>
							<div {...stylex.props(s.row, s.start)}>
								<p {...stylex.props(s.text)}>
									Add the MCP server your agent should use.
								</p>
								<button
									type="button"
									{...stylex.props(
										controls.button,
										!connection && controls.primary,
									)}
									disabled={busy}
									onClick={() => openDialog("connection")}
								>
									Add an MCP connection
								</button>
							</div>
							{data.connections.length === 1 && connection && (
								<p {...stylex.props(s.text)}>
									Using: <strong>{connection.label}</strong> ·{" "}
									{statusLabel(connection.status)}
								</p>
							)}
							{data.connections.length > 1 && (
								<label
									htmlFor={`${fieldId}-connection`}
									{...stylex.props(controls.label, s.label)}
								>
									MCP connection
									<SelectField
										id={`${fieldId}-connection`}
										value={connection?.id ?? ""}
										disabled={busy}
										items={[
											{ value: "", label: "Choose a connection" },
											...data.connections.map((entry) => ({
												value: entry.id,
												label: `${entry.label} · ${statusLabel(entry.status)}`,
											})),
										]}
										onValueChange={(value) => {
											if (value) run(() => save({ setupConnectionId: value }));
										}}
									/>
								</label>
							)}
							{unreachable && (
								<p role="status" {...stylex.props(s.text)}>
									<WarningCircleIcon
										aria-hidden="true"
										{...stylex.props(s.bad)}
									/>{" "}
									Toolstile could not reach an MCP server at the address of{" "}
									<strong>{connection.label}</strong>.{" "}
									{data.connections.length > 1
										? "Choose another connection, or add one with the right address."
										: "Add an MCP connection with the right address. Many addresses end in /mcp."}
								</p>
							)}
							{connection?.authentication === "oauth" &&
								!state.completed.connect && (
									<p {...stylex.props(s.muted)}>
										Finish the provider sign-in on the connections screen before
										continuing.
									</p>
								)}
							<p {...stylex.props(s.muted)}>
								An MCP connection links Toolstile to a provider's MCP server.
								Find the server URL, often ending in /mcp, in the provider's MCP
								documentation or account settings. Adding it does not give any
								agent access.
							</p>
						</>
					)}
					{position === 1 && (
						<>
							<p {...stylex.props(s.text)}>
								An agent is an AI app or script that uses your MCP connections.
								Choose your AI app and follow its steps.
							</p>
							<div {...stylex.props(s.alternative)}>
								<p {...stylex.props(s.muted, s.alternativeText)}>
									No AI app on this device?
								</p>
								<button
									type="button"
									{...stylex.props(controls.button, controls.small)}
									disabled={busy}
									onClick={createToken}
								>
									<KeyIcon size={16} aria-hidden="true" />
									Create an agent token
								</button>
							</div>
							<label
								htmlFor={`${fieldId}-client`}
								{...stylex.props(controls.label, s.label)}
							>
								Agent app
								<SelectField
									id={`${fieldId}-client`}
									value={client}
									disabled={busy}
									items={agentApps(endpoint)
										.filter(
											(app) => app.signIn === "browser" || app.id === client,
										)
										.map((app) => ({ value: app.id, label: app.label }))}
									onValueChange={(value) => {
										run(() => save({ setupClient: value as SetupClient }));
									}}
								/>
							</label>
							<AgentSteps steps={guide.steps} />
							<p {...stylex.props(s.muted)}>
								{clientDocs && guide.anchor ? (
									<>
										<a href={`${clientDocs}#${guide.anchor}`}>
											{guide.label} setup guide
										</a>
										{" · "}
									</>
								) : null}
								<a href={guide.source} target="_blank" rel="noreferrer">
									{guide.sourceLabel}
								</a>
							</p>
							{agents.length > 1 ? (
								<label
									htmlFor={`${fieldId}-agent`}
									{...stylex.props(controls.label, s.label)}
								>
									Authorized agent
									<SelectField
										id={`${fieldId}-agent`}
										value={activeAgent?.id ?? ""}
										disabled={busy}
										items={[
											{ value: "", label: "Choose your agent" },
											...agents.map((agent) => ({
												value: agent.id,
												label: agent.label,
											})),
										]}
										onValueChange={(value) => {
											if (value) run(() => save({ setupAgentId: value }));
										}}
									/>
								</label>
							) : activeAgent ? (
								<p role="status" {...stylex.props(s.text)}>
									<CheckCircleIcon
										aria-hidden="true"
										{...stylex.props(s.good)}
									/>{" "}
									Using: <strong>{activeAgent.label}</strong>
								</p>
							) : null}
						</>
					)}
					{position === 2 && (
						<>
							<div {...stylex.props(s.row, s.start)}>
								<p {...stylex.props(s.text)}>
									{activeAgent && connection ? (
										<>
											Allow <strong>{activeAgent.label}</strong> to use{" "}
											<strong>{connection.label}</strong>.
										</>
									) : (
										"Choose an MCP connection and an agent in the earlier steps first."
									)}
								</p>
								{canConfigureAccess && (
									<button
										type="button"
										{...stylex.props(
											controls.button,
											!state.completed.access && controls.primary,
										)}
										disabled={!activeAgent || !connection || busy}
										onClick={configureAccess}
									>
										Configure access
									</button>
								)}
							</div>
							{accessHint && !state.completed.access && accessSteps ? (
								<p {...stylex.props(s.text)}>{accessSteps}</p>
							) : null}
							{!canConfigureAccess && !state.completed.access && (
								<p role="status" {...stylex.props(s.muted)}>
									Ask an administrator to give this agent access.
								</p>
							)}
							<div role="status" {...stylex.props(s.text)}>
								{checking ? (
									<span {...stylex.props(s.inline)}>
										<span aria-hidden="true" {...stylex.props(s.spinner)} />
										{activeAgent && connection
											? `Checking that ${activeAgent.label} can list the tools on ${connection.label}…`
											: "Checking…"}
									</span>
								) : checkError ? (
									<span {...stylex.props(s.inline, s.bad)}>
										<WarningCircleIcon aria-hidden="true" />
										{checkError}
										<button
											type="button"
											{...stylex.props(controls.button, controls.small)}
											disabled={busy}
											onClick={verify}
										>
											Retry
										</button>
									</span>
								) : null}
							</div>
							{verificationNote ? (
								<p {...stylex.props(s.muted)}>{verificationNote}</p>
							) : null}
						</>
					)}
					{position === callPosition && (
						<>
							{complete ? null : (
								<p {...stylex.props(s.text)}>
									<span {...stylex.props(s.inline)}>
										{verifiedOnMount.current ? (
											<CheckCircleIcon
												aria-hidden="true"
												{...stylex.props(s.good)}
											/>
										) : (
											<VerifiedCheck />
										)}
										<span>
											<strong>Your agent is connected.</strong> {success}
										</span>
									</span>
								</p>
							)}
							{complete ? null : <AgentSteps steps={callSteps} />}
							{/* One status region for both states, so the call's arrival is announced. */}
							<div role="status" {...stylex.props(s.text)}>
								{complete && firstCall ? (
									<span {...stylex.props(s.inline)}>
										{callMark}
										<span>
											<strong>First call received.</strong> {agentName}{" "}
											{firstCall.target ? (
												<>
													called{" "}
													<code {...stylex.props(s.code)}>
														{firstCall.target}
													</code>
												</>
											) : (
												"called a tool"
											)}
											{connection ? ` on ${connection.label}` : ""}
											{callTime ? ` at ${callTime}` : ""}.
											{firstCall.failed
												? " The provider returned an error, so check the request in Activity."
												: ""}
										</span>
									</span>
								) : (
									<span {...stylex.props(s.inline)}>
										<span aria-hidden="true" {...stylex.props(s.spinner)} />
										{`Waiting for ${activeAgent ? `${activeAgent.label}'s` : "your agent's"} first tool call${connection ? ` on ${connection.label}` : ""}…`}
									</span>
								)}
							</div>
							{!complete && firstCallNote ? (
								<p {...stylex.props(s.muted)}>{firstCallNote}</p>
							) : null}
							{complete && viewCall ? (
								<div {...stylex.props(s.row, s.start)}>
									<button
										type="button"
										{...stylex.props(controls.button, controls.small)}
										onClick={viewCall}
									>
										View in Activity <ArrowRightIcon aria-hidden="true" />
									</button>
								</div>
							) : null}
							{complete ? (
								<p {...stylex.props(s.muted)}>
									Select Finish to close the guide. You can change access at any
									time on the Access page.
								</p>
							) : null}
						</>
					)}
				</div>
				<footer {...stylex.props(s.footer, moreBelow && s.footerRaised)}>
					{position > 0 && position < callPosition && (
						<button
							type="button"
							{...stylex.props(controls.button, controls.quiet, s.back)}
							disabled={busy}
							onClick={() => {
								if (position === 1) stayOnConnect.current = true;
								run(() =>
									save({ setupStep: visibleSteps[position - 1]?.step }),
								);
							}}
						>
							Back
						</button>
					)}
					{error ? (
						<p role="alert" {...stylex.props(s.error)}>
							{error}
						</p>
					) : null}
					{waiting ? (
						<p id={`${fieldId}-waiting`} {...stylex.props(s.waiting)}>
							{waiting}
						</p>
					) : null}
					{position === callPosition ? (
						<button
							type="button"
							{...stylex.props(controls.button, controls.primary)}
							disabled={busy || !complete}
							aria-describedby={waiting ? `${fieldId}-waiting` : undefined}
							onClick={finish}
						>
							Finish <CheckCircleIcon aria-hidden="true" />
						</button>
					) : (
						<button
							type="button"
							{...stylex.props(
								controls.button,
								(position === 1 || (connection && !unreachable)) &&
									controls.primary,
							)}
							disabled={busy || !!waiting}
							aria-describedby={waiting ? `${fieldId}-waiting` : undefined}
							onClick={next}
						>
							Continue <ArrowRightIcon aria-hidden="true" />
						</button>
					)}
				</footer>
			</div>
		</section>
	);
	if (!docked) return card(false);
	const openDetails = () => setDetailsOpen(true);
	const summary =
		position === 0
			? connection?.authentication === "oauth" && !state.completed.connect
				? "Finish the provider sign-in first"
				: unreachable
					? `Toolstile could not reach ${connection.label}`
					: connection
						? `Using ${connection.label}`
						: "Add the MCP server your agent uses"
			: position === 1
				? activeAgent
					? `Using ${activeAgent.label}`
					: "Waiting for your agent to sign in"
				: position === callPosition
					? callSummary
					: checking
						? "Checking the permitted tools…"
						: checkError
							? checkError
							: !canConfigureAccess && !state.completed.access
								? "Ask an administrator for access"
								: accessHint && accessSteps
									? accessSteps
									: activeAgent && connection
										? `Allow ${activeAgent.label} to use ${connection.label}`
										: "Choose an MCP connection and an agent first";
	// The dock repeats the footer's next action; a step that is waiting offers its steps instead
	// of a disabled Continue.
	const action: {
		label: string;
		arrow?: boolean;
		disabled?: boolean;
		onClick(): void;
	} =
		position === 0
			? unreachable
				? { label: "Show details", onClick: openDetails }
				: connection
					? { label: "Continue", arrow: true, disabled: busy, onClick: next }
					: {
							// The step title above already names the MCP connection.
							label: "Add connection",
							disabled: busy,
							onClick: () => openDialog("connection"),
						}
			: position === 1
				? activeAgent
					? { label: "Continue", arrow: true, disabled: busy, onClick: next }
					: { label: "Show steps", onClick: openDetails }
				: position === callPosition
					? complete
						? { label: "Finish", disabled: busy, onClick: finish }
						: { label: "Show prompt", onClick: openDetails }
					: canConfigureAccess && !state.completed.access
						? {
								label: "Configure access",
								disabled: !activeAgent || !connection || busy,
								onClick: configureAccess,
							}
						: checking
							? { label: "Checking…", disabled: true, onClick: verify }
							: checkError
								? { label: "Retry check", disabled: busy, onClick: verify }
								: { label: "Show details", onClick: openDetails };
	return (
		<>
			<section
				aria-label="Guided setup"
				{...stylex.props(s.dockSlot, s.fade, leaving && s.leaving)}
			>
				<div {...stylex.props(s.dock, rail && s.railHidden)}>
					<div {...stylex.props(s.dockHeader)}>
						<button
							type="button"
							aria-haspopup="dialog"
							{...stylex.props(s.dockTitle)}
							onClick={openDetails}
						>
							<ListChecksIcon size={16} aria-hidden="true" />
							Setup
						</button>
						<span {...stylex.props(s.dockCount)}>
							<span {...stylex.props(layout.visuallyHidden)}>Step </span>
							{position + 1} of {visibleSteps.length}
						</span>
						<button
							type="button"
							aria-label="Skip setup for now"
							title="Skip setup for now"
							{...stylex.props(s.dockClose)}
							disabled={busy}
							onClick={skip}
						>
							<XIcon size={14} aria-hidden="true" />
						</button>
					</div>
					<div aria-hidden="true" {...stylex.props(s.segments)}>
						{visibleSteps.map((entry, index) => (
							<span
								key={entry.step}
								{...stylex.props(
									s.segment,
									(index < position || (index === position && complete)) &&
										s.segmentDone,
									index === position && !complete && s.segmentCurrent,
								)}
							/>
						))}
					</div>
					<div {...stylex.props(s.dockBody)}>
						<p {...stylex.props(s.dockStep)}>
							{complete ? "Setup complete" : target.title}
						</p>
						<p role="status" title={summary} {...stylex.props(s.dockSummary)}>
							{complete ? callMark : null}
							<span {...stylex.props(s.clamp)}>{summary}</span>
						</p>
					</div>
					<div {...stylex.props(s.dockActions)}>
						<button
							type="button"
							{...stylex.props(s.dockLink, complete && s.dockFinish)}
							disabled={action.disabled}
							onClick={action.onClick}
						>
							{action.label}
							{action.arrow && !action.disabled ? (
								<ArrowRightIcon size={14} aria-hidden="true" />
							) : null}
						</button>
						{complete && viewCall ? (
							<button
								type="button"
								{...stylex.props(s.dockDetails)}
								onClick={viewCall}
							>
								View call
							</button>
						) : (
							<button
								type="button"
								aria-haspopup="dialog"
								{...stylex.props(s.dockDetails)}
								onClick={openDetails}
							>
								Details
							</button>
						)}
					</div>
					{error && (
						<p role="alert" {...stylex.props(s.error, s.dockError)}>
							{error}
						</p>
					)}
				</div>
				<button
					type="button"
					aria-haspopup="dialog"
					title={
						rail
							? complete
								? "Setup complete: finish setup"
								: `Setup, step ${position + 1} of ${visibleSteps.length}`
							: undefined
					}
					{...stylex.props(s.pill, rail && s.pillRail)}
					onClick={openDetails}
				>
					{complete ? (
						<CheckCircleIcon
							size={16}
							aria-hidden="true"
							{...stylex.props(s.good)}
						/>
					) : (
						<ListChecksIcon size={16} aria-hidden="true" />
					)}
					{complete ? (
						<span {...stylex.props(rail && s.pillWordRail)}>Finish setup</span>
					) : (
						<>
							<span {...stylex.props(s.pillWord, rail && s.pillWordRail)}>
								Setup{" "}
							</span>
							{rail
								? `${position + 1}/${visibleSteps.length}`
								: `${position + 1} of ${visibleSteps.length}`}
						</>
					)}
					{rail ? null : <ArrowRightIcon size={12} aria-hidden="true" />}
				</button>
			</section>
			{detailsOpen ? (
				<ModalFrame
					labelledBy={`${fieldId}-title ${fieldId}-step`}
					onClose={() => setDetailsOpen(false)}
				>
					{card(true)}
				</ModalFrame>
			) : null}
		</>
	);
}
function VerifiedCheck() {
	return (
		<svg
			viewBox="0 0 24 24"
			width="1em"
			height="1em"
			aria-hidden="true"
			{...stylex.props(s.good, s.check)}
		>
			<circle
				cx="12"
				cy="12"
				r="9.5"
				pathLength={1}
				{...stylex.props(s.checkStroke, s.checkRing)}
			/>
			<path
				d="M7.75 12.25l2.75 2.75 5.75-5.75"
				pathLength={1}
				{...stylex.props(s.checkStroke, s.checkMark)}
			/>
		</svg>
	);
}
const clock = new Intl.DateTimeFormat(undefined, {
	hour: "numeric",
	minute: "2-digit",
});
/** A local clock time, or nothing for a value that is not a date. */
function formatTime(value: string) {
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? "" : clock.format(date);
}
/** The permitted tools in plain words: all, a count, or up to three names. */
export function toolSummary(rules: Snapshot["grants"][number]["rules"][]) {
	const blocked = new Set(rules.flatMap((rule) => rule.block.tools));
	if (rules.some((rule) => rule.full))
		return blocked.size
			? `all tools except ${blocked.size} blocked`
			: "all tools";
	const names = [
		...new Set(
			rules.flatMap((rule) => [
				...rule.allow.tools,
				...(rule.requireApproval ?? []),
			]),
		),
	].filter((name) => !blocked.has(name));
	if (!names.length) return "its permitted resources and prompts";
	const count = `${names.length} ${names.length === 1 ? "tool" : "tools"}`;
	return names.length <= 3 ? `${count} (${names.join(", ")})` : count;
}
const reducedMotion = "@media (prefers-reduced-motion: reduce)";
const mobile = "@media (max-width: 760px)";
const coarse = "@media (pointer: coarse)";
const narrow = "@media (max-width: 400px)";
const drawStroke = stylex.keyframes({
	from: { strokeDashoffset: "1" },
	to: { strokeDashoffset: "0" },
});
const spin = stylex.keyframes({ to: { transform: "rotate(360deg)" } });
const s = stylex.create({
	card: {
		backgroundColor: colors.surface,
		boxShadow: elevation.low,
		borderRadius: geometry.corner,
		padding: 0,
		marginTop: 0,
		marginBottom: 16,
		minWidth: 0,
		maxHeight: stylex.firstThatWorks("45svh", "45vh"),
		overflowY: "auto",
		overscrollBehavior: "contain",
		scrollPaddingBlock: {
			default: 12,
			"@media (min-height: 561px)": "64px 64px",
		},
	},
	fade: {
		transitionProperty: { default: "opacity", [reducedMotion]: "none" },
		transitionDuration: motion.slow,
		transitionTimingFunction: motion.easeOut,
	},
	leaving: { opacity: 0, pointerEvents: "none" },
	// The details dialog keeps the inline card's 45% height cap.
	dialogCard: {
		width: "100%",
		marginBottom: 0,
		boxShadow: elevation.high,
	},
	dockSlot: { display: "block", minWidth: 0 },
	dock: {
		display: { default: "grid", [mobile]: "none" },
		gap: 8,
		margin: 0,
		paddingBlock: 10,
		paddingInline: space.s3,
		// A flat fill on the sidebar plane: no ring or shadow, so it reads as part of the rail.
		backgroundColor: colors.surface,
		borderRadius: geometry.corner,
		minWidth: 0,
		fontSize: typeScale.size13,
		lineHeight: typeScale.leading13,
	},
	dockPaused: {
		display: { default: "flex", [mobile]: "none" },
		alignItems: "center",
		gap: 6,
		color: colors.muted,
		paddingBlock: 6,
	},
	dockHeader: {
		display: "flex",
		alignItems: "center",
		gap: 6,
		minWidth: 0,
	},
	dockTitle: {
		display: "inline-flex",
		alignItems: "center",
		gap: 6,
		marginInlineStart: -4,
		paddingInline: 4,
		minHeight: { default: 24, [coarse]: 44 },
		borderWidth: 0,
		borderRadius: geometry.corner,
		backgroundColor: {
			default: "transparent",
			":hover": colors.hoverOverlay,
			":focus-visible": colors.hoverOverlay,
		},
		color: colors.text,
		fontFamily: geometry.fontSans,
		fontSize: typeScale.size13,
		fontWeight: 600,
		cursor: "pointer",
		outlineOffset: 2,
	},
	dockCount: {
		marginInlineStart: "auto",
		color: colors.muted,
		fontSize: typeScale.size12,
		fontVariantNumeric: "tabular-nums",
		whiteSpace: "nowrap",
	},
	dockClose: {
		display: "grid",
		placeItems: "center",
		width: { default: 24, [coarse]: 44 },
		height: { default: 24, [coarse]: 44 },
		marginInlineEnd: -4,
		padding: 0,
		borderWidth: 0,
		borderRadius: geometry.corner,
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
		cursor: { default: "pointer", ":disabled": "not-allowed" },
		outlineOffset: 2,
	},
	segments: {
		display: "grid",
		gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
		gap: 4,
	},
	segment: {
		height: 3,
		borderRadius: 2,
		backgroundColor: colors.lineStrong,
		transitionProperty: {
			default: "background-color",
			[reducedMotion]: "none",
		},
		transitionDuration: motion.slow,
		transitionTimingFunction: motion.easeOut,
	},
	segmentDone: { backgroundColor: colors.good },
	segmentCurrent: { backgroundColor: colors.action },
	dockBody: { display: "grid", gap: 2, minWidth: 0 },
	dockStep: { margin: 0, fontWeight: 500, color: colors.text },
	dockSummary: {
		display: {
			default: "flex",
			"@media (max-height: 600px)": "none",
		},
		alignItems: "center",
		gap: 4,
		margin: 0,
		minWidth: 0,
		color: colors.muted,
		fontSize: typeScale.size12,
		lineHeight: typeScale.leading12,
	},
	clamp: {
		minWidth: 0,
		display: "-webkit-box",
		overflow: "hidden",
		WebkitBoxOrient: "vertical",
		WebkitLineClamp: 2,
	},
	dockActions: {
		display: "flex",
		alignItems: "center",
		justifyContent: "space-between",
		gap: 8,
	},
	dockLink: {
		display: "inline-flex",
		alignItems: "center",
		gap: 4,
		minHeight: { default: 24, [coarse]: 44 },
		padding: 0,
		borderWidth: 0,
		backgroundColor: "transparent",
		color: { default: colors.action, ":disabled": colors.muted },
		fontFamily: geometry.fontSans,
		fontSize: typeScale.size13,
		fontWeight: 500,
		textDecoration: {
			default: "none",
			":hover": "underline",
			":focus-visible": "underline",
			":disabled": "none",
		},
		textUnderlineOffset: 3,
		whiteSpace: "nowrap",
		opacity: { default: 1, ":disabled": 0.6 },
		cursor: { default: "pointer", ":disabled": "not-allowed" },
		outlineOffset: 2,
	},
	dockFinish: { fontWeight: 600 },
	dockDetails: {
		minHeight: { default: 24, [coarse]: 44 },
		padding: 0,
		borderWidth: 0,
		backgroundColor: "transparent",
		color: {
			default: colors.muted,
			":hover": colors.text,
			":focus-visible": colors.text,
		},
		fontFamily: geometry.fontSans,
		fontSize: typeScale.size12,
		textDecoration: {
			default: "none",
			":hover": "underline",
			":focus-visible": "underline",
		},
		textUnderlineOffset: 3,
		cursor: "pointer",
		outlineOffset: 2,
	},
	dockError: { fontSize: typeScale.size12 },
	// Mobile replaces the card with a one-line pill in the top bar.
	pill: {
		display: { default: "none", [mobile]: "inline-flex" },
		alignItems: "center",
		gap: 4,
		minHeight: size.control,
		paddingInline: 10,
		borderWidth: 0,
		boxShadow: elevation.low,
		borderRadius: 999,
		backgroundColor: colors.surface,
		color: colors.text,
		fontFamily: geometry.fontSans,
		fontSize: typeScale.size12,
		fontWeight: 500,
		whiteSpace: "nowrap",
		cursor: "pointer",
		outlineOffset: 2,
	},
	railHidden: { display: { default: "none", [mobile]: "none" } },
	// On the compact rail the pill becomes a 40px tile: the icon over the step count.
	pillRail: {
		display: { default: "inline-flex", [mobile]: "inline-flex" },
		flexDirection: { default: "column", [mobile]: "row" },
		justifyContent: "center",
		gap: 2,
		width: { default: 40, [mobile]: "auto" },
		minHeight: { default: 40, [mobile]: size.control },
		paddingInline: { default: 0, [mobile]: 10 },
		borderRadius: geometry.corner,
		fontSize: 11,
		fontVariantNumeric: "tabular-nums",
	},
	pillWordRail: {
		position: "absolute",
		width: 1,
		height: 1,
		overflow: "hidden",
		clipPath: "inset(50%)",
	},
	// Narrow phones keep the icon and count; the word stays for assistive technology.
	pillWord: {
		position: { default: "static", [narrow]: "absolute" },
		width: { default: "auto", [narrow]: 1 },
		height: { default: "auto", [narrow]: 1 },
		overflow: { default: "visible", [narrow]: "hidden" },
		clipPath: { default: "none", [narrow]: "inset(50%)" },
		whiteSpace: "pre",
	},
	skippedCard: { paddingBlock: 6, paddingInline: space.s3 },
	header: {
		position: { default: "static", "@media (min-height: 561px)": "sticky" },
		top: 0,
		zIndex: 1,
		backgroundColor: colors.surface,
		paddingBlock: 6,
		paddingInline: space.s3,
		display: "flex",
		alignItems: "center",
		justifyContent: "space-between",
		gap: space.s2,
		borderBottomWidth: 1,
		borderBottomStyle: "solid",
		borderBottomColor: colors.line,
	},
	headerTitle: {
		display: "flex",
		flexWrap: "wrap",
		alignItems: "baseline",
		columnGap: 12,
		rowGap: 2,
		minWidth: 0,
	},
	title: {
		margin: 0,
		fontSize: text.sectionTitle,
		lineHeight: text.sectionTitleLeading,
		fontWeight: 600,
	},
	progress: {
		margin: 0,
		color: colors.muted,
		fontSize: text.body,
		lineHeight: typeScale.leading13,
		fontWeight: 400,
		scrollMarginBlock: 12,
	},
	actions: {
		display: "flex",
		gap: space.s1,
		alignItems: "center",
		flexShrink: 0,
	},
	content: {
		display: "grid",
		gap: space.s2,
		paddingBlock: 10,
		paddingInline: space.s3,
		maxWidth: 760,
		minWidth: 0,
	},
	footer: {
		position: { default: "static", "@media (min-height: 561px)": "sticky" },
		bottom: 0,
		zIndex: 1,
		display: "flex",
		justifyContent: "flex-end",
		alignItems: "center",
		gap: space.s2,
		flexWrap: "wrap",
		paddingBlock: 6,
		paddingInline: space.s3,
		backgroundColor: colors.surface,
		borderTopWidth: 1,
		borderTopStyle: "solid",
		borderTopColor: colors.line,
		transitionProperty: { default: "box-shadow", [reducedMotion]: "none" },
		transitionDuration: motion.base,
	},
	// Lifts the sticky footer over content still below it, so the panel reads as scrollable.
	footerRaised: { boxShadow: "0 -6px 12px -8px rgb(0 0 0 / 0.28)" },
	// Why the next action is unavailable; it sits beside the disabled button.
	waiting: {
		margin: 0,
		minWidth: 0,
		color: colors.muted,
		fontSize: text.meta,
		lineHeight: text.metaLeading,
		textAlign: "end",
	},
	alternative: {
		display: "flex",
		flexWrap: "wrap",
		alignItems: "center",
		gap: 8,
	},
	alternativeText: { flex: "0 1 auto" },
	spinner: {
		flexShrink: 0,
		width: 12,
		height: 12,
		borderWidth: 2,
		borderStyle: "solid",
		borderColor: colors.lineStrong,
		borderTopColor: colors.action,
		borderRadius: "50%",
		animationName: { default: spin, [reducedMotion]: "none" },
		animationDuration: "800ms",
		animationTimingFunction: "linear",
		animationIterationCount: "infinite",
	},
	row: {
		display: "flex",
		flexWrap: "wrap",
		alignItems: "center",
		justifyContent: "space-between",
		gap: 8,
	},
	start: { justifyContent: "flex-start", columnGap: 12 },
	text: { margin: 0, fontSize: text.body, lineHeight: text.bodyLeading },
	muted: {
		color: colors.muted,
		fontSize: text.body,
		lineHeight: typeScale.leading13,
		margin: 0,
	},
	inline: {
		display: "inline-flex",
		flexWrap: "wrap",
		alignItems: "center",
		gap: 6,
	},
	good: { color: colors.good, verticalAlign: "-2px" },
	code: {
		fontFamily: geometry.fontMono,
		fontSize: typeScale.size13,
		overflowWrap: "anywhere",
	},
	bad: { color: colors.bad },
	check: { flexShrink: 0, fontSize: typeScale.size16, overflow: "visible" },
	checkStroke: {
		fill: "none",
		stroke: "currentColor",
		strokeWidth: 2,
		strokeLinecap: "round",
		strokeLinejoin: "round",
		strokeDasharray: "1",
		strokeDashoffset: "0",
		animationName: { default: drawStroke, [reducedMotion]: "none" },
		animationTimingFunction: motion.easeOut,
		animationFillMode: "both",
	},
	checkRing: { animationDuration: "240ms" },
	// The mark starts as the ring finishes, so the whole draw lasts about 400ms.
	checkMark: { animationDuration: "180ms", animationDelay: "220ms" },
	label: {
		display: "grid",
		gap: 4,
		maxWidth: 360,
		margin: 0,
		fontSize: text.body,
	},
	back: { marginInlineEnd: "auto" },
	error: {
		color: colors.bad,
		margin: 0,
		flex: "1 1 100%",
		overflowWrap: "anywhere",
	},
});
