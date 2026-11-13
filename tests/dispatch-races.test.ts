import { describe, expect, it, vi } from "vitest";
import {
	emptyRules,
	openUpstream,
	type Runtime,
	type Upstream,
} from "../packages/gateway/src/index";
import { startFixture } from "./fixture";
import { subscriptionFixture } from "./subscription-fixture";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe("ordinary dispatch identity binding", () => {
	for (const point of ["initial check", "operation admission"] as const)
		for (const change of [
			"selected account",
			"credential revision",
			"rules",
		] as const)
			it(`fails closed after ${change} changes while ${point} is pending`, async () => {
				const fixture = await subscriptionFixture();
				const rules = emptyRules();
				rules.full = true;
				let current: Upstream = {
					id: "a",
					identityKey: "account-one:revision-one",
					label: "Fixture",
					url: fixture.url,
					transport: "http",
					headers: { Authorization: "Bearer fixture-first" },
					rules: [rules],
				};
				const captured = current;
				const entered = deferred(),
					release = deferred();
				const outcomes: string[] = [],
					sent: string[] = [];
				const runtime: Runtime = {
					connections: async () => [current],
					check: async () => {
						if (point === "initial check") {
							entered.resolve();
							await release.promise;
						}
					},
					admit: async (operation) => {
						if (
							point === "operation admission" &&
							operation.method === "tools/call"
						) {
							entered.resolve();
							await release.promise;
						}
					},
					record: async (_operation, outcome) => {
						outcomes.push(outcome);
					},
					validateDestination: async () => {},
					fetch: async (input, init) => {
						sent.push(JSON.parse(String(init?.body ?? "{}")).method ?? "GET");
						return fetch(input, init);
					},
				};
				const opening = openUpstream(
					runtime,
					captured,
					"tools/call",
					"echo",
					"tools",
				);
				let client: Awaited<typeof opening> | undefined;
				try {
					const pending =
						point === "initial check"
							? opening
							: (async () => {
									client = await opening;
									return client.callTool({
										name: "echo",
										arguments: { text: "must not execute" },
									});
								})();
					await entered.promise;
					if (change === "selected account")
						current = {
							...current,
							identityKey: "account-two:revision-one",
							headers: { Authorization: "Bearer fixture-second" },
						};
					else if (change === "credential revision")
						current = { ...current, identityKey: "account-one:revision-two" };
					else rules.block.tools.push("echo");
					release.resolve();
					await expect(pending).rejects.toThrow(
						/Upstream authorization changed|Connection closed/,
					);
					expect(sent).not.toContain("tools/call");
					expect(
						fixture.calls.filter((call) => call.method === "tools/call"),
					).toEqual([]);
					if (point === "initial check") expect(sent).toEqual([]);
					else await vi.waitFor(() => expect(outcomes.at(-1)).toBe("denied"));
				} finally {
					release.resolve();
					await client?.close();
					await fixture.close();
				}
			});
});

describe("result authorization without debug capture", () => {
	for (const captureMode of ["disabled", "not selected"] as const)
		for (const change of ["rules", "live check"] as const)
			it.each([
				"tools/call",
				"resources/read",
				"prompts/get",
				"completion/complete",
			] as const)(
				`withholds %s after a ${change} denial with capture ${captureMode}`,
				async (method) => {
					const fixture = await startFixture();
					const rules = { ...emptyRules(), full: true };
					const upstream: Upstream = {
						id: "a",
						label: "Fixture",
						url: fixture.url,
						transport: "http",
						headers: {},
						rules: [rules],
					};
					const entered = deferred(),
						release = deferred();
					let blocked = false;
					const check = vi.fn(async () => {
						if (blocked) throw new Error("Access denied");
					});
					const runtime: Runtime = {
						connections: async () => [upstream],
						check,
						admit: async () => {},
						record: async () => {},
						validateDestination: async () => {},
						...(captureMode === "not selected"
							? { capture: async () => undefined }
							: {}),
						fetch: async (input, init) => {
							const response = await fetch(input, init);
							if (JSON.parse(String(init?.body ?? "{}")).method === method) {
								entered.resolve();
								await release.promise;
							}
							return response;
						},
					};
					const kind =
						method === "tools/call"
							? "tools"
							: method === "resources/read"
								? "resources"
								: "prompts";
					const target =
						kind === "tools"
							? "read_docs"
							: kind === "resources"
								? "test://readme"
								: "review";
					const client = await openUpstream(
						runtime,
						upstream,
						method,
						target,
						kind,
					);
					try {
						const result =
							method === "tools/call"
								? client.callTool({ name: target })
								: method === "resources/read"
									? client.readResource({ uri: target })
									: method === "prompts/get"
										? client.getPrompt({ name: target })
										: client.complete({
												ref: { type: "ref/prompt", name: target },
												argument: { name: "text", value: "f" },
											});
						await entered.promise;
						if (change === "rules") rules.block[kind].push(target);
						else blocked = true;
						release.resolve();
						await expect(result).rejects.toThrow(
							change === "rules"
								? /Upstream authorization changed|Connection closed/
								: "Access denied",
						);
						if (change === "live check")
							expect(check).toHaveBeenLastCalledWith("a", kind, target, {
								inFlight: true,
							});
					} finally {
						release.resolve();
						await client.close();
						await fixture.close();
					}
				},
			);
});
