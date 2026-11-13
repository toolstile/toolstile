import { lookup as resolve } from "node:dns/promises";
export const resolveDestination = (hostname: string) => resolve(hostname, {all: true});
export { lookup } from "node:dns";
