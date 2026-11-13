// Nitro plugins and the SSR app are compiled as separate services. Share only
// lifecycle state across those bundles, without constructing a second runtime.
interface RuntimeLifecycle {
	stopMaintenance(): void;
	closeStreams(): Promise<void>;
	close(): Promise<void>;
}
const owner = globalThis as typeof globalThis & {
	__toolstileLifecycle?: { draining: boolean; runtime?: RuntimeLifecycle };
};
const state = () => (owner.__toolstileLifecycle ??= { draining: false });
export const isDraining = () => state().draining;
export const markDraining = () => {
	state().draining = true;
};
export const lifecycleRuntime = () => state().runtime;
export const registerLifecycleRuntime = (runtime: RuntimeLifecycle) => {
	state().runtime = runtime;
};
