import { type Verification, verificationView } from "@toolstile/api/contract";

/*
 * The last catalog seen for each connection, kept in this browser so the access page opens with
 * names and descriptions at once. It is only display data: access is always enforced against the
 * live server. A new check happens on Refresh, or when nothing is stored yet.
 */

const prefix = "toolstile:catalog:";
/** Entries above this size are not kept; such catalogs are checked on each visit instead. */
const maxBytes = 512_000;

const key = (scope: string, id: string) => `${prefix}${scope}:${id}`;

/** The stored catalog for a connection, unless its address has changed since. */
export function readCatalogCache(scope: string, id: string, url: string) {
	try {
		const raw = localStorage.getItem(key(scope, id));
		if (!raw) return undefined;
		const stored: unknown = JSON.parse(raw);
		if (!stored || typeof stored !== "object") return undefined;
		const {
			url: storedUrl,
			checkedAt,
			data,
		} = stored as Record<string, unknown>;
		const catalog = verificationView.safeParse(data);
		if (storedUrl !== url || typeof checkedAt !== "string" || !catalog.success)
			return undefined;
		return { data: catalog.data, checkedAt };
	} catch {
		return undefined;
	}
}

export function writeCatalogCache(
	scope: string,
	id: string,
	url: string,
	data: Verification,
	checkedAt: string,
) {
	try {
		const value = JSON.stringify({ url, checkedAt, data });
		if (value.length > maxBytes) localStorage.removeItem(key(scope, id));
		else localStorage.setItem(key(scope, id), value);
	} catch {
		// Storage may be full or disabled; the catalog is then checked on each visit.
	}
}
