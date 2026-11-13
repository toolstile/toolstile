import type { Pool } from "@toolstile/database/sql";
import { createDestinationPolicy } from "@toolstile/gateway";

export { permittedAddress } from "@toolstile/gateway";
export function createInstanceDestinationPolicy(pool: Pool) {
	return createDestinationPolicy({
		allowPrivateNetworks: async () => {
			const {
				rows: [settings],
			} = await pool.query(
				"select \"allowPrivateNetwork\" from instance_settings where id='instance'",
			);
			return settings?.allowPrivateNetwork !== false;
		},
	});
}
