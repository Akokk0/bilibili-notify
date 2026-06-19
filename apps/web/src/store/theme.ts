import { create } from "zustand";

export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

export interface ThemeState {
	preference: ThemePreference;
	systemPrefersDark: boolean;
	resolved: ResolvedTheme;
	hydratePreference: (preference: unknown, systemPrefersDark: boolean) => void;
	setPreference: (preference: ThemePreference) => void;
	setSystemPrefersDark: (systemPrefersDark: boolean) => void;
}

export function normalizeThemePreference(value: unknown): ThemePreference {
	if (value === "light" || value === "dark" || value === "system") return value;
	return "system";
}

export function resolveThemePreference(
	preference: ThemePreference,
	systemPrefersDark: boolean,
): ResolvedTheme {
	if (preference === "system") return systemPrefersDark ? "dark" : "light";
	return preference;
}

export const useThemeStore = create<ThemeState>((set) => ({
	preference: "system",
	systemPrefersDark: false,
	resolved: "light",

	hydratePreference: (preference, systemPrefersDark) => {
		const nextPreference = normalizeThemePreference(preference);
		set({
			preference: nextPreference,
			systemPrefersDark,
			resolved: resolveThemePreference(nextPreference, systemPrefersDark),
		});
	},

	setPreference: (preference) =>
		set((s) => ({
			preference,
			resolved: resolveThemePreference(preference, s.systemPrefersDark),
		})),

	setSystemPrefersDark: (systemPrefersDark) =>
		set((s) => ({
			systemPrefersDark,
			resolved: resolveThemePreference(s.preference, systemPrefersDark),
		})),
}));
