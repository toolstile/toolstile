import {
	DestinationError,
	OAuthError,
	upstreamUnreachable,
} from "@toolstile/gateway";

function* causes(error: unknown) {
	let current = error;
	for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
		yield current;
		current = current.cause;
	}
}

/** A network-policy refusal, including one raised at connection time inside "fetch failed". */
export function destinationRefused(error: unknown) {
	for (const current of causes(error))
		if (current instanceof DestinationError) return true;
	return false;
}

/**
 * A short, loggable failure class. Never the message: provider and fetch errors can quote URLs,
 * codes, state or tokens.
 */
export function failureReason(error: unknown): string {
	for (const current of causes(error)) {
		if (current instanceof DestinationError) return "destination refused";
		if (current instanceof OAuthError)
			return `oauth ${/^[a-z_]{1,64}$/.test(current.code) ? current.code : "error"}`;
	}
	return (
		upstreamUnreachable(error) ??
		(error instanceof Error ? error.name : "unknown")
	);
}
