// @vitest-environment jsdom

/**
 * 系统页「运行」格里那一格按模块日志等级 —— `app.logLevels` 的**唯一**编辑口。
 *
 * image 与 ai 从前各自躺在「图片渲染」与「智能女仆」页的底部,同一个键分三处编辑;
 * 现在五个模块同住一格。这里钉两件事:
 *
 * ① 五格一格不少 —— 搬过来的两格要真的画出来。少一格是纯静默的:类型、构建、
 *    别的测试全绿,只有真机上那一格凭空消失。
 * ② 退回「跟随全局」发的是**显式 null**。这条是踩过坑的:PATCH 走 JSON Merge
 *    Patch,键消失 = 「该字段不改」,靠「拷一份、删掉那个键、整份回传」来清除覆盖,
 *    请求会成功而后端原样留着旧等级 —— 退不回跟随全局。坑在 image / ai 各自那两页
 *    上分别栽过一次(旧守卫在 Cards.bykind-off 与 Ai.apikey-save),搬家之后五个模块
 *    共用这一条路径,守卫也跟着合并到这里。
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { useDraftStore } from "../../store/draft";
import System from "../System";

// ── 子节全部换成哑桩:这条测试只问那一格,不问各节自己画得对不对 ──────────────

vi.mock("../../components/commands-settings", () => ({
	CommandsSettings: () => <div data-testid="sec-commands" />,
}));
vi.mock("../../components/link-parsing-settings", () => ({
	LinkParsingSettings: () => <div data-testid="sec-link-parsing" />,
}));
vi.mock("../../components/browser-source-settings", () => ({
	BrowserSourceSettings: () => <div data-testid="sec-browser-source" />,
}));
vi.mock("../skins/SkinSection", () => ({ SkinSection: () => <div data-testid="sec-skin" /> }));
vi.mock("../backup/BackupSection", () => ({
	BackupSection: () => <div data-testid="sec-backup" />,
}));
vi.mock("../../components/update/update-section", () => ({
	UpdateSection: () => <div data-testid="sec-update" />,
}));
vi.mock("../../components/onboarding/reopen-section", () => ({
	OnboardingReopenSection: () => <div data-testid="sec-onboarding" />,
}));

vi.mock("../../store/auth", () => {
	const useAuthStore = (select: (s: unknown) => unknown) =>
		select({ snapshot: null, cookiesRefreshedAt: null });
	useAuthStore.getState = () => ({ clear: () => {} });
	return { useAuthStore };
});

// 假 ApiError 进 vi.hoisted:`vi.mock` 的工厂被提到文件顶,写成模块级 const 会撞 TDZ。
const { FakeApiError } = vi.hoisted(() => ({ FakeApiError: class extends Error {} }));

vi.mock("../../services/api", () => ({
	ApiError: FakeApiError,
	api: { get: vi.fn(), post: vi.fn(async () => ({ ok: true })), patch: vi.fn(async () => ({})) },
}));

import { api } from "../../services/api";

/** `logLevels` 是这份配置里已有的按模块覆盖。 */
function mockApi(logLevels: Record<string, string>): void {
	const globals = {
		app: { dynamicCron: "0 * * * *", logLevel: "info", logLevels },
		master: { targetId: undefined },
	};
	vi.mocked(api.get).mockImplementation(async (url: string) => {
		if (url === "/api/globals") return JSON.parse(JSON.stringify(globals));
		if (url === "/api/connections/capabilities") return {};
		return [];
	});
}

function resetStore(): void {
	useDraftStore.setState({
		current: null,
		uiState: "idle",
		errorMessage: null,
		panelLocked: false,
	});
}

/**
 * 渲染并停到「运行」格(那一格才装着日志等级)。
 *
 * 别拿左栏那几颗钮当草稿到齐的信号 —— 分区导航在草稿落下来之前就渲染好了,
 * 等它等于没等;`Core · 应用` 那张卡是 `draft` 到了才画的,拿它当信号才真。
 */
async function renderRuntimeSection() {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(
		<MemoryRouter initialEntries={["/system"]}>
			<QueryClientProvider client={qc}>
				<System />
			</QueryClientProvider>
		</MemoryRouter>,
	);
	fireEvent.click(screen.getAllByRole("button", { name: "运行" })[0]);
	await screen.findByText("Core · 应用");
}

/** 某个模块那一行里的「跟随全局」钮 —— 五行各有一颗,按模块名定位。 */
function inheritButtonOf(moduleLabel: string): HTMLElement {
	const row = screen.getByText(moduleLabel).closest("div");
	if (!row) throw new Error(`找不到模块「${moduleLabel}」那一行`);
	return within(row).getByText("跟随全局");
}

beforeEach(() => {
	resetStore();
	Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
	cleanup();
	resetStore();
	vi.clearAllMocks();
});

describe("系统页的按模块日志等级", () => {
	it("五个模块都在这一格里 —— image / ai 是从各自页面搬过来的", async () => {
		mockApi({});
		await renderRuntimeSection();
		for (const label of ["core 核心", "dynamic 动态", "live 直播", "image 出图", "ai 女仆"]) {
			expect(screen.getByText(label), `缺了「${label}」那一格`).toBeTruthy();
		}
	});

	it.each([
		["image 出图", "image"],
		["ai 女仆", "ai"],
	])("%s:退回「跟随全局」→ PATCH 里那个键显式为 null", async (label, key) => {
		mockApi({ [key]: "debug" });
		await renderRuntimeSection();

		// 有覆盖时「跟随全局」当然不是选中态;先确认起点,否则下一步点了个本就选中的钮,
		// 整条用例会在什么都没发生的情况下「通过」。
		expect(inheritButtonOf(label).getAttribute("aria-pressed")).toBe("false");
		fireEvent.click(inheritButtonOf(label));

		await act(async () => {
			await useDraftStore.getState().current?.onSave();
		});
		await waitFor(() => expect(api.patch).toHaveBeenCalled());

		const [url, body] = vi.mocked(api.patch).mock.calls.at(-1) as [
			string,
			{ app: { logLevels: Record<string, unknown> } },
		];
		expect(url).toBe("/api/globals");
		// 键必须在,且为 null。少了这个键,后端 deepMerge 会原样留着旧等级。
		expect(body.app.logLevels).toHaveProperty(key);
		expect(body.app.logLevels[key]).toBeNull();
	});

	it("只清自己那一格 —— 同时有两个覆盖时,没动的那个原样留着", async () => {
		// 草稿层的合并也得认 null(见 System.tsx 的 deepMerge):不认的话「拷一份删掉键
		// 整份回传」会把被删的键当场合回来,而这**只在同时有两个以上覆盖时**才现形 ——
		// 只剩一个时删空成 undefined 反而歪打正着。
		mockApi({ image: "debug", ai: "warn" });
		await renderRuntimeSection();

		fireEvent.click(inheritButtonOf("image 出图"));

		await act(async () => {
			await useDraftStore.getState().current?.onSave();
		});
		await waitFor(() => expect(api.patch).toHaveBeenCalled());

		const [, body] = vi.mocked(api.patch).mock.calls.at(-1) as [
			string,
			{ app: { logLevels: Record<string, unknown> } },
		];
		expect(body.app.logLevels.image).toBeNull();
		expect(body.app.logLevels.ai).toBe("warn");
	});
});
