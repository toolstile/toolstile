import { z } from "zod";

/** Example values from the .env.example files; an unedited copy must not start. */
const placeholder = (value: string) =>
	/replace|change-me|changeme/i.test(value);
const schema = z.object({
	DATABASE_URL: z
		.string()
		.min(1)
		.refine((value) => !placeholder(value), {
			message: "DATABASE_URL must name PostgreSQL or a PGlite data directory",
		}),
	BETTER_AUTH_URL: z.url().transform((value) => new URL(value).origin),
	BETTER_AUTH_SECRET: z
		.string()
		.min(32)
		.refine((value) => !placeholder(value), {
			message:
				"BETTER_AUTH_SECRET is still the example placeholder; generate one with `openssl rand -hex 32`",
		}),
	ENCRYPTION_KEY: z.string().regex(/^[a-f0-9]{64}$/i, {
		message:
			"ENCRYPTION_KEY must be 64 hex characters (`openssl rand -hex 32`)",
	}),
});
const parsed = schema.safeParse(process.env);
if (!parsed.success)
	// Name the variables and problems only; never echo the configured values.
	throw new Error(`Invalid server configuration:
${parsed.error.issues
	.map((issue) => `- ${issue.path.join(".")}: ${issue.message}`)
	.join("\n")}`);
export const env = parsed.data;
