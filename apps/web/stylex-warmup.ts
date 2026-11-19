import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Every non-test source file under `directories` that imports StyleX, for Vite's dev warmup.
 *
 * The StyleX plugin collects a module's rules only when Vite transforms it, and the dev
 * stylesheet (`/virtual:stylex.css`) serves only the rules collected so far. Without warmup, a
 * page's components compile on its first visit, so the page renders a few frames before its
 * rules reach the stylesheet. Warming these files compiles every rule when the server starts.
 */
export function stylexSources(directories: readonly string[]): string[] {
	const files: string[] = [];
	for (const directory of directories)
		for (const entry of readdirSync(directory, {
			recursive: true,
			withFileTypes: true,
		})) {
			if (!entry.isFile() || !/\.tsx?$/.test(entry.name)) continue;
			if (/\.(test|d)\.tsx?$/.test(entry.name)) continue;
			const file = join(entry.parentPath, entry.name);
			if (readFileSync(file, "utf8").includes("@stylexjs/stylex"))
				files.push(file);
		}
	return files.sort();
}
