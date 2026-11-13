/** A request body that exceeded its size or time budget, or could not be read. */
export class BodyReadError extends Error {
	constructor(
		public readonly status: 400 | 408 | 413,
		message: string,
	) {
		super(message);
	}
}

export type BodyLimits = {
	/** Largest accepted body in bytes, counted as received. */
	maximum: number;
	/** Total time allowed to receive the whole body. */
	timeoutMs?: number;
};

/** Reads at most `maximum` bytes within `timeoutMs`, cancelling the source on
 * overflow or expiry. A declared Content-Length cannot bypass the streaming
 * count, and cancellation never extends the deadline. A missing body is empty. */
export async function readBoundedBody(
	request: Pick<Request, "body" | "headers">,
	{ maximum, timeoutMs = 10_000 }: BodyLimits,
): Promise<Uint8Array<ArrayBuffer>> {
	const cancel = () => {
		void request.body?.cancel().catch(() => {});
	};
	if (Number(request.headers.get("content-length")) > maximum) {
		cancel();
		throw new BodyReadError(413, "Request body is too large");
	}
	if (!request.body) return new Uint8Array();
	const reader = request.body.getReader();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const expired = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			reject(new BodyReadError(408, "Request body timed out"));
			void reader.cancel().catch(() => {});
		}, timeoutMs);
	});
	// Memory follows the bytes actually received, not the permitted maximum.
	const chunks: Uint8Array[] = [];
	const expiresAt = performance.now() + timeoutMs;
	let size = 0;
	try {
		while (true) {
			const { done, value } = await Promise.race([reader.read(), expired]);
			if (performance.now() >= expiresAt) {
				void reader.cancel().catch(() => {});
				throw new BodyReadError(408, "Request body timed out");
			}
			if (done) break;
			if (size + value.byteLength > maximum) {
				void reader.cancel().catch(() => {});
				throw new BodyReadError(413, "Request body is too large");
			}
			chunks.push(value);
			size += value.byteLength;
		}
		const bytes = new Uint8Array(size);
		let offset = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return bytes;
	} catch (error) {
		if (error instanceof BodyReadError) throw error;
		void reader.cancel().catch(() => {});
		throw new BodyReadError(400, "Invalid request body");
	} finally {
		clearTimeout(timer);
		reader.releaseLock();
	}
}

/** Parses a bounded UTF-8 JSON body; any read or parse failure is a BodyReadError. */
export async function readJsonBody(
	request: Pick<Request, "body" | "headers">,
	maximum: number,
	timeoutMs?: number,
): Promise<unknown> {
	try {
		const bytes = await readBoundedBody(request, { maximum, timeoutMs });
		return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	} catch (error) {
		if (error instanceof BodyReadError && error.status !== 400) throw error;
		throw new BodyReadError(400, "Invalid JSON body");
	}
}

/** A copy of `request` whose body has been read within `limits`. */
export async function boundedRequest(
	request: Request,
	limits: BodyLimits,
): Promise<Request> {
	if (!request.body) return request;
	const body = await readBoundedBody(request, limits);
	// Node adapters may supply a Fetch-compatible wrapper without Request's
	// native brand. Copy its public fields rather than passing it as input.
	return new Request(request.url, {
		method: request.method,
		headers: request.headers,
		signal: request.signal,
		body,
	});
}

/** Bound the body before SDK routing, cloning or parsing, including established sessions. */
export async function boundedMcpRequest(
	request: Request,
): Promise<Request | Response> {
	try {
		return await boundedRequest(request, {
			maximum: 2 * 1024 * 1024,
			timeoutMs: 10_000,
		});
	} catch (error) {
		const status = error instanceof BodyReadError ? error.status : 400;
		return new Response(
			status === 413
				? "MCP request too large"
				: status === 408
					? "MCP request body timed out"
					: "Invalid MCP request body",
			{ status },
		);
	}
}
