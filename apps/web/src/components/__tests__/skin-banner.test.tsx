// @vitest-environment jsdom

/** SkinBanner:皮肤当前模式带 banner 才渲染 hero 横幅,高度/资产 URL 来自 manifest。 */

import type { SkinManifest } from "@bilibili-notify/contract";
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { useSkinStore } from "../../store/skin";
import { useThemeStore } from "../../store/theme";
import { SkinBanner } from "../skin-banner";

function setActive(modes: SkinManifest["modes"]): void {
	useSkinStore.setState({
		active: { id: "abc", manifest: { schemaVersion: 1, name: "t", modes } },
	});
}

beforeEach(() => {
	useThemeStore.setState({ preference: "system", systemPrefersDark: false, resolved: "light" });
	useSkinStore.setState({ active: null, preview: null, killSwitch: false, lockedTheme: null });
});

afterEach(cleanup);

describe("SkinBanner", () => {
	it("当前模式带 banner → 渲染横幅图,src/height 来自 manifest", () => {
		setActive({ light: { banner: { image: "assets/hero.png", height: 200 } } });
		const { container } = render(<SkinBanner />);
		const img = container.querySelector("img") as HTMLImageElement;
		expect(img).toBeTruthy();
		expect(img.getAttribute("src")).toBe("/api/skins/abc/assets/hero.png");
		expect((container.firstChild as HTMLElement).style.height).toBe("200px");
	});

	it("无 banner / 无皮肤 → 渲染空", () => {
		setActive({ light: { colors: { accent: "#fff" } } });
		expect(render(<SkinBanner />).container.firstChild).toBeNull();
		cleanup();
		useSkinStore.setState({ active: null });
		expect(render(<SkinBanner />).container.firstChild).toBeNull();
	});
});
