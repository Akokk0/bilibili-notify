// @vitest-environment jsdom

/**
 * 系统页「运行」格里 B 站那两格(动态检查频率 / 登录心跳间隔)。
 *
 * 这两格住在 B 站自己的设置里 —— `/api/settings` 把它挂在 `bilibili` 键下,和核心设置并排;不在核心的
 * `app` 下。钉三条**接线**(零件各自的测试证明不了页面真的接上了):
 *
 * ① 读 —— 两格画的是 `draft.bilibili.*` 的值。读错了地方,格子是空的 / 默认的,保存时还会把空值发回去。
 * ② 写 —— 改一格,PATCH 发的是 `{ bilibili: { … } }`。发到 `app` 底下的话,服务端按块分文件落盘,核心设置
 *    会把它当成不认得的键拒收;而面板这头照样画着改过的值,看上去一切正常。
 * ③ 没有 User-Agent 那一格 —— 自定义 UA 删了,身份一律由服务端生成(ADR-0025 决策 7)。老服务端 / 老草稿里
 *    `bilibili.userAgent` 还在也不画。
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { useDraftStore } from "../../store/draft";
import System from "../System";

// ── 子节全部换成哑桩:这条测试只问 B 站那两格,不问各节自己画得对不对 ──────────────

vi.mock("../../components/commands-settings", () => ({
	CommandsSettings: () => <div data-testid="sec-commands" />,
}));
vi.mock("../../components/link-preview-settings", () => ({
	LinkPreviewSettings: () => <div data-testid="sec-link-preview" />,
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

// 登录状态：这条测试不关心账号卡，按「还没取到」处理（与从前的空快照同一语境）。
vi.mock("../../hooks/use-source-auth", () => ({
	useSourceAuth: () => ({
		state: undefined,
		account: undefined,
		raw: undefined,
		isLoading: true,
		isError: false,
		error: null,
		startLogin: { isPending: false, mutate: () => {} },
		logout: { isPending: false, mutate: () => {} },
	}),
}));

// 假 ApiError 进 vi.hoisted:`vi.mock` 的工厂被提到文件顶,写成模块级 const 会撞 TDZ。
const { FakeApiError } = vi.hoisted(() => ({ FakeApiError: class extends Error {} }));

vi.mock("../../services/api", () => ({
	ApiError: FakeApiError,
	api: { get: vi.fn(), post: vi.fn(async () => ({ ok: true })), patch: vi.fn(async () => ({})) },
}));

import { api } from "../../services/api";

/** 服务端下发的那一份:核心那份在 `core` 下 + 并排的 `bilibili`(两格都有值)。 */
const GLOBALS = {
	core: {
		logging: { level: "info", levels: {}, retentionDays: 7, memoryLog: { enabled: false } },
		history: { retentionDays: 30 },
		master: { targetId: undefined },
	},
	bilibili: { dynamicCron: "30 */2 * * * *", healthCheckMinutes: 30 },
};

function resetStore(): void {
	useDraftStore.setState({
		current: null,
		uiState: "idle",
		errorMessage: null,
		panelLocked: false,
	});
}

/** 渲染并停到「运行」格(两格就在那里);`Core · 应用` 那张卡是草稿到了才画的,拿它当到齐的信号。 */
async function renderRuntimeSection(served: unknown = GLOBALS) {
	vi.mocked(api.get).mockImplementation(async (url: string) => {
		if (url === "/api/settings") return JSON.parse(JSON.stringify(served));
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
async function save(): Promise<{
	core?: Record<string, unknown>;
	bilibili?: Record<string, unknown>;
}> {
	await act(async () => {
		await useDraftStore.getState().current?.onSave();
	});
	await waitFor(() => expect(api.patch).toHaveBeenCalled());
	const [url, body] = vi.mocked(api.patch).mock.calls.at(-1) as [
		string,
		{ core?: Record<string, unknown>; bilibili?: Record<string, unknown> },
	];
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

describe("系统页里 B 站的两格", () => {
	it("运行草稿跨分区保留，放弃后恢复服务器值", async () => {
		await renderRuntimeSection();
		fireEvent.change(inputOf("bilibili.dynamicCron"), { target: { value: "0 */10 * * * *" } });
		fireEvent.click(screen.getAllByRole("button", { name: "账号" })[0]);
		fireEvent.click(screen.getAllByRole("button", { name: "运行" })[0]);
		expect(inputOf("bilibili.dynamicCron").value).toBe("0 */10 * * * *");
		act(() => useDraftStore.getState().current?.onDiscard());
		expect(inputOf("bilibili.dynamicCron").value).toBe("30 */2 * * * *");
		expect(api.patch).not.toHaveBeenCalled();
	});

	it("读:两格画的是 bilibili 块里的值", async () => {
		await renderRuntimeSection();
		expect(inputOf("bilibili.dynamicCron").value).toBe("30 */2 * * * *");
		expect(inputOf("bilibili.healthCheckMinutes").value).toBe("30");
	});

	it("没有 User-Agent 那一格:草稿里残留着 bilibili.userAgent 也不画", async () => {
		await renderRuntimeSection({
			...GLOBALS,
			bilibili: { ...GLOBALS.bilibili, userAgent: "UA/stale" },
		});

		expect(document.querySelector(`[data-code="bilibili.userAgent"]`)).toBeNull();
		expect(screen.queryByText("User-Agent")).toBeNull();
		expect(screen.queryByDisplayValue("UA/stale")).toBeNull();
	});

	it.each([
		["bilibili.dynamicCron", "0 */10 * * * *", "dynamicCron", "0 */10 * * * *"],
		["bilibili.healthCheckMinutes", "45", "healthCheckMinutes", 45],
	])("写:改 %s → PATCH 发 { bilibili: { … } },不碰 core", async (code, typed, key, sent) => {
		await renderRuntimeSection();
		fireEvent.change(inputOf(code), { target: { value: typed } });

		const body = await save();

		expect(body.bilibili).toMatchObject({ [key]: sent });
		expect(body).not.toHaveProperty("core");
	});

	it("改核心 logging 的一格(日志等级)→ PATCH 里没有 bilibili 块", async () => {
		await renderRuntimeSection();
		// 「运行」格里 core.logging.level 那一行的「调试」档(L4)。
		const row = document.querySelector(`[data-code="core.logging.level"]`);
		if (!row) throw new Error("找不到字段「core.logging.level」");
		fireEvent.click(within(row as HTMLElement).getByText("L4 · 调试"));

		const body = await save();

		expect(body).toMatchObject({ core: { logging: { level: "debug" } } });
		expect(body).not.toHaveProperty("bilibili");
	});
});

/**
 * **图片与重推原件保留**(ADR-0022 决策 9):只许七档,所以是段选钮组,不是能填任意数的数字框,也不是下拉 ——
 * 选项个数固定的用 `Picker`,选项来自数据、个数不定才用下拉(10-04 主人定)。
 */
describe("系统页里的保留天数", () => {
	const row = (): HTMLElement => {
		const el = document.querySelector<HTMLElement>(`[data-code="core.history.retentionDays"]`);
		if (!el) throw new Error("找不到字段「core.history.retentionDays」");
		return el;
	};

	it("读:七档段选,当前那一档按着;标签说清它管的是图片与重推原件", async () => {
		await renderRuntimeSection();
		const options = within(row()).getAllByRole("button");
		expect(options.map((b) => b.textContent)).toEqual([
			"90 天",
			"60 天",
			"30 天",
			"15 天",
			"7 天",
			"3 天",
			"1 天",
		]);
		expect(options.map((b) => b.getAttribute("aria-pressed"))).toEqual([
			"false",
			"false",
			"true",
			"false",
			"false",
			"false",
			"false",
		]);
		expect(within(row()).getByText("图片与重推原件保留")).toBeTruthy();
		expect(row().querySelector("input")).toBeNull();
	});

	it("写:点「7 天」→ PATCH 发 { core: { history: { retentionDays: 7 } } },别的块不带", async () => {
		await renderRuntimeSection();
		fireEvent.click(within(row()).getByText("7 天"));

		const body = await save();

		expect(body).toMatchObject({ core: { history: { retentionDays: 7 } } });
		expect(body.core).not.toHaveProperty("logging");
		expect(body).not.toHaveProperty("bilibili");
	});
});
