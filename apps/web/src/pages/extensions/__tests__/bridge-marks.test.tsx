// @vitest-environment jsdom
/**
 * 接入卡与 bot 行左边那枚方块。
 *
 * 一屏上常有两三条接入、每条底下挂几个 bot,全是清一色的文字行时,主人得逐行读名字才
 * 认得出谁是谁。方块是**扫一眼就能分**的那条通道 —— 设计稿 V1 里两处都有,实现时漏掉了。
 *
 * 方块里画什么,三级退让(主人 2026-09-10 拍板「koishi / AstrBot 有自己的 logo,平台 logo
 * 让桥来提供」):**桥随 bot 报上来的图标 → BN 自己认得的平台图标 → 平台名头两个字母**。
 * 桥那一级排最前:桥后面挂着什么平台是**运行时才知道**的开放词表,BN 认得的只是一小撮。
 */

import { cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { buildPlatformTable } from "../../../components/platform-meta";

vi.mock("../../../services/api", () => ({
	api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
	ApiError: class extends Error {},
}));

import { ASTRBOT_LINK, LINK, renderPanel } from "./bridge-harness";

/** 桥随 bot 报上来的平台图标(协议 §5.2)。 */
const BRIDGE_ICON = `data:image/svg+xml;base64,${btoa("<svg xmlns='http://www.w3.org/2000/svg'/>")}`;

const STATUS = {
	sessions: [
		{
			linkId: "c1",
			connected: true,
			kind: "koishi",
			name: "客厅那台",
			version: "0.1.0",
			connectedAt: 1_700_000_000_000,
			bots: [
				// 桥给了图标,而且 BN 自己也认得 onebot —— 桥那份要赢
				{
					botId: "onebot:1",
					platform: "onebot",
					name: "阿库娅",
					selfId: "2854196310",
					icon: BRIDGE_ICON,
				},
				// 桥没给、BN 认得(注册表里有图标)—— 画 BN 自己那枚
				{ botId: "onebot:9", platform: "onebot", name: "备用机" },
				// 桥没给、BN 只有短名没图标(「未指明的 HTTP 端点」)—— 与不认得同一档,别画个方章套方块
				{ botId: "generic:4", platform: "generic", name: "通用机" },
				// 谁都不认得 —— 两个字母
				{ botId: "nostalgia:2", platform: "从没见过的平台", name: "小电视" },
			],
		},
		{ linkId: "c2", connected: false, bots: [] },
	],
};

function renderMarks() {
	// 与真页面同一张表:内置平台那份注册表,拓展一个都没装
	return renderPanel({
		links: [LINK, ASTRBOT_LINK],
		status: STATUS,
		platforms: buildPlatformTable([]),
	});
}

function botMark(name: string): Element {
	const mark = screen.getByText(name).closest("[data-bot-row]")?.querySelector("[data-bot-mark]");
	if (!mark) throw new Error(`「${name}」那一行没有方块`);
	return mark;
}

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("接入卡的方块", () => {
	/**
	 * 🔴 方块印的是**配置里那一种**,不是桥自报的那一种 —— 连着的那条卡上,自报的种类
	 * 摆在会话元信息里,而「我给这条配的是什么」此前只在**没连上**时才印得出来。
	 */
	it("两条接入各带一枚认得出种类的方块,连着的那条也有", async () => {
		renderMarks();
		await screen.findByText("家里那台");
		expect(screen.getByLabelText("koishi 接入")).toBeTruthy();
		expect(screen.getByLabelText("astrbot 接入")).toBeTruthy();
	});

	it("方块里是那种桥自己的 logo,不是两个字母", async () => {
		renderMarks();
		await screen.findByText("家里那台");
		for (const kind of ["koishi", "astrbot"]) {
			const img = screen.getByLabelText(`${kind} 接入`).querySelector("img");
			expect(img?.getAttribute("src")).toMatch(/^data:image\//);
		}
	});
});

describe("bot 行的平台方块", () => {
	it("桥给了图标就画桥给的 —— 哪怕 BN 自己也认得这个平台", async () => {
		renderMarks();
		await screen.findByText("阿库娅");
		expect(botMark("阿库娅").querySelector("img")?.getAttribute("src")).toBe(BRIDGE_ICON);
	});

	it("桥没给、BN 认得 → 画 BN 自己那枚", async () => {
		renderMarks();
		await screen.findByText("备用机");
		const mark = botMark("备用机");
		expect(mark.querySelector("img")).toBeNull();
		expect(mark.querySelector("svg")).toBeTruthy();
	});

	it("桥没给、BN 只有短名没图标 → 还是两个字母,不画方章套方块", async () => {
		renderMarks();
		await screen.findByText("通用机");
		const mark = botMark("通用机");
		expect(mark.querySelector("img, svg")).toBeNull();
		expect(mark.textContent?.trim()).toBe("ge");
	});

	it("谁都不认得 → 平台名头两个字母,任何平台都画得出来", async () => {
		renderMarks();
		await screen.findByText("小电视");
		const mark = botMark("小电视");
		expect(mark.querySelector("img, svg")).toBeNull();
		expect(mark.textContent?.trim()).toBe("从没");
	});
});
