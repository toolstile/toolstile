// Reject duplicate keys in tracked JSON files. JSON.parse silently keeps the last value,
// and Oxlint does not lint JSON. Usage: node lint/json-keys.mjs <path>...
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const ignored = [/(^|\/)node_modules\//, /(^|\/)(dist|\.output|coverage)\//, /packages\/api\/catalog\//];

/** Returns the duplicate keys of every object in the JSON text, with line numbers. */
export function duplicateKeys(source) {
	let index = 0;
	const found = [];
	const line = () => source.slice(0, index).split("\n").length;
	const space = () => {
		while (/\s/.test(source[index] ?? "")) index++;
	};
	const string = () => {
		const start = index++;
		while (source[index] !== '"') index += source[index] === "\\" ? 2 : 1;
		index++;
		return JSON.parse(source.slice(start, index));
	};
	const value = () => {
		space();
		const char = source[index];
		if (char === "{") {
			index++;
			const keys = new Set();
			space();
			if (source[index] === "}") return void index++;
			for (;;) {
				space();
				const at = line();
				const key = string();
				if (keys.has(key)) found.push({ key, line: at });
				keys.add(key);
				space();
				index++; // colon
				value();
				space();
				if (source[index++] === "}") return;
			}
		}
		if (char === "[") {
			index++;
			space();
			if (source[index] === "]") return void index++;
			for (;;) {
				value();
				space();
				if (source[index++] === "]") return;
			}
		}
		if (char === '"') return void string();
		while (index < source.length && !/[\s,\]}]/.test(source[index])) index++;
	};
	JSON.parse(source); // reject invalid JSON before scanning
	value();
	return found;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const files = execFileSync("git", ["ls-files", "--", ...process.argv.slice(2)], { encoding: "utf8" })
		.split("\n")
		.filter((file) => file.endsWith(".json") && !ignored.some((pattern) => pattern.test(file)));
	let problems = 0;
	for (const file of files)
		for (const { key, line } of duplicateKeys(readFileSync(file, "utf8"))) {
			console.error(`${file}:${line}: duplicate key "${key}"`);
			problems++;
		}
	if (problems) process.exitCode = 1;
	else console.log(`No duplicate JSON keys in ${files.length} file(s).`);
}
