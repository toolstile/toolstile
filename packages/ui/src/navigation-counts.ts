import { useEffect, useState } from "react";

/** Loaders for the sidebar's actionable counts, keyed by navigation section id. */
export type NavigationCountLoaders = Record<string, () => Promise<number>>;

/**
 * Counts of waiting work for sidebar sections (pending approvals, tool changes to review),
 * reloaded whenever `refreshKey` changes, such as on navigation. A refused or failed load
 * shows no count rather than an error: the sidebar never blocks on these.
 */
export function useNavigationCounts(
	loaders: NavigationCountLoaders,
	refreshKey: string,
) {
	const [counts, setCounts] = useState<Record<string, number>>({});
	// loaders are recreated each render; the key decides when to reload.
	useEffect(() => {
		let live = true;
		for (const [id, load] of Object.entries(loaders))
			load()
				.then((count) => {
					if (live) setCounts((previous) => ({ ...previous, [id]: count }));
				})
				.catch(() => {
					if (live)
						setCounts((previous) => {
							const { [id]: _, ...rest } = previous;
							return rest;
						});
				});
		return () => {
			live = false;
		};
	// oxlint-disable-next-line react-hooks/exhaustive-deps -- loaders are recreated each render; the key decides when to reload.
	}, [refreshKey]);
	return counts;
}

/** Adds each section's count to its navigation item; zero and unknown counts show nothing. */
export function withNavigationCounts<T extends { id: string }>(
	items: T[],
	counts: Record<string, number>,
): (T & { count?: number })[] {
	return items.map((item) =>
		counts[item.id] ? { ...item, count: counts[item.id] } : item,
	);
}
