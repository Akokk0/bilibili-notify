import { beforeEach, describe, expect, it } from "vite-plus/test";
import { normalizeThemePreference, resolveThemePreference, useThemeStore } from "../theme";

function resetThemeStore(): void {
	useThemeStore.setState({
		preference: "system",
		systemPrefersDark: false,
		resolved: "light",
	});
}

describe("theme preference rules", () => {
	it("normalizes unknown preference to system", () => {
		expect(normalizeThemePreference("light")).toBe("light");
		expect(normalizeThemePreference("dark")).toBe("dark");
		expect(normalizeThemePreference("system")).toBe("system");
		expect(normalizeThemePreference("unknown")).toBe("system");
		expect(normalizeThemePreference(null)).toBe("system");
	});

	it("resolves system from OS preference and lets manual modes override it", () => {
		expect(resolveThemePreference("system", true)).toBe("dark");
		expect(resolveThemePreference("system", false)).toBe("light");
		expect(resolveThemePreference("light", true)).toBe("light");
		expect(resolveThemePreference("dark", false)).toBe("dark");
	});
});

describe("useThemeStore", () => {
	beforeEach(resetThemeStore);

	it("hydrates preference and resolved theme together", () => {
		useThemeStore.getState().hydratePreference("system", true);

		const s = useThemeStore.getState();
		expect(s.preference).toBe("system");
		expect(s.systemPrefersDark).toBe(true);
		expect(s.resolved).toBe("dark");
	});

	it("manual preference overrides later system changes", () => {
		useThemeStore.getState().hydratePreference("dark", false);
		expect(useThemeStore.getState().resolved).toBe("dark");

		useThemeStore.getState().setSystemPrefersDark(false);
		expect(useThemeStore.getState().resolved).toBe("dark");

		useThemeStore.getState().setPreference("light");
		useThemeStore.getState().setSystemPrefersDark(true);
		expect(useThemeStore.getState().resolved).toBe("light");
	});

	it("system preference tracks system changes", () => {
		useThemeStore.getState().hydratePreference("system", false);
		expect(useThemeStore.getState().resolved).toBe("light");

		useThemeStore.getState().setSystemPrefersDark(true);
		expect(useThemeStore.getState().resolved).toBe("dark");
	});
});
