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
	/** `on` lets operators add local commands (stdio MCP servers); local mode only. */
	TOOLSTILE_STDIO: z
		.string()
		.optional()
		.transform((value) => value?.trim().toLowerCase() || "off")
		.pipe(
			z.enum(["on", "off"], {
				message: "TOOLSTILE_STDIO must be on or off",
			}),
		),
});
/** A PostgreSQL server URL; anything else is an embedded PGlite directory (local mode). */
const postgresUrl = (value: string) => /^postgres(?:ql)?:\/\//i.test(value);
const configuration = schema.superRefine((value, context) => {
	// A child process runs as the server's user and can read its keys, so local commands
	// are for one person's own computer, never a shared container or cluster deployment.
	if (value.TOOLSTILE_STDIO === "on" && postgresUrl(value.DATABASE_URL))
		context.addIssue({
			code: "custom",
			path: ["TOOLSTILE_STDIO"],
			message:
				"TOOLSTILE_STDIO=on is supported only in local mode (an embedded PGlite database); unset it or set it to off",
		});
});
const parsed = configuration.safeParse(process.env);
if (!parsed.success)
	// Name the variables and problems only; never echo the configured values.
	throw new Error(`Invalid server configuration:
${parsed.error.issues
	.map((issue) => `- ${issue.path.join(".")}: ${issue.message}`)
	.join("\n")}`);
export const env = {
	...parsed.data,
	/** Operators may add local commands, and existing ones may run. */
	localCommands: parsed.data.TOOLSTILE_STDIO === "on",
};
