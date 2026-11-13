import { createHash } from "node:crypto";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import {
	type CatalogDocument,
	catalogLogoProblem,
	type LogoFile,
	parseCatalog,
} from "@toolstile/api/catalog-source";

/** The bundled snapshot: `packages/api/catalog/v1.json` plus `logos/<sha256>.<type>`. */
export const snapshotDirectory = new URL(
	"../../../packages/api/catalog/",
	import.meta.url,
);
export const snapshotFile = new URL("v1.json", snapshotDirectory);

/**
 * Writes the snapshot after validating it the way the running source will: every entry must
 * parse and every logo must match its hash and type. Logo files no entry references are removed.
 */
export async function writeCatalogSnapshot(
	document: CatalogDocument,
	logos: Map<string, LogoFile>,
	directory: URL = snapshotDirectory,
) {
	const parsed = parseCatalog(JSON.parse(JSON.stringify(document)));
	if (
		!parsed ||
		parsed.dropped ||
		parsed.entries.length !== document.entries.length
	)
		throw new Error("The snapshot does not validate as a v1 catalog");
	const files = new Map<string, Uint8Array>();
	for (const { slug, logo } of document.entries) {
		if (!logo) continue;
		const file = logos.get(logo.sha256);
		if (
			!file ||
			file.type !== logo.type ||
			createHash("sha256").update(file.body).digest("hex") !== logo.sha256
		)
			throw new Error(`${slug}: logo file does not match its entry`);
		const problem = catalogLogoProblem(logo.type, file.body);
		if (problem) throw new Error(`${slug}: ${problem}`);
		files.set(`${logo.sha256}.${logo.type}`, file.body);
	}
	const logoDirectory = new URL("logos/", directory);
	await mkdir(logoDirectory, { recursive: true });
	for (const name of await readdir(logoDirectory))
		if (!files.has(name)) await rm(new URL(name, logoDirectory));
	for (const [name, body] of files)
		await writeFile(new URL(name, logoDirectory), body);
	await writeFile(
		new URL("v1.json", directory),
		`${JSON.stringify(document, null, 2)}\n`,
	);
	return files.size;
}
