import { ArrowRightIcon } from "@phosphor-icons/react";
import * as stylex from "@stylexjs/stylex";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { AppMark } from "./AgentMark";
import { Brand, JunctionMark } from "./Brand";
import { GitHubMark, LinearMark, PostgresMark } from "./marks";
import type { SetupClient } from "./setup-contract";
import { colors, elevation, geometry, motion, text } from "./tokens.stylex";

const phone = "@media (max-width: 899px)";
// Two columns need room for the story beside the form.
const split = "@media (min-width: 1100px)";
const reducedMotion = "@media (prefers-reduced-motion: reduce)";
const forcedColors = "@media (forced-colors: active)";

/**
 * Account-page frame. Sign-in, sign-up, recovery and device approval render their content in
 * one narrow column, flat on the page. From 1100px a story panel sits beside it: the promise in
 * one sentence over a diagram of agent apps routed through Toolstile to connections. Narrower
 * screens get the column alone, under the lockup.
 */
export function AuthFrame({
	children,
	footer,
	wide = false,
}: {
	children: ReactNode;
	/** Quiet line under the content, such as legal links. */
	footer?: ReactNode;
	/** A wider column, for content such as a row of tabs. */
	wide?: boolean;
}) {
	return (
		<div {...stylex.props(frame.layout)}>
			<aside aria-label="Toolstile" {...stylex.props(frame.story)}>
				<div {...stylex.props(frame.storyBody)}>
					<a
						href="/"
						aria-label="Toolstile home"
						{...stylex.props(frame.home, frame.storyHome)}
					>
						<Brand />
					</a>
					<p {...stylex.props(frame.headline)}>
						One endpoint for every agent. Access you decide.
					</p>
					<p {...stylex.props(frame.support)}>
						Connect your MCP servers once, then choose exactly what each agent
						can reach.
					</p>
					<RouteDiagram />
				</div>
			</aside>
			<div {...stylex.props(frame.formPanel)}>
				<span aria-hidden="true" {...stylex.props(frame.spare)} />
				<header
					{...stylex.props(frame.column, wide && frame.wide, frame.header)}
				>
					<a href="/" aria-label="Toolstile home" {...stylex.props(frame.home)}>
						<Brand />
					</a>
				</header>
				<main {...stylex.props(frame.column, wide && frame.wide)}>
					{children}
				</main>
				{footer && (
					<footer
						{...stylex.props(frame.column, wide && frame.wide, frame.footer)}
					>
						{footer}
					</footer>
				)}
				<span aria-hidden="true" {...stylex.props(frame.spare)} />
			</div>
		</div>
	);
}

/** Content block inside the frame; it fills the column. */
export const authFrame = stylex.create({
	card: { width: "100%", minWidth: 0, color: colors.text },
});

/*
 * The diagram is drawn in a 480 x 280 box and scales with its container. Agent tiles sit at
 * x = 40, the gateway at the centre and connection tiles at x = 440; rows share the same heights.
 */
const boxWidth = 480;
const boxHeight = 280;
const rows = [35, 105, 175, 245];
const middle = boxHeight / 2;
const tileSize = 40;
type Tile = { client: SetupClient } | { mark: typeof GitHubMark };
const agentTiles: Tile[] = [
	{ client: "claude-code" },
	{ client: "codex" },
	{ client: "cursor" },
	{ client: "chatgpt" },
];
const connectionTiles: Tile[] = [
	{ mark: GitHubMark },
	{ mark: LinearMark },
	{ client: "slackbot" },
	{ mark: PostgresMark },
];
const inbound = (y: number) => `M62 ${y}C140 ${y} 130 ${middle} 206 ${middle}`;
const outbound = (y: number) =>
	`M274 ${middle}C350 ${middle} 340 ${y} 418 ${y}`;
const percent = (value: number, of: number) => `${(value / of) * 100}%`;

/*
 * The story, one scene per agent: which connections that agent is granted, the one it calls,
 * and whether the call needs the owner's approval.
 */
type Scene = {
	agent: number;
	granted: number[];
	target: number;
	approval?: "allow" | "deny";
};
const scenes: Scene[] = [
	{ agent: 0, granted: [0, 1], target: 0 },
	{ agent: 2, granted: [1, 2, 3], target: 3, approval: "allow" },
	{ agent: 3, granted: [0, 2], target: 2, approval: "deny" },
];
type Phase =
	| "idle"
	| "select"
	| "inbound"
	| "ask"
	| "point"
	| "press"
	| "outbound"
	| "arrived"
	| "reply"
	| "back"
	| "done"
	| "refused"
	| "bounced"
	| "failed";
/** How long each phase holds before the next. */
const hold: Record<Phase, number> = {
	idle: 500,
	select: 500,
	inbound: 800,
	ask: 500,
	point: 800,
	press: 350,
	outbound: 800,
	arrived: 500,
	reply: 800,
	back: 800,
	done: 900,
	refused: 900,
	bounced: 800,
	failed: 900,
};
function phases({ approval }: Scene): Phase[] {
	const ask: Phase[] = approval ? ["ask", "point", "press"] : [];
	const end: Phase[] =
		approval === "deny"
			? ["refused", "bounced", "failed"]
			: ["outbound", "arrived", "reply", "back", "done"];
	return ["select", "inbound", ...ask, ...end, "idle"];
}

function Logo({ item, size }: { item: Tile; size: number }) {
	return "client" in item ? (
		<AppMark client={item.client} size={size} />
	) : (
		<span {...stylex.props(diagram.tile, diagram.size(size))}>
			<item.mark size={Math.round(size * 0.6)} />
		</span>
	);
}

/**
 * Agent apps route through the gateway to connections. The routes draw once on load, and a
 * second cobalt copy shows through a mask that follows the pointer. Then the story loops: each
 * agent in turn sees only the connections it is granted, and its call is forwarded, approved by
 * the owner, or denied. Every call gets its answer back along the same route.
 */
function RouteDiagram() {
	const glow = useRef<SVGSVGElement>(null);
	const [step, setStep] = useState<{ scene: number; phase: Phase }>({
		scene: 0,
		phase: "idle",
	});
	useEffect(() => {
		// Matches the queries that show the diagram; nothing is measured while it is hidden.
		const shown = window.matchMedia(
			"(min-width: 1100px) and (forced-colors: none)",
		);
		const move = (event: PointerEvent) => {
			const node = glow.current;
			if (!node || !shown.matches) return;
			const box = node.getBoundingClientRect();
			node.style.setProperty("--route-x", `${event.clientX - box.left}px`);
			node.style.setProperty("--route-y", `${event.clientY - box.top}px`);
		};
		const leave = () => {
			glow.current?.style.removeProperty("--route-x");
			glow.current?.style.removeProperty("--route-y");
		};
		window.addEventListener("pointermove", move, { passive: true });
		document.documentElement.addEventListener("pointerleave", leave);
		/*
		 * The story plays only while the diagram shows, the tab is visible and motion is welcome.
		 * When any of those changes it stops and rests, and starts again once all hold.
		 */
		const still = window.matchMedia("(prefers-reduced-motion: reduce)");
		let timer = 0;
		let playing = false;
		const play = (scene: number, queue: Phase[]) => {
			const [phase, ...rest] = queue;
			setStep({ scene, phase });
			timer = window.setTimeout(() => {
				if (rest.length) play(scene, rest);
				else {
					const next = (scene + 1) % scenes.length;
					play(next, phases(scenes[next]));
				}
			}, hold[phase]);
		};
		const sync = (delay: number) => {
			const eligible = shown.matches && !still.matches && !document.hidden;
			if (eligible === playing) return;
			playing = eligible;
			window.clearTimeout(timer);
			if (eligible)
				timer = window.setTimeout(() => play(0, phases(scenes[0])), delay);
			else setStep({ scene: 0, phase: "idle" });
		};
		const resync = () => sync(600);
		shown.addEventListener("change", resync);
		still.addEventListener("change", resync);
		document.addEventListener("visibilitychange", resync);
		// On load the routes finish drawing first.
		sync(2400);
		return () => {
			window.clearTimeout(timer);
			shown.removeEventListener("change", resync);
			still.removeEventListener("change", resync);
			document.removeEventListener("visibilitychange", resync);
			window.removeEventListener("pointermove", move);
			document.documentElement.removeEventListener("pointerleave", leave);
		};
	}, []);
	const scene = scenes[step.scene];
	const { phase } = step;
	const live = phase !== "idle";
	const asking = phase === "ask" || phase === "point" || phase === "press";
	const pointing = phase === "point" || phase === "press";
	const allow = scene.approval === "allow";
	return (
		<div aria-hidden="true" {...stylex.props(diagram.root)}>
			<svg
				viewBox={`0 0 ${boxWidth} ${boxHeight}`}
				aria-hidden="true"
				focusable="false"
				{...stylex.props(diagram.svg)}
			>
				{rows.map((y, index) => (
					<path
						key={`in-${y}`}
						d={inbound(y)}
						pathLength={1}
						{...stylex.props(
							diagram.path,
							diagram.delay(`${200 + index * 80}ms`),
							live && scene.agent !== index && diagram.quiet,
						)}
					/>
				))}
				{rows.map((y, index) => (
					<path
						key={`out-${y}`}
						d={outbound(y)}
						pathLength={1}
						{...stylex.props(
							diagram.path,
							diagram.delay(`${750 + index * 80}ms`),
							live && !scene.granted.includes(index) && diagram.hidden,
						)}
					/>
				))}
				{phase === "inbound" && (
					<path
						key={`comet-in-${step.scene}`}
						d={inbound(rows[scene.agent])}
						pathLength={1}
						{...stylex.props(diagram.comet)}
					/>
				)}
				{phase === "outbound" && (
					<path
						key={`comet-out-${step.scene}`}
						d={outbound(rows[scene.target])}
						pathLength={1}
						{...stylex.props(diagram.comet)}
					/>
				)}
				{phase === "reply" && (
					<path
						key={`comet-reply-${step.scene}`}
						d={outbound(rows[scene.target])}
						pathLength={1}
						{...stylex.props(diagram.comet, diagram.cometBack)}
					/>
				)}
				{(phase === "back" || phase === "bounced") && (
					<path
						key={`comet-back-${step.scene}`}
						d={inbound(rows[scene.agent])}
						pathLength={1}
						{...stylex.props(
							diagram.comet,
							diagram.cometBack,
							phase === "bounced" && diagram.cometRefused,
						)}
					/>
				)}
				{(phase === "refused" || phase === "bounced") && (
					<g transform={`translate(292 ${middle})`}>
						{/* The pop's CSS transform would replace a transform attribute on the same node. */}
						<g {...stylex.props(diagram.stop)}>
							<circle r={9} />
							<path d="M-6.4 6.4L6.4 -6.4" />
						</g>
					</g>
				)}
			</svg>
			<svg
				ref={glow}
				viewBox={`0 0 ${boxWidth} ${boxHeight}`}
				aria-hidden="true"
				focusable="false"
				{...stylex.props(diagram.svg, diagram.glow)}
			>
				{rows.map((y) => (
					<g key={y}>
						<path d={inbound(y)} />
						<path d={outbound(y)} />
					</g>
				))}
			</svg>
			{agentTiles.map((item, index) => (
				<span
					key={`agent-${rows[index]}`}
					{...stylex.props(
						diagram.spot,
						diagram.at(percent(40, boxWidth), percent(rows[index], boxHeight)),
						diagram.delay(`${index * 80}ms`),
						live && scene.agent !== index && diagram.dim,
						live && scene.agent === index && diagram.calling,
						phase === "done" && scene.agent === index && diagram.reached,
						phase === "failed" && scene.agent === index && diagram.turnedAway,
					)}
				>
					<Logo item={item} size={tileSize} />
				</span>
			))}
			<span {...stylex.props(diagram.gateway)}>
				{live && phase !== "select" && phase !== "inbound" && (
					<span key={step.scene} {...stylex.props(diagram.ripple)} />
				)}
				<JunctionMark width={36} />
			</span>
			{connectionTiles.map((item, index) => (
				<span
					key={`connection-${rows[index]}`}
					{...stylex.props(
						diagram.spot,
						diagram.at(percent(440, boxWidth), percent(rows[index], boxHeight)),
						diagram.delay(`${1400 + index * 80}ms`),
						live && !scene.granted.includes(index) && diagram.withheld,
						(phase === "arrived" || phase === "reply") &&
							scene.target === index &&
							diagram.reached,
					)}
				>
					<Logo item={item} size={tileSize} />
				</span>
			))}
			<span {...stylex.props(diagram.anchor)}>
				<span {...stylex.props(diagram.popup, asking && diagram.popupOpen)}>
					<span {...stylex.props(diagram.popupRow)}>
						<Logo item={agentTiles[scene.agent]} size={22} />
						<ArrowRightIcon size={12} aria-hidden="true" />
						<Logo item={connectionTiles[scene.target]} size={22} />
						<span {...stylex.props(diagram.popupText)}>Allow this call?</span>
					</span>
					<span {...stylex.props(diagram.popupRow)}>
						<span
							{...stylex.props(
								diagram.choice,
								phase === "press" && !allow && diagram.denyPressed,
							)}
						>
							Deny
						</span>
						<span
							{...stylex.props(
								diagram.choice,
								diagram.choiceAllow,
								phase === "press" && allow && diagram.allowPressed,
							)}
						>
							Allow
						</span>
					</span>
				</span>
				<svg
					viewBox="0 0 16 20"
					aria-hidden="true"
					focusable="false"
					{...stylex.props(
						diagram.cursor,
						pointing && (allow ? diagram.cursorAllow : diagram.cursorDeny),
						phase === "press" && diagram.cursorPress,
					)}
				>
					<path d="M1.5 1.5v14l4-3.6 2.6 6 2.2-1-2.6-5.8h5.3z" />
				</svg>
			</span>
		</div>
	);
}

const frame = stylex.create({
	layout: {
		minHeight: "100dvh",
		display: "grid",
		gridTemplateColumns: {
			default: "minmax(0, 1fr)",
			[split]: "minmax(0, 11fr) minmax(480px, 10fr)",
		},
		backgroundColor: colors.page,
		color: colors.text,
		// Account screens keep their 14px reading size under the 13px dashboard root.
		fontSize: 14,
		lineHeight: 1.5,
	},
	// One soft step off the page, with a hairline against the form panel.
	story: {
		display: { default: "none", [split]: "flex" },
		flexDirection: "column",
		minWidth: 0,
		padding: "48px clamp(32px, 4vw, 64px)",
		// The sidebar step in light; the raised surface in dark, where that step is too slight.
		backgroundColor: `color-mix(in srgb, ${colors.surface} calc(var(--theme-dark) * 100%), ${colors.sidebarSurface})`,
		borderRightWidth: 1,
		borderRightStyle: "solid",
		borderRightColor: colors.line,
	},
	storyBody: {
		flexGrow: 1,
		display: "flex",
		flexDirection: "column",
		alignItems: "center",
		justifyContent: "center",
		paddingBlock: 32,
		textAlign: "center",
	},
	headline: {
		margin: 0,
		color: colors.text,
		maxWidth: "16em",
		fontSize: "clamp(28px, 2.6vw, 36px)",
		lineHeight: 1.15,
		letterSpacing: "-0.02em",
		fontWeight: 600,
		textWrap: "balance",
	},
	support: {
		margin: "16px 0 0",
		maxWidth: "36ch",
		color: colors.muted,
		fontSize: 16,
		lineHeight: "24px",
		textWrap: "balance",
	},
	formPanel: {
		minWidth: 0,
		display: "flex",
		flexDirection: "column",
		alignItems: "center",
		padding: { default: "48px 24px 32px", [phone]: "16px 20px 24px" },
	},
	// Spare height splits evenly above and below the column.
	spare: { flexGrow: { default: 1, [phone]: 0 } },
	column: {
		width: "100%",
		maxWidth: { default: 320, [phone]: "none" },
		minWidth: 0,
	},
	wide: { maxWidth: { default: 400, [phone]: "none" } },
	// The story panel carries the lockup when it shows.
	header: {
		display: { default: "flex", [split]: "none" },
		justifyContent: "center",
		marginBottom: 16,
	},
	storyHome: { marginBottom: 32 },
	home: {
		display: "inline-flex",
		alignItems: "center",
		minHeight: 44,
		borderRadius: geometry.corner,
		outlineWidth: 2,
		outlineStyle: { default: "none", ":focus-visible": "solid" },
		outlineColor: colors.action,
		outlineOffset: 4,
	},
	footer: {
		display: "flex",
		justifyContent: "center",
		marginTop: 40,
		color: colors.muted,
		fontSize: text.meta,
		lineHeight: text.metaLeading,
		textAlign: "center",
	},
});

const draw = stylex.keyframes({
	from: { strokeDashoffset: 1 },
	to: { strokeDashoffset: 0 },
});
const appear = stylex.keyframes({ from: { opacity: 0 }, to: { opacity: 1 } });
// A request: a short dash that runs the route once.
const travel = stylex.keyframes({
	from: { strokeDashoffset: 0.2 },
	to: { strokeDashoffset: -1 },
});
const spread = stylex.keyframes({
	from: {
		boxShadow: `0 0 0 0 color-mix(in srgb, ${colors.actionFill} 55%, transparent)`,
	},
	to: { boxShadow: "0 0 0 16px transparent" },
});
const pop = stylex.keyframes({
	"0%": { opacity: 0, transform: "scale(0.6)" },
	"30%": { opacity: 1, transform: "scale(1.25)" },
	"55%, 100%": { opacity: 1, transform: "scale(1)" },
});

// Popup geometry: the cursor aims at the middle of a button.
const popupWidth = 188;
const popupLift = 46;
const choiceWidth = (popupWidth - 16 - 6) / 2;
const popupHeight = 72;
// From the popup's top-left corner.
const choiceY = popupHeight - 8 - 13;
const stateChange = "280ms";

const diagram = stylex.create({
	root: {
		display: { default: "block", [forcedColors]: "none" },
		position: "relative",
		width: "100%",
		maxWidth: 500,
		aspectRatio: `${boxWidth} / ${boxHeight}`,
		marginTop: 56,
	},
	svg: {
		position: "absolute",
		inset: 0,
		width: "100%",
		height: "100%",
		overflow: "visible",
		fill: "none",
		stroke: colors.lineStrong,
		strokeWidth: 1.25,
		strokeLinecap: "round",
	},
	path: {
		strokeDasharray: 1,
		strokeDashoffset: 0,
		animationName: { default: draw, [reducedMotion]: "none" },
		animationDuration: "900ms",
		animationTimingFunction: motion.settle,
		animationFillMode: "backwards",
		transitionProperty: "opacity",
		transitionDuration: stateChange,
	},
	delay: (animationDelay: string) => ({ animationDelay }),
	// Routes of agents that are not calling step back.
	quiet: { opacity: 0.35 },
	// A connection this agent is not granted: its route breaks into dots.
	hidden: { opacity: 0.45, strokeDasharray: "0.012 0.035" },
	comet: {
		stroke: colors.action,
		strokeWidth: 3.5,
		strokeDasharray: "0.2 2",
		animationName: travel,
		animationDuration: "900ms",
		animationTimingFunction: "cubic-bezier(0.45, 0, 0.55, 1)",
		animationFillMode: "both",
	},
	// The answer runs the same route the other way, in green; a refusal comes back red.
	cometBack: { stroke: colors.good, animationDirection: "reverse" },
	cometRefused: { stroke: colors.bad },
	// A barred ring where a denied call ends, at the gateway's door.
	stop: {
		fill: colors.page,
		stroke: colors.bad,
		strokeWidth: 2,
		transformBox: "fill-box",
		transformOrigin: "center",
		animationName: pop,
		animationDuration: "700ms",
		animationTimingFunction: motion.easeOut,
		animationFillMode: "both",
	},
	glow: {
		stroke: colors.action,
		strokeWidth: 1.75,
		maskImage:
			"radial-gradient(circle 130px at var(--route-x, -999px) var(--route-y, -999px), #000 0%, transparent 100%)",
	},
	spot: {
		position: "absolute",
		marginLeft: -tileSize / 2,
		marginTop: -tileSize / 2,
		borderRadius: 6,
		animationName: { default: appear, [reducedMotion]: "none" },
		animationDuration: "500ms",
		animationTimingFunction: motion.easeOut,
		animationFillMode: "backwards",
		transitionProperty: "opacity, filter, box-shadow",
		transitionDuration: stateChange,
	},
	at: (left: string, top: string) => ({ left, top }),
	dim: { opacity: 0.45 },
	calling: {
		boxShadow: `0 0 0 3px ${colors.actionSoft}, 0 0 0 4px ${colors.action}`,
	},
	withheld: { opacity: 0.3, filter: "grayscale(1)" },
	reached: { boxShadow: `0 0 0 3px ${colors.good}` },
	turnedAway: { boxShadow: `0 0 0 3px ${colors.bad}` },
	// Matches AppMark's tile: white in light, the raised dark tile in dark.
	tile: {
		display: "grid",
		placeItems: "center",
		boxSizing: "border-box",
		backgroundColor:
			"color-mix(in srgb, #1c2029 calc(var(--theme-dark) * 100%), #fff)",
		borderWidth: 1,
		borderStyle: "solid",
		borderColor: colors.line,
		borderRadius: 6,
		color: colors.text,
	},
	size: (value: number) => ({ width: value, height: value }),
	// The one cobalt fill on the page besides the submit button.
	gateway: {
		position: "absolute",
		left: "50%",
		top: "50%",
		width: 68,
		height: 68,
		marginLeft: -34,
		marginTop: -34,
		display: "grid",
		placeItems: "center",
		borderRadius: 14,
		backgroundColor: colors.actionFill,
		color: "#fff",
		boxShadow: `0 0 0 6px color-mix(in srgb, ${colors.actionFill} 14%, transparent)`,
	},
	ripple: {
		position: "absolute",
		inset: 0,
		borderRadius: 14,
		animationName: spread,
		animationDuration: "800ms",
		animationTimingFunction: "ease-out",
		animationFillMode: "both",
	},
	// The popup's box, lifted above the gateway; the cursor is placed from its top-left corner.
	anchor: {
		position: "absolute",
		left: "50%",
		top: "50%",
		width: popupWidth,
		height: popupHeight,
		marginLeft: -popupWidth / 2,
		marginTop: -(popupLift + popupHeight),
		pointerEvents: "none",
	},
	popup: {
		position: "absolute",
		inset: 0,
		boxSizing: "border-box",
		display: "grid",
		gridTemplateRows: "22px 26px",
		gap: 8,
		padding: 8,
		borderRadius: 8,
		backgroundColor: colors.popover,
		boxShadow: elevation.medium,
		color: colors.text,
		fontSize: text.meta,
		lineHeight: text.metaLeading,
		fontWeight: 500,
		textAlign: "left",
		opacity: 0,
		transform: "translateY(4px) scale(0.96)",
		transformOrigin: "50% 100%",
		transitionProperty: "opacity, transform",
		transitionDuration: motion.enter,
		transitionTimingFunction: motion.settle,
	},
	popupOpen: { opacity: 1, transform: "none" },
	popupRow: {
		display: "flex",
		alignItems: "center",
		gap: 6,
		color: colors.muted,
	},
	popupText: { marginLeft: 2, color: colors.text, whiteSpace: "nowrap" },
	choice: {
		flexGrow: 1,
		flexBasis: 0,
		display: "grid",
		placeItems: "center",
		height: 26,
		boxSizing: "border-box",
		borderWidth: 1,
		borderStyle: "solid",
		borderColor: colors.controlBorder,
		borderRadius: geometry.corner,
		color: colors.text,
		transitionProperty: "background-color, border-color, color, transform",
		transitionDuration: motion.fast,
	},
	choiceAllow: {
		backgroundColor: colors.actionFill,
		borderColor: colors.actionFill,
		color: colors.onFill,
	},
	allowPressed: { transform: "scale(0.96)", filter: "brightness(1.15)" },
	denyPressed: {
		transform: "scale(0.96)",
		backgroundColor: colors.badTint,
		borderColor: colors.bad,
		color: colors.bad,
	},
	// The pointer's tip is the top-left of its box; it waits below the gateway, out of sight.
	cursor: {
		position: "absolute",
		left: 0,
		top: 0,
		width: 16,
		height: 20,
		overflow: "visible",
		fill: colors.text,
		stroke: colors.page,
		strokeWidth: 1.25,
		strokeLinejoin: "round",
		opacity: 0,
		transform: `translate(${popupWidth + 8}px, ${popupHeight + 60}px)`,
		transitionProperty: "opacity, transform",
		transitionDuration: "700ms",
		transitionTimingFunction: "cubic-bezier(0.45, 0, 0.2, 1)",
	},
	cursorAllow: {
		opacity: 1,
		transform: `translate(${8 + choiceWidth * 1.5 + 6}px, ${choiceY}px)`,
	},
	cursorDeny: {
		opacity: 1,
		transform: `translate(${8 + choiceWidth / 2}px, ${choiceY}px)`,
	},
	cursorPress: { transitionDuration: "120ms", scale: "0.86" },
});
