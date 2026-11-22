import { os } from "@orpc/server";
import {
	type Actor,
	type LocalCommandInput,
	localCommandCreatedView,
	localCommandInput,
} from "@toolstile/api/contract";
import type { z } from "zod";

/** Programs that start another one; the package or script they run names the connection. */
const launchers = new Set([
	"npx",
	"pnpx",
	"bunx",
	"uvx",
	"pipx",
	"node",
	"deno",
	"bun",
	"python",
	"python3",
	"uv",
	"docker",
]);
const baseName = (value: string) => value.split(/[\\/]/).pop() ?? value;

/** A readable default name: `npx -y @scope/server-files@1` is "server-files". */
export function commandLabel(command: string, args: string[]) {
	const program = baseName(command);
	const target = launchers.has(program.replace(/\.(exe|cmd)$/i, ""))
		? args.find((arg) => !arg.startsWith("-"))
		: undefined;
	const name = target
		? baseName(target.replace(/(.)@[^/@]*$/, "$1")).replace(/\.[cm]?[jt]s$/, "")
		: program;
	return (name || program).slice(0, 100);
}

/** The command line shown in the dashboard; arguments with spaces are quoted. */
export function displayCommand(command: string, args: string[]) {
	return [command, ...args]
		.map((part) =>
			/^[\w@%+=:,./-]+$/.test(part) ? part : JSON.stringify(part),
		)
		.join(" ");
}

/** The instance's local command procedures; `add` enforces the switch and the operator role. */
export function createLocalCommandRouter(
	add: (
		actor: Actor,
		input: LocalCommandInput,
		signal?: AbortSignal,
	) => Promise<z.infer<typeof localCommandCreatedView>>,
) {
	const procedure = os.$context<{ actor: Actor }>();
	return {
		addLocalCommand: procedure
			.input(localCommandInput)
			.output(localCommandCreatedView)
			.handler(({ context, input, signal }) =>
				add(context.actor, input, signal),
			),
	};
}
