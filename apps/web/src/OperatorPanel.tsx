import type { RouterClient } from "@orpc/server";
import { EnvelopeSimpleIcon, TrashIcon } from "@phosphor-icons/react";
import * as stylex from "@stylexjs/stylex";
import { useNavigate, useSearch } from "@tanstack/react-router";
import {
	CheckboxField,
	ConfirmDialog,
	CopyValue,
	Notice,
	Pagination,
	Section,
	SettingsRow,
	SettingsSection,
	StatusBadge,
} from "@toolstile/ui";
import { controls } from "@toolstile/ui/controls";
import { layout } from "@toolstile/ui/layout";
import { SelectField } from "@toolstile/ui/select";
import { useLoaded } from "@toolstile/ui/shell";
import { colors, space, text } from "@toolstile/ui/tokens.stylex";
import { type FormEvent, useState } from "react";
import type { OperatorSettings } from "./server/operator-schema";
import type { instanceRouter } from "./server/runtime";

/** Users per page on Settings › Users; the page number lives in the validated `page` search param. */
const usersPerPage = 50;

type InstanceClient = RouterClient<typeof instanceRouter>;
type Person = Awaited<ReturnType<InstanceClient["operatorUsers"]>>[number];
type Administration = {
	people: Person[];
	invitations: Awaited<ReturnType<InstanceClient["operatorInvitations"]>>;
	settings: OperatorSettings;
};
/** Instance administration, split across the Settings › Instance and Settings › Users subpages. */
export function OperatorPanel({
	api,
	email,
	view,
}: {
	api: InstanceClient;
	email: string;
	view: "instance" | "users";
}) {
	const [attempt, setAttempt] = useState(0);
	const fetchAll = async (): Promise<Administration> => {
		const [people, invitations, settings] = await Promise.all([
			api.operatorUsers(),
			api.operatorInvitations(),
			api.instanceSettings(),
		]);
		return { people, invitations, settings };
	};
	const administration = useLoaded<Administration>({
		key: String(attempt),
		load: fetchAll,
		failure: (e) =>
			e instanceof Error ? e.message : "Unable to load instance administration",
	});
	const loaded = administration.latest?.data;
	const loadError = loaded ? "" : (administration.current?.error ?? "");
	const people = loaded?.people ?? [];
	const invitations = loaded?.invitations ?? [];
	// Unsaved edits to the instance settings; a reload shows the stored values again.
	const [draft, setDraft] = useState<OperatorSettings | null>(null);
	const settings = draft ?? loaded?.settings ?? null;
	const setSettings = setDraft;
	const [link, setLink] = useState("");
	const [error, setError] = useState(""),
		[message, setMessage] = useState(""),
		[busy, setBusy] = useState(false);
	const [deleting, setDeleting] = useState<Person | null>(null);
	async function load() {
		administration.set(await fetchAll());
		setDraft(null);
	}
	async function mutate(action: () => Promise<unknown>, success: string) {
		setBusy(true);
		setError("");
		setMessage("");
		try {
			await action();
			await load();
			setMessage(success);
			return true;
		} catch (e) {
			setError(
				e instanceof Error ? e.message : "Unable to save. Please try again.",
			);
			return false;
		} finally {
			setBusy(false);
		}
	}
	async function invite(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const form = new FormData(event.currentTarget);
		setLink("");
		await mutate(async () => {
			const result = await api.inviteUser({
				email: String(form.get("email") || "").trim() || undefined,
				expiresInHours: Number(form.get("hours")),
			});
			setLink(result.url);
		}, "Invitation created. Share its one-use link privately.");
	}
	const userPage = useSearch({
		from: "/app",
		select: (search) => search.page ?? 1,
	});
	const navigate = useNavigate();
	const pageCount = Math.max(1, Math.ceil(people.length / usersPerPage));
	// An out-of-range page from the URL shows the last page instead of an empty list.
	const currentPage = Math.min(userPage, pageCount);
	const visiblePeople = people.slice(
		(currentPage - 1) * usersPerPage,
		currentPage * usersPerPage,
	);
	return (
		<div {...stylex.props(styles.panel)}>
			<p {...stylex.props(layout.description)}>
				Each person's connections, credentials and activity remain private.
				Security changes require a sign-in within the last ten minutes;
				emergency account resets require the audited server CLI.
			</p>
			{error && <Notice tone="error">{error}</Notice>}
			{message && <Notice tone="success">{message}</Notice>}
			{!loaded &&
				(loadError ? (
					<div {...stylex.props(styles.loadFailure)}>
						<Notice tone="error">{loadError}</Notice>
						<button
							{...stylex.props(controls.button)}
							type="button"
							onClick={() => setAttempt((value) => value + 1)}
						>
							Try again
						</button>
					</div>
				) : (
					<p role="status" {...stylex.props(layout.description)}>
						Loading instance administration…
					</p>
				))}
			{view === "instance" && settings && (
				<form
					{...stylex.props(styles.instanceForm)}
					onSubmit={(e) => {
						e.preventDefault();
						void mutate(
							() => api.saveInstanceSettings(settings),
							"Instance settings saved.",
						);
					}}
				>
					<SettingsSection title="Instance settings" titleHidden>
						<SettingsRow label="Registration" htmlFor="registration-policy">
							<SelectField
								id="registration-policy"
								value={settings.registrationPolicy}
								onValueChange={(v) =>
									setSettings({
										...settings,
										registrationPolicy:
											v as OperatorSettings["registrationPolicy"],
									})
								}
								items={[
									{
										value: "invite-only",
										label: "Invitation required (default)",
									},
									{ value: "open", label: "Open registration" },
								]}
							/>
						</SettingsRow>
						<SettingsRow label="Private networks">
							<CheckboxField
								checked={settings.allowPrivateNetwork}
								onCheckedChange={(checked) =>
									setSettings({
										...settings,
										allowPrivateNetwork: checked,
									})
								}
							>
								Allow MCP destinations on private networks
							</CheckboxField>
							<p {...stylex.props(styles.hint)}>
								Enabled by default. Link-local and reserved infrastructure
								addresses remain blocked.
							</p>
						</SettingsRow>
						<SettingsRow
							label="Account recovery window"
							hint="Days, 0–365"
							htmlFor="recovery-window"
						>
							<input
								id="recovery-window"
								aria-describedby="recovery-window-hint"
								{...stylex.props(controls.input, styles.number)}
								type="number"
								min={0}
								max={365}
								required
								value={settings.recoveryWindowDays}
								onChange={(e) =>
									setSettings({
										...settings,
										recoveryWindowDays: Number(e.target.value),
									})
								}
							/>
						</SettingsRow>
						<SettingsRow
							label="Activity retention"
							hint="Days, 1–3,650"
							htmlFor="activity-retention"
						>
							<input
								id="activity-retention"
								aria-describedby="activity-retention-hint"
								{...stylex.props(controls.input, styles.number)}
								type="number"
								min={1}
								max={3650}
								required
								value={settings.activityRetentionDays}
								onChange={(e) =>
									setSettings({
										...settings,
										activityRetentionDays: Number(e.target.value),
									})
								}
							/>
						</SettingsRow>
						<SettingsRow
							label="Captured payload retention"
							hint="Hours, 1–24"
							htmlFor="payload-retention"
						>
							<input
								id="payload-retention"
								aria-describedby="payload-retention-hint"
								{...stylex.props(controls.input, styles.number)}
								type="number"
								min={1}
								max={24}
								required
								value={settings.payloadRetentionHours}
								onChange={(e) =>
									setSettings({
										...settings,
										payloadRetentionHours: Number(e.target.value),
									})
								}
							/>
						</SettingsRow>
						<SettingsRow label="Telemetry">
							<CheckboxField
								checked={settings.telemetryEnabled}
								onCheckedChange={(checked) =>
									setSettings({
										...settings,
										telemetryEnabled: checked,
									})
								}
							>
								Send anonymous product telemetry (enabled by default)
							</CheckboxField>
							<p {...stylex.props(styles.hint)}>
								One daily aggregate contains only schema version 1, period
								“day”, and buckets for users, connections, agents, operations
								and errors: 0, 1–9, 10–99, 100–999, 1,000–9,999 or 10,000+. It
								contains no names, emails, URLs, tool names, arguments, results,
								tokens or stable identifiers. Delivery requires
								TOOLSTILE_TELEMETRY_URL on the server. Saving opt-out deletes
								queued reports and stops retries.
							</p>
						</SettingsRow>
					</SettingsSection>
					<button
						{...stylex.props(controls.button, controls.primary)}
						disabled={busy}
						type="submit"
					>
						Save settings
					</button>
				</form>
			)}
			{view === "users" && loaded && (
				<div {...stylex.props(layout.sections)}>
					<Section
						title="Invite a user"
						icon={<EnvelopeSimpleIcon size={16} aria-hidden="true" />}
						description="Leave email blank for a one-use invitation without email delivery. Creating another invitation for an email replaces its previous link."
					>
						<form {...stylex.props(styles.inviteForm)} onSubmit={invite}>
							<label {...stylex.props(controls.label, styles.field)}>
								<span>
									Email{" "}
									<span {...stylex.props(controls.optional)}>(optional)</span>
								</span>
								<input
									{...stylex.props(controls.input)}
									type="email"
									name="email"
									autoComplete="off"
								/>
							</label>
							<label
								{...stylex.props(controls.label, styles.field, styles.hours)}
							>
								Expires after (hours)
								<input
									{...stylex.props(controls.input)}
									type="number"
									name="hours"
									defaultValue={24}
									min={1}
									max={168}
									required
								/>
							</label>
							<button
								{...stylex.props(controls.button, controls.primary)}
								disabled={busy}
								type="submit"
							>
								Create invitation link
							</button>
						</form>
						{link && (
							<CopyValue
								value={link}
								copyLabel="Copy link"
								onCopied={() => setMessage("Invitation link copied.")}
								onCopyFailed={() =>
									setError("Unable to copy. Select and copy the link manually.")
								}
							>
								<button
									{...stylex.props(controls.button, controls.quiet)}
									type="button"
									onClick={() => setLink("")}
								>
									Hide link
								</button>
							</CopyValue>
						)}
					</Section>
					<Section title="Active invitations">
						{invitations.length ? (
							<ul {...stylex.props(layout.list)}>
								{invitations.map((invite) => (
									<li {...stylex.props(layout.listRow)} key={invite.id}>
										<span {...stylex.props(layout.listRowInline)}>
											<span {...stylex.props(styles.name, layout.truncate)}>
												{invite.email ?? "Email-free invitation"}
											</span>
											<span
												{...stylex.props(
													styles.meta,
													layout.truncate,
													layout.numeric,
												)}
											>
												Expires {new Date(invite.expiresAt).toLocaleString()}
											</span>
										</span>
										<button
											{...stylex.props(
												controls.button,
												controls.small,
												controls.quiet,
											)}
											disabled={busy}
											type="button"
											onClick={() =>
												void mutate(
													() => api.revokeInvitation({ id: invite.id }),
													"Invitation revoked.",
												)
											}
										>
											Revoke
										</button>
									</li>
								))}
							</ul>
						) : (
							<p {...stylex.props(layout.description)}>
								No active invitations.
							</p>
						)}
					</Section>
					<Section title="Users">
						<ul {...stylex.props(layout.list)}>
							{visiblePeople.map((person) => (
								<li
									{...stylex.props(layout.listRow, layout.listRowWrap)}
									key={person.id}
								>
									<span {...stylex.props(layout.listRowInline)}>
										<span {...stylex.props(styles.name, layout.truncate)}>
											{person.name}
										</span>
										<span {...stylex.props(styles.meta, layout.truncate)}>
											{person.email}
										</span>
									</span>
									<span {...stylex.props(styles.badges)}>
										{person.operator && (
											<StatusBadge status="Operator" tone="action" />
										)}
										{person.deletedAt ? (
											<StatusBadge
												status={
													person.purgeAfter
														? `Deletion pending · purge after ${new Date(person.purgeAfter).toLocaleString()}`
														: "Deletion pending"
												}
												tone="neutral"
											>
												Deletion pending
											</StatusBadge>
										) : person.suspended ? (
											<StatusBadge status="Suspended" tone="warning" />
										) : null}
									</span>
									<span {...stylex.props(layout.listRowTrailing)}>
										<button
											{...stylex.props(
												controls.button,
												controls.small,
												controls.quiet,
											)}
											disabled={
												busy || person.email === email || !!person.deletedAt
											}
											type="button"
											onClick={() =>
												void mutate(
													() =>
														api.suspendUser({
															id: person.id,
															suspended: !person.suspended,
														}),
													person.suspended
														? "Account restored. The user must sign in and reconnect agents."
														: "Account suspended. Existing access was revoked.",
												)
											}
										>
											{person.suspended ? "Unsuspend" : "Suspend"}
										</button>
										{person.suspended &&
											!person.deletedAt &&
											person.email !== email && (
												<button
													{...stylex.props(
														controls.button,
														controls.small,
														controls.quietDanger,
													)}
													disabled={busy}
													type="button"
													onClick={() => {
														setError("");
														setDeleting(person);
													}}
												>
													<TrashIcon size={16} aria-hidden="true" /> Delete
												</button>
											)}
									</span>
								</li>
							))}
						</ul>
						<Pagination
							page={currentPage}
							total={people.length}
							size={usersPerPage}
							onChange={(next) =>
								void navigate({
									to: "/app/settings/users",
									search: (previous) => ({
										...previous,
										page: next > 1 ? next : undefined,
									}),
								})
							}
						/>
					</Section>
				</div>
			)}
			{deleting && (
				<ConfirmDialog
					title={`Delete ${deleting.name}?`}
					body="Their access is revoked now and the account is purged after the recovery window."
					confirmLabel={busy ? "Deleting…" : "Delete account"}
					confirmation="DELETE"
					busy={busy}
					error={error}
					onConfirm={async () => {
						const deleted = await mutate(
							() =>
								api.operatorDeleteUser({
									id: deleting.id,
									confirmation: "DELETE",
								}),
							"Account deletion scheduled. Existing access was revoked.",
						);
						if (deleted) setDeleting(null);
					}}
					onCancel={() => setDeleting(null)}
				/>
			)}
		</div>
	);
}
const styles = stylex.create({
	loadFailure: {
		display: "flex",
		flexDirection: "column",
		alignItems: "flex-start",
		gap: space.s2,
	},
	panel: {
		display: "flex",
		flexDirection: "column",
		gap: space.s6,
		maxWidth: 760,
		minWidth: 0,
	},
	instanceForm: {
		display: "flex",
		flexDirection: "column",
		alignItems: "flex-start",
		minWidth: 0,
	},
	hint: {
		margin: 0,
		maxWidth: "75ch",
		color: colors.muted,
		fontSize: text.meta,
		lineHeight: text.metaLeading,
	},
	number: { width: 120 },
	// Email, hours and the submit button share one line on wide screens.
	inviteForm: {
		display: "flex",
		flexWrap: "wrap",
		alignItems: "flex-end",
		gap: space.s3,
	},
	field: { margin: 0, flex: "1 1 220px", minWidth: 0 },
	hours: { flex: "0 1 160px" },
	name: { flexShrink: 0, maxWidth: "50%", fontWeight: 500 },
	meta: {
		minWidth: 0,
		color: colors.muted,
		fontSize: text.meta,
		lineHeight: text.metaLeading,
	},
	badges: { display: "flex", gap: space.s1, flexShrink: 0 },
});
