// @vitest-environment jsdom

/**
 * 回归测试 —— 关掉某个卡片类型的「单独样式」,必须真的关得掉。
 *
 * 复现路径(用户报告):图片渲染 → 直播卡片 tab → 打开「单独样式」→ 保存 →
 * 再关掉 → 保存 → 刷新回来开关又是开的。
 *
 * 根因不在开关本身,在**下发方式**。PATCH 走 JSON Merge Patch 语义:键消失 =
 * 「该字段不改」,只有显式 `null` 才是删除(见 `store.ts` 的 deepMerge)。前端把
 * `delete` 过的 map 整个回传时,「关掉 live」在网络上等于什么都没说 —— 请求成功、
 * 后端原样保留旧覆盖,于是「关不掉」。
 *
 * per-UP 那侧只在**全部**关掉时才下发 `null` 清整片,所以「开了两类、关掉其中
 * 一类」同样关不掉,一并钉在这里。
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { useDraftStore } from "../../store/draft";
import { makeEmptySubscription, type Subscription } from "../../types/domain";
import type { GlobalConfig } from "../../types/globals";
import Cards from "../Cards";
import { makeDefaults } from "../rules/__tests__/fixtures";

vi.mock("../../services/api", () => ({
	api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), upload: vi.fn() },
	ApiError: class extends Error {},
}));

import { api } from "../../services/api";

/** 全局已经开着 live 的单独样式 —— 也就是用户「保存过一次」之后的状态。 */
function globalsWithLiveOverride(): GlobalConfig {
	const defaults = makeDefaults() as unknown as Record<string, unknown>;
	defaults.cardStyleByKind = { live: { font: "Live Sans" } };
	return { app: {}, master: {}, defaults } as unknown as GlobalConfig;
}

function resetStore(): void {
	useDraftStore.setState({
		current: null,
		uiState: "idle",
		errorMessage: null,
		panelLocked: false,
	});
}

// 皮肤库那节的「编辑」钮要跳编辑器路由,所以这一页现在吃 router context。
function renderCards() {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<MemoryRouter>
			<QueryClientProvider client={qc}>
				<Cards />
			</QueryClientProvider>
		</MemoryRouter>,
	);
}

/** 切到某个卡片类型 tab。用 desc 定位:label「直播开播」在全家福里也有一份。 */
function pickKindTab(desc: string): void {
	const btn = screen.getByText(desc).closest("button");
	if (!btn) throw new Error(`找不到类型 tab「${desc}」`);
	fireEvent.click(btn);
}

/** GlassBox 的开关在标题所在卡片的头部 —— 取该卡片文档序第一个 button。 */
function toggleOf(title: string): HTMLButtonElement {
	const box = screen.getByText(title).closest(".bn-glass");
	const btn = box?.querySelector("button");
	if (!btn) throw new Error(`找不到「${title}」的开关`);
	return btn as HTMLButtonElement;
}

beforeEach(() => {
	resetStore();
	Element.prototype.scrollIntoView = vi.fn();
	vi.mocked(api.post).mockResolvedValue({ ok: true, dataUrl: "data:image/png;base64,xx" });
	vi.mocked(api.patch).mockResolvedValue({});
});

afterEach(() => {
	cleanup();
	resetStore();
	vi.clearAllMocks();
});

describe("关掉「单独样式」", () => {
	it("全局:关掉直播卡的单独样式 → PATCH 里该类型显式为 null(否则后端当没说)", async () => {
		vi.mocked(api.get).mockImplementation((url: string) => {
			if (url.includes("/api/subs")) return Promise.resolve([]);
			if (url.includes("/api/targets")) return Promise.resolve([]);
			return Promise.resolve(globalsWithLiveOverride());
		});

		renderCards();
		await waitFor(() => expect(useDraftStore.getState().current?.pageKey).toBe("cards"));

		// 切到直播卡片 tab,开关此时应是开的(全局已有 live 覆盖)。
		pickKindTab("开播 / 直播中 / 下播");
		const toggle = await waitFor(() => toggleOf("直播开播 · 单独样式"));
		expect(screen.getByText("单独设置")).toBeTruthy();

		fireEvent.click(toggle); // 关掉
		await waitFor(() => expect(screen.getByText("跟随全局")).toBeTruthy());

		useDraftStore.getState().current?.onSave();
		await waitFor(() => expect(api.patch).toHaveBeenCalled());

		const [url, body] = vi.mocked(api.patch).mock.calls.at(-1) as [
			string,
			{ defaults: { cardStyleByKind: Record<string, unknown> } },
		];
		expect(url).toBe("/api/globals");
		// 键必须在,且为 null。少了这个键,后端 deepMerge 会原样留着旧覆盖。
		expect(body.defaults.cardStyleByKind).toHaveProperty("live");
		expect(body.defaults.cardStyleByKind.live).toBeNull();
	});

	// image 的日志等级曾经也在这一页上,与 cardStyleByKind 共用同一个保存函数、栽的
	// 也是同一个坑。控件已整体搬去系统页那格「按模块覆盖」,那条守卫跟着搬进了
	// System.module-log-levels(五个模块共用一条路径,不再只钉 image 一个)。

	it("per-UP:开了两类只关掉一类 → 被关的那类也得是 null", async () => {
		const sub: Subscription = {
			...makeEmptySubscription("123456"),
			overrides: {
				cardStyleByKind: {
					live: { font: "Live Sans" },
					sc: { font: "SC Sans" },
				},
			},
		};
		vi.mocked(api.get).mockImplementation((url: string) => {
			if (url.includes("/api/subs")) return Promise.resolve([sub]);
			if (url.includes("/api/targets")) return Promise.resolve([]);
			return Promise.resolve({
				app: {},
				master: {},
				defaults: makeDefaults(),
			} as unknown as GlobalConfig);
		});

		renderCards();
		await waitFor(() => expect(useDraftStore.getState().current?.pageKey).toBe("cards"));
		fireEvent.click(await screen.findByText("UID 123456"));
		await waitFor(() => expect(useDraftStore.getState().current?.pageKey).toBe("cards-perup"));

		pickKindTab("开播 / 直播中 / 下播");
		const toggle = await waitFor(() => toggleOf("直播开播 · 单独样式"));
		fireEvent.click(toggle);

		useDraftStore.getState().current?.onSave();
		await waitFor(() => expect(api.patch).toHaveBeenCalled());

		const [, body] = vi.mocked(api.patch).mock.calls.at(-1) as [
			string,
			{ overrides: { cardStyleByKind: Record<string, unknown> | null } },
		];
		const byKind = body.overrides.cardStyleByKind;
		expect(byKind).not.toBeNull();
		expect((byKind as Record<string, unknown>).live).toBeNull();
		// 没动的那类必须原样留着。
		expect((byKind as Record<string, unknown>).sc).toEqual({ font: "SC Sans" });
	});
});
