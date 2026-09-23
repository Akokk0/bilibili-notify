// @vitest-environment jsdom

/**
 * 拓展详情页整页画出来的样子 —— 拿迁到 v2 的桥来量:清单里一格接入列表,视图交来头卡的地址行
 * 与每条接入的状态 / bot 表。
 *
 * 零件各自的测试在 `extensions/declarative/__tests__/` 里;这一份钉的是**整页接起来**之后
 * 那几件主人一眼就要看到的事 —— 从路由进来、经头卡与「配置」页签,一路画到接入卡上。
 */

import type { ExtensionsResponse, ExtensionView } from "@bilibili-notify/contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import ExtensionDetail from "../ExtensionDetail";
// 迁到 v2 的桥长什么样只有一份 —— 清单那一格列表各处抄一份的话,迟早各漂各的。
import { BRIDGE } from "../extensions/declarative/__tests__/list-harness";

const { apiGetMock, apiPatchMock } = vi.hoisted(() => ({
	apiGetMock: vi.fn(),
	apiPatchMock: vi.fn(),
}));

vi.mock("../../services/api", () => ({
	api: {
		get: apiGetMock as unknown as (url: string) => Promise<unknown>,
		patch: apiPatchMock as unknown as (url: string, body?: unknown) => Promise<unknown>,
		post: vi.fn(),
		delete: vi.fn(),
	},
	ApiError: class extends Error {},
}));

const CONNECTED_ID = "11111111-1111-4111-8111-111111111111";
const CONFIGURED_ID = "22222222-2222-4222-8222-222222222222";

const LISTED: ExtensionsResponse = {
	extensions: [BRIDGE],
	restart: { can: true, how: "container" },
};

/** 接入住桥的设置里(`globals.extensions.bridge.settings.links`),不在连接表里(ADR-0012 决策 45)。 */
const GLOBALS = {
	extensions: {
		bridge: {
			enabled: true,
			settings: {
				links: [
					{ id: CONNECTED_ID, name: "家里那台", enabled: true, token: "t1", bridgeKind: "koishi" },
					{ id: CONFIGURED_ID, name: "公司那台", enabled: true, token: "t2", bridgeKind: "koishi" },
				],
			},
		},
	},
};

/** 桥交来的视图 —— 照 `extensions/bridge/src/view.ts` 算出来的形状写:一条连着、一条没连上。 */
const VIEW: ExtensionView = {
	summary: { tone: "ok", text: [{ b: "1" }, " 个 bot 在线"] },
	page: [
		{
			type: "copy",
			label: "BN 地址",
			value: { host: "extensionUrl" },
			note: [
				"这是",
				{ b: "桥那台机器" },
				"要访问得到的地址 —— BN 在 NAS 上时别填 ",
				{ mono: "127.0.0.1" },
				"。",
			],
		},
	],
	items: {
		links: {
			[CONNECTED_ID]: {
				status: { tone: "ok", text: "已连接" },
				pill: "koishi",
				subtitle: [
					"客厅那台 koishi v0.1.0",
					" · ",
					{ time: 1_700_000_000_000, suffix: "连上" },
					" · ",
					"来自 192.168.1.5",
				],
				blocks: [
					{
						type: "table",
						title: "它驮着的 bot",
						count: true,
						columns: [
							{ kind: "icon" },
							{ kind: "text", width: 210 },
							{ kind: "tristate", label: "@全体" },
							{ kind: "tristate", label: "收私聊指令" },
							{ kind: "tristate", label: "合并转发" },
						],
						rows: [
							[{ fallback: "te" }, { text: "小电视", sub: "telegram" }, "yes", "no", "unknown"],
						],
					},
				],
			},
			[CONFIGURED_ID]: {
				status: { tone: "off", text: "没连上" },
				pill: "koishi",
				subtitle: "现在没有桥用这个 token 连着。",
			},
		},
	},
};

function renderDetail(id = "bridge") {
	apiGetMock.mockImplementation(async (url: string) => {
		if (url === "/api/ext") return LISTED;
		if (url === "/api/globals") return GLOBALS;
		// 接入名单从拓展自己的设置口读(ADR-0019 决策 35);`/api/globals` 里已经没有设置那一格。
		if (url === "/api/ext/bridge/settings") {
			return { revision: "r1", values: GLOBALS.extensions.bridge.settings };
		}
		if (url === "/api/ext/bridge/status") return VIEW;
		return {};
	});
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<MemoryRouter initialEntries={[`/extensions/${id}`]}>
				<Routes>
					<Route path="/extensions/:id" element={<ExtensionDetail />} />
				</Routes>
			</MemoryRouter>
		</QueryClientProvider>,
	);
}

/** 头卡:「已启用」那枚徽章所在的玻璃卡。 */
async function headCard(): Promise<HTMLElement> {
	const head = (await screen.findByText("已启用")).closest(".bn-glass");
	if (!head) throw new Error("找不到头卡");
	return head as HTMLElement;
}

/** 一条接入的那张卡。 */
async function linkCard(id: string): Promise<HTMLElement> {
	return waitFor(() => {
		const card = document.querySelector(`[data-list-card="${id}"]`);
		if (!card) throw new Error(`没有 ${id} 那张卡`);
		return card as HTMLElement;
	});
}

describe("拓展详情页", () => {
	// ⚠️ **花括号不能省**:`mockReset()` 回的是那个 mock 本身,而 mock 是个函数 ——
	// 箭头函数直接返回它,vitest 会把它当成这一条的清理钩子,在收摊时**当函数调一次**。
	// 症状是每条用例末尾多一发 `api.get(undefined)`,栈里看不出是自己写的。
	beforeEach(() => {
		apiGetMock.mockReset();
		apiPatchMock.mockReset();
		apiPatchMock.mockResolvedValue({});
	});
	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
	});

	it("头上印的是这个拓展自己的名字、说明与状态", async () => {
		renderDetail();
		// 名字有两处:面包屑与头卡 —— 两处都该是它自己的名字。
		expect(await screen.findAllByText("机器人框架桥接")).toHaveLength(2);
		expect(screen.getByText("已启用")).toBeTruthy();
		expect(screen.getByText(BRIDGE.description as string)).toBeTruthy();
	});

	/**
	 * 🔴 接入卡是**页面级**的兄弟节点,不套在头卡肚子里(设计稿 V1)——
	 * 此前整张接入列表被塞进头卡正文,头卡长成了整页。
	 */
	it("接入卡不在头卡肚子里", async () => {
		renderDetail();
		const head = await headCard();
		const card = await linkCard(CONNECTED_ID);
		expect(head.contains(card)).toBe(false);
	});

	/**
	 * 点进详情页正是为了「摆弄它」,而开关是这一页最主要的那个动作 —— 只能回列表去拨的话,
	 * 这一页就成了只读的展板。补丁仍然**只带自己那一格**(JSON Merge Patch)。
	 */
	it("详情页也能拨开关,发出去的还是只有自己那一格", async () => {
		renderDetail();
		fireEvent.click(await screen.findByLabelText("机器人框架桥接"));
		await waitFor(() =>
			expect(apiPatchMock).toHaveBeenCalledWith("/api/globals", {
				extensions: { bridge: { enabled: false } },
			}),
		);
	});

	/**
	 * 🔴 **插件那头必须手敲这个地址**,面板不给就等于让主人去翻文档。地址由视图的 `copy` 积木
	 * 交、在浏览器里现算;最容易填错的那一处也得说出来:BN 常在 NAS / 容器里,`127.0.0.1`
	 * 对桥来说是**桥自己那台机器**。
	 */
	it("头卡里印着插件那头要填的 BN 地址,还能一键复制", async () => {
		const writeText = vi.fn().mockResolvedValue(undefined);
		Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
		renderDetail();

		const head = await headCard();
		const address = `ws://${window.location.host}/ext/bridge`;
		expect(await within(head).findByText(address)).toBeTruthy();
		// 「别填 127.0.0.1」那句与地址一样要紧 —— 填错了这一页不会留下任何记录。
		expect(within(head).getByText("127.0.0.1")).toBeTruthy();

		fireEvent.click(within(head).getByLabelText("复制 BN 地址"));
		await waitFor(() => expect(writeText).toHaveBeenCalledWith(address));
	});

	it("连上了的那条:视图交来的种类 / 名字 / 版本 / 从哪来都印出来", async () => {
		renderDetail();
		const card = await linkCard(CONNECTED_ID);
		expect(await within(card).findByText("已连接")).toBeTruthy();
		expect(within(card).getByText("koishi", { selector: "span:not([role])" })).toBeTruthy();
		expect(card.textContent).toContain("客厅那台 koishi v0.1.0");
		expect(card.textContent).toContain("来自 192.168.1.5");
		expect(within(card).getByText("小电视")).toBeTruthy();
	});

	/**
	 * 🔴 **「配了但没连上」是这一页最该看见的一行。** 只列活着的会话的话,那条根本不显示 ——
	 * 而主人正是为了查它才打开这一页。
	 */
	it("配了但没连上的那条也要在列表里", async () => {
		renderDetail();
		const card = await linkCard(CONFIGURED_ID);
		expect(within(card).getByText("公司那台")).toBeTruthy();
		expect(await within(card).findByText("没连上")).toBeTruthy();
	});

	/**
	 * 🔴 **「不支持」与「还不知道」要分开显示**(桥接设计定案里写死的):前者是结论,
	 * 后者是「试试看,可能行」。混成一个叉号,主人会以为那条平台永远做不到。
	 */
	it("能力三态分开说 —— 支持 / 不支持 / 还不知道", async () => {
		renderDetail();
		await screen.findByText("小电视");
		expect(screen.getByTitle("@全体:支持")).toBeTruthy();
		expect(screen.getByTitle("收私聊指令:不支持")).toBeTruthy();
		expect(screen.getByTitle("合并转发:还不知道")).toBeTruthy();
	});

	it("地址栏里是个不存在的拓展 → 说一句,不是白屏", async () => {
		renderDetail("nope");
		expect(await screen.findByText(/没有装名叫 nope 的拓展/)).toBeTruthy();
	});
});

/**
 * 「设置读不了」(ADR-0019 决策 36):存着的设置过不了拓展自己的 zod,它不跑 —— 出路就在这一页的
 * 「配置」里,改对了它自己起来。所以这一档表单与列表**照样画、照样能存**(它们本来就不看跑没跑),
 * 头卡上的原因是黄的提醒,不是红的出错。
 */
describe("拓展详情页 —— 设置读不了", () => {
	const DETAIL =
		"存着的设置不合它自己的规矩:「桥接入」里「家里那台」这一项的「token」:太短了。在它的「配置」里改对,改对了会自己起来";

	function renderInvalid() {
		const settings = GLOBALS.extensions.bridge.settings;
		apiGetMock.mockImplementation(async (url: string) => {
			if (url === "/api/ext") {
				return {
					...LISTED,
					extensions: [{ ...BRIDGE, state: "settings-invalid", detail: DETAIL }],
				} satisfies ExtensionsResponse;
			}
			// 设置从哪口读取决于面板那一侧的版本:拓展自己的口(决策 35),或者更早的 globals。
			if (url === "/api/ext/bridge/settings") return { revision: "r1", values: settings };
			if (url === "/api/globals") return GLOBALS;
			return {};
		});
		apiPatchMock.mockImplementation(async (url: string) =>
			url === "/api/ext/bridge/settings"
				? { revision: "r2", values: settings, added: [] }
				: GLOBALS,
		);
		const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		return render(
			<QueryClientProvider client={qc}>
				<MemoryRouter initialEntries={["/extensions/bridge"]}>
					<Routes>
						<Route path="/extensions/:id" element={<ExtensionDetail />} />
					</Routes>
				</MemoryRouter>
			</QueryClientProvider>,
		);
	}

	beforeEach(() => {
		apiGetMock.mockReset();
		apiPatchMock.mockReset();
	});
	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
	});

	it("头卡:徽章说「设置读不了」,原因是黄的提醒", async () => {
		renderInvalid();
		const badge = await screen.findByText("设置读不了");
		const head = badge.closest(".bn-glass") as HTMLElement;
		const note = within(head).getByText(DETAIL).closest("[data-bn]");
		expect(note?.getAttribute("data-bn")).toContain("note-warn");
	});

	it("「配置」照样画、照样能存", async () => {
		renderInvalid();
		const card = await linkCard(CONNECTED_ID);
		expect(within(card).getByText("家里那台")).toBeTruthy();

		fireEvent.click(await screen.findByRole("button", { name: "停用 家里那台" }));
		await waitFor(() =>
			expect(apiPatchMock).toHaveBeenCalledWith(
				expect.stringMatching(/^\/api\/(ext\/bridge\/settings|globals)$/),
				expect.anything(),
			),
		);
	});
});
