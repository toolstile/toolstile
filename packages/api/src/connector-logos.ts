import type { CatalogSource } from "./catalog-source.js";

const contentTypes: Record<string, string> = {
	svg: "image/svg+xml",
	png: "image/png",
	webp: "image/webp",
};

const notFound = () =>
	new Response("Not Found", {
		status: 404,
		headers: {
			"Content-Type": "text/plain; charset=utf-8",
			"Cache-Control": "no-store",
			"X-Content-Type-Options": "nosniff",
		},
	});
/**
 * Serves `/connector-logos/<id>-<hash>.<ext>` from the catalog source's validated logo files
 * (the remote copy or the bundled snapshot) when the entry's logo has that hash and type;
 * anything else is 404. Never sets cookies or varies by request.
 */
export async function connectorLogoResponse(
	source: Pick<CatalogSource, "logoFile">,
	request: Request,
) {
	const match =
		/^\/connector-logos\/([a-z][a-z0-9-]{0,63})-([0-9a-f]{16})\.([a-z]{3,4})$/.exec(
			new URL(request.url).pathname,
		);
	if (!match) return notFound();
	const [, id, hash, extension] = match;
	const file = await source.logoFile(id, hash, extension);
	if (!file) return notFound();
	const headers = new Headers({
		"Content-Type": contentTypes[file.type],
		"Content-Length": String(file.body.byteLength),
		"Cache-Control": "public, max-age=31536000, immutable",
		"X-Content-Type-Options": "nosniff",
	});
	// Opened directly, an SVG is a document: no scripts, requests or same-origin access.
	if (file.type === "svg")
		headers.set(
			"Content-Security-Policy",
			// SVG logos may embed raster images as data URIs (validated on load); nothing else loads.
			"default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox",
		);
	return new Response(
		request.method === "HEAD" ? null : new Uint8Array(file.body),
		{ status: 200, headers },
	);
}
