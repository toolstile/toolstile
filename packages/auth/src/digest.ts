import { createHash } from "node:crypto";

/** SHA-256 hex digest for one-way storage of opaque tokens, states and identities. */
export const digest = (value: string) =>
	createHash("sha256").update(value).digest("hex");
