// @vitest-environment jsdom

/**
 * 系统页的分区导航 —— 十节挤在一页太长,拆成五格走 `SectionNav`(与 Rules /
 * Targets / Ai / Cards 同一件组件,xl+ 左竖栏、窄视口顶部 chip 条)。
 *
 * 这里钉三件事,每件都是「接线」而不是「零件」:
 * ① 十节一节不丢,各自落在说好的那一格里;
 * ② `/system#update` 这条深链(概览卡 + 两个 toast 的「去更新」)要**先选中格**
 *    再滚 —— 只改布局不改它的话,更新那节压根不在 DOM 里,滚个空;
 * ③ 草稿跨格不丢 —— 草稿状态在页面组件上,切格只换子树;写成按格分别持有
 *    就会在切走的那一下丢掉用户刚改的东西,而门禁一行都不会红。
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { GlobalConfigPatch } from "../../types/globals";
import System from "../System";

// ── 子节全部换成哑桩:这条测试问的是「哪一格里有什么」,不是各节自己画得对不对 ──

vi.mock("../../components/commands-settings", () => ({
	CommandsSettings: ({
		draft,
		onPatch,
	}: {
		draft: { app: { dynamicCron: string } };
		onPatch: (d: GlobalConfigPatch) => void;
	}) => (
		<div data-testid="sec-commands">
			<span data-testid="cron-echo">{draft.app.dynamicCron}</span>
			<button type="button" onClick={() => onPatch({ app: { dynamicCron: "改过了" } })}>
				改一下草稿
			</button>
		</div>
	),
}));
vi.mock("../../components/link-parsing-settings", () => ({
	LinkParsingSettings: () => <div data-testid="sec-link-parsing" />,
}));
vi.mock("../../components/browser-source-settings", () => ({
	BrowserSourceSettings: () => <div data-testid="sec-browser-source" />,
}));
vi.mock("../skins/SkinSection", () => ({
	SkinSection: () => <div data-testid="sec-skin" />,
}));
vi.mock("../backup/BackupSection", () => ({
	BackupSection: () => <div data-testid="sec-backup" />,
}));
vi.mock("../../components/update/update-section", () => ({
	UpdateSection: () => <div data-testid="sec-update" />,
}));
vi.mock("../../components/onboarding/reopen-section", () => ({
	OnboardingReopenSection: () => <div data-testid="sec-onboarding" />,
}));

vi.mock("../../hooks/useDirtyDraft", () => ({ useDirtyDraft: () => {} }));

vi.mock("../../store/auth", () => {
	const useAuthStore = (select: (s: unknown) => unknown) =>
		select({ snapshot: null, cookiesRefreshedAt: null });
	useAuthStore.getState = () => ({ clear: () => {} });
	return { useAuthStore };
});

// 夹具与假 ApiError 都进 vi.hoisted:`vi.mock` 的工厂被提到文件顶,
// 而被测模块在 import 期就会解析它 —— 写成模块级 const 会撞 TDZ。
const { GLOBALS, FakeApiError } = vi.hoisted(() => {
	class FakeApiError extends Error {}
	return {
		FakeApiError,
		GLOBALS: {
			app: { dynamicCron: "0 * * * *", logLevel: "info", logLevels: {} },
			master: { targetId: undefined },
		},
	};
});

vi.mock("../../services/api", () => ({
	ApiError: FakeApiError,
	api: {
		get: vi.fn(async (url: string) => {
			if (url === "/api/globals") return GLOBALS;
			if (url === "/api/connections/capabilities") return {};
			return [];
		}),
		post: vi.fn(async () => ({ ok: true })),
		patch: vi.fn(async () => GLOBALS),
	},
}));

function renderSystem(initialEntry = "/system") {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<MemoryRouter initialEntries={[initialEntry]}>
			<QueryClientProvider client={qc}>
				<System />
			</QueryClientProvider>
		</MemoryRouter>,
	);
}

/**
 * 等草稿从 /api/globals 落下来。
 *
 * **别拿左栏那几颗钮当信号** —— 分区导航在草稿到齐之前就渲染好了,等它等于没等;
 * 主人账号那张卡是 `draft` 到了才画的,拿它当信号才真。
 */
async function waitForDraft() {
	await screen.findByText("主人账号 · master");
}

function pickSection(label: string) {
	fireEvent.click(screen.getAllByRole("button", { name: label })[0]);
}

describe("系统页的分区导航", () => {
	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	it("五格都在", async () => {
		renderSystem();
		await waitForDraft();
		for (const label of ["账号", "运行", "消息", "外观", "维护"]) {
			expect(screen.getAllByRole("button", { name: label }).length).toBeGreaterThan(0);
		}
	});

	it("默认停在账号那格,别的格的内容不在 DOM 里", async () => {
		renderSystem();
		await waitForDraft();
		expect(screen.getByText("账号 · auth")).toBeTruthy();
		expect(screen.queryByTestId("sec-skin")).toBeNull();
		expect(screen.queryByTestId("sec-update")).toBeNull();
	});

	// 十节一节不丢:每一格点进去,该格该有的都在。
	it.each([
		["账号", ["账号 · auth", "主人账号 · master", "原始登录快照"], []],
		["运行", [], ["sec-browser-source"]],
		["消息", [], ["sec-commands", "sec-link-parsing"]],
		["外观", [], ["sec-skin"]],
		["维护", [], ["sec-backup", "sec-update", "sec-onboarding"]],
	])("「%s」格装着说好的那几节", async (label, texts, testIds) => {
		renderSystem();
		await waitForDraft();
		pickSection(label as string);
		for (const t of texts as string[]) expect(screen.getByText(t)).toBeTruthy();
		for (const id of testIds as string[]) expect(screen.getByTestId(id)).toBeTruthy();
	});

	it("带 #update 进来直接停在维护格,更新那节在 DOM 里", async () => {
		renderSystem("/system#update");
		// 这里不能等主人账号那张卡:落的就是维护格,它压根不渲染。
		expect(await screen.findByTestId("sec-update")).toBeTruthy();
		expect(screen.queryByText("账号 · auth")).toBeNull();
	});

	it("草稿跨格不丢", async () => {
		renderSystem();
		await waitForDraft();
		pickSection("消息");
		expect(screen.getByTestId("cron-echo").textContent).toBe("0 * * * *");

		fireEvent.click(screen.getByRole("button", { name: "改一下草稿" }));
		expect(screen.getByTestId("cron-echo").textContent).toBe("改过了");

		pickSection("外观");
		pickSection("消息");
		expect(screen.getByTestId("cron-echo").textContent).toBe("改过了");
	});
});
