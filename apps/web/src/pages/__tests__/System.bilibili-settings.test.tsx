// @vitest-environment jsdom

/**
 * 系统页「运行」格里 B 站那三格(动态检查频率 / User-Agent / 登录心跳间隔)。
 *
 * 这三格住在 B 站自己的设置里 —— `/api/settings` 把它挂在 `bilibili` 键下,和核心设置并排;不在核心的
 * `app` 下。钉两条**接线**(零件各自的测试证明不了页面真的接上了):
 *
 * ① 读 —— 三格画的是 `draft.bilibili.*` 的值。读错了地方,格子是空的 / 默认的,保存时还会把空值发回去。
 * ② 写 —— 改一格,PATCH 发的是 `{ bilibili: { … } }`。发到 `app` 底下的话,服务端按块分文件落盘,核心设置
 *    会把它当成不认得的键拒收;而面板这头照样画着改过的值,看上去一切正常。
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { useDraftStore } from "../../store/draft";
import System from "../System";

// ── 子节全部换成哑桩:这条测试只问那三格,不问各节自己画得对不对 ──────────────

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

/** 服务端下发的那一份:核心设置的顶层块 + 并排的 `bilibili`(三格都有值,UA 是主人填过的)。 */
const GLOBALS = {
	app: { logLevel: "info", logLevels: {} },
	bilibili: { dynamicCron: "30 */2 * * * *", userAgent: "UA/1", healthCheckMinutes: 30 },
	master: { targetId: undefined },
};

function resetStore(): void {
	useDraftStore.setState({
		current: null,
		uiState: "idle",
		errorMessage: null,
		panelLocked: false,
	});
}

/** 渲染并停到「运行」格(三格就在那里);`Core · 应用` 那张卡是草稿到了才画的,拿它当到齐的信号。 */
async function renderRuntimeSection() {
	vi.mocked(api.get).mockImplementation(async (url: string) => {
		if (url === "/api/settings") return JSON.parse(JSON.stringify(GLOBALS));
		if (url === "/api/connections/capabilities") return {};
		return [];
	});
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

/** 某一格(按字段码)里的输入框。 */
function inputOf(code: string): HTMLInputElement {
	const input = document.querySelector<HTMLInputElement>(`[data-code="${code}"] input`);
	if (!input) throw new Error(`找不到字段「${code}」的输入框`);
	return input;
}

/** 点保存,返回最后一发 `PATCH /api/settings` 的 body。 */
async function save(): Promise<Record<string, unknown>> {
	await act(async () => {
		await useDraftStore.getState().current?.onSave();
	});
	await waitFor(() => expect(api.patch).toHaveBeenCalled());
	const [url, body] = vi.mocked(api.patch).mock.calls.at(-1) as [string, Record<string, unknown>];
	expect(url).toBe("/api/settings");
	return body;
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

describe("系统页里 B 站的三格", () => {
	it("读:三格画的是 bilibili 块里的值", async () => {
		await renderRuntimeSection();
		expect(inputOf("bilibili.dynamicCron").value).toBe("30 */2 * * * *");
		expect(inputOf("bilibili.userAgent").value).toBe("UA/1");
		expect(inputOf("bilibili.healthCheckMinutes").value).toBe("30");
	});

	it.each([
		["bilibili.dynamicCron", "0 */10 * * * *", "dynamicCron", "0 */10 * * * *"],
		["bilibili.userAgent", "UA/2", "userAgent", "UA/2"],
		["bilibili.healthCheckMinutes", "45", "healthCheckMinutes", 45],
	])("写:改 %s → PATCH 发 { bilibili: { … } },不往 app 底下发", async (code, typed, key, sent) => {
		await renderRuntimeSection();
		fireEvent.change(inputOf(code), { target: { value: typed } });

		const body = await save();

		expect(body.bilibili).toMatchObject({ [key]: sent });
		expect(body).not.toHaveProperty("app");
	});

	it("写:清空 User-Agent → bilibili 块里以 null 送出(删除哨兵),不是悄悄不提", async () => {
		await renderRuntimeSection();
		fireEvent.change(inputOf("bilibili.userAgent"), { target: { value: "" } });

		const body = await save();

		expect(body.bilibili).toHaveProperty("userAgent", null);
	});

	it("改核心 app 的一格(日志等级)→ PATCH 里没有 bilibili 块", async () => {
		await renderRuntimeSection();
		// 「运行」格里 app.logLevel 那一行的「调试」档(L4)。
		const row = document.querySelector(`[data-code="app.logLevel"]`);
		if (!row) throw new Error("找不到字段「app.logLevel」");
		fireEvent.click(within(row as HTMLElement).getByText("L4 · 调试"));

		const body = await save();

		expect(body).toMatchObject({ app: { logLevel: "debug" } });
		expect(body).not.toHaveProperty("bilibili");
	});
});
