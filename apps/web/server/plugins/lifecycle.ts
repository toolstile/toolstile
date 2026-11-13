import { definePlugin } from "nitro";
import { lifecycleRuntime, markDraining } from "../../src/server/lifecycle";

export default definePlugin((app) => {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let deadline: ReturnType<typeof setTimeout> | undefined;
	let started = false;
	const drain = () => {
		if (started) return;
		started = true;
		markDraining();
		lifecycleRuntime()?.stopMaintenance();
		// srvx closes HTTP admission. Close long-lived MCP streams after a brief
		// drain so they cannot prevent Nitro's final close hook from running.
		timer = setTimeout(() => {
			void lifecycleRuntime()
				?.closeStreams()
				.catch(() => {
					console.error("MCP shutdown failed");
				});
		}, 2000);
		deadline = setTimeout(() => {
			console.error(
				"Shutdown deadline exceeded; interrupted actions are not retried",
			);
			process.exit(1);
		}, 25000);
	};
	process.prependListener("SIGTERM", drain);
	process.prependListener("SIGINT", drain);
	app.hooks.hook("close", async () => {
		drain();
		let closed = false;
		try {
			await lifecycleRuntime()?.close();
			closed = true;
		} catch {
			process.exitCode = 1;
			// Nitro catches hook failures. Keep our deadline and a failing status
			// even if a failed cleanup leaves background handles alive.
			throw new Error("Runtime cleanup failed");
		} finally {
			if (timer) clearTimeout(timer);
			if (deadline && closed) clearTimeout(deadline);
			process.removeListener("SIGTERM", drain);
			process.removeListener("SIGINT", drain);
		}
	});
});
