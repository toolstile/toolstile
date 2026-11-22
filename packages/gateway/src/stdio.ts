import type { ChildProcess } from "node:child_process";
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

let running = 0;
let shuttingDown = false;
const waiting: { ready(): void; fail(error: Error): void }[] = [];
const live = new Set<LocalCommandTransport>();
let exitHook = false;

const shutdownError = () =>
	new LocalCommandError("the server is shutting down");
function cancelled(signal?: AbortSignal) {
	return signal?.reason instanceof Error
		? signal.reason
		: new Error("Local command start was cancelled");
}
async function acquireSlot(signal?: AbortSignal) {
	if (shuttingDown) throw shutdownError();
	if (signal?.aborted) throw cancelled(signal);
	if (running < LOCAL_COMMAND_LIMIT) {
		running++;
		return;
	}
	await new Promise<void>((resolve, reject) => {
		const entry = {
			ready() {
				done();
				running++;
				resolve();
			},
			fail(error: Error) {
				done();
				reject(error);
			},
		};
		const done = () => {
			const index = waiting.indexOf(entry);
			if (index >= 0) waiting.splice(index, 1);
			clearTimeout(timer);
			signal?.removeEventListener("abort", aborted);
		};
		const aborted = () => entry.fail(cancelled(signal));
		const timer = setTimeout(
			() =>
				entry.fail(
					new LocalCommandError(
						"too many local commands are running; try again shortly",
					),
				),
			SLOT_WAIT_MS,
		);
		signal?.addEventListener("abort", aborted, { once: true });
		waiting.push(entry);
	});
}
function releaseSlot() {
	running--;
	waiting[0]?.ready();
}

/**
 * A local command that could not start or stopped before it answered. The reason is fixed
 * text (and an exit code); the child's output never reaches a client.
 */
export class LocalCommandError extends Error {
	readonly reason: string;
	constructor(reason: string, options?: ErrorOptions) {
		super(`The local command failed: ${reason}`, options);
		this.name = "LocalCommandError";
		this.reason = reason;
	}
}

/**
 * The stdio transport for one operation. Every outgoing message goes through `guard`, the
 * same admission, approval and metering the HTTP transports apply to each request body.
 * It holds one of `LOCAL_COMMAND_LIMIT` slots from just before the child starts until the
 * child has exited. `authorize` runs once the slot is held, right before the child starts,
 * so a request that waited for a slot never starts on authorization that has since ended.
 * Closing stops the child: standard input closes first, then SIGTERM and SIGKILL if it
 * keeps running. The child's standard error is discarded.
 */
export class LocalCommandTransport implements Transport {
	onclose?: Transport["onclose"];
	onerror?: Transport["onerror"];
	onmessage?: Transport["onmessage"];
	readonly #inner: StdioClientTransport;
	readonly #guard: (
		message: JSONRPCMessage,
		forward: () => Promise<void>,
	) => Promise<void>;
	readonly #authorize?: () => Promise<void>;
	readonly #signal?: AbortSignal;
	#holding = false;
	#abort = () => void this.close();
	#closing?: Promise<void>;
	#exitCode: number | null = null;
	#child?: ChildProcess;
	/** Settles once the child has exited (or never started); the slot is released then. */
	#exited?: Promise<void>;
	/** True once the child was asked to start, whether or not it did. */
	spawned = false;
	constructor(
		command: LocalCommand,
		options: {
			guard?: (
				message: JSONRPCMessage,
				forward: () => Promise<void>,
			) => Promise<void>;
			authorize?: () => Promise<void>;
			signal?: AbortSignal;
		} = {},
	) {
		this.#inner = new StdioClientTransport({
			command: command.command,
			args: command.args,
			env: command.env,
			stderr: "ignore",
		});
		this.#guard = options.guard ?? ((_, forward) => forward());
		this.#authorize = options.authorize;
		this.#signal = options.signal;
	}
	/** Why the command stopped, as fixed text for an error message. */
	failure(error: unknown) {
		if (error instanceof LocalCommandError) return error;
		const code = (error as { code?: unknown } | undefined)?.code;
		const reason =
			code === "ENOENT"
				? "command not found"
				: code === "EACCES"
					? "permission denied"
					: this.#exitCode !== null
						? `the command exited before answering (exit code ${this.#exitCode})`
						: "the command did not answer as an MCP server";
		return new LocalCommandError(reason, { cause: error });
	}
	async start() {
		await acquireSlot(this.#signal);
		this.#holding = true;
		try {
			await this.#authorize?.();
			if (shuttingDown) throw shutdownError();
			if (this.#signal?.aborted) throw cancelled(this.#signal);
			if (this.#closing)
				throw new Error("Local command closed before it started");
		} catch (error) {
			this.#release();
			throw error;
		}
		this.spawned = true;
		live.add(this);
		this.#inner.onmessage = (message) => this.onmessage?.(message);
		this.#inner.onerror = (error) => this.onerror?.(error);
		this.#inner.onclose = () => this.onclose?.();
		const started = this.#inner.start();
		// The SDK keeps its child private; its exit, not the end of its pipes, frees the slot.
		const child = (this.#inner as unknown as { _process?: ChildProcess })
			._process;
		this.#child = child;
		this.#exited = new Promise<void>((resolve) => {
			if (!child || child.exitCode !== null || child.signalCode !== null)
				return resolve();
			child.once("exit", (code) => {
				this.#exitCode = code;
				resolve();
			});
			// A child that never started has no pid; any other error (a failed kill signal,
			// a pipe error) leaves it running, so its slot stays held until it exits.
			child.once("error", () => {
				if (child.pid === undefined) resolve();
			});
		}).then(() => this.#release());
		try {
			await started;
		} catch (error) {
			await this.#exited;
			throw this.failure(error);
		}
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
	/** One shared close per transport; it settles only after the child has exited. */
	close() {
		this.#closing ??= (async () => {
			try {
				await this.#inner.close();
			} finally {
				if (this.#exited) {
					// The SDK sends SIGKILL last without waiting for it.
					this.kill();
					await this.#exited;
				}
				this.#release();
			}
		})();
		return this.#closing;
	}
	/** Ends the child at once. */
	kill() {
		const child = this.#child;
		if (child && child.exitCode === null && child.signalCode === null)
			try {
				child.kill("SIGKILL");
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

/**
 * Stops every local command while the server shuts down: queued starts are refused first,
 * no new one starts, then running children are stopped and waited for.
 */
export async function closeLocalCommands() {
	shuttingDown = true;
	for (const entry of [...waiting]) entry.fail(shutdownError());
	await Promise.allSettled([...live].map((transport) => transport.close()));
}

/**
 * The check before saving a local command: start it, complete the MCP handshake and stop it.
 * Like the address check for remote servers it is not an operation, so nothing is admitted
 * or recorded. `authorize` runs again right before the child starts.
 */
export async function checkLocalCommand(
	command: LocalCommand,
	options: {
		authorize?: () => Promise<void>;
		signal?: AbortSignal;
		timeoutMs?: number;
	} = {},
) {
	const transport = new LocalCommandTransport(command, {
		authorize: options.authorize,
		signal: options.signal,
	});
	const client = new Client(
		{ name: "toolstile-connection-probe", version: "0.1.0" },
		{ versionNegotiation: { mode: "legacy" } },
	);
	try {
		await client.connect(transport, {
			timeout: options.timeoutMs ?? 20_000,
			...(options.signal ? { signal: options.signal } : {}),
		});
	} catch (error) {
		throw transport.spawned ? transport.failure(error) : error;
	} finally {
		await client.close().catch(() => {});
	}
}
