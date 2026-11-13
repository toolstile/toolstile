import {
	createUpstreamOAuthService,
	type secretBox,
	type UpstreamOAuthServiceOptions,
} from "@toolstile/auth";
import type { Pool } from "@toolstile/database/sql";
import { validateHttpDestination } from "@toolstile/gateway";

export function createInstanceUpstreamOAuth(options: {
	pool: Pool;
	box: ReturnType<typeof secretBox>;
	baseURL: string;
	authorize(userId: string, connectionId: string): Promise<{ url: string }>;
	validateDestination?(url: URL): Promise<void>;
	fetch?: typeof fetch;
	registeredClient?: UpstreamOAuthServiceOptions<void>["registeredClient"];
}) {
	const service = createUpstreamOAuthService<void>({
		...options,
		validateDestination: options.validateDestination ?? validateHttpDestination,
		authorize: (owner, id) => options.authorize(owner.userId, id),
		saveContext: async () => {},
		loadContext: async () => undefined,
	});
	return { ...service, close: async () => {} };
}
