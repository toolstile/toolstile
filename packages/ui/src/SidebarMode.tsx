import { createContext, useSyncExternalStore } from "react";

/*
 * The sidebar's width preference: the full sidebar with labels, or the compact icon rail. It is
 * a per-browser appearance choice like the theme, so it lives in local storage, not the URL.
 */

const key = "toolstile:sidebar";
const changed = "toolstile:sidebar-change";

function read(): boolean {
	try {
		return localStorage.getItem(key) === "compact";
	} catch {
		return false;
	}
}

function subscribe(onChange: () => void) {
	const onStorage = (event: StorageEvent) => {
		if (event.key === key) onChange();
	};
	window.addEventListener("storage", onStorage);
	window.addEventListener(changed, onChange);
	return () => {
		window.removeEventListener("storage", onStorage);
		window.removeEventListener(changed, onChange);
	};
}

/** Whether the sidebar is the compact rail, and a setter that persists the choice. */
export function useSidebarMode(): [boolean, (compact: boolean) => void] {
	const compact = useSyncExternalStore(subscribe, read, () => false);
	return [
		compact,
		(next) => {
			try {
				if (next) localStorage.setItem(key, "compact");
				else localStorage.removeItem(key);
			} catch {
				// Private windows may refuse storage; the sidebar then stays full width.
			}
			window.dispatchEvent(new Event(changed));
		},
	];
}

/**
 * True inside a compact sidebar; parts of the sidebar drop their text there. Read it with
 * `useContext` directly: StyleX evaluates local helper hooks while compiling and fails on them.
 */
export const SidebarCompact = createContext(false);
