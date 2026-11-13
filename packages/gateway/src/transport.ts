import { Agent, fetch } from "undici";

export { Agent };
/** Node connects through the address-pinning dispatcher and never follows redirects. */
export const send = (
	input: string,
	init: Omit<NonNullable<Parameters<typeof fetch>[1]>, "redirect">,
) => fetch(input, { ...init, redirect: "error" });
