import {
	ArrowLeftIcon,
	ArrowSquareOutIcon,
	MagnifyingGlassIcon,
	PlugsConnectedIcon,
	PlusIcon,
	WarningCircleIcon,
	XIcon,
} from "@phosphor-icons/react";
import * as stylex from "@stylexjs/stylex";
import type { ConnectorClient } from "@toolstile/api/connector-client";
import {
	applyCatalogFields,
	type CatalogField,
	type ConnectorCatalogEntry,
	type ConnectorInventory,
	type ConnectorSearch,
	connectorCategories,
	matchCatalogEntry,
	searchConnectors,
} from "@toolstile/api/connectors";
import type {
	ConnectConnectorInput,
	ConnectionPreview,
	Snapshot,
} from "@toolstile/api/contract";
import {
	type FormEvent,
	type ReactNode,
	useEffect,
	useId,
	useRef,
	useState,
} from "react";
import { Checkbox } from "./Checkbox";
import { ConnectorLogo } from "./ConnectorLogo";
import { controls } from "./Control.styles";
import { layout } from "./Layout.styles";
import { ModalFrame } from "./ModalFrame";
import { EmptyState } from "./Primitives";
import { SelectField } from "./SelectField";
import {
	connectionNeedsSignIn,
	connectionUnreachable,
	statusLabel,
} from "./status";
import {
	colors,
	elevation,
	geometry,
	size,
	space,
	text,
} from "./tokens.stylex";

// Hosts start browser sign-in after a catalog add with the same helper as the URL dialog.
export { leaveForSignIn, refreshOnReturn } from "./provider-sign-in";

type Created = Awaited<ReturnType<ConnectorClient["connectConnector"]>>;
type CatalogEntry = ConnectorCatalogEntry;
export type ConnectorCatalogProps = {
	api: ConnectorClient;
	scopeKey: string;
	connections: Snapshot["connections"];
	search: ConnectorSearch;
	connectorId?: string;
	basePath: string;
	onSearch(search: ConnectorSearch): void;
	navigate(path: string): void;
	renderLink(props: {
		to: string;
		children: ReactNode;
		className?: string;
		"aria-current"?: "page";
	}): ReactNode;
	onCustom(): void;
	/**
	 * Runs after a connection is saved, with the form still open and busy; the host shows what
	 * comes next. `isCurrent` turns false once the form closes, the view changes or the catalog
	 * unmounts; check it after any wait and before leaving the page. Resolve true when the
	 * browser is leaving for the provider's sign-in, so the form stays busy until it does.
	 */
	onCreated(
		result: Created,
		isCurrent: () => boolean,
	): Promise<boolean | undefined>;
	connect(input: ConnectConnectorInput, fields: FormData): Promise<Created>;
	/** Optional extras for the connection form, such as a workspace's attachment target. */
	renderConnectionForm(
		props: Omit<ConnectorConnectionFormProps, "children">,
	): ReactNode;
};
const errorMessage = (error: unknown) =>
	error instanceof Error
		? error.message
		: "Unable to complete this request. Try again.";
const authLabel = {
	oauth: "Browser sign-in",
	bearer: "API key or access token",
	none: "No sign-in",
};

export function ConnectorCatalog(props: ConnectorCatalogProps) {
	const { api, scopeKey } = props;
	const [state, setState] = useState<{
		key?: string;
		entries?: CatalogEntry[];
		error?: string;
	}>({});
	const [retry, setRetry] = useState(0);
	const [selection, setSelected] = useState<{
		entry: CatalogEntry;
		viewKey: string;
		/** The catalog load the form opened in; another one means the scope changed. */
		generation: number;
		requestId: string;
		/** The connection exists; the form only resumes what comes next. */
		saved?: boolean;
	} | null>(null);
	// Saved connections by form request: a retry after the provider page continues, not re-adds.
	const saved = useRef(new Map<string, Created>());
	const viewKey = JSON.stringify([scopeKey, props.connectorId]);
	const activeView = useRef(viewKey);
	activeView.current = viewKey;
	const selected = selection?.viewKey === viewKey ? selection : null;
	const openForm = useRef(selected?.requestId);
	openForm.current = selected?.requestId;
	const mounted = useRef(true);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);
	const fetchKey = JSON.stringify([scopeKey, retry]);
	const requestGeneration = useRef(0);
	const searchInput = useRef<HTMLInputElement>(null);
	// "/" jumps to search, as in most catalogs, unless the person is already typing.
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			const target = event.target;
			if (
				event.key !== "/" ||
				event.metaKey ||
				event.ctrlKey ||
				event.altKey ||
				(target instanceof Element &&
					target.closest(
						"input, textarea, select, [contenteditable=true], [role=dialog]",
					))
			)
				return;
			if (!searchInput.current) return;
			event.preventDefault();
			searchInput.current.focus();
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, []);
	useEffect(() => {
		const generation = ++requestGeneration.current;
		setState({ key: fetchKey });
		setSelected(null);
		const controller = new AbortController();
		api
			.connectorCatalog(undefined, { signal: controller.signal })
			.then((entries) => {
				if (
					requestGeneration.current === generation &&
					!controller.signal.aborted
				)
					setState({ key: fetchKey, entries });
			})
			.catch((error) => {
				if (
					requestGeneration.current === generation &&
					!controller.signal.aborted
				)
					setState({ key: fetchKey, error: errorMessage(error) });
			});
		return () => {
			controller.abort();
			// oxlint-disable-next-line react-hooks/exhaustive-deps -- requestGeneration is a request counter, not a DOM ref; bumping it in cleanup invalidates in-flight loads.
			++requestGeneration.current;
		};
	}, [api, fetchKey]);
	if (state.key === fetchKey && state.error)
		return (
			<div role="alert">
				<EmptyState
					icon={WarningCircleIcon}
					title="Catalog unavailable"
					action={
						<button
							type="button"
							{...stylex.props(controls.button)}
							onClick={() => setRetry((value) => value + 1)}
						>
							Try again
						</button>
					}
				>
					{state.error}
				</EmptyState>
			</div>
		);
	if (state.key !== fetchKey || !state.entries)
		return (
			<p role="status" {...stylex.props(s.muted)}>
				Loading MCP servers…
			</p>
		);
	const entries = state.entries;
	const detail = props.connectorId
		? entries.find((entry) => entry.slug === props.connectorId)
		: undefined;
	// Display only: a connection belongs to the entry its URL display-matches.
	const matching = (entry: CatalogEntry) =>
		props.connections.filter(
			(connection) => matchCatalogEntry(entries, connection.url) === entry,
		);
	const connectionCount = (entry: CatalogEntry) => matching(entry).length;
	const open = (entry: CatalogEntry) => {
		setSelected({
			entry,
			viewKey,
			generation: requestGeneration.current,
			requestId: crypto.randomUUID(),
		});
	};
	const matches = searchConnectors(entries, props.search);
	const filtered = Boolean(
		props.search.query || props.search.category || props.search.auth,
	);
	const clearFilters = () => props.onSearch({});
	const categoryCounts: Record<string, number> = Object.fromEntries(
		Object.keys(connectorCategories).map((key) => [
			key,
			searchConnectors(entries, {
				...props.search,
				category: key as ConnectorSearch["category"],
			}).length,
		]),
	);
	// The name link stretches over the tile, so the whole tile opens the details.
	const renderTile = (entry: CatalogEntry) => {
		const saved = matching(entry);
		const count = saved.length;
		// Saved but not signed in yet is not connected; the label matches the connections list.
		const pending = saved.filter(connectionNeedsSignIn).length;
		const method = entry.authMethods[0];
		return (
			<article
				key={entry.slug}
				{...stylex.props(stylex.defaultMarker(), s.card)}
			>
				<div {...stylex.props(s.cardHeader)}>
					<ConnectorLogo logoUrl={entry.logoUrl} size={32} />
					<div {...stylex.props(s.identityText, s.cardIdentity)}>
						<h3 {...stylex.props(s.cardTitle)}>
							{props.renderLink({
								to: `${props.basePath}/catalog/${entry.slug}`,
								...stylex.props(s.nameLink),
								children: entry.name,
							})}
						</h3>
						<p {...stylex.props(s.publisher)}>
							{/* Browser sign-in is the norm, so only other methods are named. */}
							<span {...stylex.props(s.publisherText)}>
								{[
									entry.categories[0] &&
										connectorCategories[entry.categories[0]],
									count === 0 && method !== "oauth" && authLabel[method],
								]
									.filter(Boolean)
									.join(" · ")}
							</span>
						</p>
					</div>
					{count > 0 ? (
						// A saved server shows its status in the action slot; adding another
						// account appears beside it on hover or keyboard focus.
						<div {...stylex.props(s.cardStatus)}>
							<button
								type="button"
								aria-label={`Add another account to ${entry.name}`}
								title={`Add another ${entry.name} account`}
								{...stylex.props(
									controls.button,
									controls.small,
									controls.quiet,
									controls.iconOnly,
									s.cardAction,
									s.cardAddAnother,
								)}
								onClick={() => open(entry)}
							>
								<PlusIcon size={16} aria-hidden="true" />
							</button>
							<span
								{...stylex.props(
									s.connected,
									pending === count && s.needsSignIn,
								)}
							>
								<span
									aria-hidden="true"
									{...stylex.props(
										s.connectedDot,
										pending === count && s.needsSignInDot,
									)}
								/>
								{count === 1
									? pending
										? statusLabel("authentication required")
										: "Connected"
									: pending
										? `${count} connected, ${pending} ${pending === 1 ? "needs" : "need"} sign-in`
										: `${count} connected`}
							</span>
						</div>
					) : (
						<button
							type="button"
							aria-label={`Connect ${entry.name}`}
							{...stylex.props(
								controls.button,
								controls.small,
								s.cardAction,
								s.cardConnect,
							)}
							onClick={() => open(entry)}
						>
							Connect
						</button>
					)}
				</div>
				<p title={entry.description} {...stylex.props(s.cardDescription)}>
					{entry.description}
				</p>
			</article>
		);
	};
	return (
		<section aria-label="Connector catalog" {...stylex.props(s.stack)}>
			{props.connectorId ? (
				detail ? (
					<article {...stylex.props(s.detail)}>
						{props.renderLink({
							to: `${props.basePath}/catalog`,
							...stylex.props(s.back),
							children: (
								<>
									<ArrowLeftIcon size={16} aria-hidden="true" /> All MCP servers
								</>
							),
						})}
						<header {...stylex.props(s.identity)}>
							<ConnectorLogo logoUrl={detail.logoUrl} eager />
							<div {...stylex.props(s.identityText)}>
								<h2 {...stylex.props(layout.pageTitle)}>{detail.name}</h2>
								<p {...stylex.props(s.publisher)}>
									Published by {detail.publisher}
								</p>
							</div>
						</header>
						<p {...stylex.props(s.description)}>{detail.description}</p>
						<div {...stylex.props(s.tags)}>
							{detail.categories.map((key) => (
								<span key={key} {...stylex.props(s.tag)}>
									{connectorCategories[key]}
								</span>
							))}
						</div>
						<div {...stylex.props(s.detailsGrid)}>
							<section {...stylex.props(s.detailSection)}>
								<h3 {...stylex.props(s.smallTitle)}>What you can use it for</h3>
								<ul {...stylex.props(s.list)}>
									{detail.capabilities.map((text) => (
										<li key={text}>{text}</li>
									))}
								</ul>
							</section>
							<section {...stylex.props(s.detailSection)}>
								<h3 {...stylex.props(s.smallTitle)}>Before you connect</h3>
								<p {...stylex.props(s.paragraph)}>{detail.requirements}</p>
								{detail.setupNotice && (
									<p {...stylex.props(s.muted)}>{detail.setupNotice}</p>
								)}
								<p {...stylex.props(s.muted)}>
									Sign-in:{" "}
									{detail.authMethods
										.map((method) => authLabel[method])
										.join(" or ")}
								</p>
							</section>
						</div>
						<ConnectorInventoryDetails
							key={detail.slug}
							api={api}
							connectorId={detail.slug}
						/>
						<div {...stylex.props(s.detailActions)}>
							<button
								type="button"
								{...stylex.props(controls.button, controls.primary)}
								onClick={() => open(detail)}
							>
								<PlusIcon aria-hidden="true" />
								{connectionCount(detail)
									? "Add another account"
									: `Connect ${detail.name}`}
							</button>
							<a
								href={detail.documentation}
								target="_blank"
								rel="noreferrer"
								{...stylex.props(s.link)}
							>
								Provider documentation{" "}
								<ArrowSquareOutIcon size={16} aria-hidden="true" />
							</a>
						</div>
					</article>
				) : (
					<EmptyState
						icon={PlugsConnectedIcon}
						title="Connector unavailable"
						action={
							<button
								type="button"
								{...stylex.props(controls.button)}
								onClick={() => props.navigate(`${props.basePath}/catalog`)}
							>
								Browse catalog
							</button>
						}
					>
						It may have been removed from the catalog. Your existing connections
						remain in Connected.
					</EmptyState>
				)
			) : (
				<>
					{/* Search and categories stay in reach while the long grid scrolls. */}
					<div {...stylex.props(s.toolbar)}>
						<div {...stylex.props(s.filters)}>
							<div {...stylex.props(s.search)}>
								<label {...stylex.props(s.searchLabel)}>
									<span {...stylex.props(layout.visuallyHidden)}>
										Search connectors
									</span>
									<MagnifyingGlassIcon
										aria-hidden="true"
										size={16}
										{...stylex.props(s.searchIcon)}
									/>
									<input
										ref={searchInput}
										type="search"
										value={props.search.query ?? ""}
										placeholder="Search MCP servers or tasks, like issue tracking"
										aria-keyshortcuts="/"
										{...stylex.props(controls.input, s.searchInput)}
										onChange={(event) =>
											props.onSearch({
												...props.search,
												query: event.target.value || undefined,
											})
										}
										onKeyDown={(event) => {
											if (event.key === "Escape" && props.search.query) {
												event.preventDefault();
												props.onSearch({ ...props.search, query: undefined });
											}
										}}
									/>
								</label>
								{props.search.query ? (
									<button
										type="button"
										aria-label="Clear search"
										{...stylex.props(
											controls.button,
											controls.small,
											controls.quiet,
											controls.iconOnly,
											s.clearSearch,
										)}
										onClick={() => {
											props.onSearch({ ...props.search, query: undefined });
											searchInput.current?.focus();
										}}
									>
										<XIcon size={14} aria-hidden="true" />
									</button>
								) : (
									<span aria-hidden="true" {...stylex.props(s.shortcut)}>
										/
									</span>
								)}
							</div>
							<div {...stylex.props(s.method)}>
								<SelectField
									aria-label="Sign-in method"
									value={props.search.auth ?? ""}
									onValueChange={(value) =>
										props.onSearch({
											...props.search,
											auth: (value || undefined) as ConnectorSearch["auth"],
										})
									}
									items={[
										{ value: "", label: "Any sign-in" },
										...Object.entries(authLabel).map(([value, label]) => ({
											value,
											label,
										})),
									]}
								/>
							</div>
							<button
								type="button"
								{...stylex.props(controls.button, s.custom)}
								onClick={props.onCustom}
							>
								<PlugsConnectedIcon aria-hidden="true" /> Custom URL
							</button>
						</div>
						<div {...stylex.props(s.categoryRow)}>
							<fieldset
								aria-label="Connector categories"
								{...stylex.props(controls.fieldset, s.categories)}
							>
								{[
									{ key: "", label: "All" },
									...Object.entries(connectorCategories).map(
										([key, label]) => ({ key, label }),
									),
								].map(({ key, label }) => (
									<button
										type="button"
										key={key}
										aria-pressed={(props.search.category ?? "") === key}
										{...stylex.props(
											s.category,
											key !== "" && !categoryCounts[key] && s.emptyCategory,
											(props.search.category ?? "") === key &&
												s.selectedCategory,
										)}
										onClick={() =>
											props.onSearch({
												...props.search,
												category: (key ||
													undefined) as ConnectorSearch["category"],
											})
										}
									>
										{label}
										{key && (
											<span
												{...stylex.props(
													s.categoryCount,
													(props.search.category ?? "") === key &&
														s.categoryCountSelected,
												)}
											>
												{categoryCounts[key]}
											</span>
										)}
									</button>
								))}
							</fieldset>
						</div>
					</div>
					{filtered && matches.length > 0 && (
						<p aria-live="polite" {...stylex.props(s.count)}>
							{matches.length}{" "}
							{matches.length === 1 ? "MCP server" : "MCP servers"}
							<button
								type="button"
								{...stylex.props(s.textButton)}
								onClick={clearFilters}
							>
								Clear filters
							</button>
						</p>
					)}
					{matches.length ? (
						(filtered
							? [{ title: "", items: matches }]
							: [
									{
										title: "Featured",
										items: matches.filter((entry) => entry.featured),
									},
									{
										title: "All MCP servers",
										items: matches.filter((entry) => !entry.featured),
									},
								]
						)
							.filter((group) => group.items.length)
							.map((group) => (
								<section
									key={group.title}
									aria-label={group.title || "Results"}
									{...stylex.props(s.group)}
								>
									{group.title && (
										<h2 {...stylex.props(s.groupTitle)}>
											{group.title}
											<span {...stylex.props(s.groupCount)}>
												{group.items.length}
											</span>
										</h2>
									)}
									<div {...stylex.props(s.grid)}>
										{group.items.map((entry) => renderTile(entry))}
									</div>
								</section>
							))
					) : (
						<EmptyState
							icon={MagnifyingGlassIcon}
							title={
								props.search.query
									? `No MCP servers match “${props.search.query.trim()}”`
									: "No matching MCP servers"
							}
							action={
								<div {...stylex.props(s.emptyActions)}>
									<button
										type="button"
										{...stylex.props(controls.button)}
										onClick={clearFilters}
									>
										Clear filters
									</button>
									<button
										type="button"
										{...stylex.props(controls.button)}
										onClick={props.onCustom}
									>
										Add custom URL
									</button>
								</div>
							}
						>
							Try another server name or task. If the server is not listed, add
							it by its URL.
						</EmptyState>
					)}
				</>
			)}
			{selected &&
				props.renderConnectionForm({
					definition: selected.entry,
					requestId: selected.requestId,
					saved: !!selected.saved,
					preview: (url) => api.previewConnection({ url }),
					onClose: () => setSelected(null),
					onSubmit: async (input, fields) => {
						// The form, scope and page it opened in; any change since then cancels what follows.
						const current = () =>
							mounted.current &&
							openForm.current === selected.requestId &&
							selected.generation === requestGeneration.current &&
							selected.viewKey === activeView.current;
						if (!current()) return;
						const { requestId } = selected;
						let result = saved.current.get(requestId);
						if (!result) {
							result = await props.connect(input, fields);
							saved.current.set(requestId, result);
							// From here the form only resumes; changing the connection happens on the list.
							setSelected((now) =>
								now?.requestId === requestId ? { ...now, saved: true } : now,
							);
						}
						if (!current()) return;
						// Browser sign-in starts from here; the form stays busy until the page leaves.
						if (await props.onCreated(result, current)) return true;
						if (!current()) return;
						setSelected(null);
					},
				})}
		</section>
	);
}

const inventorySource: Record<ConnectorInventory["source"], string> = {
	discovery: "automatic discovery",
	refresh: "an administrator's refresh",
	docs: "provider documentation",
};
const plural = (count: number, word: string) =>
	`${count} ${count === 1 ? word : `${word}s`}`;
/** Last observed listing for the details page; a live connection still loads its own. */
function ConnectorInventoryDetails({
	api,
	connectorId,
}: {
	api: ConnectorClient;
	connectorId: string;
}) {
	const [state, setState] = useState<{
		inventory?: ConnectorInventory | null;
		error?: boolean;
	}>({});
	useEffect(() => {
		const controller = new AbortController();
		api
			.connectorInventory({ connectorId }, { signal: controller.signal })
			.then((inventory) => {
				if (!controller.signal.aborted) setState({ inventory });
			})
			.catch(() => {
				if (!controller.signal.aborted) setState({ error: true });
			});
		return () => controller.abort();
	}, [api, connectorId]);
	const after =
		"The available tools, resources and prompts are refreshed from the server after you connect.";
	if (state.error || state.inventory === null)
		return <p {...stylex.props(s.muted)}>{after}</p>;
	const inventory = state.inventory;
	if (!inventory)
		return (
			<p role="status" {...stylex.props(s.muted)}>
				Loading tools…
			</p>
		);
	const observed = new Date(inventory.observedAt).toLocaleDateString(
		undefined,
		{ year: "numeric", month: "short", day: "numeric" },
	);
	const groups = [
		{
			title: "Tools",
			items: inventory.tools.map((tool) => ({
				key: tool.name,
				name: tool.title ?? tool.name,
				code: tool.title ? tool.name : undefined,
				description: tool.description,
				tags: [
					tool.annotations?.readOnlyHint && "Read-only",
					tool.annotations?.destructiveHint && "Destructive",
				].filter((tag): tag is string => !!tag),
			})),
		},
		{
			title: "Resources",
			items: inventory.resources.map((resource) => ({
				key: resource.uri ?? resource.uriTemplate ?? resource.name,
				name: resource.name,
				code: resource.uri ?? resource.uriTemplate,
				description: resource.description,
				tags: resource.uriTemplate ? ["Template"] : [],
			})),
		},
		{
			title: "Prompts",
			items: inventory.prompts.map((prompt) => ({
				key: prompt.name,
				name: prompt.name,
				code: undefined,
				description: prompt.description,
				tags: [],
			})),
		},
	].filter((group) => group.items.length);
	return (
		<section
			aria-label="Tools, resources and prompts"
			{...stylex.props(s.inventory)}
		>
			<p {...stylex.props(s.muted)}>
				{[
					plural(inventory.tools.length, "tool"),
					plural(inventory.resources.length, "resource"),
					plural(inventory.prompts.length, "prompt"),
				].join(" · ")}
				. Last observed {observed} by {inventorySource[inventory.source]}; a
				connection loads the current list from the server.
			</p>
			{groups.map((group) => (
				<section key={group.title} {...stylex.props(s.detailSection)}>
					<h3 {...stylex.props(s.smallTitle)}>
						{group.title}
						<span {...stylex.props(s.categoryCount)}>{group.items.length}</span>
					</h3>
					<ul {...stylex.props(s.inventoryList)}>
						{group.items.map((item) => (
							<li key={item.key} {...stylex.props(s.inventoryItem)}>
								<div {...stylex.props(s.inventoryName)}>
									<span {...stylex.props(s.inventoryTitle)}>{item.name}</span>
									{item.code && item.code !== item.name && (
										<code {...stylex.props(s.inventoryCode)}>{item.code}</code>
									)}
									{item.tags.map((tag) => (
										<span key={tag} {...stylex.props(s.tag)}>
											{tag}
										</span>
									))}
								</div>
								{item.description && (
									<p {...stylex.props(s.inventoryDescription)}>
										{item.description}
									</p>
								)}
							</li>
						))}
					</ul>
				</section>
			))}
		</section>
	);
}

export type ConnectorConnectionFormProps = {
	definition: CatalogEntry;
	/** One per form: every retry sends it again, so a save whose answer was lost replays. */
	requestId: string;
	/**
	 * The connection from this form exists (its sign-in may not). The form is locked and only
	 * continues to what comes next, or closes; changes happen on the connections list.
	 */
	saved?: boolean;
	/** Discovery for the catalog address; saves nothing. */
	preview(url: string): Promise<ConnectionPreview>;
	onClose(): void;
	/** Saves the connection; resolves true when the browser is leaving for the provider. */
	onSubmit(
		input: ConnectConnectorInput,
		fields: FormData,
	): Promise<boolean | undefined>;
	/**
	 * Host extras shown above the settings, such as a workspace's attachment target. A function
	 * receives the address the settings build (null while a setting is invalid) and whether the
	 * form is locked: submitting, or already saved. Locked extras must not change.
	 */
	children?:
		| ReactNode
		| ((address: string | null, locked: boolean) => ReactNode);
};
type AuthMethod = keyof typeof authLabel;
/**
 * The sign-in choices an entry offers, its first method first. An entry whose first method is no
 * sign-in and that also accepts a key offers one choice with an optional key field.
 */
function signInChoices(methods: readonly AuthMethod[]) {
	return methods[0] === "none"
		? methods.filter((method) => method !== "bearer")
		: [...methods];
}
const switchLabel: Record<AuthMethod, string> = {
	oauth: "Use browser sign-in instead",
	bearer: "Use an API key instead",
	none: "Connect without sign-in instead",
};
function buildAddress(
	definition: CatalogEntry,
	values: Record<string, string>,
) {
	try {
		return applyCatalogFields(definition.endpoint, definition.fields, values);
	} catch {
		return null;
	}
}
type Attempt = {
	url: string;
	method: AuthMethod;
	transport: ConnectConnectorInput["transport"];
};
/**
 * Connecting a catalog entry: the person's settings are applied to the catalog address, and one
 * submit checks that address and saves exactly it. The address and sign-in methods come only
 * from the catalog; any other address or method is added through Custom URL.
 */
export function ConnectorConnectionForm({
	definition,
	requestId,
	saved = false,
	preview,
	onClose,
	onSubmit,
	children,
}: ConnectorConnectionFormProps) {
	const choices = signInChoices(definition.authMethods);
	const [method, setMethod] = useState<AuthMethod>(choices[0]);
	// Where the entry works without sign-in first, a key it accepts is optional.
	const keyField =
		method === "bearer"
			? "required"
			: method === "none" &&
					definition.authMethods[0] === "none" &&
					definition.authMethods.includes("bearer")
				? "optional"
				: null;
	const [values, setValues] = useState<Record<string, string>>({});
	const address = buildAddress(definition, values);
	const [phase, setPhase] = useState<"checking" | "saving" | "leaving" | null>(
			null,
		),
		[error, setError] = useState("");
	const busyRef = useRef(false);
	// A save was sent for this address and method; a retry repeats it without checking again.
	const attempted = useRef<Attempt | null>(null);
	const mounted = useRef(true);
	useEffect(() => {
		mounted.current = true;
		// Back from the provider restores this page from the cache; the form is usable again.
		const onShow = (event: PageTransitionEvent) => {
			if (event.persisted) setPhase((now) => (now === "leaving" ? null : now));
		};
		window.addEventListener("pageshow", onShow);
		return () => {
			mounted.current = false;
			window.removeEventListener("pageshow", onShow);
		};
	}, []);
	const busy = phase !== null;
	// Submitting, or saved: the inputs that made the connection no longer change.
	const locked = busy || saved;
	function setField(name: string, value: string) {
		setValues({ ...values, [name]: value });
		setError("");
	}
	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (busyRef.current) return;
		const form = event.currentTarget,
			data = new FormData(form);
		let url: string;
		try {
			url = applyCatalogFields(definition.endpoint, definition.fields, values);
		} catch (problem) {
			setError(errorMessage(problem));
			return;
		}
		const apiKey = keyField ? String(data.get("apiKey") ?? "").trim() : "";
		busyRef.current = true;
		setError("");
		let leaving = false;
		try {
			const previous = attempted.current;
			let transport: ConnectConnectorInput["transport"];
			if (
				previous &&
				(saved || (previous.url === url && previous.method === method))
			)
				transport = previous.transport;
			else {
				setPhase("checking");
				// Without the key a server may refuse or hide; with one, the save's own check decides.
				const found = await preview(url).catch((problem) => {
					if (apiKey) return null;
					throw problem;
				});
				if (!mounted.current) return;
				if (found && found.url !== url) {
					setError(
						`${definition.name}'s catalog address did not respond as an MCP server. To use another address, add it with Custom URL.`,
					);
					return;
				}
				if (found && connectionUnreachable(found.status) && !apiKey) {
					setError(
						`Toolstile could not reach ${definition.name}'s MCP server. Check the values you entered and try again. Nothing was saved.`,
					);
					return;
				}
				transport =
					found && !connectionUnreachable(found.status)
						? found.transport
						: undefined;
			}
			attempted.current = { url, method, transport };
			setPhase("saving");
			leaving = !!(await onSubmit(
				{
					requestId,
					url,
					authentication: method === "oauth" ? "oauth" : "headers",
					...(transport ? { transport } : {}),
					headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
					label: definition.name,
					suggestionId: definition.slug,
				},
				data,
			));
		} catch (error) {
			if (mounted.current) setError(errorMessage(error));
		} finally {
			busyRef.current = false;
			if (mounted.current) setPhase(leaving ? "leaving" : null);
		}
	}
	const description =
		method === "oauth"
			? "Toolstile checks the server, then opens the provider so you can sign in."
			: "Toolstile checks the server and adds the connection.";
	return (
		<ModalFrame
			title={`Connect ${definition.name}`}
			description={description}
			onClose={() => {
				if (!busyRef.current) onClose();
			}}
		>
			<form onSubmit={submit} {...stylex.props(s.stack)}>
				<div {...stylex.props(s.identity)}>
					<ConnectorLogo logoUrl={definition.logoUrl} eager />
					<p {...stylex.props(s.muted)}>{definition.requirements}</p>
				</div>
				{typeof children === "function" ? children(address, locked) : children}
				<ConnectorConfigurationFields
					fields={definition.fields}
					values={values}
					disabled={locked}
					onChange={setField}
				/>
				<div {...stylex.props(s.signIn)}>
					<p {...stylex.props(s.muted)}>
						Sign-in: {authLabel[method]}
						{keyField === "optional" && " or API key"}
					</p>
					{!saved &&
						choices
							.filter((choice) => choice !== method)
							.map((choice) => (
								<button
									key={choice}
									type="button"
									disabled={busy}
									{...stylex.props(s.textButton, s.switchMethod)}
									onClick={() => {
										setMethod(choice);
										setError("");
									}}
								>
									{switchLabel[choice]}
								</button>
							))}
				</div>
				{keyField && !saved && (
					<label {...stylex.props(controls.label)}>
						{keyField === "optional"
							? "API key (optional)"
							: "API key or access token"}
						<input
							{...stylex.props(controls.input)}
							name="apiKey"
							type="password"
							required={keyField === "required"}
							readOnly={busy}
							maxLength={4096}
							autoComplete="off"
							data-ph-no-capture
						/>
						{keyField === "optional" && (
							<span {...stylex.props(s.muted)}>
								Leave empty to connect without one.
							</span>
						)}
					</label>
				)}
				<p {...stylex.props(s.muted)}>
					Server address{" "}
					<code {...stylex.props(s.address)}>
						{address ?? definition.endpoint}
					</code>
				</p>
				{definition.setupNotice && (
					<p {...stylex.props(s.muted)}>{definition.setupNotice}</p>
				)}
				{saved && (
					<p role="status" {...stylex.props(s.paragraph)}>
						{method === "oauth"
							? `${definition.name} is saved and needs sign-in. Continue to sign in, or close and sign in later from MCP connections.`
							: `${definition.name} is saved. Change its settings or key from MCP connections.`}
					</p>
				)}
				{error && (
					<p role="alert" {...stylex.props(controls.error)}>
						{error}
					</p>
				)}
				<p {...stylex.props(s.muted)}>This does not grant agent access.</p>
				<div {...stylex.props(s.actions)}>
					<button
						type="button"
						disabled={busy && phase !== "leaving"}
						{...stylex.props(controls.button)}
						onClick={onClose}
					>
						{saved ? "Close" : "Cancel"}
					</button>
					<button
						type="submit"
						disabled={busy}
						{...stylex.props(controls.button, controls.primary)}
					>
						{phase === "checking"
							? "Checking…"
							: phase === "saving" || phase === "leaving"
								? method === "oauth"
									? "Opening provider…"
									: "Adding…"
								: method === "oauth"
									? "Continue to sign in"
									: saved
										? "Finish"
										: "Add connection"}
					</button>
				</div>
			</form>
		</ModalFrame>
	);
}

const mobile = "@media (max-width: 650px)";
// Matches Layout.styles: the page bar stops pinning at this width.
const pageBarFlow = "@media (max-width: 760px)";
const s = stylex.create({
	stack: {
		display: "flex",
		flexDirection: "column",
		gap: space.s4,
		minWidth: 0,
	},
	identity: {
		display: "flex",
		alignItems: "center",
		gap: space.s3,
		minWidth: 0,
	},
	identityText: {
		display: "flex",
		flexDirection: "column",
		minWidth: 0,
	},
	grid: {
		display: "grid",
		gridTemplateColumns: {
			default: "repeat(3,minmax(0,1fr))",
			"@media (max-width: 1150px)": "repeat(2,minmax(0,1fr))",
			[mobile]: "minmax(0,1fr)",
		},
		// One elevated container frames the tiles; hairlines between them come from each tile's
		// right and bottom edge, and the container clips the ones on its outer edges.
		backgroundColor: colors.surface,
		borderRadius: geometry.corner,
		boxShadow: elevation.low,
		overflow: "hidden",
	},
	// A flat selectable tile: no frame, a soft fill on hover.
	card: {
		position: "relative",
		display: "flex",
		flexDirection: "column",
		alignItems: "stretch",
		gap: 6,
		paddingBlock: 14,
		paddingInline: space.s4,
		minWidth: 0,
		boxShadow: `1px 0 0 ${colors.line}, 0 1px 0 ${colors.line}`,
		backgroundColor: {
			default: "transparent",
			":hover": colors.hoverOverlay,
			":focus-within": colors.hoverOverlay,
		},
		transitionProperty: "background-color",
		transitionDuration: "150ms",
	},
	cardHeader: {
		display: "flex",
		alignItems: "center",
		gap: space.s3,
		minWidth: 0,
	},
	cardIdentity: { flexGrow: 1 },
	// Above the stretched name link so the button keeps its own click. One edge for both states.
	cardAction: {
		position: "relative",
		zIndex: 1,
		alignSelf: "flex-start",
		flexShrink: 0,
		paddingInline: 12,
	},
	// A quiet ghost button: neutral at rest so 26 of them don't shout; cobalt with an edge
	// while its tile is hovered or focused.
	cardConnect: {
		color: {
			default: colors.muted,
			[stylex.when.ancestor(":hover")]: colors.action,
			[stylex.when.ancestor(":focus-within")]: colors.action,
			":hover": colors.action,
			":focus-visible": colors.action,
		},
		backgroundColor: {
			default: "transparent",
			":hover": colors.controlFillHover,
			":focus-visible": colors.controlFillHover,
		},
		backgroundImage: "none",
		boxShadow: "none",
		borderColor: {
			default: "transparent",
			[stylex.when.ancestor(":hover")]: colors.controlBorder,
			[stylex.when.ancestor(":focus-within")]: colors.controlBorder,
			":hover": colors.controlBorderHover,
			":focus-visible": colors.controlBorderHover,
		},
		fontSize: 13,
		fontWeight: 500,
	},
	// Status and the hover-only "add another" share the Connect slot.
	cardStatus: {
		display: "flex",
		alignItems: "center",
		gap: space.s1,
		flexShrink: 0,
		alignSelf: "flex-start",
		minHeight: 28,
		// Lines the label's end up with the Connect label (the button's 12px inset).
		paddingInlineEnd: 12,
	},
	cardAddAnother: {
		paddingInline: 0,
		color: {
			default: colors.muted,
			":hover": colors.text,
			":focus-visible": colors.text,
		},
		opacity: {
			default: 0,
			[stylex.when.ancestor(":hover")]: 1,
			[stylex.when.ancestor(":focus-within")]: 1,
			"@media (pointer: coarse)": 1,
		},
		transitionProperty: "opacity",
		transitionDuration: "120ms",
	},
	publisherText: { minWidth: 0 },
	// Matches StatusBadge: a semantic dot beside plain 13px text.
	connected: {
		display: "inline-flex",
		alignItems: "center",
		gap: 6,
		color: colors.text,
		fontSize: 13,
		lineHeight: "20px",
		fontWeight: 400,
		whiteSpace: "nowrap",
	},
	connectedDot: {
		width: 6,
		height: 6,
		borderRadius: 999,
		backgroundColor: colors.good,
	},
	needsSignIn: { color: colors.text },
	needsSignInDot: { backgroundColor: colors.action },
	cardTitle: {
		margin: 0,
		fontSize: text.sectionTitle,
		lineHeight: text.sectionTitleLeading,
		fontWeight: 500,
		overflowWrap: "anywhere",
	},
	// The visible link stays one text line; on touch screens a taller hit area reaches 44px.
	nameLink: {
		color: colors.text,
		textDecoration: "none",
		outline: "none",
		"::before": {
			content: '""',
			position: "absolute",
			inset: 0,
			borderRadius: geometry.corner,
		},
	},
	publisher: {
		display: "flex",
		flexWrap: "wrap",
		alignItems: "center",
		columnGap: 6,
		margin: 0,
		color: colors.muted,
		fontSize: text.meta,
		lineHeight: text.metaLeading,
		overflowWrap: "anywhere",
	},
	cardDescription: {
		margin: 0,
		color: colors.muted,
		fontSize: 13,
		lineHeight: "20px",
		// Exactly two lines tall (clamped, full text in the title), so every tile in the grid has
		// the same height whether its description wraps or not.
		minHeight: 40,
		display: "-webkit-box",
		WebkitBoxOrient: "vertical",
		WebkitLineClamp: 2,
		overflow: "hidden",
	},
	// Pinned under the page bar, whose measured height PageHeader publishes; the bar scrolls
	// away on phones.
	toolbar: {
		position: "sticky",
		top: { default: "var(--page-header-height, 86px)", [pageBarFlow]: 0 },
		zIndex: 4,
		// Phones regroup into search, then sign-in beside Custom URL, then the chips.
		display: { default: "flex", [mobile]: "grid" },
		gridTemplateColumns: "minmax(0, 1fr) auto",
		gridTemplateAreas: '"search search" "method custom" "chips chips"',
		flexDirection: "column",
		gap: space.s3,
		marginBlock: `calc(-1 * ${space.s3})`,
		paddingBlock: space.s3,
		// Reaches past the tile container's 1px ring so scrolled tiles never peek beside it.
		marginInline: -4,
		paddingInline: 4,
		backgroundColor: colors.page,
	},
	categoryRow: {
		display: { default: "flex", [mobile]: "contents" },
		alignItems: "center",
		gap: space.s2,
		minWidth: 0,
	},
	clearSearch: {
		position: "absolute",
		insetInlineEnd: space.s1,
		color: colors.muted,
	},
	shortcut: {
		position: "absolute",
		insetInlineEnd: space.s2,
		minWidth: 18,
		paddingInline: space.s1,
		borderRadius: geometry.cornerSmall,
		backgroundColor: colors.insetTint,
		color: colors.muted,
		fontFamily: geometry.fontSans,
		fontSize: text.meta,
		lineHeight: "18px",
		textAlign: "center",
		pointerEvents: "none",
		display: {
			default: "block",
			"@media (pointer: coarse)": "none",
			[mobile]: "none",
		},
	},
	group: {
		display: "flex",
		flexDirection: "column",
		gap: space.s2,
		minWidth: 0,
	},
	// A real section heading over each group of tiles.
	groupTitle: {
		margin: 0,
		marginTop: space.s4,
		color: colors.muted,
		fontSize: text.meta,
		lineHeight: text.metaLeading,
		fontWeight: 500,
	},
	groupCount: {
		marginInlineStart: 6,
		color: colors.muted,
		fontSize: text.meta,
		fontWeight: 400,
		opacity: 0.75,
		fontVariantNumeric: "tabular-nums",
	},
	textButton: {
		marginInlineStart: space.s2,
		padding: 0,
		borderWidth: 0,
		backgroundColor: "transparent",
		color: colors.action,
		fontSize: "inherit",
		fontFamily: "inherit",
		lineHeight: "inherit",
		fontWeight: 500,
		cursor: "pointer",
		textDecoration: {
			default: "none",
			":hover": "underline",
			":focus-visible": "underline",
		},
	},
	filters: {
		display: { default: "flex", [mobile]: "contents" },
		flexWrap: "wrap",
		alignItems: "center",
		gap: space.s2,
	},
	search: {
		position: "relative",
		display: "flex",
		alignItems: "center",
		flex: "1 1 320px",
		gridArea: "search",
		minWidth: 0,
		color: colors.muted,
	},
	searchLabel: { display: "contents" },
	searchIcon: {
		position: "absolute",
		insetInlineStart: space.s3,
		pointerEvents: "none",
	},
	searchInput: {
		height: 32,
		minHeight: 32,
		paddingBlock: 5,
		width: "100%",
		minWidth: 0,
		paddingInlineStart: space.s8,
		paddingInlineEnd: space.s8,
		"::-webkit-search-cancel-button": { display: "none" },
	},
	method: {
		flex: "0 0 160px",
		gridArea: "method",
		minWidth: 0,
	},
	custom: { gridArea: "custom" },
	categories: {
		borderWidth: 0,
		margin: 0,
		gridArea: "chips",
		minWidth: 0,
		// On phones the chips scroll sideways; the fade shows there are more.
		maskImage: {
			default: "none",
			[mobile]: "linear-gradient(to right, #000 85%, transparent)",
		},
		// The same compact segmented control as the Approvals and Activity filters: left-aligned
		// and hugging its segments; phones scroll it sideways.
		display: "flex",
		flexWrap: "nowrap",
		flex: "0 1 auto",
		width: "fit-content",
		maxWidth: "100%",
		overflowX: "auto",
		scrollbarWidth: "none",
		gap: 2,
		padding: 2,
		borderRadius: geometry.corner,
		backgroundColor: colors.insetTint,
	},
	category: {
		display: "inline-flex",
		alignItems: "center",
		justifyContent: "center",
		gap: 6,
		flex: "0 0 auto",
		minHeight: { default: 28, "@media (pointer: coarse)": 44 },
		paddingInline: 10,
		borderWidth: 0,
		borderRadius: geometry.cornerSmall,
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
		fontFamily: geometry.fontSans,
		fontSize: text.body,
		lineHeight: text.bodyLeading,
		fontWeight: 400,
		whiteSpace: "nowrap",
		cursor: "pointer",
		outline: "none",
	},
	categoryCount: {
		color: colors.muted,
		fontSize: text.meta,
		lineHeight: text.metaLeading,
		fontWeight: 400,
		fontVariantNumeric: "tabular-nums",
		opacity: 0.8,
	},
	categoryCountSelected: { opacity: 1 },
	emptyCategory: { opacity: 0.5 },
	emptyActions: {
		display: "flex",
		flexWrap: "wrap",
		justifyContent: "center",
		gap: space.s2,
	},
	selectedCategory: {
		backgroundColor: {
			default: colors.surface,
			":hover": colors.surface,
			":focus-visible": colors.surface,
		},
		color: {
			default: colors.text,
			":hover": colors.text,
			":focus-visible": colors.text,
		},
		fontWeight: 500,
		boxShadow: elevation.low,
	},
	count: {
		margin: 0,
		color: colors.muted,
		fontSize: text.meta,
		lineHeight: text.metaLeading,
	},
	tags: { display: "flex", flexWrap: "wrap", gap: space.s1 },
	tag: {
		backgroundColor: colors.insetTint,
		color: colors.muted,
		fontSize: text.meta,
		lineHeight: text.metaLeading,
		paddingBlock: space.s0_5,
		paddingInline: 6,
		borderRadius: geometry.cornerSmall,
		whiteSpace: "nowrap",
	},
	// Plain page content under the page header; no frame of its own.
	detail: {
		display: "flex",
		flexDirection: "column",
		alignItems: "flex-start",
		gap: space.s4,
		minWidth: 0,
	},
	description: {
		margin: 0,
		maxWidth: "65ch",
		fontSize: text.prose,
		lineHeight: text.proseLeading,
	},
	detailsGrid: {
		display: "grid",
		alignSelf: "stretch",
		gridTemplateColumns: {
			default: "repeat(2,minmax(0,1fr))",
			[mobile]: "minmax(0,1fr)",
		},
		gap: space.s6,
		maxWidth: size.contentMax,
		fontSize: text.body,
		lineHeight: text.bodyLeading,
	},
	detailSection: {
		display: "flex",
		flexDirection: "column",
		gap: space.s2,
		minWidth: 0,
	},
	smallTitle: {
		margin: 0,
		fontSize: text.sectionTitle,
		lineHeight: text.sectionTitleLeading,
		fontWeight: 600,
	},
	list: { margin: 0, paddingInlineStart: space.s5 },
	inventory: {
		display: "flex",
		flexDirection: "column",
		gap: space.s4,
		alignSelf: "stretch",
		maxWidth: size.contentMax,
		fontSize: text.body,
		lineHeight: text.bodyLeading,
	},
	inventoryList: {
		listStyle: "none",
		margin: 0,
		padding: 0,
		display: "flex",
		flexDirection: "column",
	},
	inventoryItem: {
		display: "flex",
		flexDirection: "column",
		gap: space.s0_5,
		paddingBlock: space.s2,
		borderTopWidth: { default: 1, ":first-child": 0 },
		borderTopStyle: "solid",
		borderTopColor: colors.lineTint,
		minWidth: 0,
	},
	inventoryName: {
		display: "flex",
		flexWrap: "wrap",
		alignItems: "baseline",
		gap: space.s2,
		minWidth: 0,
	},
	inventoryTitle: { fontWeight: 500, overflowWrap: "anywhere" },
	inventoryCode: {
		fontFamily: geometry.fontMono,
		fontSize: text.meta,
		color: colors.muted,
		overflowWrap: "anywhere",
	},
	inventoryDescription: {
		margin: 0,
		color: colors.muted,
		overflowWrap: "anywhere",
		// Long upstream text stays readable without dominating the list.
		display: "-webkit-box",
		WebkitBoxOrient: "vertical",
		WebkitLineClamp: 3,
		overflow: "hidden",
	},
	paragraph: { margin: 0, overflowWrap: "anywhere" },
	detailActions: {
		display: "flex",
		alignItems: "center",
		flexWrap: "wrap",
		gap: space.s2,
	},
	muted: {
		fontWeight: 400,
		margin: 0,
		color: colors.muted,
		fontSize: text.body,
		lineHeight: text.bodyLeading,
		overflowWrap: "anywhere",
	},
	link: {
		display: "inline-flex",
		alignItems: "center",
		gap: space.s1,
		minHeight: size.control,
		color: colors.action,
		fontSize: text.body,
		fontWeight: 500,
		textDecoration: "none",
		":hover": { textDecoration: "underline" },
		":focus-visible": { textDecoration: "underline" },
	},
	back: {
		display: "inline-flex",
		alignItems: "center",
		gap: space.s2,
		minHeight: size.control,
		color: {
			default: colors.muted,
			":hover": colors.text,
			":focus-visible": colors.text,
		},
		fontSize: text.body,
		textDecoration: "none",
	},
	address: {
		fontFamily: geometry.fontMono,
		fontSize: text.meta,
		lineHeight: text.metaLeading,
		color: colors.text,
		overflowWrap: "anywhere",
	},
	signIn: {
		display: "flex",
		flexWrap: "wrap",
		alignItems: "baseline",
		columnGap: space.s3,
		rowGap: space.s1,
	},
	switchMethod: {
		marginInlineStart: 0,
		fontSize: text.body,
		lineHeight: text.bodyLeading,
	},
	actions: {
		display: "flex",
		justifyContent: "flex-end",
		gap: space.s2,
		flexWrap: "wrap",
	},
});

/** Catalog settings; each value becomes one query parameter of the address. */
function ConnectorConfigurationFields({
	fields,
	values,
	disabled,
	onChange,
}: {
	fields: readonly CatalogField[];
	values: Record<string, string>;
	disabled: boolean;
	onChange(name: string, value: string): void;
}) {
	const prefix = useId();
	return (
		<>
			{fields.map((field) => (
				<label
					key={field.name}
					htmlFor={`${prefix}-${field.name}`}
					{...stylex.props(controls.label)}
				>
					{field.label}
					{field.kind === "boolean" ? (
						<Checkbox
							id={`${prefix}-${field.name}`}
							checked={values[field.name] === "true"}
							disabled={disabled}
							onCheckedChange={(value) =>
								onChange(field.name, value ? "true" : "")
							}
						/>
					) : (
						<input
							id={`${prefix}-${field.name}`}
							value={values[field.name] ?? ""}
							onChange={(event) => onChange(field.name, event.target.value)}
							readOnly={disabled}
							required={field.required}
							maxLength={field.kind === "identifier" ? 128 : 200}
							autoComplete="off"
							autoCapitalize="off"
							spellCheck={false}
							{...stylex.props(controls.input)}
						/>
					)}
					<span {...stylex.props(s.muted)}>{field.help}</span>
				</label>
			))}
		</>
	);
}
