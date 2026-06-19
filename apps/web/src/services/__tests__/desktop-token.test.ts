import { afterEach, describe, expect, it, vi } from "vite-plus/test";

function stubBrowser(url: string, savedToken: string | null = null) {
	const store = new Map<string, string>();
	if (savedToken) store.set("bn.desktopToken", savedToken);
	const replaceState = vi.fn();
	const setItem = vi.fn((key: string, value: string) => store.set(key, value));
	const getItem = vi.fn((key: string) => store.get(key) ?? null);
	vi.stubGlobal("location", { href: url });
	vi.stubGlobal("history", { state: { test: true }, replaceState });
	vi.stubGlobal("sessionStorage", { getItem, setItem });
	return { getItem, replaceState, setItem };
}

describe("desktop token client helpers", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.resetModules();
	});

	it("reads the launcher token from URL fragment, stores it, strips it, and attaches it to HTTP/WS", async () => {
		const browser = stubBrowser("http://127.0.0.1:8787/#desktopToken=secret&keep=1");
		const mod = await import("../desktop-token");

		expect(mod.getDesktopToken()).toBe("secret");
		expect(browser.setItem).toHaveBeenCalledWith("bn.desktopToken", "secret");
		expect(browser.replaceState).toHaveBeenCalledWith({ test: true }, "", "/#keep=1");
		expect(mod.withDesktopTokenHeader().get("x-bn-desktop-token")).toBe("secret");
		expect(mod.withDesktopTokenQuery("ws://127.0.0.1:8787/ws")).toBe(
			"ws://127.0.0.1:8787/ws?desktopToken=secret",
		);
	});

	it("ignores desktopToken in search params but strips it before falling back to storage", async () => {
		const browser = stubBrowser("http://127.0.0.1:8787/?desktopToken=query-token&keep=1", "saved");
		const mod = await import("../desktop-token");

		expect(mod.getDesktopToken()).toBe("saved");
		expect(browser.setItem).not.toHaveBeenCalled();
		expect(browser.replaceState).toHaveBeenCalledWith({ test: true }, "", "/?keep=1");
	});

	it("falls back to sessionStorage after the URL has been cleaned", async () => {
		const browser = stubBrowser("http://127.0.0.1:8787/", "saved");
		const mod = await import("../desktop-token");

		expect(mod.getDesktopToken()).toBe("saved");
		expect(browser.getItem).toHaveBeenCalledWith("bn.desktopToken");
		expect(browser.replaceState).not.toHaveBeenCalled();
	});
});
