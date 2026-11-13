import assert from "node:assert/strict";

/** Assert fixture prerequisites before using their values. */
export function defined<T>(value: T | null | undefined): T {
	assert.ok(value !== null && value !== undefined, "Expected a fixture value");
	return value;
}
