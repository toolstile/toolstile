/** True only when `work` fulfills within `limitMs`. A rejection or a still-pending
 * promise both report false, so the caller can fall back to a hard reset. */
export async function settlesWithin(
	work: Promise<unknown>,
	limitMs: number,
): Promise<boolean> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			work.then(
				() => true,
				() => false,
			),
			new Promise<boolean>((resolve) => {
				timer = setTimeout(() => resolve(false), limitMs);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}
