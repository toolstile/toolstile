import { describe, expect, it } from "vitest";
import { formatExpiry, formatRelative } from "./format";
import { connectionMarkColors, contrastRatio, hslToRgb } from "./identity";

const now = new Date("2026-10-19T12:00:00Z");
const later = (days: number) => new Date(now.getTime() + days * 86_400_000);

describe("formatExpiry", () => {
	it("uses relative phrasing", () => {
		expect(formatExpiry(later(90), now)).toBe("Expires in 3 months");
		expect(formatExpiry(later(1), now)).toBe("Expires tomorrow");
		expect(formatExpiry(later(6), now)).toBe("Expires in 6 days");
		expect(formatExpiry(later(21), now)).toBe("Expires in 3 weeks");
		expect(formatExpiry(later(800), now)).toBe("Expires in 2 years");
		expect(formatExpiry(later(-1), now)).toBe("Expired");
	});

	it("handles past dates in formatRelative", () => {
		expect(formatRelative(new Date(now.getTime() - 20_000), now)).toBe(
			"just now",
		);
		expect(formatRelative(later(-2), now)).toBe("2 days ago");
		expect(formatRelative(new Date(now.getTime() + 5 * 60_000), now)).toBe(
			"in 5 minutes",
		);
	});

	it("has a compact form for narrow columns", () => {
		const ago = (ms: number) => new Date(now.getTime() - ms);
		expect(formatRelative(ago(20_000), now, { compact: true })).toBe(
			"just now",
		);
		expect(formatRelative(ago(4 * 60_000), now, { compact: true })).toBe(
			"4m ago",
		);
		expect(formatRelative(later(-1), now, { compact: true })).toBe("1d ago");
		expect(formatRelative(later(-21), now, { compact: true })).toBe("3w ago");
	});
});

describe("connectionMarkColors", () => {
	const parse = (css: string) => {
		const [hue, saturation, lightness] = (css.match(/[\d.]+/g) ?? []).map(
			Number,
		);
		return hslToRgb(hue, saturation, lightness);
	};

	it("is deterministic per host and ignores the path", () => {
		expect(connectionMarkColors("https://mcp.linear.app/sse")).toEqual(
			connectionMarkColors("https://mcp.linear.app/other"),
		);
	});

	it("keeps text readable in both themes", () => {
		for (const host of ["a.example", "mcp.linear.app", "127.0.0.1:4312", "x"]) {
			const { light, dark } = connectionMarkColors(`https://${host}/mcp`);
			expect(
				contrastRatio(parse(light.text), parse(light.background)),
			).toBeGreaterThanOrEqual(7);
			expect(
				contrastRatio(parse(dark.text), parse(dark.background)),
			).toBeGreaterThanOrEqual(7);
		}
	});
});
