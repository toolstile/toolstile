import type { Rules, Snapshot } from "@toolstile/api/contract";

/**
 * Pure helpers behind the access grid. A column holds one rule set (an agent's grant or the
 * Everyone rule) for one server. Cells show the gateway's effective decision: any matching
 * block denies; otherwise a tool listed in `requireApproval` (here or in Everyone) runs only
 * per approved call; otherwise `full` or a listed name allows. Toggling a cell writes the smallest
 * change to the column's own rules and leaves entries the grid does not show untouched.
 */
export type Capability = "tools" | "resources" | "prompts";
export const capabilityKinds = ["tools", "resources", "prompts"] as const;

export const emptyRules = (): Rules => ({
	full: false,
	allow: { tools: [], resources: [], prompts: [] },
	block: { tools: [], resources: [], prompts: [] },
});

function copyRules(rules?: Rules): Rules {
	if (!rules) return emptyRules();
	return {
		full: rules.full,
		allow: {
			tools: [...rules.allow.tools],
			resources: [...rules.allow.resources],
			prompts: [...rules.allow.prompts],
		},
		block: {
			tools: [...rules.block.tools],
			resources: [...rules.block.resources],
			prompts: [...rules.block.prompts],
		},
		...(rules.requireApproval
			? { requireApproval: [...rules.requireApproval] }
			: {}),
	};
}
const approvals = (rules?: Rules) => rules?.requireApproval ?? [];

interface CellState {
	checked: boolean;
	/** Checked by something other than this column's own allow entry. */
	inherited?: "all" | "everyone" | "everyone-all";
	/** Unchecked by an explicit block in this column or in the Everyone rule. */
	blocked?: "self" | "everyone";
	/** Checked tool that runs only after a person approves each call. */
	approval?: "self" | "everyone";
}

/** Effective state of one capability for a column; `everyone` applies to agent columns only. */
export function cellState(
	own: Rules,
	kind: Capability,
	name: string,
	everyone?: Rules,
): CellState {
	if (everyone?.block[kind].includes(name))
		return { checked: false, blocked: "everyone" };
	if (own.block[kind].includes(name))
		return { checked: false, blocked: "self" };
	if (kind === "tools" && approvals(everyone).includes(name))
		return { checked: true, approval: "everyone" };
	if (kind === "tools" && approvals(own).includes(name))
		return { checked: true, approval: "self" };
	if (own.allow[kind].includes(name)) return { checked: true };
	if (own.full) return { checked: true, inherited: "all" };
	if (everyone?.full) return { checked: true, inherited: "everyone-all" };
	if (everyone?.allow[kind].includes(name))
		return { checked: true, inherited: "everyone" };
	return { checked: false };
}

/**
 * Rules after setting one cell. Unchecking an inherited cell adds a block; checking a blocked
 * cell removes the block and adds an allow only when nothing else already allows it. An
 * Everyone block cannot be lifted from an agent column, so that change is ignored.
 */
export function toggleCell(
	own: Rules,
	kind: Capability,
	name: string,
	checked: boolean,
	everyone?: Rules,
): Rules {
	if (everyone?.block[kind].includes(name)) return own;
	const next = copyRules(own);
	const without = (names: string[]) => names.filter((entry) => entry !== name);
	if (checked) {
		next.block[kind] = without(next.block[kind]);
		if (!cellState(next, kind, name, everyone).checked)
			next.allow[kind].push(name);
	} else {
		next.allow[kind] = without(next.allow[kind]);
		if (kind === "tools" && next.requireApproval)
			next.requireApproval = without(next.requireApproval);
		if (cellState(next, kind, name, everyone).checked)
			next.block[kind].push(name);
	}
	return compact(next);
}
/** Drops an empty approval list so unchanged rule sets keep their original shape. */
function compact(rules: Rules): Rules {
	if (rules.requireApproval && !rules.requireApproval.length) {
		const { requireApproval: _, ...rest } = rules;
		return rest;
	}
	return rules;
}

/**
 * Rules after choosing whether one tool needs approval. Requiring approval is a conditional
 * grant: it lifts this column's own block. Allowing immediately removes this column's entry
 * and adds an allow when nothing else grants the tool. An Everyone block or approval cannot
 * be lifted from an agent column, so those changes are ignored.
 */
export function setApproval(
	own: Rules,
	name: string,
	required: boolean,
	everyone?: Rules,
): Rules {
	if (everyone?.block.tools.includes(name)) return own;
	if (!required && approvals(everyone).includes(name)) return own;
	const next = copyRules(own);
	const without = (names: string[]) => names.filter((entry) => entry !== name);
	next.block.tools = without(next.block.tools);
	next.requireApproval = without(approvals(next));
	if (required) {
		next.allow.tools = without(next.allow.tools);
		next.requireApproval.push(name);
	} else if (!cellState(next, "tools", name, everyone).checked)
		next.allow.tools.push(name);
	return compact(next);
}

/** Sets several cells at once, such as every visible row of a column. */
export function toggleCells(
	own: Rules,
	kind: Capability,
	names: string[],
	checked: boolean,
	everyone?: Rules,
): Rules {
	return names.reduce(
		(rules, name) => toggleCell(rules, kind, name, checked, everyone),
		own,
	);
}

/** "All, including new": `full` covers every tool, resource and prompt; blocks still apply. */
export function setFull(own: Rules, full: boolean): Rules {
	return { ...copyRules(own), full };
}

export function isEmptyRules(rules: Rules) {
	return (
		!rules.full &&
		capabilityKinds.every(
			(kind) => !rules.allow[kind].length && !rules.block[kind].length,
		) &&
		!approvals(rules).length
	);
}

/**
 * Edited entries between two rule sets: one per changed `full` flag and one per name whose
 * allow/block membership differs, so checking a blocked cell counts once.
 */
export function countChanges(saved: Rules, draft: Rules) {
	let count = saved.full === draft.full ? 0 : 1;
	for (const kind of capabilityKinds) {
		const names = new Set([
			...saved.allow[kind],
			...saved.block[kind],
			...draft.allow[kind],
			...draft.block[kind],
		]);
		if (kind === "tools")
			for (const name of [...approvals(saved), ...approvals(draft)])
				names.add(name);
		for (const name of names)
			if (
				saved.allow[kind].includes(name) !== draft.allow[kind].includes(name) ||
				saved.block[kind].includes(name) !== draft.block[kind].includes(name) ||
				(kind === "tools" &&
					approvals(saved).includes(name) !== approvals(draft).includes(name))
			)
				count++;
	}
	return count;
}

export const sameRules = (a: Rules, b: Rules) => countChanges(a, b) === 0;

/** Names any of these rule sets mention for one capability, in first-seen order. */
function referencedNames(sets: Rules[], kind: Capability) {
	return [
		...new Set(
			sets.flatMap((rules) => [
				...rules.allow[kind],
				...rules.block[kind],
				...(kind === "tools" ? approvals(rules) : []),
			]),
		),
	];
}

export interface CapabilityRow {
	name: string;
	description?: string;
	/** False when the loaded catalog no longer lists it; undefined while unknown. */
	offered?: boolean;
}

/**
 * Grid rows: the live catalog in server order, then saved names it no longer offers, then
 * names added by hand. Without a catalog only saved and added names are shown.
 */
export function capabilityRows(
	kind: Capability,
	catalog: { names: string[]; descriptions?: Map<string, string> } | undefined,
	sets: Rules[],
	added: string[] = [],
): CapabilityRow[] {
	const offered = new Set(catalog?.names);
	const rows: CapabilityRow[] = (catalog?.names ?? []).map((name) => ({
		name,
		description: catalog?.descriptions?.get(name),
		offered: true,
	}));
	const seen = new Set(offered);
	for (const name of [...referencedNames(sets, kind), ...added]) {
		if (seen.has(name)) continue;
		seen.add(name);
		rows.push({ name, offered: catalog ? false : undefined });
	}
	return rows;
}

/** One-line effective access for an agent on a server, or null when it may use nothing. */
export function accessSummary(sets: Rules[]) {
	const blocked = new Set(
		capabilityKinds.flatMap((kind) =>
			sets.flatMap((rules) =>
				rules.block[kind].map((name) => `${kind}:${name}`),
			),
		),
	);
	const approval = new Set(
		sets
			.flatMap((rules) => approvals(rules))
			.filter((name) => !blocked.has(`tools:${name}`)),
	);
	const approvalNote = approval.size
		? `${approval.size} ${approval.size === 1 ? "needs" : "need"} approval`
		: "";
	if (sets.some((rules) => rules.full))
		return [
			"full access",
			blocked.size ? `${blocked.size} blocked` : "",
			approvalNote,
		]
			.filter(Boolean)
			.join(", ");
	const labels = {
		tools: ["tool", "tools"],
		resources: ["resource", "resources"],
		prompts: ["prompt", "prompts"],
	} as const;
	const parts = capabilityKinds.flatMap((kind) => {
		const count = new Set(
			sets
				.flatMap((rules) => rules.allow[kind])
				.filter(
					(name) =>
						!blocked.has(`${kind}:${name}`) &&
						!(kind === "tools" && approval.has(name)),
				),
		).size;
		return count ? [`${count} ${labels[kind][count === 1 ? 0 : 1]}`] : [];
	});
	if (approvalNote) parts.push(approvalNote);
	return parts.length ? parts.join(", ") : null;
}

/**
 * Effective access on one connection from the snapshot's own rules. `agents` counts active
 * agents (not revoked, on an active device, not expired) whose own rules plus the all-agent
 * rule still allow something after blocks; `active` is how many agents were considered.
 * `allAgentRule` reports that an all-agent rule allows something; it does not mean every
 * agent has access, since an agent's own blocks still apply.
 */
export function connectionAccess(
	data: Snapshot,
	connectionId: string,
	now = Date.now(),
) {
	const everyoneRules = data.allAgentGrants.find(
		(grant) => grant.connectionId === connectionId,
	)?.rules;
	const devices = new Set(
		data.devices.filter((device) => !device.revoked).map((device) => device.id),
	);
	let agents = 0,
		active = 0;
	for (const agent of data.agents) {
		if (agent.revoked || !devices.has(agent.deviceId)) continue;
		if (agent.expiresAt && Date.parse(agent.expiresAt) <= now) continue;
		active++;
		const own = data.grants.find(
			(grant) =>
				grant.agentId === agent.id && grant.connectionId === connectionId,
		)?.rules;
		if (
			accessSummary(
				[own, everyoneRules].filter((rules): rules is Rules => !!rules),
			)
		)
			agents++;
	}
	return {
		agents,
		active,
		allAgentRule: !!everyoneRules && !!accessSummary([everyoneRules]),
	};
}

/** "1 agent" or "3 agents". */
const agentCount = (count: number) =>
	`${count} ${count === 1 ? "agent" : "agents"}`;

/**
 * Label for `connectionAccess`: "2 agents have access · All-agent rule" on connection rows, or
 * the shorter "2 agents · All-agent rule" where space is tight.
 */
export function connectionAccessLabel(
	{
		agents,
		allAgentRule,
	}: Pick<ReturnType<typeof connectionAccess>, "agents" | "allAgentRule">,
	short = false,
) {
	const base = !agents
		? "No agent access"
		: short
			? agentCount(agents)
			: `${agentCount(agents)} ${agents === 1 ? "has" : "have"} access`;
	return allAgentRule ? `${base} · All-agent rule` : base;
}

/** Effective summary per server for one agent, including the Everyone rule. */
export function agentAccessSummaries(data: Snapshot, agentId: string) {
	return data.connections.flatMap((connection) => {
		const sets = [
			data.grants.find(
				(grant) =>
					grant.agentId === agentId && grant.connectionId === connection.id,
			)?.rules,
			data.allAgentGrants.find((grant) => grant.connectionId === connection.id)
				?.rules,
		].filter((rules): rules is Rules => !!rules);
		const summary = accessSummary(sets);
		return summary ? [{ connection, summary }] : [];
	});
}
