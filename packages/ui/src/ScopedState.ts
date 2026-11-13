import { useCallback, useEffect, useRef, useState } from "react";

/** Local drafts and secrets belong to one view. Old asynchronous setters cannot cross views. */
export function useScopedState<T>(scope: string, initial: T) {
	const current = useRef({ key: scope });
	if (current.current.key !== scope) current.current = { key: scope };
	const generation = current.current;
	const fallback = useRef(initial);
	fallback.current = initial;
	const [state, setState] = useState({ generation, value: initial });
	const value = state.generation === generation ? state.value : initial;
	const set = useCallback(
		(next: T | ((previous: T) => T)) => {
			if (current.current !== generation) return;
			setState((previous) => {
				if (current.current !== generation) return previous;
				const value =
					previous.generation === generation
						? previous.value
						: fallback.current;
				return {
					generation,
					value:
						typeof next === "function"
							? (next as (value: T) => T)(value)
							: next,
				};
			});
		},
		[generation],
	);
	return [value, set] as const;
}

type Loaded<T> = { key: string; data?: T; error?: string };

/**
 * Loads `key`'s data once per key within `scope`, ignoring results that arrive after the key or
 * scope changed. `current` is the result for this key (null while loading); `latest` is the last
 * result in this scope, for views that keep showing it while a newer key loads. `set` replaces
 * the current key's data after a local refresh.
 */
export function useLoaded<T>({
	scope = "",
	key,
	load,
	failure,
}: {
	scope?: string;
	key: string;
	/** Nothing loads while this is undefined. */
	load: (() => Promise<T>) | undefined;
	/** The error shown on failure, or how to describe the thrown error. */
	failure: string | ((error: unknown) => string);
}) {
	const [latest, setLatest] = useScopedState<Loaded<T> | null>(scope, null);
	const work = useRef(load);
	work.current = load;
	const describe = useRef(failure);
	describe.current = failure;
	const enabled = Boolean(load);
	useEffect(() => {
		const run = work.current;
		if (!enabled || !run) return;
		let active = true;
		Promise.resolve()
			.then(run)
			.then(
				(data) => {
					if (active) setLatest({ key, data });
				},
				(error: unknown) => {
					if (!active) return;
					const message = describe.current;
					setLatest({
						key,
						error: typeof message === "string" ? message : message(error),
					});
				},
			);
		return () => {
			active = false;
		};
	}, [key, enabled, setLatest]);
	const set = useCallback(
		(data: T) => setLatest({ key, data }),
		[key, setLatest],
	);
	return { current: latest?.key === key ? latest : null, latest, set };
}
