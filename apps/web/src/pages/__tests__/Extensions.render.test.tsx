// @vitest-environment jsdom

import type {
	ExtensionsResponse,
	ExtensionView,
	MarketplaceResponse,
} from "@bilibili-notify/contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { i18n } from "../../i18n";
import Extensions from "../Extensions";
import { type CardMotion, EXT_UPDATE_BUTTON, useCardMotionStore } from "../extensions/card-motion";

beforeEach(() => i18n.set({ locale: "zh-CN", voice: "maid" }));

const { apiGetMock, apiPatchMock, apiPostMock, apiUploadMock } = vi.hoisted(() => ({
	apiGetMock: vi.fn(),
	apiPatchMock: vi.fn(),
	apiPostMock: vi.fn(),
	apiUploadMock: vi.fn(),
}));

vi.mock("../../services/api", () => ({
	api: {
		get: apiGetMock as unknown as (url: string) => Promise<unknown>,
		patch: apiPatchMock as unknown as (url: string, body?: unknown) => Promise<unknown>,
		post: apiPostMock as unknown as (url: string, body?: unknown) => Promise<unknown>,
		upload: apiUploadMock,
	},
	ApiError: class ApiError extends Error {},
}));

/** 市场那一口的默认回答:官方源在、什么都没列 —— 单独一条用例才往里放条目。 */
const MARKET: MarketplaceResponse = {
	available: true,
	fetchedAt: "2026-10-27T00:00:00.000Z",
	sources: [],
	extensions: [],
};

/** 迁到 v2 的桥 —— 卡上「N 条连接」后面那一行由它的视图交(`summary`)。 */
const BRIDGE: ExtensionsResponse["extensions"][number] = {
	id: "bridge",
	name: "机器人框架桥接",
	description: "把别的机器人框架里的 bot 借过来发推送",
	version: "1.0.0",
	apiVersion: 1,
	provides: ["push"],
	icon: '<svg viewBox="0 0 24 24" data-testid="bridge-icon"><path d="M4 4h16"/></svg>',
	enabled: true,
	state: "running",
	dir: "/data/extensions/bridge",
};

/** 从第三方源装来的一条 —— 「更新」这条路上 BN 同样不担保它。 */
const THIRD_PARTY: ExtensionsResponse["extensions"][number] = {
	id: "alice.douyin",
	name: "抖音订阅源(alice)",
	version: "1.0.0",
	provides: ["subscription"],
	enabled: true,
	state: "running",
	dir: "/data/extensions/alice.douyin",
};

const THIRD_PARTY_ENTRY: MarketplaceResponse["extensions"][number] = {
	source: "s1",
	official: false,
	id: "alice.douyin",
	name: "抖音订阅源(alice)",
	description: "",
	version: "1.0.0",
	apiVersion: 1,
	prerelease: false,
	size: 1,
	installed: { version: "1.0.0", source: "s1" },
	state: "installed",
};

function marketWith(entry: MarketplaceResponse["extensions"][number]): MarketplaceResponse {
	return {
		...MARKET,
		sources: [
			{ id: "official", name: "BN 官方拓展", official: true, ok: true },
			{
				id: "s1",
				name: "alice",
				official: false,
				url: "https://alice.example/m.json",
				namespace: "alice",
				ok: true,
			},
		],
		extensions: [entry],
	};
}

const LISTED: ExtensionsResponse = {
	extensions: [
		BRIDGE,
		{
			id: "douyin",
			name: "抖音订阅源",
			version: "0.2.0",
			provides: ["subscription"],
			enabled: true,
			state: "blocked",
			detail: "连续加载失败 3 次,已自动停用;换一版会重新试",
			dir: "/data/extensions/douyin",
		},
	],
	restart: { can: true, how: "container" },
};

/** 从桥借来的 bot 建的两条连接,外加一条与拓展无关的直连 —— 数错了它就会混进来。 */
const CONNECTIONS = [
	{ id: "a", name: "家里那台", adapterKey: "bridge", enabled: true },
	{ id: "b", name: "机房那台", adapterKey: "bridge", enabled: true },
	{ id: "c", name: "本地 OneBot", adapterKey: "onebot", enabled: true },
	// ⚠️ 别的拓展名下的一条。少了它,「按 adapterKey 过滤」这条守卫离了保护也不会坏。
	{ id: "d", name: "别人家的", adapterKey: "somewhere-else", enabled: true },
];

/**
 * 桥交来的视图:列表页那一行是「2 个 bot 在线」。只数**连着的**会话驮着几个,是桥自己算好交来的
 * (`extensions/bridge/src/view.ts`),面板照着画。
 */
const STATUS: ExtensionView = { summary: { tone: "ok", text: [{ b: "2" }, " 个 bot 在线"] } };

/** `status` 传 `null` = 状态那一口拿不到。(⚠️ 别用 undefined:默认参数会把它换成 STATUS。) */
function renderPage(
	/** 重启能力这一格不给就当「能」—— 这一页的大多数用例不关心它。 */
	listed: Pick<ExtensionsResponse, "extensions"> & Partial<ExtensionsResponse> = LISTED,
	connections: unknown = CONNECTIONS,
	status: unknown = STATUS,
	market: MarketplaceResponse = MARKET,
	/** 从哪个地址进来 —— 别处的「去拓展市场」带着 `#marketplace`。 */
	entry = "/extensions",
	/** 给了就等它放行才回拓展表 —— 造「市场索引先到、拓展表后到」。 */
	listedGate?: Promise<unknown>,
) {
	apiGetMock.mockImplementation(async (url: string) => {
		if (url === "/api/connections") return connections;
		if (url.startsWith("/api/ext/marketplace")) return market;
		if (url.startsWith("/api/ext/")) {
			if (status === null) throw new Error("拓展没跑起来");
			return status;
		}
		if (listedGate) await listedGate;
		return { restart: { can: true, how: "container" }, ...listed } satisfies ExtensionsResponse;
	});
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const invalidate = vi.spyOn(qc, "invalidateQueries");
	const view = render(
		<QueryClientProvider client={qc}>
			<MemoryRouter initialEntries={[entry]}>
				<Extensions />
			</MemoryRouter>
		</QueryClientProvider>,
	);
	return { ...view, invalidate };
}

/** 那张卡 —— 从名字往上找到玻璃卡的边。 */
async function cardOf(name: string): Promise<HTMLElement> {
	const card = (await screen.findByText(name)).closest(".bn-glass");
	if (!card) throw new Error(`「${name}」不在一张卡上`);
	return card as HTMLElement;
}

/** 市场说桥有新版 v1.1.0(装着 1.0.0)—— 卡上长出「更新」钮。 */
const UPDATABLE_MARKET: MarketplaceResponse = {
	...MARKET,
	sources: [{ id: "official", name: "BN 官方拓展", official: true, ok: true }],
	extensions: [
		{
			source: "official",
			official: true,
			id: "bridge",
			name: "机器人框架桥接",
			description: "",
			version: "1.1.0",
			apiVersion: 1,
			prerelease: false,
			size: 1,
			installed: { version: "1.0.0", source: "official" },
			state: "updatable",
		},
	],
};

describe("拓展页", () => {
	beforeEach(() => {
		apiGetMock.mockReset();
		apiPatchMock.mockReset();
		apiPatchMock.mockResolvedValue({});
	});

	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
	});

	it.each([
		[
			"ja",
			"ご主人様、拡張機能はまだインストールされていませんよ。マーケットで選ぶか、信頼できるパッケージをアップロードしてくださいね。",
			"ご主人様、拡張機能はBNに外部の機能を追加しますよ。本体には同梱していないので、インストールして有効にしてくださいね。",
		],
		[
			"zh-TW",
			"主人，還沒有安裝拓展呢。可以到拓展市場挑選，或上傳信任的套件喔。",
			"主人，拓展能替 BN 接上外部功能；本體不附帶拓展，安裝並啟用後才會生效喔。",
		],
	] as const)(
		"%s maid extension guidance rereads only marketplace explanations without installing",
		async (locale, empty, description) => {
			apiPostMock.mockReset();
			apiUploadMock.mockReset();
			i18n.set({ locale: "zh-CN", voice: "plain" });
			renderPage({ extensions: [] });
			await screen.findByText("还没有安装拓展。可从拓展市场安装，或上传拓展包。");
			const previousReads = apiGetMock.mock.calls.map(([url]) => url);
			act(() => i18n.set({ locale, voice: "maid" }));
			expect(screen.getByText(empty)).toBeTruthy();
			expect(screen.getByText(description)).toBeTruthy();
			await waitFor(() =>
				expect(apiGetMock.mock.calls.map(([url]) => url)).toEqual([
					...previousReads,
					"/api/ext/marketplace",
				]),
			);
			expect(apiPostMock).not.toHaveBeenCalled();
			expect(apiPatchMock).not.toHaveBeenCalled();
			expect(apiUploadMock).not.toHaveBeenCalled();
		},
	);

	it.each(["install", "update"] as const)(
		"%s feedback translates according to the submitted action without another installation",
		async (action) => {
			i18n.set({ locale: "zh-CN", voice: "plain" });
			apiPostMock.mockReset();
			apiPostMock.mockRejectedValue(new Error("原下载诊断 / EHOST"));
			const base = UPDATABLE_MARKET.extensions[0];
			if (!base) throw new Error("Missing marketplace fixture");
			const entry = {
				...base,
				...(action === "update"
					? { installed: { version: "1.0.0", source: "official", revoked: true as const } }
					: { id: "new", name: "Original new", state: "installable" as const }),
			};
			renderPage(LISTED, CONNECTIONS, STATUS, { ...UPDATABLE_MARKET, extensions: [entry] });
			const card = await cardOf(action === "update" ? BRIDGE.name : "Original new");
			for (const [locale, revoked, offer, button] of [
				[
					"en",
					"The installed release has been revoked",
					"New version v1.1.0",
					action === "update" ? "Update" : "Install",
				],
				[
					"ja",
					"インストール済みのリリースは撤回されています",
					"新バージョン v1.1.0",
					action === "update" ? "更新" : "インストール",
				],
				["zh-TW", "已安裝的版本已撤回", "有新版 v1.1.0", action === "update" ? "更新" : "安裝"],
			] as const) {
				act(() => i18n.set({ locale }));
				if (action === "update") {
					expect(within(card).getByText(revoked)).toBeTruthy();
					expect(within(card).getByText(offer)).toBeTruthy();
				}
				expect(within(card).getByRole("button", { name: button })).toBeTruthy();
				expect(apiPostMock).not.toHaveBeenCalled();
			}
			fireEvent.click(
				within(card).getByRole("button", { name: action === "update" ? "更新" : "安裝" }),
			);
			await screen.findByText(/原下载诊断 \/ EHOST/);
			for (const [locale, failure] of [
				[
					"en",
					action === "update"
						? "Update failed: 原下载诊断 / EHOST"
						: "Installation failed: 原下载诊断 / EHOST",
				],
				[
					"ja",
					action === "update"
						? "更新できませんでした：原下载诊断 / EHOST"
						: "インストールできませんでした：原下载诊断 / EHOST",
				],
				[
					"zh-TW",
					action === "update" ? "更新失敗：原下载诊断 / EHOST" : "安裝失敗：原下载诊断 / EHOST",
				],
			] as const) {
				act(() => i18n.set({ locale }));
				expect(screen.getByText(failure)).toBeTruthy();
				expect(apiPostMock).toHaveBeenCalledExactlyOnceWith("/api/ext/marketplace/install", {
					source: "official",
					id: entry.id,
				});
			}
		},
	);

	it("extension manager language changes preserve the capability filter, raw state details, and switches", async () => {
		i18n.set({ locale: "zh-CN", voice: "plain" });
		const states = [
			"running",
			"disabled",
			"blocked",
			"failed",
			"unreadable",
			"incompatible",
			"staged",
			"settings-invalid",
		] as const;
		renderPage({
			extensions: states.map((state) => ({
				...BRIDGE,
				id: state,
				name: `Original / ${state}`,
				state,
				enabled: state !== "disabled",
				provides:
					state === "unreadable"
						? undefined
						: state === "disabled"
							? []
							: state === "running"
								? ["push", "subscription"]
								: ["push"],
				detail: `原诊断 / ${state}`,
				apiVersion: undefined,
			})),
		});
		await screen.findByRole("button", { name: "全部 8" });
		fireEvent.click(screen.getByRole("button", { name: "订阅 1" }));
		for (const [
			locale,
			title,
			subtitle,
			all,
			push,
			sub,
			unknownHint,
			unknown,
			empty,
			count,
			manage,
			install,
			labels,
		] of [
			[
				"en",
				"Extensions",
				"Add external features to BN. Install extensions separately and enable them to use their features.",
				"All 8",
				"Push 6",
				"Subscription 1",
				"Capabilities unknown: 1. Select “All” to view the affected extensions.",
				"Capabilities unknown",
				"No business capabilities declared",
				"connections",
				"Manage",
				"Install extension",
				[
					"Enabled",
					"Disabled",
					"Automatically disabled",
					"Failed to load",
					"Manifest unreadable",
					"Incompatible version",
					"New code awaiting activation",
					"Settings unreadable",
				],
			],
			[
				"ja",
				"拡張機能",
				"BNに外部の機能を追加します。拡張機能は別途インストールし、有効にすると利用できます。",
				"すべて 8",
				"送信 6",
				"購読 1",
				"1件の拡張機能の能力が不明です。「すべて」に切り替えると表示できます。",
				"能力不明",
				"業務機能の宣言なし",
				"接続",
				"管理",
				"拡張機能をインストール",
				[
					"有効",
					"無効",
					"自動的に無効化",
					"読み込み失敗",
					"マニフェストを読み込めません",
					"バージョン非互換",
					"新しいコードの適用待ち",
					"設定を読み込めません",
				],
			],
			[
				"zh-TW",
				"拓展",
				"為 BN 加入外部功能。拓展需另外安裝，啟用後生效。",
				"全部 8",
				"推播 6",
				"訂閱 1",
				"有 1 個拓展的能力尚不明確，可切換至「全部」查看。",
				"能力未知",
				"未宣告業務能力",
				"條連線",
				"管理",
				"安裝拓展",
				[
					"已啟用",
					"已停用",
					"已自動停用",
					"載入失敗",
					"無法讀取資訊清單",
					"版本不相容",
					"新版等待載入",
					"無法讀取設定",
				],
			],
		] as const) {
			act(() => i18n.set({ locale }));
			expect(screen.getByRole("button", { name: sub }).getAttribute("aria-pressed")).toBe("true");
			expect(screen.getByText(title)).toBeTruthy();
			expect(screen.getByText(subtitle)).toBeTruthy();
			expect(screen.getByText(unknownHint)).toBeTruthy();
			expect(screen.queryByLabelText("Original / failed")).toBeNull();
			expect(screen.getByRole("button", { name: push })).toBeTruthy();
			expect(screen.getByRole("button", { name: install })).toBeTruthy();
			fireEvent.click(screen.getByRole("button", { name: all }));
			for (const [index, state] of states.entries()) {
				const card = await cardOf(`Original / ${state}`);
				const label = labels[index];
				if (label === undefined) throw new Error("Missing translated state label");
				expect(within(card).getByText(label)).toBeTruthy();
				expect(
					within(card).getByLabelText(`Original / ${state}`).getAttribute("aria-pressed"),
				).toBe(String(state !== "disabled"));
				expect(within(card).getByRole("link", { name: manage }).getAttribute("href")).toBe(
					`/extensions/${state}`,
				);
				if (state !== "running" && state !== "disabled")
					expect(within(card).getByText(`原诊断 / ${state}`)).toBeTruthy();
			}
			expect(within(await cardOf("Original / unreadable")).getByText(unknown)).toBeTruthy();
			expect(within(await cardOf("Original / disabled")).getByText(empty)).toBeTruthy();
			expect(within(await cardOf("Original / running")).getByText(count)).toBeTruthy();
			fireEvent.click(screen.getByRole("button", { name: sub }));
		}
		expect(apiPatchMock).not.toHaveBeenCalled();
	});

	it.each(["unreadable", "empty", "filtered"] as const)(
		"%s extension list translates without treating a failed read as empty",
		async (result) => {
			i18n.set({ locale: "zh-CN", voice: "plain" });
			let finish!: () => void;
			let fail!: (error: Error) => void;
			const pending = new Promise<void>((resolve, reject) => {
				finish = resolve;
				fail = reject;
			});
			renderPage(
				{
					extensions:
						result === "filtered"
							? [{ ...BRIDGE, provides: undefined, apiVersion: undefined }]
							: [],
				},
				CONNECTIONS,
				STATUS,
				MARKET,
				"/extensions",
				pending,
			);
			await screen.findByText("正在读取拓展…");
			for (const [locale, loading] of [
				["en", "Reading extensions…"],
				["ja", "拡張機能を読み込んでいます…"],
				["zh-TW", "正在讀取拓展…"],
			] as const) {
				act(() => i18n.set({ locale }));
				expect(screen.getByText(loading)).toBeTruthy();
			}
			await act(async () => {
				if (result === "unreadable") fail(new Error("磁盘只读 / EACCES"));
				else finish();
			});
			if (result === "filtered")
				fireEvent.click(await screen.findByRole("button", { name: "推播 0" }));
			for (const [locale, unreadable, empty, filtered] of [
				[
					"en",
					"Could not read installed extensions: 磁盘只读 / EACCES",
					"No extensions are installed. Install one from the marketplace or upload an extension package.",
					"No extensions declare this capability. Select “All” to view other extensions.",
				],
				[
					"ja",
					"インストール済みの拡張機能を読み込めません：磁盘只读 / EACCES",
					"拡張機能はまだインストールされていません。マーケットからインストールするか、拡張機能のパッケージをアップロードしてください。",
					"この能力を宣言する拡張機能はありません。「すべて」に切り替えると、ほかの拡張機能を表示できます。",
				],
				[
					"zh-TW",
					"無法讀取已安裝的拓展：磁盘只读 / EACCES",
					"尚未安裝拓展。可從拓展市場安裝，或上傳拓展套件。",
					"沒有宣告此能力的拓展。可切換至「全部」查看其他拓展。",
				],
			] as const) {
				act(() => i18n.set({ locale }));
				expect(
					await screen.findByText(
						result === "unreadable" ? unreadable : result === "empty" ? empty : filtered,
					),
				).toBeTruthy();
				if (result === "unreadable") expect(screen.queryByText(empty)).toBeNull();
			}
			expect(apiPatchMock).not.toHaveBeenCalled();
		},
	);

	it("staged and different-source notices translate while a failed toggle stays on its original extension", async () => {
		i18n.set({ locale: "zh-CN", voice: "plain" });
		apiPatchMock.mockRejectedValue(new Error("磁盘只读 / EACCES"));
		renderPage(
			{
				extensions: [
					{ ...BRIDGE, staged: { version: "1.0.0" } },
					{ ...THIRD_PARTY, state: "disabled", enabled: false, staged: { version: "1.1.0" } },
				],
			},
			CONNECTIONS,
			STATUS,
			marketWith({
				...THIRD_PARTY_ENTRY,
				id: BRIDGE.id,
				version: "9.0.0",
				state: "installed-elsewhere",
			}),
		);
		await cardOf(BRIDGE.name);
		fireEvent.click(screen.getByLabelText(BRIDGE.name));
		await screen.findByText(/磁盘只读 \/ EACCES/);
		for (const [locale, same, version, manage, elsewhere, failure] of [
			[
				"en",
				"Code on disk has changed; waiting to load",
				"v1.1.0 waiting to load",
				"Choose how to load it in “Manage”",
				"alice also offers v9.0.0. The installed version is not from that source, so no update is offered.",
				"Could not change this switch: 磁盘只读 / EACCES",
			],
			[
				"ja",
				"ディスク上のコードが変更され、読み込み待ちです",
				"v1.1.0は読み込み待ちです",
				"「管理」で読み込み方法を選択してください",
				"aliceにもv9.0.0がありますが、現在のバージョンはその配布元からインストールされていないため、更新は提示しません。",
				"このスイッチを変更できませんでした：磁盘只读 / EACCES",
			],
			[
				"zh-TW",
				"磁碟上的程式碼已更換，等待載入",
				"v1.1.0 等待載入",
				"前往「管理」選擇載入方式",
				"alice 也有 v9.0.0，但目前版本並非從該來源安裝，因此不提示更新。",
				"無法切換此開關：磁盘只读 / EACCES",
			],
		] as const) {
			act(() => i18n.set({ locale }));
			const running = await cardOf(BRIDGE.name);
			const disabled = await cardOf(THIRD_PARTY.name);
			expect(within(running).getByText(same)).toBeTruthy();
			expect(within(disabled).getByText(version)).toBeTruthy();
			expect(within(running).getByText(manage)).toBeTruthy();
			expect(within(running).getByText(elsewhere)).toBeTruthy();
			expect(screen.getByText(failure)).toBeTruthy();
			expect(screen.getByLabelText(BRIDGE.name).getAttribute("aria-pressed")).toBe("true");
			expect(screen.getByLabelText(THIRD_PARTY.name).getAttribute("aria-pressed")).toBe("false");
			expect(apiPatchMock).toHaveBeenCalledExactlyOnceWith("/api/settings", {
				core: { extensions: { bridge: { enabled: false } } },
			});
		}
	});

	it.each([
		[0, "connections"],
		[1, "connection"],
		[2, "connections"],
	] as const)(
		"%i borrowed connections use the matching English count label",
		async (count, unit) => {
			i18n.set({ locale: "en", voice: "plain" });
			renderPage(
				{ extensions: [{ ...BRIDGE, apiVersion: undefined }] },
				CONNECTIONS.slice(0, count),
			);
			const card = await cardOf(BRIDGE.name);
			expect(within(card).getByText(String(count))).toBeTruthy();
			expect(within(card).getByText(unit)).toBeTruthy();
		},
	);

	it("装了什么就列什么 —— 卡片文案来自服务端,不在前端再抄一份", async () => {
		renderPage();
		expect(await screen.findByText("机器人框架桥接")).toBeTruthy();
		expect(screen.getByText("把别的机器人框架里的 bot 借过来发推送")).toBeTruthy();
		expect(screen.getByText("抖音订阅源")).toBeTruthy();
		expect(apiGetMock).toHaveBeenCalledWith("/api/ext");
	});

	it("双口拓展只有一张卡、一个开关,卡上标明两个口", async () => {
		renderPage({ extensions: [{ ...BRIDGE, provides: ["push", "subscription"] }] });
		await screen.findAllByText(BRIDGE.name);
		expect(screen.getAllByLabelText(BRIDGE.name)).toHaveLength(1);
		expect(document.querySelectorAll('[data-ext-card="bridge"]')).toHaveLength(1);
		const card = await cardOf(BRIDGE.name);
		expect(within(card).getByText("推送", { exact: true })).toBeTruthy();
		expect(within(card).getByText("订阅", { exact: true })).toBeTruthy();
	});

	it("按口单选筛选,双口每口计一次,停用与失败的声明也计入", async () => {
		renderPage({
			extensions: [
				{ ...BRIDGE, provides: ["push", "subscription"] },
				{ ...THIRD_PARTY, enabled: false, state: "disabled" },
				{ ...BRIDGE, id: "broken", name: "失败推送", state: "failed" },
			],
		});
		const all = await screen.findByRole("button", { name: "全部 3" });
		expect(all.getAttribute("aria-pressed")).toBe("true");
		fireEvent.click(screen.getByRole("button", { name: "订阅 2" }));
		expect(screen.queryByLabelText("失败推送")).toBeNull();
		expect(screen.getAllByLabelText(BRIDGE.name)).toHaveLength(1);
		expect(screen.getByLabelText(THIRD_PARTY.name)).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "推送 2" }));
		expect(screen.queryByLabelText(THIRD_PARTY.name)).toBeNull();
		expect(screen.getByLabelText("失败推送")).toBeTruthy();
		expect(screen.getByRole("button", { name: "订阅 2" }).getAttribute("aria-pressed")).toBe(
			"false",
		);
		fireEvent.click(all);
		expect(screen.getByLabelText(THIRD_PARTY.name)).toBeTruthy();
	});

	it("能力未知与明确空表分开标记,不猜口或画连接行,零项筛选说明未知项", async () => {
		renderPage({
			extensions: [
				{ ...BRIDGE, id: "unknown", name: "清单坏了", provides: undefined, state: "unreadable" },
				{ ...BRIDGE, id: "empty", name: "只有开发能力", provides: [] },
			],
		});
		const unknown = await cardOf("清单坏了");
		expect(within(unknown).getByText("能力未知")).toBeTruthy();
		expect(unknown.textContent).not.toContain("条连接");
		const empty = await cardOf("只有开发能力");
		expect(within(empty).getByText("未声明业务口")).toBeTruthy();
		expect(empty.textContent).not.toContain("条连接");
		fireEvent.click(screen.getByRole("button", { name: "推送 0" }));
		expect(screen.getByText(/没有声明此能力的拓展/)).toBeTruthy();
		expect(screen.getByText(/还有 1 个拓展的能力暂时认不出来/)).toBeTruthy();
		expect(screen.queryByLabelText("清单坏了")).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "全部 2" }));
		expect(screen.getByLabelText("清单坏了")).toBeTruthy();
	});

	/**
	 * 🔴 **开关开着却没跑,正是最该看见的那一格。** 只印开关的话,连败自动停用的那个
	 * 拓展看起来跟正常跑着的一模一样,而主人只会觉得「推送怎么不来了」。
	 */
	it("没跑起来的说得出为什么 —— 状态与开关是两件事", async () => {
		renderPage();
		const card = await cardOf("抖音订阅源");
		expect(within(card).getByText("已自动停用")).toBeTruthy();
		expect(within(card).getByText(/连续加载失败 3 次/)).toBeTruthy();
		// 跑着的那张说的是设计稿上那个词
		expect(within(await cardOf("机器人框架桥接")).getByText("已启用")).toBeTruthy();
	});

	/**
	 * 「设置读不了」(ADR-0019 决策 36)是「等你去改设置」,不是「坏了」:原因摆成黄的提醒 —— 与加载
	 * 失败同一个红盒的话,它会被当成要去翻日志的那一类,而出路其实就在它的「配置」里。
	 */
	it("设置读不了:徽章这么说,原因摆成提醒、不是出错", async () => {
		renderPage({
			extensions: [
				{
					...BRIDGE,
					state: "settings-invalid",
					detail:
						"存着的设置不合它自己的规矩:「桥接入」里「家里那台」这一项的「token」:太短了。在它的「配置」里改对,改对了会自己起来",
				},
				{
					id: "boom",
					name: "炸了的那个",
					version: "0.1.0",
					provides: ["subscription"],
					enabled: true,
					state: "failed",
					detail: "activate 炸了",
					dir: "/data/extensions/boom",
				},
			],
		});
		const card = await cardOf("机器人框架桥接");
		expect(within(card).getByText("设置读不了")).toBeTruthy();
		const note = within(card)
			.getByText(/存着的设置不合它自己的规矩/)
			.closest("[data-bn]");
		expect(note?.getAttribute("data-bn")).toContain("note-warn");
		// 对照:真炸了的那张是红的 —— 两档分得开,才说明这一档是自己挑的颜色。
		const boom = within(await cardOf("炸了的那个"))
			.getByText("activate 炸了")
			.closest("[data-bn]");
		expect(boom?.getAttribute("data-bn")).toContain("note-danger");
	});

	/**
	 * 跑着旧的、盘上换了新版(ADR-0012 决策 47):徽章还是「已启用」(它确实在跑),所以卡上得
	 * 另说一句有新版在等、去哪儿选怎么换。两条出路本身只在详情页 —— 卡上不给按钮。
	 */
	it("跑着的那张盘上有新版等着 → 卡上说一句,按钮留给详情页", async () => {
		renderPage({ extensions: [{ ...BRIDGE, staged: { version: "1.1.0" } }] });
		const card = await cardOf("机器人框架桥接");
		expect(within(card).getByText(/v1\.1\.0 等着换上/)).toBeTruthy();
		expect(within(card).queryByRole("button", { name: "只重载这个拓展" })).toBeNull();
		expect(within(card).queryByRole("button", { name: "重启 BN" })).toBeNull();
	});

	/**
	 * 关着的那张也带着「等着换上」:徽章说的是「已停用」,新版在等这件事得另说一句。关着的那一行
	 * `version` 就是盘上那一版(没有跑着的旧版可比),照样说出版本号。
	 */
	it("关着的那张盘上有新版等着 → 卡上也说一句", async () => {
		renderPage({
			extensions: [
				{
					...BRIDGE,
					version: "1.1.0",
					enabled: false,
					state: "disabled",
					staged: { version: "1.1.0" },
				},
			],
		});
		const card = await cardOf("机器人框架桥接");
		expect(within(card).getByText(/v1\.1\.0 等着换上/)).toBeTruthy();
	});

	it("没有新版等着 → 卡上不说这句", async () => {
		renderPage();
		const card = await cardOf("机器人框架桥接");
		expect(within(card).queryByText(/等着换上/)).toBeNull();
	});

	/**
	 * 🔴 **补丁只带自己那一格。** 配置是 JSON Merge Patch:整份 `extensions` 发出去的话,
	 * 别人刚拨的开关会被这一发悄悄按回旧值,而两边都不会报错。
	 */
	it("拨开关只发自己那一格,不把整张表发出去;拨成了拓展表重取", async () => {
		const { invalidate } = renderPage();
		const toggle = await screen.findByLabelText("机器人框架桥接");
		fireEvent.click(toggle);
		// mutate 是异步发起的,同步断言会在请求出门之前就跑完。
		await waitFor(() =>
			expect(apiPatchMock).toHaveBeenCalledWith("/api/settings", {
				core: {
					extensions: { bridge: { enabled: false } },
				},
			}),
		);
		await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ["extensions"] }));
	});

	/**
	 * 🔴 数的是**这个拓展名下**的连接(一条连接就是一个借来的 bot),而且**只按 `provides` 判**,不按拓展 id ——
	 * 列表页认得某个具体拓展就是那条硬约束的破口。别的连接(直连的 OneBot)不算数。
	 */
	it("开推送源那一口的卡数得出自己名下几条连接", async () => {
		renderPage();
		const card = await cardOf("机器人框架桥接");
		expect(card.textContent).toMatch(/2\s*条连接/);
	});

	it("不开推送源那一口的卡不说这句 —— 它压根没有连接这回事", async () => {
		renderPage();
		const card = await cardOf("抖音订阅源");
		expect(card.textContent).not.toMatch(/条连接/);
	});

	it("一条都没配的也报 0 —— 那正是「装好了但还没接上」该看见的", async () => {
		renderPage(LISTED, []);
		const card = await cardOf("机器人框架桥接");
		expect(card.textContent).toMatch(/0\s*条连接/);
	});

	/**
	 * 「配了两条一条没连上」和「两条全连着」得在列表上就分得开 —— 那句 bot 数由桥的视图交,
	 * 跟在「N 条连接」后面。
	 */
	it("桥那张卡还数得出现在几个 bot 在线", async () => {
		renderPage();
		const card = await cardOf("机器人框架桥接");
		await waitFor(() => expect(card.textContent).toMatch(/2\s*个 bot 在线/));
	});

	// 「声明式」= 有清单(apiVersion 有值),与清单是第几版脱钩:抬档不用再改这一处判据。
	it("清单是第 3 版的拓展也画得出视图交来的那一行(声明式不看档位)", async () => {
		renderPage({ extensions: [{ ...BRIDGE, apiVersion: 1 }] });
		const card = await cardOf("机器人框架桥接");
		await waitFor(() => expect(card.textContent).toMatch(/2\s*个 bot 在线/));
	});

	it("状态那一口拿不到时只数连接,不假装有 bot 在线", async () => {
		renderPage(LISTED, CONNECTIONS, null);
		const card = await cardOf("机器人框架桥接");
		// 状态那条查询要先认输,才能断言它「没出现」而不是「还没来」
		await waitFor(() => expect(apiGetMock).toHaveBeenCalledWith("/api/ext/bridge/status"));
		await new Promise((r) => setTimeout(r, 20));
		expect(card.textContent).toMatch(/2\s*条连接/);
		expect(card.textContent).not.toMatch(/bot 在线/);
	});

	it("关着的那张也不问 bot —— 关着就没有「在线」这回事", async () => {
		renderPage({
			extensions: [{ ...BRIDGE, enabled: false, state: "disabled" }],
		});
		const card = await cardOf("机器人框架桥接");
		expect(within(card).getByText("已关闭")).toBeTruthy();
		expect(apiGetMock).not.toHaveBeenCalledWith("/api/ext/bridge/status");
		expect(card.textContent).not.toMatch(/bot 在线/);
	});

	/** 详情页是拓展自己那块面板的唯一去处 —— 卡片上不给入口的话只能手敲地址。 */
	it("每张卡都通到自己的详情页", async () => {
		renderPage();
		const links = await screen.findAllByRole("link", { name: "管理" });
		expect(links.map((a) => a.getAttribute("href"))).toEqual([
			"/extensions/bridge",
			"/extensions/douyin",
		]);
	});

	/**
	 * 🔴 **开箱就是这一屏** —— 本体一个拓展都不带,新装的 BN 打开这一页是空的。已装列表空着,
	 * 而「怎么装」那扇门就在页头:点开要把两条来路说完,而且传包那条**当场能走**。
	 */
	it("一个拓展都没装时显示统一空态,页头安装入口仍把两条来路说完", async () => {
		const { container } = renderPage({ extensions: [] });
		expect(await screen.findByText(/还没有装拓展呢/)).toBeTruthy();
		expect(screen.getByRole("button", { name: "全部 0" })).toBeTruthy();

		fireEvent.click(screen.getByRole("button", { name: /装拓展/ }));
		const dialog = await screen.findByRole("dialog");
		expect(container.ownerDocument.querySelector('input[type="file"]')).toBeTruthy();
		expect(within(dialog).getByText("现在能用")).toBeTruthy();
		expect(within(dialog).getByText(/<dataDir>\/extensions\//)).toBeTruthy();
		// 开发版走的还是第②条,只是那几下由 devtools 代劳 —— 不说的话下一个人会去翻
		// 那个已经不存在的「源码根」。
		expect(within(dialog).getByText(/devtools/)).toBeTruthy();
		expect(within(dialog).getByText(/重载/)).toBeTruthy();
	});

	/**
	 * 🔴 拨不动的时候开关会自己弹回原位(它的值来自服务端那份表)—— 那是唯一的反馈,
	 * 而它与「我点歪了」长得一模一样。原因就在响应里躺着,不说等于让人对着黑盒反复按。
	 */
	it("拨开关失败:把服务端那句话摆出来,不是开关自己弹回去就完事", async () => {
		renderPage();
		apiPatchMock.mockRejectedValue(new Error("配置文件是只读的"));
		fireEvent.click(await screen.findByLabelText("机器人框架桥接"));
		expect(await screen.findByText(/配置文件是只读的/)).toBeTruthy();
	});

	/**
	 * 🔴 **读不到 ≠ 一个都没装**。这一页读不出拓展表时此前画的是「还没有推送源拓展」
	 * 加一句「现在能推的只有直连的那些目标」—— 全是假话,而且请主人去装一个他其实已经
	 * 装了的东西。
	 */
	it("拓展表读不到时说读不到,不把空态当事实", async () => {
		apiGetMock.mockImplementation(async (url: string) => {
			if (url === "/api/connections") return [];
			if (url.startsWith("/api/ext/marketplace")) return MARKET;
			throw new Error("拓展表读不出来:500");
		});
		const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		render(
			<QueryClientProvider client={qc}>
				<MemoryRouter>
					<Extensions />
				</MemoryRouter>
			</QueryClientProvider>,
		);
		expect(await screen.findByText(/拓展表读不出来/)).toBeTruthy();
		expect(screen.queryByText(/还没有推送源拓展/)).toBeNull();
		expect(screen.queryByText(/还没有订阅源拓展/)).toBeNull();
	});

	/**
	 * ADR-0025 决策 13:统一列卡,不按口分节。清单读不出的卡也必须留在列表里供排查。
	 */
	it("统一列卡,清单读不出来的也不许消失", async () => {
		renderPage({
			extensions: [
				...LISTED.extensions,
				{ id: "broken", name: "坏掉的那个", enabled: false, state: "unreadable", dir: "/x" },
			],
		});
		expect(await screen.findByText("机器人框架桥接")).toBeTruthy();
		expect(screen.getByText("抖音订阅源")).toBeTruthy();
		expect(screen.getByText("坏掉的那个")).toBeTruthy();
	});

	/**
	 * 图标跟着拓展走(决策 20)—— 清单里那段 SVG **服务端已经过过白名单**,这里只管画。
	 * 一直没画的后果是:字段一路送到浏览器,类型、门禁、测试全绿,而屏幕上什么都没有。
	 */
	it("清单里的图标真的画出来;没有图标的退回灰方章", async () => {
		const { container } = renderPage();
		await screen.findByText("机器人框架桥接");
		expect(container.querySelector('[data-testid="bridge-icon"]')).toBeTruthy();
		// 抖音那条没有 icon —— 它得有个占位,而不是一个空方块。
		expect(container.querySelectorAll('[data-bn-ext-icon="fallback"]')).toHaveLength(1);
	});
});

describe("拓展安装后的唯一落点", () => {
	const originalScroll = Element.prototype.scrollIntoView;
	const scroll = vi.fn();
	beforeEach(() => {
		apiGetMock.mockReset();
		apiPostMock.mockReset();
		apiUploadMock.mockReset();
		scroll.mockClear();
		Element.prototype.scrollIntoView = scroll;
		vi.stubGlobal("matchMedia", () => ({ matches: true }));
	});
	afterEach(() => {
		cleanup();
		Element.prototype.scrollIntoView = originalScroll;
		vi.unstubAllGlobals();
		useCardMotionStore.setState({ motion: null });
	});

	it.each([true, false])("市场装成双口拓展,切回全部并滚到唯一卡（减少动态=%s）", async (reduce) => {
		vi.stubGlobal("matchMedia", () => ({ matches: reduce }));
		const listed = { extensions: [BRIDGE] };
		const fresh = { ...THIRD_PARTY, provides: ["push", "subscription"] as const };
		apiPostMock.mockImplementation(async () => {
			listed.extensions.push({ ...fresh, provides: [...fresh.provides] });
			return {
				id: fresh.id,
				name: fresh.name,
				version: "1.0.0",
				enabled: true,
				staged: false,
				restart: { can: true, how: "container" },
			};
		});
		renderPage(
			listed,
			[],
			null,
			marketWith({
				...THIRD_PARTY_ENTRY,
				official: true,
				installed: undefined,
				state: "installable",
			}),
		);
		fireEvent.click(await screen.findByRole("button", { name: "订阅 0" }));
		const marketCard = await cardOf(fresh.name);
		fireEvent.click(within(marketCard).getByRole("button", { name: "安装" }));
		await waitFor(() =>
			expect(screen.getByRole("button", { name: "全部 2" }).getAttribute("aria-pressed")).toBe(
				"true",
			),
		);
		expect(document.querySelectorAll(`[data-ext-card="${fresh.id}"]`)).toHaveLength(1);
		await waitFor(() =>
			expect(
				scroll.mock.contexts.some(
					(target) => (target as HTMLElement).getAttribute("data-ext-card") === fresh.id,
				),
			).toBe(true),
		);
	});

	it("市场安装失败保留当前筛选,不滚到其他卡", async () => {
		apiPostMock.mockRejectedValue(new Error("测试下载失败"));
		renderPage(
			{ extensions: [BRIDGE] },
			[],
			null,
			marketWith({
				...THIRD_PARTY_ENTRY,
				official: true,
				installed: undefined,
				state: "installable",
			}),
		);
		fireEvent.click(await screen.findByRole("button", { name: "订阅 0" }));
		fireEvent.click(within(await cardOf(THIRD_PARTY.name)).getByRole("button", { name: "安装" }));
		await screen.findByText(/测试下载失败/);
		expect(screen.getByRole("button", { name: "订阅 0" }).getAttribute("aria-pressed")).toBe(
			"true",
		);
		expect(scroll).not.toHaveBeenCalled();
	});

	it("上传失败关闭弹窗后仍保留当前筛选,不留下定位动作", async () => {
		apiUploadMock.mockRejectedValue(new Error("测试包坏了"));
		renderPage({ extensions: [BRIDGE] }, [], null);
		fireEvent.click(await screen.findByRole("button", { name: "订阅 0" }));
		fireEvent.click(screen.getByRole("button", { name: "装拓展" }));
		const dialog = await screen.findByRole("dialog");
		const input = dialog.querySelector('input[type="file"]');
		if (!input) throw new Error("没有文件输入框");
		fireEvent.change(input, { target: { files: [new File(["bad"], "source.zip")] } });
		await within(dialog).findByText(/测试包坏了/);
		fireEvent.click(within(dialog).getByRole("button", { name: "关闭" }));
		expect(screen.getByRole("button", { name: "订阅 0" }).getAttribute("aria-pressed")).toBe(
			"true",
		);
		expect(scroll).not.toHaveBeenCalled();
	});

	it("上传装成后切回全部,保留结果弹窗,关闭才滚到唯一卡", async () => {
		const listed = { extensions: [BRIDGE] };
		apiUploadMock.mockImplementation(async () => {
			listed.extensions.push(THIRD_PARTY);
			return {
				id: THIRD_PARTY.id,
				name: THIRD_PARTY.name,
				version: "1.0.0",
				enabled: true,
				staged: false,
				restart: { can: true, how: "container" },
			};
		});
		renderPage(listed, [], null);
		fireEvent.click(await screen.findByRole("button", { name: "推送 1" }));
		fireEvent.click(screen.getByRole("button", { name: "装拓展" }));
		const dialog = await screen.findByRole("dialog");
		const input = dialog.querySelector('input[type="file"]');
		if (!input) throw new Error("没有文件输入框");
		fireEvent.change(input, { target: { files: [new File(["zip"], "source.zip")] } });
		await within(dialog).findByText(/装好了/);
		expect(screen.getByRole("dialog")).toBe(dialog);
		await waitFor(() =>
			expect(
				screen.getByRole("button", { name: "全部 2", hidden: true }).getAttribute("aria-pressed"),
			).toBe("true"),
		);
		expect(scroll).not.toHaveBeenCalled();
		fireEvent.click(within(dialog).getByRole("button", { name: "关闭" }));
		await waitFor(() =>
			expect(
				scroll.mock.contexts.some(
					(target) => (target as HTMLElement).getAttribute("data-ext-card") === THIRD_PARTY.id,
				),
			).toBe(true),
		);
		expect(document.querySelectorAll(`[data-ext-card="${THIRD_PARTY.id}"]`)).toHaveLength(1);
	});
});

/**
 * 市场说「有新版」的那张已装卡片:徽章 + 更新钮就在卡上,不用主人滚到市场那一节去找;
 * 按下去走的是市场那一口(同一个 source + id),不是传包。
 */
describe("已装卡片上的「有新版」", () => {
	/** 已装的那张卡:市场那一节也会列同名条目,所以从开关(它只在已装卡上)往上找。 */
	function installedCardOf(name: string): HTMLElement {
		const card = screen.getByRole("button", { name }).closest(".bn-glass");
		if (!card) throw new Error(`「${name}」不在一张已装卡上`);
		return card as HTMLElement;
	}

	afterEach(() => {
		cleanup();
	});

	beforeEach(() => {
		apiGetMock.mockReset();
		apiPatchMock.mockReset();
		apiPostMock.mockReset();
		apiPostMock.mockResolvedValue({
			id: "bridge",
			name: "机器人框架桥接",
			version: "1.1.0",
			staged: true,
			enabled: true,
			restart: { can: true, how: "container" },
		});
	});

	it("市场里这条是 updatable → 卡上出徽章与更新钮;按下去 POST 市场那一口", async () => {
		renderPage(LISTED, CONNECTIONS, STATUS, {
			...MARKET,
			sources: [{ id: "official", name: "BN 官方拓展", official: true, ok: true }],
			extensions: [
				{
					source: "official",
					official: true,
					id: "bridge",
					name: "机器人框架桥接",
					description: "",
					version: "1.1.0",
					apiVersion: 1,
					prerelease: false,
					size: 1,
					installed: { version: "1.0.0", source: "official" },
					state: "updatable",
				},
			],
		});
		await screen.findAllByText("机器人框架桥接");
		const card = installedCardOf("机器人框架桥接");
		expect(await within(card).findByText(/有新版 v1\.1\.0/)).toBeTruthy();
		// 老形状(没有 `installed.revoked` 那一格,老服务端就是这样):缺了当没撤回,不标红。
		expect(within(card).queryByText(/撤回/)).toBeNull();
		fireEvent.click(within(card).getByRole("button", { name: /更新/ }));
		await waitFor(() =>
			expect(apiPostMock).toHaveBeenCalledWith("/api/ext/marketplace/install", {
				source: "official",
				id: "bridge",
			}),
		);
		// 盖掉的是一份正在跑的:装完那句话要说清「换不上」,并给两条出路。
		expect(await screen.findByText(/换不上/)).toBeTruthy();
		expect(screen.getByRole("button", { name: "只重载这个拓展" })).toBeTruthy();
	});

	/**
	 * 🔴 装着那版被撤回、市场里有能换过去的新版(`updatable` + `installed.revoked`)—— 恰恰是最该
	 * 更新的时候。红字与那颗「更新」得**同时**在:只标红不给钮,主人知道出事了却没有出路;只给钮
	 * 不标红,它看起来就是一次可有可无的例行更新。
	 */
	it("装着那版被撤回、有能换过去的新版 → 标红说撤回,更新钮照给,按下去走市场那一口", async () => {
		renderPage(LISTED, CONNECTIONS, STATUS, {
			...UPDATABLE_MARKET,
			extensions: UPDATABLE_MARKET.extensions.map((entry) => ({
				...entry,
				installed: { version: "1.0.0", source: "official", revoked: true },
			})),
		});
		await screen.findAllByText("机器人框架桥接");
		const card = installedCardOf("机器人框架桥接");
		const revoked = await within(card).findByText("装着的这一版被撤回了");
		expect(revoked.className).toContain("text-bn-danger");
		expect(within(card).getByText(/有新版 v1\.1\.0/)).toBeTruthy();
		fireEvent.click(within(card).getByRole("button", { name: /更新/ }));
		await waitFor(() =>
			expect(apiPostMock).toHaveBeenCalledWith("/api/ext/marketplace/install", {
				source: "official",
				id: "bridge",
			}),
		);
	});

	/**
	 * 更新要**演一段换装**,起点是按下去的那颗「更新」钮 —— 此前更新一声不响,只有版本号悄悄
	 * 变了。🔴 **请求一出门就开演**:下载那几秒正是「蓄」,等装完才开演的话,那几秒页面上只有
	 * 一颗灰掉的钮。jsdom 没有动画接口,换装一放进去就当场收摊,所以记的是「放进来过什么」。
	 */
	it("按下「更新」→ 不等装完就开演,球从那颗钮起飞;装成了才算落定", async () => {
		const played: CardMotion[] = [];
		const unsubscribe = useCardMotionStore.subscribe((state) => {
			if (state.motion) played.push(state.motion);
		});
		let answer: (value: unknown) => void = () => {};
		apiPostMock.mockImplementation(() => new Promise((resolve) => (answer = resolve)));
		renderPage(LISTED, CONNECTIONS, STATUS, UPDATABLE_MARKET);
		await screen.findAllByText("机器人框架桥接");
		const card = installedCardOf("机器人框架桥接");
		const button = await within(card).findByRole("button", { name: /更新/ });
		// devtools「播放更新动画」认这个标记找起飞点 —— 真的那颗钮身上得有,不然那头悄悄退化。
		expect(button.hasAttribute(EXT_UPDATE_BUTTON)).toBe(true);
		fireEvent.click(button);

		// 服务端还没回话,就已经在演了。
		await waitFor(() => expect(played).toHaveLength(1));
		unsubscribe();
		const motion = played[0];
		if (motion?.kind !== "update") throw new Error("应该是一段换装");
		expect(motion.id).toBe("bridge");
		expect(motion.from).toBeTruthy();

		answer({
			id: "bridge",
			name: "机器人框架桥接",
			version: "1.1.0",
			staged: true,
			enabled: true,
			restart: { can: true, how: "container" },
		});
		await expect(motion.outcome).resolves.toBe(true);
	});

	it("更新砸了 → 那段换装落定成「没装成」(光环淡出,不画勾)", async () => {
		const played: CardMotion[] = [];
		const unsubscribe = useCardMotionStore.subscribe((state) => {
			if (state.motion) played.push(state.motion);
		});
		apiPostMock.mockRejectedValue(new Error("下不动"));
		renderPage(LISTED, CONNECTIONS, STATUS, UPDATABLE_MARKET);
		await screen.findAllByText("机器人框架桥接");
		fireEvent.click(
			await within(installedCardOf("机器人框架桥接")).findByRole("button", { name: /更新/ }),
		);

		await waitFor(() => expect(played).toHaveLength(1));
		unsubscribe();
		const motion = played[0];
		if (motion?.kind !== "update") throw new Error("应该是一段换装");
		await expect(motion.outcome).resolves.toBe(false);
	});

	/**
	 * 🔴 市场里也有这个 id、但装着的这份不是从那儿来的(手动传包装的最常见)。这句话此前
	 * 只在市场那一节印,而已装的现在不在市场里露面了 —— 不搬过来的话,主人永远不会知道
	 * 市场里还有一份、也不会知道为什么这张卡上从来不提示更新。
	 */
	it("市场里也有、但装的不是那一份 → 卡上说清楚,并说明为什么不提示更新", async () => {
		renderPage(LISTED, CONNECTIONS, STATUS, {
			...MARKET,
			sources: [{ id: "official", name: "BN 官方拓展", official: true, ok: true }],
			extensions: [
				{
					source: "official",
					official: true,
					id: "bridge",
					name: "机器人框架桥接",
					description: "",
					version: "1.1.0",
					apiVersion: 1,
					prerelease: false,
					size: 1,
					installed: { version: "1.0.0", source: "手动" },
					state: "installed-elsewhere",
				},
			],
		});

		await screen.findAllByText("机器人框架桥接");
		const card = installedCardOf("机器人框架桥接");
		const note = await within(card).findByText(/不是从那儿装的/);
		expect(note.textContent).toMatch(/v1\.1\.0/);
		expect(note.textContent).toMatch(/BN 官方拓展/);
		// 这一档不是「有新版」—— 别画成更新,不然按下去等于换了一份来路不同的代码。
		expect(within(card).queryByRole("button", { name: /更新/ })).toBeNull();
	});

	/**
	 * 🔴 **失败那句话要跟着刚才那一下走**:更新砸了却被告知「装不了」,主人会去找一个他
	 * 根本没装过的东西;反过来也一样。措辞由 `entry.state` 决定,而更新钮只长在已装卡上
	 * —— 所以这条守卫住在这一页,不在市场那一节。
	 */
	it("更新砸了说「更新不了」,不是「装不了」", async () => {
		apiPostMock.mockRejectedValue(new Error("下不动"));
		renderPage(LISTED, CONNECTIONS, STATUS, {
			...MARKET,
			sources: [{ id: "official", name: "BN 官方拓展", official: true, ok: true }],
			extensions: [
				{
					source: "official",
					official: true,
					id: "bridge",
					name: "机器人框架桥接",
					description: "",
					version: "1.1.0",
					apiVersion: 1,
					prerelease: false,
					size: 1,
					installed: { version: "1.0.0", source: "official" },
					state: "updatable",
				},
			],
		});

		await screen.findAllByText("机器人框架桥接");
		fireEvent.click(
			within(installedCardOf("机器人框架桥接")).getByRole("button", { name: /更新/ }),
		);

		expect(await screen.findByText(/更新不了:下不动/)).toBeTruthy();
	});

	/**
	 * 🔴 **更新走的必须是与「装」同一条路。** 第三方条目装之前要先确认(它在 BN 进程里跑
	 * 代码,BN 不担保),而更新钮此前直接 `install.mutate` —— 于是任何第三方源只要把版本号
	 * 抬一格,主人在已装卡片上按一下就零确认装进了新代码。
	 */
	it("第三方来源的更新也先确认 —— 取消就不发,确认才发", async () => {
		renderPage(
			{ extensions: [BRIDGE, THIRD_PARTY] },
			CONNECTIONS,
			STATUS,
			marketWith({ ...THIRD_PARTY_ENTRY, version: "1.1.0", state: "updatable" }),
		);
		await screen.findAllByText(THIRD_PARTY.name);
		const card = installedCardOf(THIRD_PARTY.name);
		fireEvent.click(within(card).getByRole("button", { name: /更新/ }));
		const dialog = await screen.findByRole("dialog");
		expect(within(dialog).getByText(/在 BN 进程里跑代码/)).toBeTruthy();
		expect(apiPostMock).not.toHaveBeenCalled();

		fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
		expect(apiPostMock).not.toHaveBeenCalled();

		fireEvent.click(
			within(installedCardOf(THIRD_PARTY.name)).getByRole("button", { name: /更新/ }),
		);
		fireEvent.click(await screen.findByRole("button", { name: /照样/ }));
		await waitFor(() =>
			expect(apiPostMock).toHaveBeenCalledWith("/api/ext/marketplace/install", {
				source: "s1",
				id: "alice.douyin",
			}),
		);
	});

	/**
	 * 🔴 「装不了 / 更新不了」说的是**失败的那一发**。第三方那条点下去只是弹确认框、还没发;取消
	 * 之后,上一发更新砸了的那句话不许被改口成「装不了」—— 主人会去找一个他根本没点过的装。
	 */
	it("第三方确认框取消后,上一发失败的那句话不改口", async () => {
		apiPostMock.mockRejectedValue(new Error("下不动"));
		const installable = {
			...THIRD_PARTY_ENTRY,
			installed: undefined,
			state: "installable" as const,
		};
		renderPage(LISTED, CONNECTIONS, STATUS, {
			...marketWith(installable),
			extensions: [...UPDATABLE_MARKET.extensions, installable],
		});
		await screen.findAllByText("机器人框架桥接");
		fireEvent.click(
			await within(installedCardOf("机器人框架桥接")).findByRole("button", { name: /更新/ }),
		);
		expect(await screen.findByText(/更新不了:下不动/)).toBeTruthy();

		fireEvent.click(within(await cardOf(THIRD_PARTY.name)).getByRole("button", { name: "安装" }));
		fireEvent.click(
			within(await screen.findByRole("dialog")).getByRole("button", { name: "取消" }),
		);

		expect(screen.getByText(/更新不了:下不动/)).toBeTruthy();
		expect(screen.queryByText(/装不了/)).toBeNull();
	});

	it("市场那一节挂在页上;市场问不到时已装卡片照常、不出徽章", async () => {
		renderPage();
		expect(await screen.findByText("拓展市场")).toBeTruthy();
		await screen.findAllByText("机器人框架桥接");
		expect(within(installedCardOf("机器人框架桥接")).queryByText(/有新版/)).toBeNull();
	});
});

/**
 * 带着 `#marketplace` 进来(从前是第 1 版详情页的「去拓展市场」,那块提示随退路一起删了,
 * 地址栏手敲或别处再加链接仍走这条)—— 市场那一节在页面最底下,不该再让主人自己往下翻一屏。
 */
describe("拓展页 —— 从别处「去拓展市场」跳过来", () => {
	// jsdom 没有 scrollIntoView;这里只关心滚没滚、滚的是不是市场那一节。
	const scrollIntoView = vi.fn();
	const original = Element.prototype.scrollIntoView;
	beforeEach(() => {
		apiGetMock.mockReset();
		scrollIntoView.mockClear();
		Element.prototype.scrollIntoView = scrollIntoView;
	});
	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
		Element.prototype.scrollIntoView = original;
	});

	it("带着 #marketplace 进来 → 市场那一节滚进视口", async () => {
		renderPage(LISTED, CONNECTIONS, STATUS, MARKET, "/extensions#marketplace");
		await screen.findByText("拓展市场");
		await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
		const target = scrollIntoView.mock.contexts.at(-1) as HTMLElement;
		expect(within(target).getByText("拓展市场")).toBeTruthy();
	});

	/**
	 * 🔴 拓展表回来之前这一页只画「正在读取」,市场那一节的锚点还没挂上。市场索引先到的话,
	 * 「该滚了」那一刻锚点不在;锚点挂上时又没有东西再叫它 —— 一下都不滚。
	 */
	it("市场索引先到、拓展表后到(锚点晚挂上)→ 照样滚过去", async () => {
		let release: (value?: unknown) => void = () => {};
		const gate = new Promise((resolve) => {
			release = resolve;
		});
		renderPage(LISTED, CONNECTIONS, STATUS, MARKET, "/extensions#marketplace", gate);
		await waitFor(() =>
			expect(
				apiGetMock.mock.calls.some(([url]) => String(url).startsWith("/api/ext/marketplace")),
			).toBe(true),
		);
		// 让市场索引先落进缓存,再放拓展表回来。
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(scrollIntoView).not.toHaveBeenCalled();
		release();
		await screen.findByText("拓展市场");
		await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
		const target = scrollIntoView.mock.contexts.at(-1) as HTMLElement;
		expect(within(target).getByText("拓展市场")).toBeTruthy();
	});

	it("正常打开拓展页 → 不乱滚", async () => {
		renderPage();
		await screen.findByText("拓展市场");
		expect(scrollIntoView).not.toHaveBeenCalled();
	});
});
