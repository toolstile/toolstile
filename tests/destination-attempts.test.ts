import { expect, it, vi } from "vitest";

const agents = vi.hoisted((): unknown[] => []);
// The gateway's own undici copy; the repository root does not install one.
vi.mock("../packages/gateway/node_modules/undici", async (original) => {
	const undici =
		await original<typeof import("../packages/gateway/node_modules/undici")>();
	return {
		...undici,
		Agent: class extends undici.Agent {
			constructor(options: ConstructorParameters<typeof undici.Agent>[0]) {
				super(options);
				agents.push(options);
			}
		},
	};
});

it("gives each address of a distant upstream more than Node's 250 ms to connect", async () => {
	const { createDestinationPolicy } = await import(
		"../packages/gateway/src/network"
	);
	createDestinationPolicy();
	// Public, private and plain-HTTP (private-only) dispatchers.
	expect(agents).toHaveLength(3);
	for (const options of agents)
		expect(options).toMatchObject({
			connect: {
				autoSelectFamily: true,
				autoSelectFamilyAttemptTimeout: 2_000,
				lookup: expect.any(Function),
			},
		});
});
