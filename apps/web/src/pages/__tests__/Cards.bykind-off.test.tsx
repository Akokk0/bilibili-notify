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
	defaults.cardStyleByKind = { live: { cardColorStart: "#abcdef" } };
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

function renderCards() {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<Cards />
		</QueryClientProvider>,
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

	it("同一根因:把图片日志等级调回「跟随全局」也得显式 null", async () => {
		// 与 cardStyleByKind 同一个坑,就在同一个保存函数里:靠「把键过滤掉」来清除
		// 覆盖,在 PATCH 里等于什么都没说,日志等级同样清不掉。
		const globals = {
			app: { logLevels: { image: "debug" } },
			master: {},
			defaults: makeDefaults(),
		} as unknown as GlobalConfig;
		vi.mocked(api.get).mockImplementation((url: string) => {
			if (url.includes("/api/subs")) return Promise.resolve([]);
			if (url.includes("/api/targets")) return Promise.resolve([]);
			return Promise.resolve(globals);
		});

		renderCards();
		await waitFor(() => expect(useDraftStore.getState().current?.pageKey).toBe("cards"));

		fireEvent.click(await screen.findByText("跟随全局"));
		useDraftStore.getState().current?.onSave();
		await waitFor(() => expect(api.patch).toHaveBeenCalled());

		const [, body] = vi.mocked(api.patch).mock.calls.at(-1) as [
			string,
			{ app: { logLevels: Record<string, unknown> } },
		];
		expect(body.app.logLevels).toHaveProperty("image");
		expect(body.app.logLevels.image).toBeNull();
	});

	it("per-UP:开了两类只关掉一类 → 被关的那类也得是 null", async () => {
		const sub: Subscription = {
			...makeEmptySubscription("123456"),
			overrides: {
				cardStyleByKind: {
					live: { cardColorStart: "#live" },
					sc: { cardColorStart: "#sc" },
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
		expect((byKind as Record<string, unknown>).sc).toEqual({ cardColorStart: "#sc" });
	});
});
