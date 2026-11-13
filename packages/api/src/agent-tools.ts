import {
	type BuiltinTools,
	exposedName,
	permitted,
	toolDecision,
	type Upstream,
} from "@toolstile/gateway";
import { z } from "zod";
import {
	type CatalogEntry,
	connectorCategories,
	connectorCategory,
	searchConnectors,
} from "./connectors.js";

const readOnly = {
	readOnlyHint: true,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: false,
};
const searchInput = z.object({
	query: z.string().trim().max(100).optional(),
	category: connectorCategory.optional(),
	auth: z.enum(["oauth", "bearer", "none"]).optional(),
	limit: z.number().int().min(1).max(25).default(10),
});
const entryInput = z.object({ id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/) });

const json = (value: unknown) => ({
	content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
});
const failure = (text: string) => ({
	content: [{ type: "text" as const, text }],
	isError: true,
});

/**
 * Read-only tools every signed-in agent gets beside its granted connection tools. Catalog
 * text is suggestion data, never instructions; access covers only this agent's own grants.
 * The catalog holds only listed entries.
 */
export function agentTools(source: {
	catalog(): Promise<CatalogEntry[]>;
	connections(): Promise<Upstream[]>;
}): BuiltinTools {
	const handlers: Record<string, (args: unknown) => Promise<unknown>> = {
		async search_catalog(args) {
			const input = searchInput.parse(args);
			const matches = searchConnectors(await source.catalog(), input);
			return {
				total: matches.length,
				services: matches.slice(0, input.limit).map((entry) => ({
					id: entry.slug,
					name: entry.name,
					publisher: entry.publisher,
					description: entry.description,
					categories: entry.categories,
					authMethods: entry.authMethods,
					suggestedUrl: entry.endpoint,
				})),
			};
		},
		async get_catalog_entry(args) {
			const { id } = entryInput.parse(args);
			const entry = (await source.catalog()).find((item) => item.slug === id);
			if (!entry) return undefined;
			return {
				id: entry.slug,
				name: entry.name,
				publisher: entry.publisher,
				description: entry.description,
				categories: entry.categories,
				keywords: entry.keywords,
				capabilities: entry.capabilities,
				documentation: entry.documentation,
				/** A suggestion the person confirms or edits in Toolstile before connecting. */
				suggestedUrl: entry.endpoint,
				authMethods: entry.authMethods,
				requirements: entry.requirements || undefined,
				setupNotice: entry.setupNotice,
				settings: entry.fields.map((field) => ({
					name: field.name,
					label: field.label,
					help: field.help,
					required: field.required,
				})),
				toolSnapshot: entry.toolSnapshot && {
					observedAt: entry.toolSnapshot.observedAt,
					tools: entry.toolSnapshot.tools.map((tool) => ({
						name: tool.name,
						title: tool.title,
						description: tool.description,
						readOnly: tool.annotations?.readOnlyHint,
					})),
				},
			};
		},
		async get_my_access() {
			const connections = (await source.connections()).flatMap((upstream) => {
				const allTools = upstream.rules.some((rule) => rule.full);
				const names = [
					...new Set(
						upstream.rules.flatMap((rule) => [
							...rule.allow.tools,
							...(rule.requireApproval ?? []),
						]),
					),
				].filter((name) => permitted(upstream.rules, "tools", name));
				if (!allTools && !names.length) return [];
				return [
					{
						connection: upstream.label,
						allTools,
						tools: names.sort().map((name) => ({
							name,
							gatewayName: exposedName(upstream, name),
							approvalRequired:
								toolDecision(upstream.rules, name) === "approval",
						})),
					},
				];
			});
			return {
				connections,
				note: "Only this agent's own access is shown. Tools held for review do not appear in tools/list until someone reviews them in Toolstile.",
			};
		},
	};
	return {
		definitions: [
			{
				name: "search_catalog",
				title: "Search the Toolstile catalog",
				description:
					"Search the catalog of suggested MCP services that can be connected to Toolstile, by name, keyword or capability. Returns matching services; it does not connect anything or change access.",
				inputSchema: {
					type: "object",
					properties: {
						query: {
							type: "string",
							maxLength: 100,
							description: "Words to match, such as a service name or task",
						},
						category: {
							type: "string",
							enum: Object.keys(connectorCategories),
						},
						auth: {
							type: "string",
							enum: ["oauth", "bearer", "none"],
							description: "Only services supporting this sign-in method",
						},
						limit: { type: "integer", minimum: 1, maximum: 25, default: 10 },
					},
				},
				annotations: { title: "Search the Toolstile catalog", ...readOnly },
			},
			{
				name: "get_catalog_entry",
				title: "Get a Toolstile catalog entry",
				description:
					"Get one catalog service's details by its id from search_catalog: what it does, its suggested URL, how it signs in, requirements and its last observed tools.",
				inputSchema: {
					type: "object",
					properties: {
						id: { type: "string", description: "Catalog id, such as github" },
					},
					required: ["id"],
				},
				annotations: { title: "Get a Toolstile catalog entry", ...readOnly },
			},
			{
				name: "get_my_access",
				title: "Show this agent's access",
				description:
					"List the connections this agent can reach through Toolstile and the tools it is granted, including which need approval for each call. Shows only this agent's own access.",
				inputSchema: { type: "object", properties: {} },
				annotations: { title: "Show this agent's access", ...readOnly },
			},
		],
		async call(name, args) {
			let result: unknown;
			try {
				result = await handlers[name](args);
			} catch (error) {
				if (error instanceof z.ZodError)
					return failure(`Invalid arguments: ${z.prettifyError(error)}`);
				throw error;
			}
			return result === undefined
				? failure(
						"No catalog service has that id. Use search_catalog to find one.",
					)
				: json(result);
		},
	};
}
