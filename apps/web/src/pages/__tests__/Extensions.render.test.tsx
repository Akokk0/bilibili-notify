// @vitest-environment jsdom

import type { ExtensionsResponse } from "@bilibili-notify/contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import Extensions from "../Extensions";

const { apiGetMock, apiPatchMock } = vi.hoisted(() => ({
	apiGetMock: vi.fn(),
	apiPatchMock: vi.fn(),
}));

vi.mock("../../services/api", () => ({
	api: {
		get: apiGetMock as unknown as (url: string) => Promise<unknown>,
		patch: apiPatchMock as unknown as (url: string, body?: unknown) => Promise<unknown>,
	},
}));

const BRIDGE: ExtensionsResponse["extensions"][number] = {
	id: "bridge",
	name: "机器人框架桥接",
	description: "把别的机器人框架里的 bot 借过来发推送",
	version: "1.0.0",
	provides: ["push"],
	icon: '<svg viewBox="0 0 24 24" data-testid="bridge-icon"><path d="M4 4h16"/></svg>',
	enabled: true,
	state: "running",
	dir: "/data/extensions/bridge",
};

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
};

/** 桥名下两条接入,外加一条与拓展无关的直连 —— 数错了它就会混进来。 */
const CONNECTIONS = [
	{ id: "a", name: "家里那台", kind: "extension", extensionId: "bridge", enabled: true },
	{ id: "b", name: "机房那台", kind: "extension", extensionId: "bridge", enabled: true },
	{ id: "c", name: "本地 OneBot", kind: "direct", enabled: true },
	// ⚠️ 别的拓展名下的一条。少了它,「按 extensionId 过滤」这条守卫离了保护也不会坏。
	{ id: "d", name: "别人家的", kind: "extension", extensionId: "somewhere-else", enabled: true },
];

/** 桥的活口状态:两条接入一条连着(驮两个 bot)、一条没连上。 */
const STATUS = {
	sessions: [
		{
			connectionId: "a",
			connected: true,
			kind: "koishi",
			bots: [
				{ botId: "onebot:1", platform: "onebot", name: "阿库娅" },
				{ botId: "telegram:2", platform: "telegram", name: "小电视" },
			],
		},
		{ connectionId: "b", connected: false, bots: [] },
	],
};

/** `status` 传 `null` = 拓展没跑起来,那一口 404。(⚠️ 别用 undefined:默认参数会把它换成 STATUS。) */
function renderPage(
	listed: ExtensionsResponse = LISTED,
	connections: unknown = CONNECTIONS,
	status: unknown = STATUS,
) {
	apiGetMock.mockImplementation(async (url: string) => {
		if (url === "/api/connections") return connections;
		if (url.startsWith("/api/ext/")) {
			if (status === null) throw new Error("拓展没跑起来");
			return status;
		}
		return listed;
	});
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<MemoryRouter>
				<Extensions />
			</MemoryRouter>
		</QueryClientProvider>,
	);
}

/** 那张卡 —— 从名字往上找到玻璃卡的边。 */
async function cardOf(name: string): Promise<HTMLElement> {
	const card = (await screen.findByText(name)).closest(".bn-glass");
	if (!card) throw new Error(`「${name}」不在一张卡上`);
	return card as HTMLElement;
}

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

	it("装了什么就列什么 —— 卡片文案来自服务端,不在前端再抄一份", async () => {
		renderPage();
		expect(await screen.findByText("机器人框架桥接")).toBeTruthy();
		expect(screen.getByText("把别的机器人框架里的 bot 借过来发推送")).toBeTruthy();
		expect(screen.getByText("抖音订阅源")).toBeTruthy();
		expect(apiGetMock).toHaveBeenCalledWith("/api/ext");
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
	 * 🔴 **补丁只带自己那一格。** 配置是 JSON Merge Patch:整份 `extensions` 发出去的话,
	 * 别人刚拨的开关会被这一发悄悄按回旧值,而两边都不会报错。
	 */
	it("拨开关只发自己那一格,不把整张表发出去", async () => {
		renderPage();
		const toggle = await screen.findByLabelText("机器人框架桥接");
		fireEvent.click(toggle);
		// mutate 是异步发起的,同步断言会在请求出门之前就跑完。
		await waitFor(() =>
			expect(apiPatchMock).toHaveBeenCalledWith("/api/globals", {
				extensions: { bridge: { enabled: false } },
			}),
		);
	});

	/**
	 * 🔴 数的是**这个拓展名下**的接入,而且**只按 `provides` 判**,不按拓展 id ——
	 * 列表页认得某个具体拓展就是那条硬约束的破口。别的连接(直连的 OneBot)不算数。
	 */
	it("开推送源那一口的卡数得出自己名下几条接入", async () => {
		renderPage();
		const card = await cardOf("机器人框架桥接");
		expect(card.textContent).toMatch(/2\s*条接入/);
	});

	it("不开推送源那一口的卡不说这句 —— 它压根没有接入这回事", async () => {
		renderPage();
		const card = await cardOf("抖音订阅源");
		expect(card.textContent).not.toMatch(/条接入/);
	});

	it("一条都没配的也报 0 —— 那正是「装好了但还没接上」该看见的", async () => {
		renderPage(LISTED, []);
		const card = await cardOf("机器人框架桥接");
		expect(card.textContent).toMatch(/0\s*条接入/);
	});

	/**
	 * 「配了两条一条没连上」和「两条全连着」得在列表上就分得开 —— 那句 bot 数只数
	 * **连着的**会话驮着的。
	 */
	it("桥那张卡还数得出现在几个 bot 在线", async () => {
		renderPage();
		const card = await cardOf("机器人框架桥接");
		await waitFor(() => expect(card.textContent).toMatch(/2\s*个 bot 在线/));
	});

	it("拓展没跑起来时只数接入,不假装有 bot 在线", async () => {
		renderPage(LISTED, CONNECTIONS, null);
		const card = await cardOf("机器人框架桥接");
		// 状态那条查询要先认输,才能断言它「没出现」而不是「还没来」
		await waitFor(() => expect(apiGetMock).toHaveBeenCalledWith("/api/ext/bridge/status"));
		await new Promise((r) => setTimeout(r, 20));
		expect(card.textContent).toMatch(/2\s*条接入/);
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
	 * 🔴 **开箱就是这一屏** —— 本体一个拓展都不带,新装的 BN 打开这一页是空的。两口都空着,
	 * 而「怎么装」那扇门就在页头:点开要把两条来路说完,而且传包那条**当场能走**。
	 */
	it("一个拓展都没装时,两口都说清楚它空着,页头那扇门里把两条来路说完", async () => {
		const { container } = renderPage({ extensions: [] });
		expect(await screen.findByText(/还没有推送源拓展/)).toBeTruthy();
		expect(screen.getByText(/还没有订阅源拓展/)).toBeTruthy();

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
	 * 拓展只开两口(ADR-0012):推送源接进「推送目标」,订阅源接进「订阅 UP 主」。分组不是
	 * 排版口味 —— 主人来这一页多半是**为了某一口**,而卡片上的机器词 `provides` 说不清
	 * 它会出现在哪。
	 */
	it("按开的那一口分组;归不了口的(清单读不出来)也不许消失", async () => {
		renderPage({
			extensions: [
				...LISTED.extensions,
				{ id: "broken", name: "坏掉的那个", enabled: false, state: "unreadable", dir: "/x" },
			],
		});
		expect(await screen.findByText("推送源")).toBeTruthy();
		expect(screen.getByText("订阅源")).toBeTruthy();
		expect(screen.getByText("坏掉的那个")).toBeTruthy();
		expect(screen.getByText("没归到口上的")).toBeTruthy();
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
