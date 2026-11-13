const day = 86_400_000;
const relativeLong = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
const narrow = new Intl.RelativeTimeFormat("en", { style: "narrow" });

/**
 * Relative phrasing such as "in 3 months", "tomorrow" or "2 days ago", computed on the client.
 * `compact` gives "just now", "4m ago" or "2d ago" for narrow columns.
 */
export function formatRelative(
	date: Date | string | number,
	now: Date | number = Date.now(),
	{ compact = false }: { compact?: boolean } = {},
) {
	const delta = new Date(date).getTime() - new Date(now).getTime();
	const days = Math.abs(delta) / day;
	const sign = delta < 0 ? -1 : 1;
	if (delta <= 0 && delta > -60_000) return "just now";
	const relative = compact ? narrow : relativeLong;
	if (days < 1 / 24)
		return relative.format(
			sign * Math.max(1, Math.round(Math.abs(delta) / 60_000)),
			"minute",
		);
	if (days < 1) return relative.format(sign * Math.round(days * 24), "hour");
	if (days < 14) return relative.format(sign * Math.round(days), "day");
	if (days < 60) return relative.format(sign * Math.round(days / 7), "week");
	if (days < 365) return relative.format(sign * Math.round(days / 30), "month");
	return relative.format(sign * Math.round(days / 365), "year");
}

/** "Expires in 3 months", "Expires tomorrow" or "Expired". */
export function formatExpiry(
	date: Date | string | number,
	now: Date | number = Date.now(),
) {
	if (new Date(date).getTime() <= new Date(now).getTime()) return "Expired";
	return `Expires ${formatRelative(date, now)}`;
}

/** Full locale date and time for title attributes next to relative text. */
export function formatFullDate(date: Date | string | number) {
	return new Date(date).toLocaleString(undefined, {
		dateStyle: "full",
		timeStyle: "short",
	});
}
