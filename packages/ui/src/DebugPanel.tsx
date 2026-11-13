import { ClockClockwiseIcon, StopIcon } from "@phosphor-icons/react";
import * as stylex from "@stylexjs/stylex";
import type { ManagementClient } from "@toolstile/api/client";
import type {
	DebugPayload,
	DebugStatus,
	Snapshot,
} from "@toolstile/api/contract";
import { controls } from "@toolstile/ui/controls";
import { SelectField } from "@toolstile/ui/select";
import { useId, useState } from "react";
import { Checkbox } from "./Checkbox";
import { useLoaded } from "./ScopedState";
import { colors, geometry, space, text, typeScale } from "./tokens.stylex";

export interface DebugPanelProps {
	api: ManagementClient;
	agents: Snapshot["agents"];
	connections: Snapshot["connections"];
	selectedPayloadId?: string;
	onSelectPayload(id?: string): void;
}
export function DebugPanel({
	api,
	agents,
	connections,
	selectedPayloadId,
	onSelectPayload,
}: DebugPanelProps) {
	const fieldId = useId();
	const [agentDraft, setAgentDraft] = useState<string[]>([]),
		[connectionDraft, setConnectionDraft] = useState<string[]>([]),
		[error, setError] = useState(""),
		[busy, setBusy] = useState(false);
	const statusLoad = useLoaded<DebugStatus>({
		key: "status",
		load: () => api.debugStatus(),
		failure: "Debug capture is unavailable or you do not have access.",
	});
	const status = statusLoad.latest?.data ?? null;
	// The capture's own error belongs to that selection and clears when another is chosen.
	const payloadLoad = useLoaded<DebugPayload>({
		key: selectedPayloadId ?? "",
		load: selectedPayloadId
			? () => api.debugPayload({ id: selectedPayloadId })
			: undefined,
		failure: "This capture expired or is unavailable.",
	});
	const payload = selectedPayloadId
		? (payloadLoad.current?.data ?? null)
		: null;
	const shownError =
		error || statusLoad.current?.error || payloadLoad.current?.error;
	async function load() {
		statusLoad.set(await api.debugStatus());
	}
	async function action(work: () => Promise<unknown>) {
		setBusy(true);
		setError("");
		try {
			await work();
			await load();
		} catch (failure) {
			setError(
				failure instanceof Error
					? failure.message
					: "Debug capture could not be updated",
			);
		} finally {
			setBusy(false);
		}
	}
	function toggle(
		id: string,
		checked: boolean,
		values: string[],
		set: (value: string[]) => void,
	) {
		set(checked ? [...values, id] : values.filter((value) => value !== id));
	}
	return (
		<div {...stylex.props(styles.root)}>
			{/* The activity page's "Debug capture" tab names this view, so no heading repeats it. */}
			<p {...stylex.props(styles.intro)}>
				Capture is off by default. Select agents and MCPs, then start a one-hour
				session; only their requests are captured. Stored arguments and results
				are encrypted, bounded and expire automatically.
			</p>
			{status ? (
				<>
					<p {...stylex.props(styles.meta)}>
						Activity kept {status.activityRetentionDays} days · payloads kept{" "}
						{status.payloadRetentionHours} hours · up to 1,000 captures per
						session, 64 KB each · authentication fields redacted
					</p>
					<form
						onSubmit={(event) => {
							event.preventDefault();
							void action(() =>
								api.startDebug({
									agentIds: agentDraft,
									connectionIds: connectionDraft,
								}),
							);
						}}
						{...stylex.props(styles.form)}
					>
						<div {...stylex.props(styles.columns)}>
							<fieldset {...stylex.props(controls.fieldset, styles.group)}>
								<legend {...stylex.props(controls.legend, styles.legend)}>
									Agents to capture
								</legend>
								{agents
									.filter((a) => !a.revoked)
									.map((agent) => (
										<label key={agent.id} {...stylex.props(styles.check)}>
											<Checkbox
												checked={agentDraft.includes(agent.id)}
												disabled={busy}
												onCheckedChange={(checked) =>
													toggle(agent.id, checked, agentDraft, setAgentDraft)
												}
											/>
											{agent.label}
										</label>
									))}
							</fieldset>
							<fieldset {...stylex.props(controls.fieldset, styles.group)}>
								<legend {...stylex.props(controls.legend, styles.legend)}>
									MCPs to capture
								</legend>
								{connections.map((connection) => (
									<label key={connection.id} {...stylex.props(styles.check)}>
										<Checkbox
											checked={connectionDraft.includes(connection.id)}
											disabled={busy}
											onCheckedChange={(checked) =>
												toggle(
													connection.id,
													checked,
													connectionDraft,
													setConnectionDraft,
												)
											}
										/>
										{connection.label}
									</label>
								))}
							</fieldset>
						</div>
						<div {...stylex.props(styles.actions)}>
							<button
								{...stylex.props(controls.button, controls.primary)}
								type="submit"
								disabled={busy || !agentDraft.length || !connectionDraft.length}
							>
								Start capture for one hour
							</button>
							<button
								{...stylex.props(controls.button)}
								type="button"
								disabled={busy}
								onClick={() => void action(load)}
							>
								Refresh
							</button>
						</div>
					</form>
					{status.sessions.length ? (
						<ul {...stylex.props(styles.list)}>
							{status.sessions.map((session) => {
								const live =
									!session.stoppedAt &&
									Date.parse(session.stopsAt) > Date.now();
								return (
									<li key={session.id} {...stylex.props(styles.session)}>
										<div>
											<strong {...stylex.props(styles.sessionTitle)}>
												{live
													? "Capturing selected requests"
													: "Capture stopped"}
											</strong>
											<p {...stylex.props(styles.meta)}>
												{live ? "Auto-stop" : "Stopped"}:{" "}
												{new Date(
													session.stoppedAt ?? session.stopsAt,
												).toLocaleString()}{" "}
												· {session.agentIds.length} agents ·{" "}
												{session.connectionIds.length} MCPs
											</p>
										</div>
										{live ? (
											<div {...stylex.props(styles.actions)}>
												<button
													{...stylex.props(controls.button)}
													type="button"
													disabled={busy}
													onClick={() =>
														void action(() =>
															api.extendDebug({ id: session.id }),
														)
													}
												>
													<ClockClockwiseIcon aria-hidden="true" /> Extend to
													one hour from now
												</button>
												<button
													{...stylex.props(controls.button)}
													type="button"
													disabled={busy}
													onClick={() =>
														void action(() => api.stopDebug({ id: session.id }))
													}
												>
													<StopIcon aria-hidden="true" /> Stop
												</button>
											</div>
										) : null}
									</li>
								);
							})}
						</ul>
					) : null}
					<label
						{...stylex.props(controls.label, styles.field)}
						htmlFor={`${fieldId}-payload`}
					>
						Stored capture
						<SelectField
							id={`${fieldId}-payload`}
							value={selectedPayloadId ?? ""}
							onValueChange={(value) => onSelectPayload(value || undefined)}
							items={[
								{ value: "", label: "Select a capture" },
								...status.payloads.map((item) => ({
									value: item.id,
									label: `${new Date(item.createdAt).toLocaleString()} · ${agents.find((a) => a.id === item.agentId)?.label ?? "Removed agent"} · ${connections.find((c) => c.id === item.connectionId)?.label ?? "Removed MCP"}`,
								})),
							]}
						/>
					</label>
					{!status.payloads.length ? (
						<p {...stylex.props(styles.meta)}>
							No unexpired captures. Starting a session does not run any tools.
						</p>
					) : null}
				</>
			) : null}
			{payload ? (
				<section
					aria-label="Captured payload"
					{...stylex.props(styles.payload)}
				>
					<h3 {...stylex.props(styles.subheading)}>Arguments and result</h3>
					<textarea
						readOnly
						aria-label="Captured arguments and result"
						value={JSON.stringify(payload, null, 2)}
						rows={12}
						{...stylex.props(controls.textarea, styles.code)}
					/>
					{payload.truncated ? (
						<p {...stylex.props(styles.meta)}>
							Payload truncated to the capture size limit.
						</p>
					) : null}
				</section>
			) : null}
			{shownError ? (
				<p role="alert" {...stylex.props(styles.error)}>
					{shownError}
				</p>
			) : null}
		</div>
	);
}
const styles = stylex.create({
	// The activity page's tab strip already spaces it from the header.
	root: { display: "grid", gap: space.s4, minWidth: 0 },
	intro: {
		margin: 0,
		maxWidth: "75ch",
		color: colors.muted,
		fontSize: text.body,
		lineHeight: text.bodyLeading,
	},
	meta: {
		margin: 0,
		color: colors.muted,
		fontSize: text.meta,
		lineHeight: text.metaLeading,
		overflowWrap: "anywhere",
	},
	form: { display: "grid", gap: space.s4 },
	columns: {
		display: "grid",
		gridTemplateColumns: {
			default: "1fr 1fr",
			"@media (max-width: 600px)": "1fr",
		},
		gap: { default: space.s6, "@media (max-width: 600px)": space.s4 },
	},
	group: { margin: 0, gap: 0, alignContent: "start", minWidth: 0 },
	legend: { marginBottom: space.s1 },
	check: {
		display: "flex",
		gap: space.s2,
		alignItems: "center",
		paddingBlock: space.s1,
		fontSize: text.body,
		lineHeight: text.bodyLeading,
		overflowWrap: "anywhere",
	},
	actions: {
		display: "flex",
		flexWrap: "wrap",
		gap: space.s2,
		alignItems: "center",
	},
	list: { listStyle: "none", padding: 0, margin: 0 },
	session: {
		display: "flex",
		flexWrap: "wrap",
		alignItems: "center",
		justifyContent: "space-between",
		gap: space.s3,
		paddingBlock: space.s2,
		borderBottomWidth: 1,
		borderBottomStyle: "solid",
		borderBottomColor: colors.line,
		fontSize: text.body,
		lineHeight: typeScale.leading13,
	},
	sessionTitle: { fontWeight: 500 },
	field: { margin: 0, maxWidth: 480 },
	payload: { display: "grid", gap: space.s2 },
	subheading: {
		margin: 0,
		fontSize: text.body,
		lineHeight: typeScale.leading13,
		fontWeight: 600,
	},
	code: {
		fontFamily: geometry.fontMono,
		fontSize: text.meta,
		lineHeight: typeScale.leading13,
		width: "100%",
		resize: "vertical",
		backgroundColor: colors.insetTint,
		borderRadius: geometry.corner,
		padding: space.s3,
	},
	error: {
		margin: 0,
		color: colors.bad,
		fontSize: text.body,
		lineHeight: typeScale.leading13,
	},
});
