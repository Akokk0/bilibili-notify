// @vitest-environment jsdom

/**
 * 推送平台的**标识色**从库里出。
 *
 * 库早就导出了 `PlatformIcon` 与 `platformLabel`,唯独没导出这个色 —— 于是需要它的
 * 页面(Targets 的平台胶囊)只好照着 `PLATFORM_META` 又抄了一份 `PLATFORM_TINT`,
 * 三个色加一个 `#888` 兜底,逐字节相同。同一张表两处维护,改一处就飘。
 *
 * 顺手把兜底挂上 `--color-bn-inactive` —— 「这个平台我不认识」本就是静默档的意思,
 * 站里那批同义灰都在往这个 token 上收。
 */

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { PlatformIcon, platformTint } from "../atoms";

afterEach(cleanup);

describe("platformTint", () => {
	it("三个已知平台各有各的色,互不相同", () => {
		const tints = ["onebot", "qq-official", "webhook"].map(platformTint);
		expect(new Set(tints).size).toBe(3);
		for (const t of tints) expect(t).toMatch(/^#[0-9a-fA-F]{6}$/);
	});

	it("不认识的平台退静默档 token,不是写死的灰", () => {
		expect(platformTint("carrier-pigeon")).toBe("var(--color-bn-inactive)");
	});

	it("图标用的就是它 —— 图标与胶囊不许各走各的", () => {
		const { container } = render(<PlatformIcon platform="webhook" />);
		const badge = container.querySelector("span") as HTMLElement;
		// webhook 没有图标,走首字母方章,底色即平台色。
		expect(badge.style.background).toBeTruthy();
		const { container: unknown } = render(<PlatformIcon platform="carrier-pigeon" />);
		const fallback = unknown.querySelector("span") as HTMLElement;
		expect(fallback.style.background).toContain("--color-bn-inactive");
	});
});
