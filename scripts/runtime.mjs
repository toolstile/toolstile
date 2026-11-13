// Local runtime adapter: setup, stop, resume, teardown, check and dev for this checkout.
import { runLifecycleCli } from "./worktree-resources.mjs";

await runLifecycleCli({
	envPath: "apps/web/.env",
	appDir: "apps/web",
	portStart: 4400,
}).catch((error) => {
	console.error(`runtime: ${error.message}`);
	process.exitCode = 1;
});
