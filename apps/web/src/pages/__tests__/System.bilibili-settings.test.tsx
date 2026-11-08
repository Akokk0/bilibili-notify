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

import type {
	IntegrationSettingsDescriptorsResponse,
	InvalidSettingView,
} from "@bilibili-notify/contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { i18n } from "../../i18n";
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
		stats: { enabled: true },
		master: { targetId: undefined },
	},
	bilibili: { dynamicCron: "30 */2 * * * *", healthCheckMinutes: 30 },
};

const DEFINITIONS: IntegrationSettingsDescriptorsResponse = {
	integrations: [
		{
			key: "bilibili",
			label: "B 站",
			identityReset: "restart",
			fields: [
				{
					key: "dynamicCron",
					type: "string",
					label: "动态检查频率",
					default: "0 */2 * * * *",
					monospace: true,
				},
				{
					key: "healthCheckMinutes",
					type: "number",
					label: "登录心跳间隔",
					default: 30,
					min: 5,
					max: 180,
					unit: "min",
					step: 1,
				},
			],
		},
	],
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
async function renderRuntimeSection(
	served: unknown = GLOBALS,
	definitions: IntegrationSettingsDescriptorsResponse = DEFINITIONS,
	invalid: InvalidSettingView[] = [],
) {
	vi.mocked(api.get).mockImplementation(async (url: string) => {
		if (url === "/api/settings/invalid") return { entries: invalid };
		if (url === "/api/settings") return JSON.parse(JSON.stringify(served));
		if (url === "/api/system/storage") return { rows: [] };
		if (url === "/api/system/generations") return { generations: [] };
		if (url === "/api/settings/integrations") return definitions;
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

async function renderIntegrationSection(served: unknown = GLOBALS) {
	await renderRuntimeSection(served);
	fireEvent.click(await screen.findByRole("button", { name: "B 站" }));
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
	[key: string]: unknown;
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
	i18n.set({ locale: "zh-CN", voice: "plain" });
	resetStore();
	Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
	cleanup();
	resetStore();
	vi.clearAllMocks();
});

describe("系统页里 B 站的两格", () => {
	it("集成图片放在中性标识底上，不叠同色渐变，并放大到可辨认尺寸", async () => {
		const icon = "data:image/png;base64,QUJD";
		await renderRuntimeSection(GLOBALS, {
			integrations: DEFINITIONS.integrations.map((entry) => ({ ...entry, icon })),
		});
		fireEvent.click(await screen.findByRole("button", { name: "B 站" }));
		const header = screen.getByText("集成设置").parentElement?.parentElement;
		const image = header?.querySelector("img");
		expect(image?.getAttribute("src")).toBe(icon);
		expect(image?.parentElement?.getAttribute("style")).toContain("--color-bn-inactive");
		expect(image?.parentElement?.getAttribute("style")).not.toContain("linear-gradient");
		expect(image?.style.width).toBe("20px");
	});

	it("来源设置在原侧栏独立列出，运行区不再重复显示", async () => {
		await renderRuntimeSection();
		expect(document.querySelector('[data-code="bilibili.dynamicCron"]')).toBeNull();
		fireEvent.click(await screen.findByRole("button", { name: "B 站" }));
		expect(inputOf("bilibili.dynamicCron").value).toBe("30 */2 * * * *");
		expect(inputOf("bilibili.healthCheckMinutes").value).toBe("30");
		expect(screen.getByRole("button", { name: "换一个身份" })).toBeTruthy();
	});

	it("规则范围在表单校验，越界不发保存请求，合法值仍只改集成段", async () => {
		await renderIntegrationSection();
		fireEvent.change(inputOf("bilibili.healthCheckMinutes"), { target: { value: "181" } });
		expect(screen.getByText(/5.*180/)).toBeTruthy();
		await act(async () => {
			await useDraftStore.getState().current?.onSave();
		});
		expect(api.patch).not.toHaveBeenCalled();
		expect(useDraftStore.getState().errorMessage).toMatch(/5.*180/);
		fireEvent.change(inputOf("bilibili.healthCheckMinutes"), { target: { value: "5" } });
		expect(await save()).toMatchObject({ bilibili: { healthCheckMinutes: 5 } });
	});
	it("更换身份先确认，取消不请求，成功说明下次重启生效", async () => {
		await renderIntegrationSection();
		fireEvent.click(screen.getByRole("button", { name: "换一个身份" }));
		expect(screen.getByRole("dialog").textContent).toContain("下次服务重启");
		fireEvent.click(screen.getByRole("button", { name: "取消" }));
		expect(api.post).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "换一个身份" }));
		fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "换一个身份" }));
		await screen.findByText("已安排在下次服务重启时生成新身份。");
		expect(api.post).toHaveBeenCalledExactlyOnceWith(
			"/api/settings/integrations/bilibili/reset-identity",
		);
		expect(api.patch).not.toHaveBeenCalled();
	});
	it("身份重置失败显示原话，未保存的草稿阻止即时动作", async () => {
		vi.mocked(api.post).mockRejectedValueOnce(new Error("identity write failed"));
		await renderIntegrationSection();
		fireEvent.click(screen.getByRole("button", { name: "换一个身份" }));
		fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "换一个身份" }));
		await screen.findByText("identity write failed");
		fireEvent.change(inputOf("bilibili.dynamicCron"), { target: { value: "0 */10 * * * *" } });
		await waitFor(() =>
			expect(
				(screen.getByRole("button", { name: "换一个身份" }) as HTMLButtonElement).disabled,
			).toBe(true),
		);
		expect(api.post).toHaveBeenCalledTimes(1);
	});

	it("不同集成的键、字段和范围同样取自描述，保存不混入核心或别的集成", async () => {
		await renderRuntimeSection(
			{ ...GLOBALS, native: { poll: 12 } },
			{
				integrations: [
					{
						key: "native",
						label: "Library",
						fields: [
							{
								key: "poll",
								type: "number",
								label: "Poll interval",
								min: 10,
								max: 20,
								default: 12,
							},
						],
					},
				],
			},
		);
		fireEvent.click(await screen.findByRole("button", { name: "Library" }));
		expect(inputOf("native.poll").value).toBe("12");
		expect(screen.queryByRole("button", { name: "换一个身份" })).toBeNull();
		fireEvent.change(inputOf("native.poll"), { target: { value: "15" } });
		expect(await save()).toEqual({ native: { poll: 15 } });
	});
	it("集成草稿跨分区保留，放弃后恢复服务器值", async () => {
		await renderIntegrationSection();
		fireEvent.change(inputOf("bilibili.dynamicCron"), { target: { value: "0 */10 * * * *" } });
		fireEvent.click(screen.getAllByRole("button", { name: "账号" })[0]);
		fireEvent.click(screen.getAllByRole("button", { name: "B 站" })[0]);
		expect(inputOf("bilibili.dynamicCron").value).toBe("0 */10 * * * *");
		act(() => useDraftStore.getState().current?.onDiscard());
		expect(inputOf("bilibili.dynamicCron").value).toBe("30 */2 * * * *");
		expect(api.patch).not.toHaveBeenCalled();
	});

	it("读:两格画的是 bilibili 块里的值", async () => {
		await renderIntegrationSection();
		expect(inputOf("bilibili.dynamicCron").value).toBe("30 */2 * * * *");
		expect(inputOf("bilibili.healthCheckMinutes").value).toBe("30");
	});

	it("没有 User-Agent 那一格:草稿里残留着 bilibili.userAgent 也不画", async () => {
		await renderIntegrationSection({
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
		await renderIntegrationSection();
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
		fireEvent.click(screen.getByRole("button", { name: "存储" }));
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
		fireEvent.click(screen.getByRole("button", { name: "存储" }));
		fireEvent.click(within(row()).getByText("7 天"));

		const body = await save();

		expect(body).toMatchObject({ core: { history: { retentionDays: 7 } } });
		expect(body.core).not.toHaveProperty("logging");
		expect(body).not.toHaveProperty("bilibili");
	});
});

describe("系统运行区的统计开关", () => {
	it.each([true, false])("读取enabled=%s，改动可放弃，保存只提交统计块", async (enabled) => {
		await renderRuntimeSection({ ...GLOBALS, core: { ...GLOBALS.core, stats: { enabled } } });
		const toggle = screen.getByRole("button", { name: "统计记录" });
		expect(toggle.getAttribute("aria-pressed")).toBe(String(enabled));
		fireEvent.click(toggle);
		expect(toggle.getAttribute("aria-pressed")).toBe(String(!enabled));
		act(() => useDraftStore.getState().current?.onDiscard());
		expect(toggle.getAttribute("aria-pressed")).toBe(String(enabled));
		expect(api.patch).not.toHaveBeenCalled();
		fireEvent.click(toggle);
		await waitFor(() =>
			expect(useDraftStore.getState().current?.diff.map((item) => item.code)).toContain(
				"core.stats.enabled",
			),
		);
		expect(await save()).toEqual({ core: { stats: { enabled: !enabled } } });
	});
});

describe("isolated settings on the System page", () => {
	it("shows original non-secret values and every reason, while secret cells have no value view", async () => {
		await renderRuntimeSection(GLOBALS, DEFINITIONS, [
			{
				path: ["bilibili", "healthCheckMinutes"],
				secret: false,
				raw: 999,
				missing: false,
				issues: [{ path: ["healthCheckMinutes"], message: "too large" }],
			},
			{
				path: ["core", "ai", "providers", "hidden"],
				secret: true,
				issues: [{ path: [], message: "invalid provider" }],
			},
		]);
		expect(await screen.findByText("999")).toBeTruthy();
		expect(screen.getByText("too large")).toBeTruthy();
		expect(screen.getByText("invalid provider")).toBeTruthy();
		expect(screen.getByText("core.ai.providers.hidden")).toBeTruthy();
		expect(screen.getByText("密钥原值不显示")).toBeTruthy();
		expect(api.patch).not.toHaveBeenCalled();
	});
});

it("invalid-setting guidance translates while original values, paths and diagnostics stay visible", async () => {
	await renderRuntimeSection(GLOBALS, DEFINITIONS, [
		{
			path: ["core", "stats", "enabled"],
			secret: false,
			raw: "原始无效值",
			missing: false,
			issues: [{ path: ["enabled"], message: "原诊断" }],
		},
		{
			path: ["core", "ai", "providers", "hidden"],
			secret: true,
			issues: [{ path: [], message: "原密钥诊断" }],
		},
		{
			path: [],
			secret: false,
			raw: null,
			missing: true,
			issues: [{ path: [], message: "缺少文件" }],
		},
	]);
	for (const [locale, title, secret, original, missing, file] of [
		[
			"en",
			"Invalid settings",
			"Original secret values are not displayed",
			"Original value",
			"Missing setting",
			"Settings file",
		],
		[
			"ja",
			"無効な設定",
			"シークレットの元の値は表示しません",
			"元の値",
			"項目がありません",
			"設定ファイル",
		],
		["zh-TW", "設定無效", "不顯示機密原值", "原值", "缺少此項", "設定檔"],
	] as const) {
		act(() => i18n.set({ locale }));
		expect(await screen.findByText(title)).toBeTruthy();
		expect(screen.getByText(secret)).toBeTruthy();
		expect(screen.getAllByText(original).length).toBeGreaterThan(0);
		expect(screen.getByText(missing)).toBeTruthy();
		expect(screen.getByText(file)).toBeTruthy();
		expect(screen.getByText('"原始无效值"')).toBeTruthy();
		expect(
			within(screen.getByText('"原始无效值"').closest("li") as HTMLElement).getByText(
				"core.stats.enabled",
			),
		).toBeTruthy();
		expect(screen.getByText("原诊断")).toBeTruthy();
		expect(screen.getByText("原密钥诊断")).toBeTruthy();
		expect(api.patch).not.toHaveBeenCalled();
	}
});

it("translated browser identity confirmation changes only the chosen integration and retains unsaved drafts", async () => {
	await renderIntegrationSection();
	for (const [locale, title, reset, hint] of [
		[
			"en",
			"Browser identity",
			"Change identity",
			"The change takes effect the next time the service restarts. Current requests and live connections keep using the existing identity; sign-in state is preserved.",
		],
		[
			"ja",
			"ブラウザー識別情報",
			"識別情報を変更",
			"次回のサービス再起動時に反映されます。処理中のリクエストとライブ接続は現在の識別情報を使い続け、ログイン状態も保持されます。",
		],
		[
			"zh-TW",
			"瀏覽器身分",
			"更換身分",
			"變更將於下次服務重新啟動時生效。目前的請求與直播連線會繼續使用現有身分，並保留登入狀態。",
		],
	] as const) {
		act(() => i18n.set({ locale }));
		expect(screen.getByText(title)).toBeTruthy();
		expect(screen.getByText(hint)).toBeTruthy();
		expect(screen.getByRole("button", { name: reset })).toBeTruthy();
		expect(api.post).not.toHaveBeenCalled();
	}
	fireEvent.click(screen.getByRole("button", { name: "更換身分" }));
	const dialog = await screen.findByRole("dialog");
	for (const [locale, title, reset, hint] of [
		[
			"en",
			"Change browser identity?",
			"Change identity",
			"The change takes effect the next time the service restarts. Current requests and live connections keep using the existing identity; sign-in state is preserved.",
		],
		[
			"ja",
			"ブラウザー識別情報を変更しますか？",
			"識別情報を変更",
			"次回のサービス再起動時に反映されます。処理中のリクエストとライブ接続は現在の識別情報を使い続け、ログイン状態も保持されます。",
		],
		[
			"zh-TW",
			"更換瀏覽器身分？",
			"更換身分",
			"變更將於下次服務重新啟動時生效。目前的請求與直播連線會繼續使用現有身分，並保留登入狀態。",
		],
	] as const) {
		act(() => i18n.set({ locale }));
		expect(within(dialog).getByText(title)).toBeTruthy();
		expect(within(dialog).getByText(hint)).toBeTruthy();
		expect(within(dialog).getByRole("button", { name: reset })).toBeTruthy();
		expect(api.post).not.toHaveBeenCalled();
	}
	vi.mocked(api.post).mockResolvedValueOnce({ ok: true });
	fireEvent.click(within(dialog).getByRole("button", { name: "更換身分" }));
	await screen.findByText("已安排於下次服務重新啟動時產生新身分。");
	fireEvent.change(inputOf("bilibili.dynamicCron"), { target: { value: "0 */10 * * * *" } });
	for (const [locale, reset, done, dirty] of [
		[
			"en",
			"Change identity",
			"A new identity will be generated the next time the service restarts.",
			"Save or discard the current draft before changing the browser identity.",
		],
		[
			"ja",
			"識別情報を変更",
			"次回のサービス再起動時に新しい識別情報を生成します。",
			"ブラウザー識別情報を変更する前に、現在の下書きを保存または破棄してください。",
		],
		[
			"zh-TW",
			"更換身分",
			"已安排於下次服務重新啟動時產生新身分。",
			"請先儲存或放棄目前草稿，再更換瀏覽器身分。",
		],
	] as const) {
		act(() => i18n.set({ locale }));
		expect(screen.getByText(done)).toBeTruthy();
		expect(await screen.findByText(dirty)).toBeTruthy();
		expect((screen.getByRole("button", { name: reset }) as HTMLButtonElement).disabled).toBe(true);
		expect(inputOf("bilibili.dynamicCron").value).toBe("0 */10 * * * *");
		expect(api.patch).not.toHaveBeenCalled();
	}
	expect(api.post).toHaveBeenCalledExactlyOnceWith(
		"/api/settings/integrations/bilibili/reset-identity",
	);
});
