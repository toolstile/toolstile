import {
	Client,
	type JSONRPCMessage,
	type Transport,
	type TransportSendOptions,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

/**
 * An MCP server the gateway starts as a child process and speaks to over stdin and stdout.
 * The child runs as the server's operating-system user. Its environment is exactly `env` on
 * top of a small inherited base (`HOME`, `LOGNAME`, `PATH`, `SHELL`, `TERM`, `USER`), never
 * the server's own environment.
 */
export interface LocalCommand {
	command: string;
	args: string[];
	env: Record<string, string>;
}

/** Children running at once across this process; more requests wait for a free slot. */
const LOCAL_COMMAND_LIMIT = 8;
const SLOT_WAIT_MS = 30_000;
/** The end of a child's standard error kept for error messages. */
const STDERR_LIMIT = 4096;

let running = 0;
const waiting: (() => void)[] = [];
const live = new Set<LocalCommandTransport>();
let exitHook = false;

async function acquireSlot(signal?: AbortSignal) {
	if (running < LOCAL_COMMAND_LIMIT) {
		running++;
		return;
	}
	await new Promise<void>((resolve, reject) => {
		const ready = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", aborted);
			running++;
			resolve();
		};
		const leave = (error: Error) => {
			const index = waiting.indexOf(ready);
			if (index >= 0) waiting.splice(index, 1);
			clearTimeout(timer);
			signal?.removeEventListener("abort", aborted);
			reject(error);
		};
		const aborted = () =>
			leave(
				signal?.reason instanceof Error
					? signal.reason
					: new Error("Local command start was cancelled"),
			);
		const timer = setTimeout(
			() =>
				leave(
					new LocalCommandError(
						"too many local commands are running; try again shortly",
					),
				),
			SLOT_WAIT_MS,
		);
		signal?.addEventListener("abort", aborted, { once: true });
		waiting.push(ready);
	});
}
function releaseSlot() {
	running--;
	waiting.shift()?.();
}

/** A local command that could not start or stopped before it answered. */
export class LocalCommandError extends Error {
	readonly reason: string;
	constructor(reason: string, options?: ErrorOptions) {
		super(`The local command failed: ${reason}`, options);
		this.name = "LocalCommandError";
		this.reason = reason;
	}
}

/** Long token-like runs and the configured values are hidden from error messages. */
function redact(text: string, secrets: string[]) {
	let result = text;
	for (const secret of secrets)
		if (secret.length >= 4) result = result.split(secret).join("[redacted]");
	// Without "/", so long file paths in an error stay readable.
	return result.replace(/[A-Za-z0-9+_=-]{32,}/g, "[redacted]");
}

/**
 * The stdio transport for one operation. Every outgoing message goes through `guard`, the
 * same admission, approval and metering the HTTP transports apply to each request body.
 * It holds one of `LOCAL_COMMAND_LIMIT` slots from start to close, and closing stops the
 * child: standard input closes first, then SIGTERM and SIGKILL if it keeps running.
 */
export class LocalCommandTransport implements Transport {
	onclose?: Transport["onclose"];
	onerror?: Transport["onerror"];
	onmessage?: Transport["onmessage"];
	readonly #inner: StdioClientTransport;
	readonly #secrets: string[];
	readonly #guard: (
		message: JSONRPCMessage,
		forward: () => Promise<void>,
	) => Promise<void>;
	readonly #signal?: AbortSignal;
	#stderr = "";
	#holding = false;
	#abort = () => void this.close();
	#exited = false;
	/** True once the child was asked to start, whether or not it did. */
	spawned = false;
	constructor(
		command: LocalCommand,
		options: {
			guard?: (
				message: JSONRPCMessage,
				forward: () => Promise<void>,
			) => Promise<void>;
			signal?: AbortSignal;
		} = {},
	) {
		this.#inner = new StdioClientTransport({
			command: command.command,
			args: command.args,
			env: command.env,
			stderr: "pipe",
		});
		this.#secrets = Object.values(command.env);
		this.#guard = options.guard ?? ((_, forward) => forward());
		this.#signal = options.signal;
		// Always drained, so a chatty child never blocks on a full pipe.
		this.#inner.stderr?.on("data", (chunk: Buffer | string) => {
			this.#stderr = (this.#stderr + String(chunk)).slice(-STDERR_LIMIT);
		});
	}
	/** The end of the child's standard error, with secrets and token-like text hidden. */
	stderrTail() {
		return redact(this.#stderr, this.#secrets).trim().slice(-1000);
	}
	/** Why the command stopped, for an error message, with the end of its standard error. */
	failure(error: unknown) {
		if (error instanceof LocalCommandError) return error;
		const code = (error as { code?: unknown } | undefined)?.code;
		const reason =
			code === "ENOENT"
				? "command not found"
				: code === "EACCES"
					? "permission denied"
					: this.#exited
						? "the process exited before it answered"
						: "the process did not answer as an MCP server";
		const tail = this.stderrTail();
		return new LocalCommandError(
			tail ? `${reason}. Last output: ${tail}` : reason,
			{ cause: error },
		);
	}
	async start() {
		await acquireSlot(this.#signal);
		this.#holding = true;
		this.spawned = true;
		this.#inner.onmessage = (message) => this.onmessage?.(message);
		this.#inner.onerror = (error) => this.onerror?.(error);
		this.#inner.onclose = () => {
			this.#exited = true;
			this.#release();
			this.onclose?.();
		};
		try {
			await this.#inner.start();
		} catch (error) {
			this.#exited = true;
			this.#release();
			throw this.failure(error);
		}
		live.add(this);
		if (!exitHook) {
			exitHook = true;
			// Last resort when the server exits without closing them.
			process.once("exit", () => {
				for (const transport of live) transport.kill();
			});
		}
		if (this.#signal?.aborted) await this.close();
		else this.#signal?.addEventListener("abort", this.#abort, { once: true });
	}
	send(message: JSONRPCMessage, _options?: TransportSendOptions) {
		return this.#guard(message, () => this.#inner.send(message));
	}
	async close() {
		try {
			await this.#inner.close();
		} finally {
			this.#release();
		}
	}
	/** Ends the child at once; used only when the server itself is exiting. */
	kill() {
		const pid = this.#inner.pid;
		if (pid)
			try {
				process.kill(pid, "SIGKILL");
			} catch {}
	}
	#release() {
		live.delete(this);
		this.#signal?.removeEventListener("abort", this.#abort);
		if (!this.#holding) return;
		this.#holding = false;
		releaseSlot();
	}
}

/** Stops every running local command; the server calls this while shutting down. */
export async function closeLocalCommands() {
	await Promise.allSettled([...live].map((transport) => transport.close()));
}

/**
 * The check before saving a local command: start it, complete the MCP handshake and stop it.
 * Like the address check for remote servers it is not an operation, so nothing is admitted
 * or recorded.
 */
export async function checkLocalCommand(
	command: LocalCommand,
	timeoutMs = 20_000,
) {
	const transport = new LocalCommandTransport(command);
	const client = new Client(
		{ name: "toolstile-connection-probe", version: "0.1.0" },
		{ versionNegotiation: { mode: "legacy" } },
	);
	try {
		await client.connect(transport, { timeout: timeoutMs });
	} catch (error) {
		throw transport.failure(error);
	} finally {
		await client.close().catch(() => {});
	}
}
