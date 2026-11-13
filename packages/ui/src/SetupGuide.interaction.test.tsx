// @vitest-environment happy-dom
import type { Snapshot } from "@toolstile/api/contract";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@stylexjs/stylex", () => ({
	create: <T,>(value: T) => value,
	defineVars: <T,>(value: T) => value,
	keyframes: () => "",
	firstThatWorks: (value: string) => value,
	defaultMarker: () => ({}),
	when: { ancestor: () => ":hover" },
	props: () => ({}),
}));

import { SetupGuide, useSetupProgress } from "./SetupGuide";
import type { SetupApi, SetupState } from "./setup-contract";

(
	globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver ??= class {
	observe() {}
	unobserve() {}
	disconnect() {}
} as unknown as typeof ResizeObserver;

const snapshot = (agents: Snapshot["agents"]) =>
	({
		user: { name: "Test", email: "setup@example.test", operator: false },
		connections: [
			{
				id: "c1",
				label: "deepwiki.com",
				url: "https://mcp.deepwiki.com/mcp",
				transport: "http",
				status: "reachable",
				authentication: "headers",
				canManageAuthentication: true,
			},
		],
		devices: [],
		agents,
		grants: [],
		activity: [],
		allAgentGrants: [],
	}) as Snapshot;
const signedIn = {
	id: "signed-in",
	label: "Claude Code",
	deviceId: "d1",
	revoked: false,
	expiresAt: null,
	canTest: true,
};
const waiting: SetupState = {
	status: "active",
	step: "agent",
	client: "claude-code",
	connectionId: "c1",
	completed: { connect: true, agent: false, access: false, verify: false },
	verifiedAt: null,
};

let root: Root | undefined;
afterEach(() => {
	act(() => root?.unmount());
	root = undefined;
	vi.useRealTimers();
});

describe("guided setup waiting for an agent", () => {
	it("reloads while step 2 waits and moves on to access when an agent signs in elsewhere", async () => {
		vi.useFakeTimers();
		let data = snapshot([]);
		let state = waiting;
		let finishReload: () => void = () => undefined;
		const reload = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					finishReload = resolve;
				}),
		);
		const saveSetup = vi.fn<SetupApi["saveSetup"]>(async (input) => ({
			...state,
			step: input.step,
			agentId: input.agentId,
			completed: { ...state.completed, agent: !!input.agentId },
		}));
		const api: SetupApi = {
			setupStatus: vi.fn(),
			setupAgents: vi.fn(async () => ({ agentIds: [] })),
			saveSetup,
			verifySetup: vi.fn(),
		};
		const render = () =>
			root?.render(
				<SetupGuide
					state={state}
					api={api}
					data={data}
					endpoint="https://toolstile.example/mcp"
					reload={reload}
					onState={(next) => {
						state = next;
						render();
					}}
					onDialog={() => undefined}
					onConfigureAccess={() => undefined}
					onDone={() => undefined}
				/>,
			);
		root = createRoot(document.createElement("div"));
		await act(async () => render());
		expect(reload).not.toHaveBeenCalled();
		// Focus and the interval reload, but never while a reload is still running.
		await act(async () => {
			window.dispatchEvent(new Event("focus"));
			vi.advanceTimersByTime(5000);
		});
		expect(reload).toHaveBeenCalledTimes(1);
		// The agent signed in on its own consent page; the reload brings it in.
		data = snapshot([signedIn]);
		await act(async () => {
			finishReload();
			render();
		});
		await act(async () => {
			await vi.runOnlyPendingTimersAsync();
		});
		expect(saveSetup).toHaveBeenCalledWith(
			expect.objectContaining({ agentId: "signed-in", step: "access" }),
		);
		expect(state.step).toBe("access");
		// Step 2 is over, so the reloads stop.
		const calls = reload.mock.calls.length;
		await act(async () => {
			vi.advanceTimersByTime(20000);
			window.dispatchEvent(new Event("focus"));
		});
		expect(reload).toHaveBeenCalledTimes(calls);
	});
	it("keeps reloading with an existing agent selected and moves on only for a new one", async () => {
		vi.useFakeTimers();
		const existing = { ...signedIn, id: "existing", label: "Laptop agent" };
		let data = snapshot([existing]);
		let state: SetupState = waiting;
		const reload = vi.fn(async () => undefined);
		const saveSetup = vi.fn<SetupApi["saveSetup"]>(async (input) => ({
			...state,
			step: input.step,
			agentId: input.agentId,
			completed: { ...state.completed, agent: !!input.agentId },
		}));
		// The server's agent list, ahead of the dashboard snapshot the guide shows.
		let serverAgents = ["existing"];
		const setupAgents = vi.fn(async () => ({ agentIds: serverAgents }));
		const api: SetupApi = {
			setupStatus: vi.fn(),
			setupAgents,
			saveSetup,
			verifySetup: vi.fn(),
		};
		const render = () =>
			root?.render(
				<SetupGuide
					state={state}
					api={api}
					data={data}
					endpoint="https://toolstile.example/mcp"
					reload={reload}
					onState={(next) => {
						state = next;
						render();
					}}
					onDialog={() => undefined}
					onConfigureAccess={() => undefined}
					onDone={() => undefined}
				/>,
			);
		root = createRoot(document.createElement("div"));
		await act(async () => render());
		await act(async () => {
			await vi.runOnlyPendingTimersAsync();
		});
		// The existing agent is selected, but step 2 stays put.
		expect(saveSetup).toHaveBeenCalledTimes(1);
		expect(saveSetup).toHaveBeenLastCalledWith(
			expect.objectContaining({ agentId: "existing", step: "agent" }),
		);
		expect(state.agentId).toBe("existing");
		// Step 2 keeps checking agents while that agent is selected, without reloading the
		// dashboard while nothing new has signed in.
		const checks = setupAgents.mock.calls.length;
		await act(async () => {
			await vi.advanceTimersByTimeAsync(10000);
		});
		expect(setupAgents).toHaveBeenCalledTimes(checks + 2);
		expect(reload).not.toHaveBeenCalled();
		// Another agent signs in on its own consent page; the next check reloads.
		serverAgents = ["existing", "signed-in"];
		await act(async () => {
			await vi.advanceTimersByTimeAsync(5000);
		});
		expect(reload).toHaveBeenCalledTimes(1);
		data = snapshot([existing, signedIn]);
		await act(async () => render());
		await act(async () => {
			await vi.runOnlyPendingTimersAsync();
		});
		expect(saveSetup).toHaveBeenLastCalledWith(
			expect.objectContaining({ agentId: "signed-in", step: "access" }),
		);
		expect(state.step).toBe("access");
	});
	it("drops a reload that started before a save and does not poll while saving", async () => {
		const existing = { ...signedIn, id: "existing", label: "Laptop agent" };
		const data = snapshot([existing]);
		const selected: SetupState = {
			...waiting,
			agentId: "existing",
			completed: { ...waiting.completed, agent: true },
		};
		const deferred = <T,>() => {
			let resolve: (value: T) => void = () => undefined;
			const promise = new Promise<T>((done) => {
				resolve = done;
			});
			return { promise, resolve };
		};
		const reloads: ReturnType<typeof deferred<SetupState>>[] = [];
		const saves: ReturnType<typeof deferred<SetupState>>[] = [];
		const api: SetupApi = {
			setupStatus: vi.fn(),
			setupAgents: vi.fn(async () => ({ agentIds: [] })),
			saveSetup: vi.fn(() => {
				const next = deferred<SetupState>();
				saves.push(next);
				return next.promise;
			}),
			verifySetup: vi.fn(),
		};
		let shown: SetupState | null = selected;
		function Host() {
			const [setup, setSetup] = useState<SetupState | null>(selected);
			const progress = useSetupProgress(setSetup);
			shown = setup;
			// The host's reload: snapshot and setup progress, applied only if no save came after.
			const reload = async () => {
				const apply = progress.reloadStarted();
				const next = deferred<SetupState>();
				reloads.push(next);
				apply(await next.promise);
			};
			return setup?.status === "active" ? (
				<SetupGuide
					state={setup}
					api={api}
					data={data}
					endpoint="https://toolstile.example/mcp"
					reload={reload}
					onState={progress.onState}
					onDialog={() => undefined}
					onConfigureAccess={() => undefined}
					onDone={() => undefined}
				/>
			) : null;
		}
		const container = document.createElement("div");
		root = createRoot(container);
		await act(async () => root?.render(<Host />));
		const button = (label: string) =>
			[...container.querySelectorAll("button")].find((element) =>
				element.textContent?.startsWith(label),
			);
		// A poll starts, then the user continues; the save answers first.
		await act(async () => window.dispatchEvent(new Event("focus")));
		expect(reloads).toHaveLength(1);
		await act(async () => button("Continue")?.click());
		expect(saves).toHaveLength(1);
		await act(async () => saves[0].resolve({ ...selected, step: "access" }));
		expect(shown?.step).toBe("access");
		// The older poll answers last with step 2; it must not move the guide back.
		await act(async () => reloads[0].resolve(selected));
		expect(shown?.step).toBe("access");
		// Back to step 2, then Skip: no poll starts while that save is pending.
		await act(async () => button("Back")?.click());
		await act(async () => saves[1].resolve(selected));
		expect(shown?.step).toBe("agent");
		await act(async () => button("Skip")?.click());
		await act(async () => window.dispatchEvent(new Event("focus")));
		expect(reloads).toHaveLength(1);
		await act(async () => saves[2].resolve({ ...selected, status: "skipped" }));
		expect(shown?.status).toBe("skipped");
	});
});
