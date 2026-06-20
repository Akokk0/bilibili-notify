import { normalizeThemePreference, type ThemePreference } from "../store/theme";

export const THEME_STORAGE_KEY = "bn.dashboardTheme";
const DARK_MEDIA_QUERY = "(prefers-color-scheme: dark)";

type LegacyMediaQueryList = {
	addListener?: (handler: (event: MediaQueryListEvent) => void) => void;
	removeListener?: (handler: (event: MediaQueryListEvent) => void) => void;
};

export function readThemePreference(): ThemePreference {
	try {
		if (typeof localStorage === "undefined") return "system";
		return normalizeThemePreference(localStorage.getItem(THEME_STORAGE_KEY));
	} catch {
		return "system";
	}
}

export function writeThemePreference(preference: ThemePreference): void {
	try {
		if (typeof localStorage === "undefined") return;
		localStorage.setItem(THEME_STORAGE_KEY, preference);
	} catch {
		// Storage can be unavailable in private browsing / embedded shells; theme still works in memory.
	}
}

export function getSystemPrefersDark(): boolean {
	try {
		if (typeof matchMedia === "undefined") return false;
		return matchMedia(DARK_MEDIA_QUERY).matches;
	} catch {
		return false;
	}
}

export function subscribeSystemThemeChange(onChange: (matches: boolean) => void): () => void {
	try {
		if (typeof matchMedia === "undefined") return () => {};
		const query = matchMedia(DARK_MEDIA_QUERY);
		const handler = (event: MediaQueryListEvent) => onChange(event.matches);
		if (typeof query.addEventListener === "function") {
			query.addEventListener("change", handler);
			return () => query.removeEventListener("change", handler);
		}
		const legacy = query as unknown as LegacyMediaQueryList;
		legacy.addListener?.(handler);
		return () => legacy.removeListener?.(handler);
	} catch {
		return () => {};
	}
}
