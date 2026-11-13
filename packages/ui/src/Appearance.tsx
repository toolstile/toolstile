import { useEffect, useSyncExternalStore } from "react";

const changed = "toolstile:appearance-change";
const themes = ["system", "light", "dark"] as const;
export type Theme = (typeof themes)[number];
let memory: string | undefined;

function valid(value: string | null | undefined): Theme {
	return themes.find((theme) => theme === value) ?? themes[0];
}
function read() {
	if (typeof window === "undefined") return themes[0];
	try {
		return valid(
			localStorage.getItem("toolstile:theme") ??
				localStorage.getItem("theme") ??
				memory,
		);
	} catch {
		return valid(memory);
	}
}
function store(next: Theme) {
	memory = next;
	try {
		localStorage.setItem("toolstile:theme", next);
	} catch {
		/* Keep the current tab usable if storage is unavailable. */
	}
	window.dispatchEvent(new Event(changed));
}
function write(value: string) {
	const next = valid(value);
	const root = document.documentElement;
	// The whole page crossfades between themes instead of every surface switching at once.
	if (
		next === root.dataset.theme ||
		typeof document.startViewTransition !== "function" ||
		matchMedia("(prefers-reduced-motion: reduce)").matches
	) {
		store(next);
		return;
	}
	document.startViewTransition(() => {
		root.dataset.theme = next;
		store(next);
	});
}
function subscribe(listener: () => void) {
	window.addEventListener("storage", listener);
	window.addEventListener(changed, listener);
	return () => {
		window.removeEventListener("storage", listener);
		window.removeEventListener(changed, listener);
	};
}

/** Reads the stored theme without ever overwriting it during mount/hydration. */
export function useAppearance() {
	const theme = useSyncExternalStore(subscribe, read, () => "system" as const);
	return { theme, setTheme: write };
}

/** Applies the theme on every route, including sign-in and recovery. */
export function AppearanceRuntime() {
	const { theme } = useAppearance();
	// store updates trigger reapplication; read() preserves the stored theme during the initial hydration snapshot.
	useEffect(() => {
		// Read the store, not `theme`: during hydration `theme` is the server's "system", and
		// writing it would undo the bootstrap's stored choice for a frame.
		document.documentElement.dataset.theme = read();
	}, [theme]);
	return null;
}

// A validated, read-only bootstrap avoids flashing a different theme before hydration.
export const appearanceBootstrap = `try{const value=localStorage.getItem("toolstile:theme")??localStorage.getItem("theme");if(["system","light","dark"].includes(value))document.documentElement.dataset.theme=value}catch{}`;
