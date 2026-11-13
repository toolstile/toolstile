import { z } from "zod";

export const connectorCategories = {
	development: "Development",
	productivity: "Productivity",
	communication: "Communication",
	sales: "Sales & support",
	research: "Marketing & research",
	data: "Data & infrastructure",
} as const;
export const connectorCategory = z.enum(
	Object.keys(connectorCategories) as [
		keyof typeof connectorCategories,
		...(keyof typeof connectorCategories)[],
	],
);
export const httpsUrl = z.url().refine((value) => {
	// Refinements also run after z.url() fails, so a malformed value must not throw here.
	const url = URL.parse(value);
	return (
		url?.protocol === "https:" && !url.username && !url.password && !url.hash
	);
}, "Use a public HTTPS URL without credentials or a fragment");
/** Served as an image file (see connector-logos.ts), never as markup, so a logo cannot run script. */
export const connectorLogoMaxLength = 65536;
const unsafeSvg = [
	/<script/i,
	/<foreignObject/i,
	/<!DOCTYPE|<!ENTITY/i,
	/@import/i,
	/\son[a-z]+\s*=/i,
	/javascript:/i,
	// Only fragment references or embedded raster images; never external resources.
	/(?:href|src)\s*=\s*["'](?!#|data:image\/(?:png|jpe?g|gif|webp);)/i,
	/url\(\s*["']?(?!#)/i,
];
export function connectorLogoProblem(value: string): string | undefined {
	if (value.length > connectorLogoMaxLength) return "Logo is larger than 64 KB";
	if (value.startsWith("data:"))
		return /^data:image\/(?:png|jpeg|gif|webp|x-icon|vnd\.microsoft\.icon);base64,[A-Za-z0-9+/]+={0,2}$/.test(
			value,
		)
			? undefined
			: "Use a base64 PNG, JPEG, GIF, WebP or ICO data URI, or inline SVG markup";
	if (
		!/^(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg[\s>][\s\S]*<\/svg>$/.test(
			value,
		)
	)
		return "Inline SVG must be a single <svg> element";
	if (unsafeSvg.some((pattern) => pattern.test(value)))
		return "SVG logos cannot contain scripts, event handlers or external references";
}
/**
 * Discovery output is checked with strict objects (unknown keys are errors); remote catalog
 * snapshots are read with the same shape but unknown keys stripped. Output types are identical.
 */
type ObjectFactory = typeof z.object;
const strictObject = ((shape: z.ZodRawShape) =>
	z.strictObject(shape)) as unknown as ObjectFactory;
const text = (max: number) => z.string().trim().min(1).max(max);
const inventorySchema = (object: ObjectFactory) =>
	object({
		observedAt: z.iso.datetime({ offset: true }),
		source: z.enum(["discovery", "refresh", "docs"]),
		tools: z
			.array(
				object({
					name: text(200),
					title: text(200).optional(),
					description: text(1000).optional(),
					annotations: object({
						readOnlyHint: z.boolean().optional(),
						destructiveHint: z.boolean().optional(),
						idempotentHint: z.boolean().optional(),
						openWorldHint: z.boolean().optional(),
					}).optional(),
				}),
			)
			.max(1000),
		resources: z
			.array(
				object({
					uri: text(2048).optional(),
					uriTemplate: text(2048).optional(),
					name: text(200),
					description: text(1000).optional(),
				}).refine(
					(value) => !value.uri !== !value.uriTemplate,
					"A resource has either a URI or a URI template",
				),
			)
			.max(1000),
		prompts: z
			.array(object({ name: text(200), description: text(1000).optional() }))
			.max(1000),
	});
/**
 * A reviewed starter selection: exact tool names written by hand after reading each tool's
 * description, never inferred from names or annotations. Applying one only adds its tools to an
 * editor draft: existing access stays, it never sets full access (so it grants no tool the server
 * adds later), and `requireApproval` tools run only per approved call.
 */
const starterSchema = (object: ObjectFactory) =>
	object({
		id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
		name: text(80),
		description: text(240),
		/** At least one tool runs without review, so a starter is never approval-only. */
		allow: z.array(text(200)).min(1).max(100),
		requireApproval: z.array(text(200)).max(100).optional(),
	}).superRefine((starter, context) => {
		const names = [...starter.allow, ...(starter.requireApproval ?? [])];
		if (new Set(names).size !== names.length)
			context.addIssue({
				code: "custom",
				message: `Starter ${starter.id} lists a tool twice`,
			});
	});
export const connectorStarter = starterSchema(z.object);
export type ConnectorStarter = z.infer<typeof connectorStarter>;
export const connectorInventory = inventorySchema(strictObject);
/** The same shape for remote catalog snapshots: unknown fields are dropped instead of rejected. */
export const lenientConnectorInventory = inventorySchema(z.object);
export type ConnectorInventory = z.infer<typeof connectorInventory>;
export const connectorSearch = z.object({
	query: z.string().max(100).optional().catch(undefined),
	category: connectorCategory.optional().catch(undefined),
	auth: z.enum(["oauth", "bearer", "none"]).optional().catch(undefined),
});
export type ConnectorSearch = z.infer<typeof connectorSearch>;

/**
 * A field becomes one query parameter of the suggested URL. There are no remote regular
 * expressions: `identifier` uses a fixed in-code check and `boolean` takes `true`/`false`.
 */
export const catalogField = z.object({
	name: z.string().regex(/^[a-z_][a-z0-9_]{0,49}$/),
	label: z.string().trim().min(1).max(100),
	help: z.string().max(240),
	required: z.boolean().default(false),
	kind: z.enum(["text", "identifier", "boolean"]),
	pattern: z.never().optional(),
});
export type CatalogField = z.infer<typeof catalogField>;
export const catalogIdentifier = /^[A-Za-z0-9_-]{1,128}$/;
export const catalogLogoTypes = ["svg", "png", "webp"] as const;
export type CatalogLogoType = (typeof catalogLogoTypes)[number];
export const catalogSlug = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
/**
 * One v1 catalog entry. Each entry is checked on its own: an invalid one is dropped, unknown
 * fields are ignored, and an operator OAuth client (`registeredClient`) is never accepted.
 */
export const catalogEntry = z.object({
	slug: catalogSlug,
	name: z.string().trim().min(1).max(100),
	publisher: z.string().trim().min(1).max(100),
	description: z.string().trim().min(1).max(240),
	categories: z.array(connectorCategory).min(1).max(6),
	keywords: z.array(z.string().min(1).max(80)).max(30),
	capabilities: z.array(z.string().min(1).max(160)).max(20),
	documentation: httpsUrl,
	endpoint: httpsUrl,
	authMethods: z
		.array(z.enum(["oauth", "bearer", "none"]))
		.min(1)
		.max(3),
	fields: z
		.array(catalogField)
		.max(6)
		.refine(
			(fields) =>
				new Set(fields.map((field) => field.name)).size === fields.length,
			"Duplicate configuration field",
		)
		.default([]),
	requirements: z.string().max(800).default(""),
	setupNotice: z.string().max(800).optional(),
	starters: z
		.array(connectorStarter)
		.min(1)
		.max(4)
		.refine(
			(starters) =>
				new Set(starters.map((starter) => starter.id)).size === starters.length,
			"Duplicate starter ID",
		)
		.optional(),
	featured: z.boolean().default(false),
	listed: z.boolean(),
	logo: z
		.object({
			sha256: z.string().regex(/^[0-9a-f]{64}$/),
			type: z.enum(catalogLogoTypes),
		})
		.optional(),
	toolSnapshot: lenientConnectorInventory.optional(),
	registeredClient: z.never().optional(),
});
export type CatalogEntry = z.infer<typeof catalogEntry>;
/** What the dashboard catalog receives: no tool snapshot, and the logo only by URL. */
export const connectorCatalogEntry = catalogEntry
	.omit({
		listed: true,
		logo: true,
		toolSnapshot: true,
		registeredClient: true,
	})
	.extend({ logoUrl: z.string().nullable() });
export type ConnectorCatalogEntry = z.infer<typeof connectorCatalogEntry>;

/**
 * The suggested URL with the person's field values applied as query parameters (encoded by
 * URLSearchParams). Runs in the browser before the person confirms the address; the server
 * only ever sees the confirmed URL.
 */
export function applyCatalogFields(
	endpoint: string,
	fields: readonly CatalogField[],
	values: Record<string, string>,
) {
	const url = new URL(endpoint);
	for (const field of fields) {
		const value = values[field.name]?.trim() ?? "";
		if (!value) {
			if (field.required) throw new Error(`${field.label} is required.`);
			continue;
		}
		if (
			(field.kind === "identifier" && !catalogIdentifier.test(value)) ||
			(field.kind === "boolean" && value !== "true" && value !== "false") ||
			value.length > 200
		)
			throw new Error(
				field.kind === "identifier"
					? `${field.label} can use only letters, digits, hyphens and underscores.`
					: `Check the ${field.label.toLowerCase()} value.`,
			);
		url.searchParams.set(field.name, value);
	}
	// The same limit as an address typed by hand.
	if (url.href.length > 2048)
		throw new Error(
			"The address would be longer than 2,048 characters. Shorten the values you entered.",
		);
	return url.href;
}

export function searchConnectors<
	T extends Pick<
		CatalogEntry,
		| "categories"
		| "authMethods"
		| "name"
		| "keywords"
		| "description"
		| "featured"
	>,
>(entries: T[], search: ConnectorSearch) {
	const normalize = (text: string) =>
		text
			.toLowerCase()
			.normalize("NFKD")
			.replace(/\p{Diacritic}/gu, "");
	const query = normalize(search.query?.trim() ?? "");
	return entries
		.filter(
			(entry) =>
				(!search.category || entry.categories.includes(search.category)) &&
				(!search.auth || entry.authMethods.includes(search.auth)),
		)
		.map((entry) => {
			const name = normalize(entry.name),
				keywords = normalize(entry.keywords.join(" "));
			const haystack = `${name} ${keywords} ${normalize(entry.description)} ${entry.categories.map((key) => normalize(connectorCategories[key])).join(" ")}`;
			const score = !query
				? Number(entry.featured)
				: name === query
					? 100
					: name.startsWith(query)
						? 80
						: keywords.includes(query)
							? 60
							: query.split(/\s+/).every((word) => haystack.includes(word))
								? 40
								: 0;
			return { entry, score };
		})
		.filter(({ score }) => !query || score > 0)
		.sort(
			(a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name),
		)
		.map(({ entry }) => entry);
}

/** Exact HTTPS origin and path, ignoring a trailing slash and query; never a host substring. */
export function connectorEndpointKey(value: string) {
	const url = URL.parse(value);
	if (url?.protocol !== "https:" || url.username || url.password) return;
	return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}
const displayKey = (value: string) =>
	connectorEndpointKey(value)?.toLowerCase();
/**
 * The entry to show for a connection URL, for display only (logos, starters, catalog tool
 * names), never identity: lowercase origin and path, trailing slash dropped, query ignored;
 * otherwise the only entry on that host.
 */
export function matchCatalogEntry<T extends Pick<CatalogEntry, "endpoint">>(
	entries: readonly T[],
	url: string,
) {
	const key = displayKey(url);
	if (!key) return;
	const exact = entries.find((entry) => displayKey(entry.endpoint) === key);
	if (exact) return exact;
	const host = new URL(url).host;
	const sameHost = entries.filter(
		(entry) => URL.parse(entry.endpoint)?.host === host,
	);
	return sameHost.length === 1 ? sameHost[0] : undefined;
}
