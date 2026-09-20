// @vitest-environment jsdom

/**
 * 回归测试 —— 关掉某个卡种的覆盖,必须真的关得掉。
 *
 * 复现路径(用户报告):图片渲染 → 直播卡片 tab → 打开覆盖 → 保存 →
 * 再关掉 → 保存 → 刷新回来开关又是开的。
 *
 * 根因不在开关本身,在**下发方式**。PATCH 走 JSON Merge Patch 语义:键消失 =
 * 「该字段不改」,只有显式 `null` 才是删除(见 `store.ts` 的 deepMerge)。前端把
 * `delete` 过的 map 整个回传时,「关掉 live」在网络上等于什么都没说 —— 请求成功、
 * 后端原样保留旧覆盖,于是「关不掉」。
 *
 * per-UP 那侧只在**全部**关掉时才下发 `null` 清整片。2026-09-14 之后 per-kind 覆盖只剩
 * 直播那一格(封面与数据区),所以「关掉最后一格」走的正是清整片那条路。
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

describe("关掉某个卡种的覆盖", () => {
	/**
	 * 2026-09-14 起「单独样式」那四个盒子没了 —— 它们编的是字体与背景图,而这两项退役成了
	 * 皮肤旋钮。于是**全局**那层 `cardStyleByKind` 再没有写入方,那一条用例跟着撤掉;
	 * per-UP 这层还剩直播封面(与数据区开关)在写,「关掉 → 得发显式 null」那个坑仍在这条
	 * 路径上,守卫留在这里。
	 */
	it("per-UP:关掉直播封面覆盖 → PATCH 里那一格显式为 null(否则后端当没说)", async () => {
		const sub: Subscription = {
			...makeEmptySubscription("123456"),
			overrides: { cardStyleByKind: { live: { liveCoverImages: ["img1"] } } },
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
		fireEvent.click(await waitFor(() => toggleOf("直播封面")));

		useDraftStore.getState().current?.onSave();
		await waitFor(() => expect(api.patch).toHaveBeenCalled());

		const [, body] = vi.mocked(api.patch).mock.calls.at(-1) as [
			string,
			{ overrides: { cardStyleByKind: Record<string, unknown> | null } },
		];
		// 键必须在,且为 null。**键消失 = 「这个字段不改」**,后端 deepMerge 会原样留着旧覆盖
		// —— 那正是「关不掉」那个 bug 的形状。这里关掉的是唯一那一格,所以清的是整片。
		expect(body.overrides).toHaveProperty("cardStyleByKind");
		expect(body.overrides.cardStyleByKind).toBeNull();
	});
});

/**
 * 全家福上那颗「单独」药丸 —— 它说的是「这张卡在**这个作用域**里另有一份覆盖」。
 *
 * 2026-09-14 起全局 tab 上的「单独样式」四个盒子撤了(它们编的字体与背景退役成了皮肤
 * 旋钮),于是**全局这半边再没有任何入口写 `cardStyleByKind`**,`effStyleFor` 里它也一个
 * 字都不贡献。药丸却还照旧按它亮:老配置里留着那一格的实例,全家福上就挂一颗「单独」,
 * 而旁边那张预览用的正是全局基准 —— 没有任何一处点得进去看或改。
 *
 * 字段本身留着(要认得住老数据),但它在全局这半边只剩「读进来、原样存回去」,不该再
 * 出现在渲染判断里。
 */
describe("全家福上那颗「单独」药丸", () => {
	/** 全局/per-UP 两种作用域共用的 api.get 安排。 */
	function mockGet(subs: Subscription[], gByKind: Record<string, unknown>): void {
		vi.mocked(api.get).mockImplementation((url: string) => {
			if (url.includes("/api/subs")) return Promise.resolve(subs);
			if (url.includes("/api/targets")) return Promise.resolve([]);
			return Promise.resolve({
				app: {},
				master: {},
				defaults: { ...makeDefaults(), cardStyleByKind: gByKind },
			} as unknown as GlobalConfig);
		});
	}

	it("🔴 全局作用域:老配置里 cardStyleByKind 有直播这一格,也不挂药丸", async () => {
		mockGet([], { live: { liveCoverImages: ["img1"] } });
		renderCards();
		await waitFor(() => expect(useDraftStore.getState().current?.pageKey).toBe("cards"));
		await screen.findByText("卡片全家福 · 实时反映全局配置");
		expect(screen.queryByText("单独")).toBeNull();
	});

	// 反面:per-UP 这半边的覆盖仍有入口、仍生效,药丸照挂 —— 不是把药丸整个删掉。
	it("per-UP 作用域:该 UP 的那一格有覆盖 → 药丸照挂", async () => {
		const sub: Subscription = {
			...makeEmptySubscription("123456"),
			overrides: { cardStyleByKind: { live: { liveCoverImages: ["img1"] } } },
		};
		mockGet([sub], {});
		renderCards();
		await waitFor(() => expect(useDraftStore.getState().current?.pageKey).toBe("cards"));
		fireEvent.click(await screen.findByText("UID 123456"));
		await waitFor(() => expect(useDraftStore.getState().current?.pageKey).toBe("cards-perup"));
		expect(await screen.findByText("单独")).toBeTruthy();
	});
});
