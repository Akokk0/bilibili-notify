// @vitest-environment jsdom

/**
 * 系统页「运行」格里那一格按模块日志等级 —— `logging.levels` 的**唯一**编辑口。
 *
 * image 与 ai 从前各自躺在「图片渲染」与「智能女仆」页的底部,同一个键分三处编辑;
 * 现在四个模块同住一格(动态与直播两个引擎共用一个 B 站键)。这里钉两件事:
 *
 * ① 四格一格不少 —— 搬过来的两格要真的画出来。少一格是纯静默的:类型、构建、
 *    别的测试全绿,只有真机上那一格凭空消失。
 * ② 退回「跟随全局」发的是**显式 null**。这条是踩过坑的:PATCH 走 JSON Merge
 *    Patch,键消失 = 「该字段不改」,靠「拷一份、删掉那个键、整份回传」来清除覆盖,
 *    请求会成功而后端原样留着旧等级 —— 退不回跟随全局。坑在 image / ai 各自那两页
 *    上分别栽过一次(旧守卫在 Cards.bykind-off 与 Ai.apikey-save),搬家之后四个模块
 *    共用这一条路径,守卫也跟着合并到这里。
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { handleStateEnvelope } from "../../hooks/useStateChannel";
import { i18n } from "../../i18n";
import { useDraftStore } from "../../store/draft";
import System from "../System";

// ── 子节全部换成哑桩:这条测试只问那一格,不问各节自己画得对不对 ──────────────

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

/**
 * `logLevels` 是这份配置里已有的按模块覆盖。`bilibili` 是 B 站自己的设置(动态 cron / UA / 登录心跳间隔),
 * `/api/settings` 把它挂在 `core` 的旁边下发 —— 系统页画那三格要读它,缺了整页画不出来。
 */
function mockApi(
	logLevels: Record<string, string>,
	metadata?: () => { source: string; adapter: string; extension: string },
): void {
	const settings = {
		core: {
			logging: {
				level: "info",
				levels: logLevels,
				retentionDays: 7,
				memoryLog: { enabled: false },
			},
			history: { retentionDays: 30 },
			stats: { enabled: true },
			master: { targetId: undefined },
		},
		bilibili: { dynamicCron: "30 */2 * * * *", healthCheckMinutes: 30 },
	};
	vi.mocked(api.get).mockImplementation(async (url: string) => {
		if (url === "/api/settings") return JSON.parse(JSON.stringify(settings));
		if (url === "/api/connections/capabilities") return {};
		if (url === "/api/sources")
			return {
				sources: [
					{
						key: "bilibili",
						descriptor: { label: metadata?.().source ?? "内置来源" },
						status: "running",
					},
					{ key: "acme.dual", descriptor: { label: "双口来源" }, status: "disabled" },
				],
			};
		if (url === "/api/adapters")
			return {
				adapters: [
					{ key: "onebot", descriptor: { label: metadata?.().adapter ?? "适配器甲" } },
					{ key: "qq-official", descriptor: { label: "适配器乙" } },
					{ key: "webhook", descriptor: { label: "适配器丙" } },
					{ key: "acme.dual", descriptor: { label: "双口推送" } },
				],
			};
		if (url === "/api/ext")
			return {
				extensions: [
					{
						id: "acme.dual",
						name: metadata?.().extension ?? "双口拓展",
						state: "disabled",
						provides: ["subscription", "push"],
					},
				],
			};
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
	await screen.findByText("双口拓展");
	return qc;
}

/** 某个模块那一行里的「跟随全局」钮 —— 四行各有一颗,按模块名定位。 */
function inheritButtonOf(moduleLabel: string): HTMLElement {
	const row = screen.getByText(moduleLabel).closest("fieldset");
	if (!row) throw new Error(`找不到模块「${moduleLabel}」那一行`);
	return within(row).getByText("跟随全局");
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

describe("系统页的按模块日志等级", () => {
	it.each([
		[
			"ja",
			"ご主人様、ログの出力元を読み込んでいますよ…",
			"ご主人様、ログの出力元をすべて読み込めませんでした。取得済みの項目と既存の上書き設定は残してあるので、もう一度試してくださいね。",
			"ご主人様、この出力元はまだ識別できませんが、既存の上書き設定は残しますね。",
			"ご主人様、個別に設定しない出力元は全体のログレベルに従いますよ。保存後すぐに反映されるので、再起動は不要です。",
		],
		[
			"zh-TW",
			"主人，女僕正在讀取日誌歸屬喔…",
			"主人，日誌歸屬還沒讀取完整；女僕保留了已知項目與既有覆寫，可以重試喔。",
			"主人，暫時無法辨識這個歸屬，女僕會保留既有覆寫喔。",
			"主人，未個別設定的項目會跟隨全域等級；儲存後立即生效，不必重新啟動喔。",
		],
	] as const)(
		"%s maid log-owner failures retain existing overrides without refetching owners or writing settings",
		async (locale, loading, failure, unknown, hint) => {
			mockApi({ "missing.source": "warn" });
			const read = vi.mocked(api.get).getMockImplementation();
			let reject!: (error: Error) => void;
			const pending = new Promise((_, fail) => {
				reject = fail;
			});
			vi.mocked(api.get).mockImplementation(async (path) =>
				path === "/api/sources" ? pending : read?.(path),
			);
			await renderRuntimeSection();
			const raw = screen.getByText("missing.source");
			const ownerReads = () =>
				vi
					.mocked(api.get)
					.mock.calls.filter(([path]) =>
						["/api/sources", "/api/adapters", "/api/ext"].includes(path),
					).length;
			const calls = ownerReads();
			act(() => i18n.set({ locale, voice: "maid" }));
			expect(screen.getByText(loading)).toBeTruthy();
			expect(screen.getByText(unknown)).toBeTruthy();
			expect(screen.getByText(hint)).toBeTruthy();
			expect(screen.getByText("missing.source")).toBe(raw);
			expect(ownerReads()).toBe(calls);
			await act(async () => reject(new Error("Original source list failure")));
			await screen.findByText(failure);
			expect(screen.getByText("missing.source")).toBe(raw);
			expect(screen.getByText("双口拓展")).toBeTruthy();
			expect(api.patch).not.toHaveBeenCalled();
			expect(api.post).not.toHaveBeenCalled();
		},
	);

	it("log owner loading and partial failures translate while known rows and existing overrides stay available", async () => {
		mockApi({ "missing.source": "warn" });
		const read = vi.mocked(api.get).getMockImplementation();
		let reject!: (error: Error) => void;
		const pending = new Promise((_, fail) => {
			reject = fail;
		});
		let recovered = false;
		vi.mocked(api.get).mockImplementation(async (path) => {
			if (path === "/api/sources" && !recovered) return pending;
			return read?.(path);
		});
		await renderRuntimeSection();
		for (const [locale, loading] of [
			["en", "Reading log owners…"],
			["ja", "ログの出力元を読み込んでいます…"],
			["zh-TW", "正在讀取日誌歸屬…"],
		] as const) {
			act(() => i18n.set({ locale }));
			expect(screen.getByText(loading)).toBeTruthy();
			expect(screen.getByText("双口拓展")).toBeTruthy();
			expect(screen.getByText("missing.source")).toBeTruthy();
		}
		await act(async () => reject(new Error("Original source list failure")));
		for (const [locale, failure, retry, visible] of [
			[
				"en",
				"The log owner list could not be read completely. Known owners and existing overrides are retained.",
				"Retry reading log owners",
				"Retry",
			],
			[
				"ja",
				"ログの出力元をすべて読み込めませんでした。取得済みの出力元と既存の上書き設定は保持しています。",
				"ログの出力元を再読み込み",
				"再試行",
			],
			["zh-TW", "無法完整讀取日誌歸屬清單，仍保留已知項目與既有覆寫。", "重試讀取日誌歸屬", "重試"],
		] as const) {
			act(() => i18n.set({ locale }));
			expect(screen.getByText(failure)).toBeTruthy();
			expect(screen.getByRole("button", { name: retry }).textContent).toBe(visible);
			expect(screen.getByText("双口拓展")).toBeTruthy();
			expect(screen.getByText("missing.source")).toBeTruthy();
			expect(api.patch).not.toHaveBeenCalled();
		}
		recovered = true;
		fireEvent.click(screen.getByRole("button", { name: "重試讀取日誌歸屬" }));
		await waitFor(() =>
			expect(screen.queryByText("無法完整讀取日誌歸屬清單，仍保留已知項目與既有覆寫。")).toBeNull(),
		);
		expect(screen.getByText("内置来源")).toBeTruthy();
		expect(screen.getByText("missing.source")).toBeTruthy();
		expect(api.patch).not.toHaveBeenCalled();
	});

	it("log override translations preserve the edited level and unknown owners until an explicit save", async () => {
		mockApi({ "old.source": "warn", core: "debug" });
		await renderRuntimeSection();
		fireEvent.click(
			within(screen.getByRole("group", { name: "核心（core）日志等级" })).getByText("L1 · 错误"),
		);
		for (const [
			locale,
			title,
			subtitle,
			overrides,
			hint,
			core,
			image,
			ai,
			unknown,
			memory,
			selected,
		] of [
			[
				"en",
				"Core · App",
				"Backend runtime settings",
				"Per-owner overrides",
				"Uses the global level unless overridden. Saved changes apply without restarting.",
				"Core (core) log level",
				"Image rendering (image) log level",
				"AI (ai) log level",
				"Owner not recognized. Its existing override is retained.",
				"Memory self-check logging",
				"L1 · Error",
			],
			[
				"ja",
				"Core · アプリ",
				"バックエンドの実行設定",
				"出力元別の上書き",
				"上書きしない場合は全体のログレベルに従います。保存後すぐに反映され、再起動は不要です。",
				"コア（core）のログレベル",
				"画像描画（image）のログレベル",
				"AI（ai）のログレベル",
				"出力元を識別できません。既存の上書き設定を保持しています。",
				"メモリー自己診断ログ",
				"L1 · エラー",
			],
			[
				"zh-TW",
				"Core · 應用程式",
				"後端執行參數",
				"依歸屬覆寫",
				"未覆寫時跟隨全域等級；儲存後生效，不需重新啟動。",
				"核心（core）日誌等級",
				"圖片繪製（image）日誌等級",
				"AI（ai）日誌等級",
				"無法識別歸屬，仍保留既有覆寫。",
				"記憶體自我檢查日誌",
				"L1 · 錯誤",
			],
		] as const) {
			act(() => i18n.set({ locale }));
			for (const text of [title, subtitle, overrides, hint, unknown])
				expect(screen.getByText(text)).toBeTruthy();
			expect(
				within(screen.getByRole("group", { name: core }))
					.getByRole("button", { name: selected })
					.getAttribute("aria-pressed"),
			).toBe("true");
			expect(screen.getByRole("group", { name: image })).toBeTruthy();
			expect(screen.getByRole("group", { name: ai })).toBeTruthy();
			expect(screen.getByText("双口拓展")).toBeTruthy();
			expect(screen.getByText("old.source")).toBeTruthy();
			expect(screen.getByRole("button", { name: memory }).getAttribute("aria-pressed")).toBe(
				"false",
			);
			expect(api.patch).not.toHaveBeenCalled();
		}
		await act(async () => {
			await useDraftStore.getState().current?.onSave();
		});
		expect(api.patch).toHaveBeenCalledExactlyOnceWith(
			"/api/settings",
			expect.objectContaining({
				core: expect.objectContaining({
					logging: expect.objectContaining({ levels: { "old.source": "warn", core: "error" } }),
				}),
			}),
		);
	});

	it("未知归属覆盖继续可见，修改别的归属后保存仍保留它", async () => {
		mockApi({ "old.source": "warn", core: "debug" });
		await renderRuntimeSection();
		expect(screen.getByText("未识别归属，保留已有覆盖。")).toBeTruthy();
		fireEvent.click(
			within(screen.getByRole("group", { name: "核心（core）日志等级" })).getByText("L1 · 错误"),
		);
		await act(async () => {
			await useDraftStore.getState().current?.onSave();
		});
		expect(api.patch).toHaveBeenCalledWith(
			"/api/settings",
			expect.objectContaining({
				core: expect.objectContaining({
					logging: expect.objectContaining({ levels: { "old.source": "warn", core: "error" } }),
				}),
			}),
		);
	});

	it("归属读口失败时明确提示不完整，已有覆盖仍可手动清除", async () => {
		mockApi({ "missing.source": "warn" });
		const read = vi.mocked(api.get).getMockImplementation();
		vi.mocked(api.get).mockImplementation(async (path) => {
			if (path === "/api/sources") throw new Error("unavailable");
			return read?.(path);
		});
		await renderRuntimeSection();
		expect(
			await screen.findByText("日志归属列表未完整读取，已知项和已有覆盖仍保留。"),
		).toBeTruthy();
		fireEvent.click(inheritButtonOf("missing.source"));
		await act(async () => {
			await useDraftStore.getState().current?.onSave();
		});
		expect(api.patch).toHaveBeenCalledWith(
			"/api/settings",
			expect.objectContaining({
				core: expect.objectContaining({
					logging: expect.objectContaining({ levels: { "missing.source": null } }),
				}),
			}),
		);
	});
	it("核心、来源、适配器与停用拓展按归属列出，多口拓展只占一行", async () => {
		mockApi({});
		await renderRuntimeSection();
		for (const label of [
			"核心",
			"内置来源",
			"出图",
			"AI",
			"适配器甲",
			"适配器乙",
			"适配器丙",
			"双口拓展",
		]) {
			expect(screen.getByText(label), `缺了「${label}」那一格`).toBeTruthy();
		}
		// 并掉的两格不再各画一格。
		expect(screen.queryByText("双口来源")).toBeNull();
		expect(screen.queryByText("双口推送")).toBeNull();
		expect(screen.getAllByText("双口拓展")).toHaveLength(1);
		expect(screen.queryByText("dynamic 动态")).toBeNull();
		expect(screen.queryByText("live 直播")).toBeNull();
	});

	it.each([
		["出图", "image"],
		["AI", "ai"],
		["内置来源", "bilibili"],
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

		const [url, { core: body }] = vi.mocked(api.patch).mock.calls.at(-1) as [
			string,
			{ core: { logging: { levels: Record<string, unknown> } } },
		];
		expect(url).toBe("/api/settings");
		// 键必须在,且为 null。少了这个键,后端 deepMerge 会原样留着旧等级。
		expect(body.logging.levels).toHaveProperty(key);
		expect(body.logging.levels[key]).toBeNull();
	});

	it("内存自检开关的补丁根在 logging.memoryLog.enabled,别的格不带", async () => {
		mockApi({ ai: "warn" });
		await renderRuntimeSection();

		fireEvent.click(screen.getByRole("button", { name: "内存自检打印" }));

		await act(async () => {
			await useDraftStore.getState().current?.onSave();
		});
		await waitFor(() => expect(api.patch).toHaveBeenCalled());

		const [, { core: body }] = vi.mocked(api.patch).mock.calls.at(-1) as [
			string,
			{ core: { logging: { memoryLog: { enabled: boolean } } } },
		];
		expect(body.logging.memoryLog.enabled).toBe(true);
	});

	it("只清自己那一格 —— 同时有两个覆盖时,没动的那个原样留着", async () => {
		// 草稿层的合并也得认 null(见 System.tsx 的 deepMerge):不认的话「拷一份删掉键
		// 整份回传」会把被删的键当场合回来,而这**只在同时有两个以上覆盖时**才现形 ——
		// 只剩一个时删空成 undefined 反而歪打正着。
		mockApi({ image: "debug", ai: "warn" });
		await renderRuntimeSection();

		fireEvent.click(inheritButtonOf("出图"));

		await act(async () => {
			await useDraftStore.getState().current?.onSave();
		});
		await waitFor(() => expect(api.patch).toHaveBeenCalled());

		const [, { core: body }] = vi.mocked(api.patch).mock.calls.at(-1) as [
			string,
			{ core: { logging: { levels: Record<string, unknown> } } },
		];
		expect(body.logging.levels.image).toBeNull();
		expect(body.logging.levels.ai).toBe("warn");
	});
});

it("settings events refresh localized source, adapter and extension descriptions without discarding an active draft", async () => {
	let metadata = { source: "内置来源", adapter: "适配器甲", extension: "双口拓展" };
	mockApi({ core: "debug", "old.source": "warn" }, () => metadata);
	const qc = await renderRuntimeSection();
	fireEvent.click(
		within(screen.getByRole("group", { name: "核心（core）日志等级" })).getByRole("button", {
			name: "L1 · 错误",
		}),
	);
	for (const [locale, source, adapter, extension, core, selected] of [
		[
			"en",
			"Source English",
			"Adapter English",
			"Extension English",
			"Core (core) log level",
			"L1 · Error",
		],
		[
			"ja",
			"日本語のソース",
			"日本語のアダプター",
			"日本語の拡張機能",
			"コア（core）のログレベル",
			"L1 · エラー",
		],
		["zh-TW", "繁中來源", "繁中適配器", "繁中拓展", "核心（core）日誌等級", "L1 · 錯誤"],
	] as const) {
		metadata = { source, adapter, extension };
		await act(async () => {
			i18n.set({ locale, voice: "plain" });
			handleStateEnvelope(
				{
					type: "state",
					event: "config-changed",
					data: { scope: "globals" },
					ts: "2026-11-08T00:00:00.000Z",
				},
				qc,
			);
		});
		expect(await screen.findByText(source)).toBeTruthy();
		expect(await screen.findByText(adapter)).toBeTruthy();
		expect(await screen.findByText(extension)).toBeTruthy();
		expect(
			within(screen.getByRole("group", { name: core }))
				.getByRole("button", { name: selected })
				.getAttribute("aria-pressed"),
		).toBe("true");
		expect(screen.getByText("old.source")).toBeTruthy();
		expect(api.patch).not.toHaveBeenCalled();
	}
});
