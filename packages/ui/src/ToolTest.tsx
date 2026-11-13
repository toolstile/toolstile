import { PlayIcon } from "@phosphor-icons/react";
import * as stylex from "@stylexjs/stylex";
import type { ManagementClient } from "@toolstile/api/client";
import type { Snapshot } from "@toolstile/api/contract";
import { type FormEvent, useEffect, useId, useState } from "react";
import { controls } from "./Control.styles";
import { Disclosure } from "./Disclosure";
import { formatRelative } from "./format";
import { MarkdownContent } from "./MarkdownContent";
import { ModalFrame } from "./ModalFrame";
import { Notice } from "./Primitives";
import { SelectField } from "./SelectField";
import { specificMessage } from "./status";
import { colors, geometry, space, text, typeScale } from "./tokens.stylex";

type Catalog = Awaited<ReturnType<ManagementClient["agentCatalog"]>>;
type Result = Awaited<ReturnType<ManagementClient["testTool"]>>;
export function ToolTest({
	connection,
	agents,
	agentId,
	toolName,
	api,
	onSelect,
	onClose,
	reload,
}: {
	connection?: Snapshot["connections"][number];
	agents: Snapshot["agents"];
	agentId?: string;
	toolName?: string;
	api: ManagementClient;
	onSelect(agentId?: string, toolName?: string): void;
	onClose(): void;
	reload(): Promise<void>;
}) {
	const fieldId = useId();
	const [catalog, setCatalog] = useState<Catalog | null>(null),
		[argumentsDraft, setArgumentsDraft] = useState("{}"),
		[result, setResult] = useState<Result | null>(null),
		[error, setError] = useState<{
			step: "load" | "run";
			message: string;
		} | null>(null),
		[busy, setBusy] = useState(false);
	const eligible = agents.filter((agent) => agent.canTest && !agent.revoked);
	const selected = catalog?.tools.find((tool) => tool.name === toolName);
	// changing either target must clear the previous target's catalog, result and error.
	useEffect(() => {
		setCatalog(null);
		setResult(null);
		setError(null);
	}, [agentId, connection?.id]);
	// each selected tool starts with a fresh argument draft and no previous result.
	useEffect(() => {
		setArgumentsDraft("{}");
		setResult(null);
	}, [toolName]);
	async function load() {
		if (!connection || !agentId) return;
		setBusy(true);
		setError(null);
		try {
			setCatalog(
				await api.agentCatalog({ connectionId: connection.id, agentId }),
			);
		} catch (failure) {
			setError({
				step: "load",
				message:
					specificMessage(failure) ??
					"Toolstile could not load the tools that this agent may use.",
			});
		} finally {
			setBusy(false);
		}
	}
	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (!connection || !agentId || !selected) return;
		setBusy(true);
		setError(null);
		setResult(null);
		try {
			const args = JSON.parse(argumentsDraft);
			if (!args || typeof args !== "object" || Array.isArray(args))
				throw new Error("Arguments must be a JSON object");
			setResult(
				await api.testTool({
					connectionId: connection.id,
					agentId,
					name: selected.name,
					arguments: args,
				}),
			);
			await reload();
		} catch (failure) {
			setError({
				step: "run",
				message:
					specificMessage(failure) ?? "Toolstile could not run this tool.",
			});
		} finally {
			setBusy(false);
		}
	}
	return (
		<ModalFrame
			title={`Test ${connection?.label ?? "an MCP"}`}
			description="Run a tool with an agent’s current account and permissions"
			closeLabel="Close tool test"
			width="lg"
			onClose={onClose}
		>
			<p {...stylex.props(styles.description)}>
				Review the arguments: a tool can change data. Results appear here and
				are not added to activity metadata.
			</p>
			{!connection ? (
				<p role="alert" {...stylex.props(styles.error)}>
					This MCP is unavailable.
				</p>
			) : (
				<>
					<div {...stylex.props(styles.load)}>
						<label
							htmlFor={`${fieldId}-agent`}
							{...stylex.props(controls.label, styles.field, styles.grow)}
						>
							Agent
							<SelectField
								id={`${fieldId}-agent`}
								aria-label="Agent"
								value={agentId ?? ""}
								disabled={busy}
								onValueChange={(value) => onSelect(value || undefined)}
								items={[
									{ value: "", label: "Select your agent" },
									...eligible.map((agent) => ({
										value: agent.id,
										label: agent.label,
									})),
								]}
							/>
						</label>
						<button
							type="button"
							disabled={!agentId || busy}
							onClick={load}
							{...stylex.props(controls.button)}
						>
							Load permitted tools
						</button>
					</div>
					{!eligible.length ? (
						<p {...stylex.props(styles.description)}>
							Connect an agent and configure its access before testing.
						</p>
					) : null}
					{catalog ? (
						<form onSubmit={submit} {...stylex.props(styles.form)}>
							<label
								htmlFor={`${fieldId}-tool`}
								{...stylex.props(controls.label, styles.first)}
							>
								Tool
								<SelectField
									id={`${fieldId}-tool`}
									aria-label="Tool"
									value={toolName ?? ""}
									disabled={busy}
									onValueChange={(value) =>
										onSelect(agentId, value || undefined)
									}
									items={[
										{ value: "", label: "Select a tool" },
										...catalog.tools.map((tool) => ({
											value: tool.name,
											label: tool.name,
										})),
									]}
								/>
							</label>
							{!catalog.tools.length ? (
								<p {...stylex.props(styles.description)}>
									No tools are currently permitted. Update access and load
									again.
								</p>
							) : null}
							{selected ? (
								<>
									<MarkdownContent>
										{selected.description ?? ""}
									</MarkdownContent>
									<Disclosure summary="Input schema">
										<pre {...stylex.props(styles.code)}>
											{JSON.stringify(selected.inputSchema, null, 2)}
										</pre>
									</Disclosure>
									<label {...stylex.props(controls.label)}>
										Tool arguments (JSON)
										<textarea
											rows={7}
											spellCheck={false}
											maxLength={100_000}
											value={argumentsDraft}
											onChange={(event) =>
												setArgumentsDraft(event.target.value)
											}
											{...stylex.props(controls.textarea, styles.editor)}
										/>
									</label>
								</>
							) : null}
							<footer {...stylex.props(styles.actions)}>
								<button
									type="button"
									onClick={onClose}
									{...stylex.props(controls.button)}
								>
									Close
								</button>
								<button
									type="submit"
									disabled={busy || !selected}
									{...stylex.props(controls.button, controls.primary)}
								>
									<PlayIcon />
									{busy ? "Working…" : "Run test tool"}
								</button>
							</footer>
						</form>
					) : null}
				</>
			)}
			{error ? (
				<div role="alert" {...stylex.props(styles.failure)}>
					<p {...stylex.props(styles.error)}>{error.message}</p>
					<p {...stylex.props(styles.description)}>
						{error.step === "load"
							? "Check that the MCP server is reachable (Refresh tools on the MCP connections page) and that this agent has access to it. Then try again."
							: "Check the arguments and that the MCP server is reachable. Then try again."}
					</p>
					{error.step === "load" ? (
						<button
							type="button"
							disabled={busy}
							onClick={load}
							{...stylex.props(controls.button, controls.small, styles.retry)}
						>
							Try again
						</button>
					) : null}
				</div>
			) : null}
			{result?.approval ? (
				<ApprovalNotice approval={result.approval} tool={selected?.name} />
			) : result ? (
				<section aria-label="Tool test result" {...stylex.props(styles.result)}>
					<h3 {...stylex.props(styles.subheading)}>
						{result.isError ? "Tool returned an error" : "Tool result"}
					</h3>
					<textarea
						readOnly
						aria-label="Tool response preview"
						rows={9}
						value={result.preview}
						{...stylex.props(controls.textarea, styles.code)}
					/>
					{result.truncated ? (
						<p {...stylex.props(styles.description)}>
							Preview truncated at 64 KB.
						</p>
					) : null}
				</section>
			) : null}
		</ModalFrame>
	);
}
/** A review link on this origin as a path; links elsewhere are not shown. */
function sameOriginPath(value?: string) {
	if (!value || typeof location === "undefined") return undefined;
	try {
		const url = new URL(value, location.origin);
		return url.origin === location.origin
			? `${url.pathname}${url.search}`
			: undefined;
	} catch {
		return undefined;
	}
}

/** The test needs a person's approval; the same arguments can be run again afterwards. */
function ApprovalNotice({
	approval,
	tool,
}: {
	approval: NonNullable<Result["approval"]>;
	tool?: string;
}) {
	const href = sameOriginPath(approval.reviewUrl);
	return (
		<Notice tone="warning">
			{approval.status === "denied"
				? `This call to ${tool ?? "the tool"} was denied. Change the arguments or ask again later.`
				: approval.status === "busy"
					? `An approved call to ${tool ?? "the tool"} with these arguments is already running.`
					: `${tool ?? "This tool"} requires approval for each call. After it is approved, run the test again with the same arguments. The request expires ${formatRelative(approval.expiresAt)}.`}{" "}
			{href && approval.status === "pending" ? (
				<a href={href} {...stylex.props(styles.link)}>
					Review the request
				</a>
			) : null}
		</Notice>
	);
}

const styles = stylex.create({
	link: { color: colors.action, textUnderlineOffset: 2 },
	description: {
		margin: 0,
		color: colors.muted,
		fontSize: text.body,
		lineHeight: typeScale.leading13,
	},
	load: {
		display: "flex",
		flexWrap: "wrap",
		alignItems: "end",
		gap: space.s3,
	},
	field: { margin: 0 },
	grow: { flexGrow: 1, minWidth: "min(200px, 100%)" },
	// Block flow: field and disclosure margins collapse into one field gap.
	form: { display: "flow-root" },
	first: { marginTop: 0 },
	editor: { fontFamily: geometry.fontMono, resize: "vertical", width: "100%" },
	code: {
		width: "100%",
		margin: 0,
		fontFamily: geometry.fontMono,
		fontSize: text.meta,
		lineHeight: typeScale.leading13,
		backgroundColor: colors.insetTint,
		borderRadius: geometry.corner,
		padding: space.s3,
		maxHeight: 240,
		overflow: "auto",
		whiteSpace: "pre-wrap",
		overflowWrap: "anywhere",
	},
	result: { display: "grid", gap: space.s2 },
	failure: { display: "grid", gap: space.s1 },
	retry: { justifySelf: "start", marginTop: space.s1 },
	subheading: {
		margin: 0,
		fontSize: text.body,
		lineHeight: typeScale.leading13,
		fontWeight: 600,
	},
	// Spacing alone separates the actions; no rule.
	actions: {
		display: "flex",
		flexWrap: "wrap",
		justifyContent: "flex-end",
		gap: space.s2,
		marginTop: space.s4,
	},
	error: {
		margin: 0,
		color: colors.bad,
		fontSize: text.body,
		lineHeight: typeScale.leading13,
	},
});
