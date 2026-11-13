import { ORPCError } from "@orpc/server";
import { expect, it } from "vitest";
import { createAgentConsentHandler } from "../src/http";

it.each([
	[
		new ORPCError("FORBIDDEN", {
			message: "Sign in again before changing account security",
		}),
		"Sign in again before changing account security",
	],
	[
		new ORPCError("INTERNAL_SERVER_ERROR", { message: "private SQL details" }),
		"Authorization failed. Try again.",
	],
	[new Error("private database details"), "Authorization failed. Try again."],
])("exposes only safe consent guidance for %s", async (error, message) => {
	const handler = createAgentConsentHandler({
		origin: "https://fixture.invalid",
		secret: "fixture",
		session: async () => ({ user: { id: "user" }, session: { id: "session" } }),
		resolveActor: async () => ({ userId: "user" }),
		clientName: async () => null,
		browserDevice: { lookup: async () => null, bind: async () => {} },
		list: async () => {
			throw error;
		},
		addDevice: async () => ({ id: "device" }),
		addAgent: async () => ({ id: "agent" }),
		resolveReference: async () => "reference",
		describeReference: async () => ({
			agentLabel: "Agent",
			deviceLabel: "Device",
		}),
		selection: { save: async () => {}, lookup: async () => undefined },
	});
	const response = await handler(
		new Request("https://fixture.invalid/consent"),
	);
	expect(response.status).toBe(400);
	expect(await response.json()).toEqual({ message });
});
