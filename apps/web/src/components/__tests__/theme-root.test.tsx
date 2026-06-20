// @vitest-environment jsdom

import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { useThemeStore } from "../../store/theme";
import { ThemeRoot } from "../theme-root";

function resetThemeStore(): void {
	useThemeStore.setState({
		preference: "system",
		systemPrefersDark: false,
		resolved: "light",
	});
}

function stubLocalStorage(initial: Record<string, string> = {}) {
	const store = new Map(Object.entries(initial));
	const getItem = vi.fn((key: string) => store.get(key) ?? null);
	const setItem = vi.fn((key: string, value: string) => store.set(key, value));
	vi.stubGlobal("localStorage", { getItem, setItem });
	return { getItem, setItem, store };
}

function stubMatchMedia(initialMatches: boolean) {
	let matches = initialMatches;
	const listeners = new Set<(event: MediaQueryListEvent) => void>();
	const mql = {
		media: "(prefers-color-scheme: dark)",
		get matches() {
			return matches;
		},
		addEventListener: vi.fn((type: string, cb: (event: MediaQueryListEvent) => void) => {
			if (type === "change") listeners.add(cb);
		}),
		removeEventListener: vi.fn((type: string, cb: (event: MediaQueryListEvent) => void) => {
			if (type === "change") listeners.delete(cb);
		}),
		addListener: vi.fn((cb: (event: MediaQueryListEvent) => void) => listeners.add(cb)),
		removeListener: vi.fn((cb: (event: MediaQueryListEvent) => void) => listeners.delete(cb)),
	};
	const matchMedia = vi.fn(() => mql as unknown as MediaQueryList);
	vi.stubGlobal("matchMedia", matchMedia);
	return {
		mql,
		setMatches(next: boolean) {
			matches = next;
			const event = { matches: next } as MediaQueryListEvent;
			for (const cb of [...listeners]) cb(event);
		},
	};
}

beforeEach(() => {
	resetThemeStore();
	delete document.documentElement.dataset.theme;
	document.documentElement.style.colorScheme = "";
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("ThemeRoot", () => {
	it("hydrates saved dark preference and applies it to the document", async () => {
		stubLocalStorage({ "bn.dashboardTheme": "dark" });
		stubMatchMedia(false);

		render(
			<ThemeRoot>
				<div>Dashboard</div>
			</ThemeRoot>,
		);

		await waitFor(() => expect(document.documentElement.dataset.theme).toBe("dark"));
		expect(document.documentElement.style.colorScheme).toBe("dark");
		expect(useThemeStore.getState().preference).toBe("dark");
	});

	it("uses system preference when there is no saved theme", async () => {
		stubLocalStorage();
		stubMatchMedia(true);

		render(
			<ThemeRoot>
				<div>Dashboard</div>
			</ThemeRoot>,
		);

		await waitFor(() => expect(document.documentElement.dataset.theme).toBe("dark"));
		expect(useThemeStore.getState()).toMatchObject({
			preference: "system",
			systemPrefersDark: true,
			resolved: "dark",
		});
	});

	it("tracks matchMedia changes while preference is system", async () => {
		stubLocalStorage({ "bn.dashboardTheme": "system" });
		const media = stubMatchMedia(false);
		render(
			<ThemeRoot>
				<div>Dashboard</div>
			</ThemeRoot>,
		);
		await waitFor(() => expect(document.documentElement.dataset.theme).toBe("light"));

		media.setMatches(true);

		await waitFor(() => expect(document.documentElement.dataset.theme).toBe("dark"));
	});

	it("keeps manual light preference when the system switches to dark", async () => {
		stubLocalStorage({ "bn.dashboardTheme": "light" });
		const media = stubMatchMedia(false);
		render(
			<ThemeRoot>
				<div>Dashboard</div>
			</ThemeRoot>,
		);
		await waitFor(() => expect(document.documentElement.dataset.theme).toBe("light"));

		media.setMatches(true);

		await waitFor(() => expect(useThemeStore.getState().systemPrefersDark).toBe(true));
		expect(document.documentElement.dataset.theme).toBe("light");
	});

	it("persists later user preference changes", async () => {
		const storage = stubLocalStorage();
		stubMatchMedia(false);
		render(
			<ThemeRoot>
				<div>Dashboard</div>
			</ThemeRoot>,
		);
		await waitFor(() => expect(document.documentElement.dataset.theme).toBe("light"));

		useThemeStore.getState().setPreference("dark");

		await waitFor(() => expect(document.documentElement.dataset.theme).toBe("dark"));
		expect(storage.setItem).toHaveBeenLastCalledWith("bn.dashboardTheme", "dark");
	});

	it("removes matchMedia listener on unmount", async () => {
		stubLocalStorage();
		const media = stubMatchMedia(false);
		const view = render(
			<ThemeRoot>
				<div>Dashboard</div>
			</ThemeRoot>,
		);
		await waitFor(() => expect(media.mql.addEventListener).toHaveBeenCalled());

		view.unmount();

		expect(media.mql.removeEventListener).toHaveBeenCalledWith("change", expect.any(Function));
	});
});
