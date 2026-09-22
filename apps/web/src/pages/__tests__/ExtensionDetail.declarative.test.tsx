// @vitest-environment jsdom

/**
 * v2 拓展的详情页照声明画(ADR-0019 决策 19 / 25 / 32):头卡正文是视图的页级积木,「配置」
 * 页签里是照清单画的设置表单。v1(今天只有桥)那一页一格不动。
 *
 * 值得钉的:
 * - **按契约档位分岔**,不按 id —— 桥迁过去之后还叫 bridge。
 * - 🔴 **拓展关着设置照样能改**(决策 32):「装好 → 填 → 启用」这个顺序靠它才走得通。
 * - 关着与没跑起来**分开说**:前者是主人自己刚拨的开关,后者要去查日志。
 */

import type { ExtensionDTO, ExtensionsResponse, ExtensionView } from "@bilibili-notify/contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import ExtensionDetail from "../ExtensionDetail";

const { apiGetMock, apiPatchMock, NotFound } = vi.hoisted(() => {
	class NotFound extends Error {
		readonly status = 404;
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

const DOUYIN: ExtensionDTO = {
	id: "douyin",
	name: "抖音订阅",
	description: "盯着抖音作者的新作品与开播。",
	version: "0.1.0",
	apiVersion: 2,
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

const VIEW: ExtensionView = {
	summary: { tone: "ok", text: "12 位作者" },
	page: [
		{
			type: "keyValue",
			items: [
				{ label: "登录", value: "cookie 有效", tone: "ok" },
				{ label: "在看的作者", value: "12 位" },
			],
		},
	],
};

interface Setup {
	ext?: ExtensionDTO;
	/** 状态那一口:一份视图,或一个错(`NotFound` = 404)。 */
	status?: ExtensionView | Error;
	settings?: Record<string, unknown>;
}

function renderDetail({ ext = DOUYIN, status = VIEW, settings = { interval: 90 } }: Setup = {}) {
	apiGetMock.mockImplementation(async (url: string) => {
		if (url === "/api/ext") return { extensions: [ext] } satisfies ExtensionsResponse;
		if (url === "/api/globals") {
			return { extensions: { [ext.id]: { enabled: ext.enabled, settings } } };
		}
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
			expect(apiPatchMock).toHaveBeenCalledWith("/api/globals", {
				extensions: { douyin: { settings: { interval: 120 } } },
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

describe("v1 的桥:原样", () => {
	const BRIDGE_V1: ExtensionDTO = {
		id: "bridge",
		name: "机器人框架桥接",
		description: "借 bot",
		version: "1.0.0",
		apiVersion: 1,
		provides: ["push"],
		enabled: true,
		state: "running",
		dir: "/data/extensions/bridge",
	};

	it("头卡里还是 BN 地址那一行,底下那句不带版本号,配置里是手写的接入那一节", async () => {
		renderDetail({ ext: BRIDGE_V1, status: { sessions: [] } as never, settings: { links: [] } });
		const head = await headCard("机器人框架桥接");
		expect(within(head).getByText("BN 地址")).toBeTruthy();
		expect(within(head).getByText(/^卸掉它/)).toBeTruthy();
		expect(await screen.findByText("还没有桥接入。")).toBeTruthy();
		expect(screen.queryByText("设置")).toBeNull();
	});
});
