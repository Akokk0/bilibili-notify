import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
	getSystemPrefersDark,
	readThemePreference,
	THEME_STORAGE_KEY,
	writeThemePreference,
} from "../theme";

describe("theme browser helpers", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("returns system when localStorage is unavailable", () => {
		vi.stubGlobal("localStorage", undefined);

		expect(readThemePreference()).toBe("system");
	});

	it("normalizes invalid localStorage values", () => {
		const getItem = vi.fn(() => "solarized");
		vi.stubGlobal("localStorage", { getItem });

		expect(readThemePreference()).toBe("system");
		expect(getItem).toHaveBeenCalledWith(THEME_STORAGE_KEY);
	});

	it("writes valid preference to localStorage", () => {
		const setItem = vi.fn();
		vi.stubGlobal("localStorage", { setItem });

		writeThemePreference("dark");

		expect(setItem).toHaveBeenCalledWith(THEME_STORAGE_KEY, "dark");
	});

	it("swallows localStorage read and write failures", () => {
		const err = new Error("blocked");
		vi.stubGlobal("localStorage", {
			getItem: vi.fn(() => {
				throw err;
			}),
			setItem: vi.fn(() => {
				throw err;
			}),
		});

		expect(readThemePreference()).toBe("system");
		expect(() => writeThemePreference("light")).not.toThrow();
	});

	it("reads system dark preference through matchMedia when available", () => {
		const matchMedia = vi.fn(() => ({ matches: true }));
		vi.stubGlobal("matchMedia", matchMedia);

		expect(getSystemPrefersDark()).toBe(true);
		expect(matchMedia).toHaveBeenCalledWith("(prefers-color-scheme: dark)");
	});

	it("falls back to light when matchMedia is unavailable", () => {
		vi.stubGlobal("matchMedia", undefined);

		expect(getSystemPrefersDark()).toBe(false);
	});
});
