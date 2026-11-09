// @vitest-environment jsdom

/**
 * v2 拓展的详情页照声明画(ADR-0019 决策 19 / 25 / 32):头卡正文是视图的页级积木,「配置」
 * 页签里是照清单画的设置表单。第 1 版的退路已删:它的清单读不出来(版本不合),没有面板,
 * 头卡里只有状态那句原因,不摆「配置」。
 *
 * 值得钉的:
 * - **按清单分岔**,不按 id —— 桥的手写页退役之后,叫 bridge 的版本不合拓展也只有通用的那句原因。
 * - 🔴 **拓展关着设置照样能改**(决策 32):「装好 → 填 → 启用」这个顺序靠它才走得通。
 * - 关着与没跑起来**分开说**:前者是主人自己刚拨的开关,后者要去查日志。
 */

import type {
	ExtensionEntryView,
	ExtensionPanelView,
	ExtensionsResponse,
	RestartAbility,
} from "@bilibili-notify/contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { i18n } from "../../i18n";
import { api } from "../../services/api";
import ExtensionDetail from "../ExtensionDetail";

const { apiGetMock, apiPatchMock, NotFound } = vi.hoisted(() => {
	class NotFound extends Error {
		readonly status = 404;
		readonly code = "not_found";
	}
	return { apiGetMock: vi.fn(), apiPatchMock: vi.fn(), NotFound };
});

vi.mock("../../services/api", () => ({
	api: {
		get: apiGetMock as unknown as (url: string) => Promise<unknown>,
		patch: apiPatchMock as unknown as (url: string, body?: unknown) => Promise<unknown>,
		post: vi.fn(),
		delete: vi.fn(),
	},
	ApiError: class extends Error {},
}));

const DOUYIN: ExtensionEntryView = {
	id: "douyin",
	name: "抖音订阅",
	description: "盯着抖音作者的新作品与开播。",
	version: "0.1.0",
	apiVersion: 1,
	provides: ["subscription"],
	settings: {
		fields: [
			{ key: "cookie", type: "string", label: "Cookie", required: true, secret: true },
			{ key: "interval", type: "number", label: "检查间隔", min: 30, max: 600, unit: "秒" },
		],
	},
	enabled: true,
	state: "running",
	dir: "/data/extensions/douyin",
};

/** 宿主核过、全都合规矩的一份(ADR-0019 决策 40:页上每块包在 `{ block }` 里)。 */
const VIEW: ExtensionPanelView = {
	summary: { tone: "ok", text: "12 位作者" },
	page: [
		{
			block: {
				type: "keyValue",
				items: [
					{ label: "登录", value: "cookie 有效", tone: "ok" },
					{ label: "在看的作者", value: "12 位" },
				],
			},
		},
	],
};

interface Setup {
	ext?: ExtensionEntryView;
	/** 状态那一口:一份视图,或一个错(`NotFound` = 404)。 */
	status?: ExtensionPanelView | Error;
	settings?: Record<string, unknown>;
	/** 这台机器能不能自己重启(`GET /api/ext` 那一格)。 */
	restart?: RestartAbility;
}

function renderDetail({
	ext = DOUYIN,
	status = VIEW,
	settings = { interval: 90 },
	restart = { can: true, how: "container" },
}: Setup = {}) {
	apiGetMock.mockImplementation(async (url: string) => {
		if (url.endsWith("/settings/invalid")) return { entries: [] };
		if (url === "/api/ext") return { extensions: [ext], restart } satisfies ExtensionsResponse;
		if (url === "/api/settings") return { core: { logging: { level: "info", levels: {} } } };
		// 设置走拓展自己的口(ADR-0019 决策 35)—— `/api/settings` 里已经没有这一格了。
		if (url === `/api/ext/${ext.id}/settings`) return { revision: "r1", values: settings };
		if (url === `/api/ext/${ext.id}/status`) {
			if (status instanceof Error) throw status;
			return status;
		}
		if (url === `/api/ext/${ext.id}/docs`) return {};
		throw new Error(`没有这个口:${url}`);
	});
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<MemoryRouter initialEntries={[`/extensions/${ext.id}`]}>
				<Routes>
					<Route path="/extensions/:id" element={<ExtensionDetail />} />
				</Routes>
			</MemoryRouter>
		</QueryClientProvider>,
	);
}

/** 头卡:名字所在的那张玻璃卡。 */
async function headCard(name = "抖音订阅"): Promise<HTMLElement> {
	const titles = await screen.findAllByText(name);
	const card = titles.map((el) => el.closest(".bn-glass")).find(Boolean);
	if (!card) throw new Error("找不到头卡");
	return card as HTMLElement;
}

function statusCalls(id = "douyin"): number {
	return apiGetMock.mock.calls.filter(([url]) => url === `/api/ext/${id}/status`).length;
}

beforeEach(() => {
	i18n.set({ locale: "zh-CN", voice: "plain" });
	apiGetMock.mockReset();
	apiPatchMock.mockReset();
	apiPatchMock.mockResolvedValue({});
});
afterEach(() => {
	cleanup();
});

describe("v2 拓展的详情页", () => {
	it("头卡正文是视图交来的页级积木", async () => {
		renderDetail();
		const head = await headCard();
		expect(await within(head).findByText("cookie 有效")).toBeTruthy();
		expect(within(head).getByText("在看的作者")).toBeTruthy();
	});

	/** 头卡和别的拓展一样显示版本号(决策 24 的五处之一)。 */
	it("头卡底下那句带版本号", async () => {
		renderDetail();
		const head = await headCard();
		expect(within(head).getByText(/^v0\.1\.0 · 卸掉它/)).toBeTruthy();
	});

	it("有设置项就有「配置」页签,里面是照清单画的设置", async () => {
		renderDetail();
		expect(await screen.findByText("设置")).toBeTruthy();
		expect(await screen.findByLabelText("检查间隔")).toBeTruthy();
		expect(screen.getByRole("button", { name: "保存" })).toBeTruthy();
	});

	// 「声明式」= 有清单(apiVersion 有值),与清单是第几版脱钩:抬档不用再改这一处判据。
	it("清单是第 3 版的拓展同样有「配置」页签", async () => {
		renderDetail({ ext: { ...DOUYIN, apiVersion: 1 } });
		expect(await screen.findByText("设置")).toBeTruthy();
		expect(await screen.findByLabelText("检查间隔")).toBeTruthy();
	});

	it("没有设置项就不摆「配置」", async () => {
		renderDetail({ ext: { ...DOUYIN, settings: undefined } });
		await headCard();
		expect(await screen.findByText("cookie 有效")).toBeTruthy();
		expect(screen.queryByText("设置")).toBeNull();
		expect(screen.queryByRole("tab", { name: /配置/ })).toBeNull();
	});

	/**
	 * 🔴 关着的拓展**设置照样能改**(决策 32),顶上一条黄盒说清「是你关的、改了等打开再生效」。
	 * 状态那一口不问 —— 问了也是 404。
	 */
	it("关着:黄盒说清楚,设置照样能改、能存", async () => {
		renderDetail({ ext: { ...DOUYIN, enabled: false, state: "disabled" } });
		const note = await screen.findByText("拓展关着,它现在什么都不做。");
		expect(note.tagName).toBe("STRONG");
		expect(note.parentElement?.textContent).toBe(
			"拓展关着,它现在什么都不做。下面的设置照样能改,打开拓展之后生效;连接状态要等它跑起来才看得到。",
		);

		fireEvent.change(await screen.findByLabelText("检查间隔"), { target: { value: "120" } });
		fireEvent.click(screen.getByRole("button", { name: "保存" }));
		await waitFor(() =>
			expect(apiPatchMock).toHaveBeenCalledWith("/api/ext/douyin/settings", {
				revision: "r1",
				ops: [{ op: "set", key: "interval", value: 120 }],
			}),
		);
		expect(statusCalls()).toBe(0);
		expect(screen.queryByText("cookie 有效")).toBeNull();
	});

	/** 开着却没跑起来:要去查日志 —— 与「关着」要主人做的事正相反,不能说成一句。 */
	it("开着却没跑起来:说「去日志里看」,不说「关着」", async () => {
		renderDetail({
			ext: { ...DOUYIN, state: "failed", detail: "activate 抛了:cookie 解不出来" },
		});
		expect(
			await screen.findByText(
				"这个拓展现在没跑起来,底下只有设置、没有状态 —— 去日志里看它为什么没起来。",
			),
		).toBeTruthy();
		expect(screen.queryByText("拓展关着,它现在什么都不做。")).toBeNull();
		expect(await screen.findByLabelText("检查间隔")).toBeTruthy();
		expect(statusCalls()).toBe(0);
	});

	/**
	 * 设置读不了(ADR-0019 决策 36):存着的设置过不了它自己的规矩,它不跑 —— 出路就在这个「配置」
	 * 页签里,改对了它自己起来。原因不在日志里(叫人去翻日志等于把人支走),也不是出错,是提醒:
	 * 服务端那句 `detail` 已经点名哪一格、为什么,原样摆出来。
	 */
	it("设置读不了:配置页签顶上是黄的提醒,原样摆那句原因,不叫人去翻日志", async () => {
		const detail =
			"存着的设置不合它自己的规矩:「检查间隔」:要在 30 到 600 之间。在它的「配置」里改对,改对了会自己起来";
		renderDetail({ ext: { ...DOUYIN, state: "settings-invalid", detail } });
		const head = await headCard();
		expect(await screen.findByLabelText("检查间隔")).toBeTruthy();
		const notes = screen.getAllByText(detail).filter((el) => !head.contains(el));
		expect(notes).toHaveLength(1);
		expect(notes[0]?.closest("[data-bn]")?.getAttribute("data-bn")).toContain("note-warn");
		expect(screen.queryByText(/去日志里看/)).toBeNull();
		expect(screen.queryByText(/没跑起来/)).toBeNull();
		expect(statusCalls()).toBe(0);
	});

	/**
	 * 跑着、但一份视图都没交过(只有设置项的拓展就是这样)是 404 —— 那不是「没跑起来」,
	 * 头卡里什么都不画就对了。
	 */
	it("跑着但没交过视图(404):不说没跑起来", async () => {
		renderDetail({ status: new NotFound("not found") });
		await waitFor(() => expect(statusCalls()).toBe(1));
		expect(await screen.findByLabelText("检查间隔")).toBeTruthy();
		expect(screen.queryByText(/没跑起来/)).toBeNull();
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("状态那一口别的失败:原话摆在头卡里", async () => {
		renderDetail({ status: new Error("连接中断") });
		const head = await headCard();
		expect((await within(head).findByRole("alert")).textContent).toContain("连接中断");
	});

	/** 删除确认去掉只写给桥的那句括号(决策 24 的五处之一)。 */
	it("删除确认里没有桥的那句", async () => {
		renderDetail();
		fireEvent.click(await screen.findByRole("button", { name: "删除拓展" }));
		const dialog = await screen.findByRole("dialog");
		expect(dialog.textContent).not.toContain("桥");
		expect(dialog.textContent).toContain("删掉它的设置也会一起没");
	});
});

describe("localized declarative availability", () => {
	it.each([
		[
			"disabled",
			false,
			"This extension is disabled. It is not performing any work.",
			"この拡張機能は無効です。現在は何も実行していません。",
			"此拓展已關閉，目前不會執行任何工作。",
		],
		[
			"settings-invalid",
			true,
			"The saved settings do not meet this extension’s requirements, so it is not running. Correct them below and it will start automatically.",
			"保存済みの設定が拡張機能の要件を満たしていないため、停止しています。下の設定を修正すると自動的に起動します。",
			"已儲存的設定不符合此拓展的規則，因此尚未執行；在下方修正後會自動啟動。",
		],
		[
			"staged",
			true,
			"The new version is installed but has not been loaded. Only settings are available below; choose how to load it in the card above.",
			"新しいバージョンはインストール済みですが、まだ読み込まれていません。下には設定のみ表示されます。読み込み方法は上のカードで選べます。",
			"新版已安裝但尚未載入，下方只有設定、沒有狀態；請在上方卡片選擇載入方式。",
		],
		[
			"failed",
			true,
			"This extension could not start. Only settings are available below; check the logs for the cause.",
			"この拡張機能は起動できていません。下には設定のみ表示されます。原因はログを確認してください。",
			"此拓展尚未啟動，下方只有設定、沒有狀態；請到日誌查看原因。",
		],
	] as const)(
		"%s guidance translates while the editable draft remains intact",
		async (state, enabled, en, ja, tw) => {
			renderDetail({ ext: { ...DOUYIN, state, enabled } });
			const field = await screen.findByLabelText("检查间隔");
			fireEvent.change(field, { target: { value: "120" } });
			vi.mocked(api.post).mockClear();
			vi.mocked(api.delete).mockClear();
			for (const [locale, voice, expected, disabledHint] of [
				[
					"en",
					"plain",
					en,
					"You can still edit settings below. They take effect when you enable the extension; connection status is available only while it is running.",
				],
				[
					"ja",
					"plain",
					ja,
					"下の設定は変更できます。有効にすると反映されます。接続状態は拡張機能の実行中のみ表示されます。",
				],
				[
					"zh-TW",
					"plain",
					tw,
					"下方設定仍可修改，啟用拓展後生效；連線狀態需等拓展執行後才會顯示。",
				],
				[
					"ja",
					"maid",
					state === "disabled"
						? ja
						: {
								"settings-invalid":
									"ご主人様、保存済みの設定が拡張機能の要件を満たさないため、いまは動いていませんよ。下で修正すると、自動で起動します。",
								staged:
									"ご主人様、新しいバージョンはインストール済みですが、まだ読み込まれていませんよ。下には設定だけを表示しています。読み込み方法は上のカードで選んでくださいね。",
								failed:
									"ご主人様、この拡張機能はいま動いていないので、下には設定だけを表示していますよ。起動できなかった理由はログを確認してくださいね。",
							}[state],
					"ご主人様、下の設定は無効のままでも変更できますよ。有効にすると反映されます。接続状態は起動してから表示しますね。",
				],
				[
					"zh-TW",
					"maid",
					state === "disabled"
						? tw
						: {
								"settings-invalid":
									"主人，已儲存的設定不符合拓展的規則，因此尚未執行喔；在下方修正後，它會自動啟動。",
								staged:
									"主人，新版已安裝但尚未載入，下方只有設定、沒有狀態喔；請在上方卡片選擇載入方式。",
								failed:
									"主人，這個拓展目前沒有開始執行，下方只有設定、沒有狀態喔；請到日誌查看未能啟動的原因。",
							}[state],
					"主人，下方設定仍可修改，啟用拓展後才會生效喔；連線狀態要等它開始執行後才看得到。",
				],
			] as const) {
				await act(async () => {
					i18n.set({ locale, voice });
				});
				expect(screen.getByText(expected)).toBeTruthy();
				if (!enabled) expect(screen.getByText(disabledHint, { exact: false })).toBeTruthy();
				expect(screen.getByLabelText("检查间隔")).toBe(field);
				expect((field as HTMLInputElement).value).toBe("120");
				expect(screen.getAllByText("抖音订阅").length).toBeGreaterThan(0);
			}
			expect(statusCalls()).toBe(0);
			expect(apiPatchMock).not.toHaveBeenCalled();
			expect(api.post).not.toHaveBeenCalled();
			expect(api.delete).not.toHaveBeenCalled();
		},
	);

	it("unavailable live state translates the explanation and preserves the host error", async () => {
		renderDetail({ status: new Error("原始读取诊断 / ECONNRESET") });
		const note = await within(await headCard()).findByRole("alert");
		for (const [locale, prefix] of [
			["en", "Could not read the current status:"],
			["ja", "現在の状態を読み込めません："],
			["zh-TW", "無法讀取目前狀態："],
		] as const) {
			await act(async () => {
				i18n.set({ locale, voice: "plain" });
			});
			expect(note.textContent).toContain(prefix);
			expect(note.textContent).toContain("原始读取诊断 / ECONNRESET");
			expect(screen.getByLabelText("检查间隔")).toBeTruthy();
		}
		expect(apiPatchMock).not.toHaveBeenCalled();
	});
});

/**
 * 盘上换了代码、这个进程干净地换不上(ADR-0012 决策 47)。头卡里摆那块「两条出路」—— 跑着旧的
 * 那一档与开着却没跑那一档都要;**没有新代码时一颗也不给**(生产上不给随手漏模块的口子)。
 */
describe("新版等着换上", () => {
	const STAGED: ExtensionEntryView = { ...DOUYIN, staged: { version: "0.2.0" } };

	it("跑着旧的、盘上换了新版 → 头卡里两条出路,说清两边各是哪一版", async () => {
		renderDetail({ ext: STAGED });
		const head = await headCard();
		expect(within(head).getByText(/盘上换成了 v0\.2\.0,这里跑的还是 v0\.1\.0/)).toBeTruthy();
		expect(within(head).getByRole("button", { name: "重启 BN" })).toBeTruthy();
		expect(within(head).getByRole("button", { name: "只重载这个拓展" })).toBeTruthy();
	});

	/** 那一档没有状态可看,但原因不在日志里 —— 叫人去翻日志等于把人支走。 */
	it("开着却换不上(state staged)→ 头卡里同一块;配置页签不叫人去翻日志", async () => {
		renderDetail({
			ext: { ...DOUYIN, version: "0.2.0", state: "staged", staged: { version: "0.2.0" } },
		});
		const head = await headCard();
		expect(
			within(head).getByText(/v0\.2\.0 装好了,但这个进程早就认下了它的另一份代码/),
		).toBeTruthy();
		expect(within(head).getByRole("button", { name: "只重载这个拓展" })).toBeTruthy();
		expect(await screen.findByLabelText("检查间隔")).toBeTruthy();
		expect(screen.queryByText(/去日志里看/)).toBeNull();
		expect(statusCalls()).toBe(0);
	});

	/**
	 * 关着、这个进程跑过它别的代码:那一行也带着「等着换上」。头卡里照样说,但只给「重启 BN」——
	 * 只重载按下去就是把一个关着的拓展跑起来,那是开关的活。
	 */
	it("关着、盘上换了新版 → 头卡里同一块,只给「重启 BN」", async () => {
		renderDetail({
			ext: {
				...DOUYIN,
				version: "0.2.0",
				enabled: false,
				state: "disabled",
				staged: { version: "0.2.0" },
			},
		});
		const head = await headCard();
		expect(
			within(head).getByText(/v0\.2\.0 装好了,但这个进程早就认下了它的另一份代码/),
		).toBeTruthy();
		expect(within(head).getByRole("button", { name: "重启 BN" })).toBeTruthy();
		expect(within(head).queryByRole("button", { name: "只重载这个拓展" })).toBeNull();
	});

	it("没有新版等着 → 页上既没有「只重载」,也没有「重启 BN」", async () => {
		renderDetail();
		await headCard();
		expect(await screen.findByLabelText("检查间隔")).toBeTruthy();
		expect(screen.queryByRole("button", { name: "只重载这个拓展" })).toBeNull();
		expect(screen.queryByRole("button", { name: "重启 BN" })).toBeNull();
	});

	it("这台机器拉不起自己 → 不给「重启 BN」,换成原因", async () => {
		renderDetail({
			ext: STAGED,
			restart: { can: false, code: "unsupervised", message: "这个进程退了没人拉" },
		});
		const head = await headCard();
		expect(within(head).queryByRole("button", { name: "重启 BN" })).toBeNull();
		expect(within(head).getByText("这个进程退了没人拉")).toBeTruthy();
		expect(within(head).getByRole("button", { name: "只重载这个拓展" })).toBeTruthy();
	});

	it("按「只重载这个拓展」→ POST 这个拓展自己那一口", async () => {
		vi.mocked(api.post).mockResolvedValue({ ok: true });
		renderDetail({ ext: STAGED });
		const head = await headCard();
		fireEvent.click(within(head).getByRole("button", { name: "只重载这个拓展" }));
		await waitFor(() => expect(api.post).toHaveBeenCalledWith("/api/ext/douyin/swap", {}));
	});
});

describe("版本不合的拓展(第 1 版的退路已删):没有清单、没有面板", () => {
	/**
	 * 🔴 叫 bridge 的也一样 —— 手写的桥页退役了(决策 19),这一页不再认得任何具体拓展。
	 * 按 id 留一条岔路的话,它会悄悄接着画一块已经不存在的面板。
	 */
	it.each(["legacy", "bridge"])(
		"%s:头卡里只有状态那句原因与「没有交上来自己的面板」,不摆「配置」,不问状态,删除确认里没有桥的那句",
		async (id) => {
			// 清单读不出来(版本不合):服务端不给 apiVersion / provides,只有身份那几格与原因。
			const legacy: ExtensionEntryView = {
				id,
				name: "老拓展",
				description: "还停在 v1",
				version: "1.0.0",
				enabled: true,
				state: "incompatible",
				detail: "它是给宿主契约 v1 写的,这一版 BN 只认 v2 —— 换它的新版",
				dir: `/data/extensions/${id}`,
			};
			renderDetail({ ext: legacy, settings: { links: [] } });
			const head = await headCard("老拓展");
			expect(within(head).getByText(/换它的新版/)).toBeTruthy();
			expect(within(head).getByText(/这个拓展没有交上来自己的面板/)).toBeTruthy();
			expect(within(head).queryByText("BN 地址")).toBeNull();
			await waitFor(() => expect(apiGetMock).toHaveBeenCalledWith(`/api/ext/${id}/docs`));
			expect(screen.queryByRole("tab")).toBeNull();
			expect(screen.queryByText("还没有桥接入。")).toBeNull();
			expect(statusCalls(id)).toBe(0);

			fireEvent.click(screen.getByRole("button", { name: "删除拓展" }));
			const dialog = await screen.findByRole("dialog");
			expect(dialog.textContent).not.toContain("桥");
			expect(dialog.textContent).toContain("删掉它的设置也会一起没");
		},
	);
});
