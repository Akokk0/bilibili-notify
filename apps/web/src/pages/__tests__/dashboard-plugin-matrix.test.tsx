// @vitest-environment jsdom
/**
 * 概览页「系统状态 · 各模块」的模块矩阵。
 *
 * 这里钉两条**行为**(其余是观感,留手动验证):
 *
 * ① 日志等级徽章只在**该模块被单独调过**时出现。八个模块各挂一个 `DEBUG` 徽章时,
 *    重复度高到没人会去看,真正要紧的「哪个被单独设过」反而淹在里面。
 * ② 全局那档等级搬进卡头副标题 —— 收起八个徽章不等于把这个信息丢掉,它跟「核心 /
 *    面板版本」是同一类:这套东西当前的全局事实,一处说一遍。
 */

import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { ModuleLogLevels } from "../../types/globals";
import { SystemHealthCard } from "../Dashboard";

vi.stubGlobal("__WEB_VERSION__", "0.0.0-test");

afterEach(cleanup);

function renderCard(over: { logLevel?: string; logLevels?: ModuleLogLevels } = {}) {
	return render(
		<MemoryRouter initialEntries={["/"]}>
			<SystemHealthCard
				health={{ status: "ok", version: "0.9.0", uptime: 1, startedAt: "2026-09-07T00:00:00Z" }}
				reachable
				logLevel={over.logLevel ?? "debug"}
				logLevels={over.logLevels}
				loggedIn
				subCount={1}
				targetCount={3}
				dynamicEnabled
				liveEnabled
				imageEnabled
				aiEnabled
			/>
		</MemoryRouter>,
	);
}

/** 某个模块那一条 —— 靠模块名定位,不依赖它在第几格。 */
function row(label: string): HTMLElement {
	const el = screen.getByText(label).closest("[data-module]");
	if (!(el instanceof HTMLElement)) throw new Error(`没找到 ${label} 那一条`);
	return el;
}

describe("模块矩阵的日志等级", () => {
	it("全部继承全局时,一个徽章都不出现", () => {
		renderCard({ logLevel: "debug" });
		// 八行八个一模一样的 DEBUG,看的人只会把它当背景纹理。
		expect(screen.queryAllByTitle("按模块覆盖")).toHaveLength(0);
		// 「继承全局」那档整个不渲染 —— 只是不标星、照样画出来的话噪音一点没少。
		expect(screen.queryAllByTitle("继承全局")).toHaveLength(0);
	});

	it("某个模块被单独调过 → 只有它那一条挂徽章", () => {
		renderCard({ logLevel: "debug", logLevels: { live: "warn" } });
		const badges = screen.getAllByTitle("按模块覆盖");
		expect(badges).toHaveLength(1);
		expect(badges[0]?.textContent).toContain("WARN");
		// 挂在直播那条上,不是随便哪条。
		expect(within(row("直播 · live")).getByTitle("按模块覆盖")).toBeTruthy();
		expect(within(row("动态 · dynamic")).queryByTitle("按模块覆盖")).toBeNull();
	});

	it("覆盖成与全局相同的等级时也算被单独设过 —— 那是一条会留在盘上的设置", () => {
		// 全局日后改了,这条不跟着动;说它「和全局一样所以不用标」是把将来的分歧藏起来。
		renderCard({ logLevel: "debug", logLevels: { ai: "debug" } });
		expect(screen.getAllByTitle("按模块覆盖")).toHaveLength(1);
	});

	it("全局那档写在卡头副标题上,与核心 / 面板版本并排", () => {
		renderCard({ logLevel: "warn" });
		const badge = screen.getByTitle("全局日志等级");
		expect(badge.textContent).toBe("WARN");
		// 而且是在卡头上,不是混在某一条模块里 —— 那样就成了第九个模块的等级。
		expect(badge.closest("[data-module]")).toBeNull();
	});
});
