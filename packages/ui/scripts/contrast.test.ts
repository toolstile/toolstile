import { describe, expect, it } from "vitest";
import { connectionMarkColors, contrastRatio, hslToRgb } from "../src/identity";
import { audit, passes, themeSelectors, variables } from "./contrast";

describe("palette contrast", () => {
	for (const theme of ["light", "dark"] as const)
		it(`meets every target in the ${theme} theme`, () => {
			const failures = audit(theme)
				.filter((row) => !passes(row))
				.map(
					(row) =>
						`${row.foreground} on ${row.background}: ${row.ratio.toFixed(2)} outside ${row.minimum}–${row.maximum ?? "∞"}`,
				);
			expect(failures).toEqual([]);
		});

	it("keeps connection monogram text at 4.5:1 or more on its tile in both themes", () => {
		const rgb = (hsl: string) => {
			const [h, s, l] = (hsl.match(/[\d.]+/g) ?? []).map(Number);
			return hslToRgb(h, s, l);
		};
		let lowest = Number.POSITIVE_INFINITY;
		for (let index = 0; index < 2000; index++) {
			const { light, dark } = connectionMarkColors(
				`https://mcp-${index}.example`,
			);
			for (const tile of [light, dark])
				lowest = Math.min(
					lowest,
					contrastRatio(rgb(tile.text), rgb(tile.background)),
				);
		}
		expect(lowest).toBeGreaterThanOrEqual(4.5);
	});

	it("keeps the system and explicit dark themes identical", () => {
		expect(Object.fromEntries(variables(themeSelectors.systemDark))).toEqual(
			Object.fromEntries(variables(themeSelectors.dark)),
		);
	});
});
