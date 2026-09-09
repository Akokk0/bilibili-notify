// @vitest-environment jsdom

import type { ExtensionsResponse } from "@bilibili-notify/contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

const LISTED: ExtensionsResponse = {
	extensions: [
		{
			id: "bridge",
			name: "机器人框架桥接",
			description: "把别的机器人框架里的 bot 借过来发推送",
			version: "1.0.0",
			provides: ["push"],
			icon: '<svg viewBox="0 0 24 24" data-testid="bridge-icon"><path d="M4 4h16"/></svg>',
			enabled: true,
			state: "running",
			root: { kind: "data", dir: "/data/extensions/bridge" },
		},
		{
			id: "douyin",
			name: "抖音订阅源",
			version: "0.2.0",
			enabled: true,
			state: "blocked",
			detail: "连续加载失败 3 次,已自动停用;换一版会重新试",
			root: { kind: "data", dir: "/data/extensions/douyin" },
		},
	],
	shadowed: [],
};

function renderPage(listed: ExtensionsResponse = LISTED) {
	apiGetMock.mockResolvedValue(listed);
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<MemoryRouter>
				<Extensions />
			</MemoryRouter>
		</QueryClientProvider>,
	);
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
		expect(await screen.findByText("已自动停用")).toBeTruthy();
		expect(screen.getByText(/连续加载失败 3 次/)).toBeTruthy();
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
	 * 🔴 **开关热、代码不热**(ADR-0012 决策 10),两半都得说清楚:只说前半,主人换完
	 * 拓展代码会以为拨一下开关就够;只说后半,他会为一次停用去重启整个进程。
	 */
	it("说清楚开关立刻生效、换代码才要重启", async () => {
		renderPage();
		expect(await screen.findByText(/立刻生效/)).toBeTruthy();
		expect(await screen.findByText(/才要重启一次/)).toBeTruthy();
	});

	/** 详情页是拓展自己那块面板的唯一去处 —— 卡片上不给入口的话只能手敲地址。 */
	it("每张卡都通到自己的详情页", async () => {
		renderPage();
		const links = await screen.findAllByText("详情 →");
		expect(links.map((a) => a.getAttribute("href"))).toEqual([
			"/extensions/bridge",
			"/extensions/douyin",
		]);
	});

	/**
	 * 🔴 **开箱就是这一屏** —— 本体一个拓展都不带,新装的 BN 打开这一页是空的。所以它要
	 * 把「怎么装」说完,而不是只写一句「还没有装任何拓展」。
	 */
	it("一个拓展都没装时,把两条来路说完", async () => {
		renderPage({ extensions: [], shadowed: [] });
		expect(await screen.findByText(/还没有装任何拓展/)).toBeTruthy();
		// 面板安装那条路还没建 —— **明说**「还没做」,不是藏起来让人以为按钮在别处。
		expect(screen.getByText("还没做")).toBeTruthy();
		expect(screen.getByText("现在能用")).toBeTruthy();
		expect(screen.getByText(/<dataDir>\/extensions\//)).toBeTruthy();
		// 我们自己开发拓展走的是仓里那个源码根,不是往 dataDir 里拷。
		expect(screen.getByText(/tsx watch/)).toBeTruthy();
	});

	/**
	 * 拓展只开两口(ADR-0012):推送源接进「推送目标」,订阅源接进「订阅 UP 主」。分组不是
	 * 排版口味 —— 主人来这一页多半是**为了某一口**,而卡片上的机器词 `provides` 说不清
	 * 它会出现在哪。
	 */
	it("按开的那一口分组,空的那一口也留着并说清楚它空着", async () => {
		renderPage();
		// 「推送源」在页面上有两处:分节标题,与桥那张卡上的药丸 —— 两处都该有。
		expect(await screen.findByText("接进「推送目标」")).toBeTruthy();
		expect(screen.getAllByText("推送源").length).toBeGreaterThan(1);
		expect(screen.getByText("接进「订阅 UP 主」")).toBeTruthy();
		expect(screen.getByText(/还没有订阅源拓展/)).toBeTruthy();
	});

	/** 两份同名的摆在盘上时,「我改的是不是跑着的那个」只有全路径答得了。 */
	it("每张卡都说得出自己是从哪儿扫出来的", async () => {
		renderPage();
		expect(await screen.findByText("/data/extensions/bridge")).toBeTruthy();
		expect(screen.getAllByText(/主人装的/).length).toBeGreaterThan(0);
	});

	/**
	 * 🔴 悄悄盖掉正是「我明明改了怎么没生效」最难查的原因:盘上两份、列表上一行,
	 * 不说的话没有任何办法判断跑的是哪个。
	 */
	it("同一个 id 有两份时,页面上把两份的位置都摆出来", async () => {
		renderPage({
			...LISTED,
			shadowed: [
				{
					id: "bridge",
					winner: { kind: "source", dir: "/repo/extensions/bridge" },
					shadowed: { kind: "data", dir: "/data/extensions/bridge" },
				},
			],
		});
		expect(await screen.findByText(/\/repo\/extensions\/bridge/)).toBeTruthy();
		expect(screen.getAllByText(/仓里源码/).length).toBeGreaterThan(0);
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
