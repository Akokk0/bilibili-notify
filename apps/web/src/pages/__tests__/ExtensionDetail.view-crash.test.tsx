// @vitest-environment jsdom

/**
 * 照拓展声明画的那几块(头卡里的页级积木、「配置」页签)在画的时候抛了错:**只换掉那一块**,
 * 详情页别的部分照常 —— 面包屑、头卡的名字 / 开关 / 删除钮都在,那一块说出了什么错、带原文、
 * 能重试。那是拓展交来的视图(面板比服务端旧的那几秒、渲染器自己的漏洞都可能让它炸),
 * 炸了连累整页、甚至整个面板白屏,不值当。
 *
 * 怎么炸:把积木与设置表单换成按开关抛错的桩 —— 要钉的是「炸了之后别的部分还在」,
 * 不是某一种积木怎么炸。
 */

import type { ExtensionDTO, ExtensionsResponse } from "@bilibili-notify/contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import ExtensionDetail from "../ExtensionDetail";

const { apiGetMock, crash } = vi.hoisted(() => ({
	apiGetMock: vi.fn(),
	crash: { blocks: false, settings: false },
}));

vi.mock("../../services/api", () => ({
	api: {
		get: apiGetMock as unknown as (url: string) => Promise<unknown>,
		patch: vi.fn(),
		post: vi.fn(),
		delete: vi.fn(),
	},
	ApiError: class extends Error {},
}));

vi.mock("../extensions/declarative/blocks", async (importOriginal) => ({
	...(await importOriginal<typeof import("../extensions/declarative/blocks")>()),
	PageBlocks: () => {
		if (crash.blocks) throw new TypeError("Cannot read properties of undefined (reading 'rows')");
		return <p>积木照常</p>;
	},
}));

vi.mock("../extensions/declarative/settings-form", async (importOriginal) => ({
	...(await importOriginal<typeof import("../extensions/declarative/settings-form")>()),
	SettingsForm: () => {
		if (crash.settings) throw new Error("设置表单炸了");
		return <p>设置表单照常</p>;
	},
}));

const DOUYIN: ExtensionDTO = {
	id: "douyin",
	name: "抖音订阅",
	description: "盯着抖音作者的新作品与开播。",
	version: "0.1.0",
	apiVersion: 2,
	provides: ["subscription"],
	settings: {
		fields: [{ key: "interval", type: "number", label: "检查间隔", min: 30, max: 600 }],
	},
	enabled: true,
	state: "running",
	dir: "/data/extensions/douyin",
};

function renderDetail() {
	apiGetMock.mockImplementation(async (url: string) => {
		if (url === "/api/ext") {
			return {
				extensions: [DOUYIN],
				restart: { can: true, how: "container" },
			} satisfies ExtensionsResponse;
		}
		// 视图只要「页上有东西」就会交给积木去画 —— 积木是桩,形状不重要。
		if (url === "/api/ext/douyin/status") return { page: [{ block: { type: "keyValue" } }] };
		if (url === "/api/ext/douyin/settings") return { revision: "r1", values: {} };
		if (url === "/api/ext/douyin/docs") return {};
		throw new Error(`没有这个口:${url}`);
	});
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<MemoryRouter initialEntries={["/extensions/douyin"]}>
				<Routes>
					<Route path="/extensions/:id" element={<ExtensionDetail />} />
				</Routes>
			</MemoryRouter>
		</QueryClientProvider>,
	);
}

/** 头卡:名字所在的那张玻璃卡。 */
async function headCard(): Promise<HTMLElement> {
	const titles = await screen.findAllByText("抖音订阅");
	const card = titles.map((el) => el.closest(".bn-glass")).find(Boolean);
	if (!card) throw new Error("找不到头卡");
	return card as HTMLElement;
}

beforeEach(() => {
	crash.blocks = false;
	crash.settings = false;
	apiGetMock.mockReset();
	// React 把接住的渲染错误往 console.error 打一大串 —— 这里是故意的,静音;断言照写。
	vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

describe("拓展交来的视图画的时候抛错", () => {
	it("头卡里的积木炸了:头卡的名字、开关、删除钮与面包屑都在,那一块说出了错、带原文", async () => {
		crash.blocks = true;
		renderDetail();
		const note = await screen.findByRole("alert");
		const head = await headCard();
		expect(head.contains(note)).toBe(true);
		expect(note.textContent).toMatch(/这个拓展交来的这一块没能画出来/);
		expect(note.textContent).toContain(
			"TypeError: Cannot read properties of undefined (reading 'rows')",
		);
		expect(within(head).getByRole("button", { name: "抖音订阅" })).toBeTruthy();
		expect(within(head).getByRole("button", { name: "删除拓展" })).toBeTruthy();
		expect(screen.getByRole("link", { name: "返回拓展列表" })).toBeTruthy();
		// 「配置」那一节不受牵连。
		expect(screen.getByText("设置表单照常")).toBeTruthy();
	});

	it("点那一块的「重试」重新画,好了就回来", async () => {
		crash.blocks = true;
		renderDetail();
		const note = await screen.findByRole("alert");
		crash.blocks = false;
		fireEvent.click(within(note).getByRole("button", { name: "重试" }));
		expect(await screen.findByText("积木照常")).toBeTruthy();
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("「配置」里照清单画的那块炸了:头卡与它里面的积木照常", async () => {
		crash.settings = true;
		renderDetail();
		const note = await screen.findByRole("alert");
		const head = await headCard();
		expect(head.contains(note)).toBe(false);
		expect(note.textContent).toContain("Error: 设置表单炸了");
		expect(await within(head).findByText("积木照常")).toBeTruthy();
		expect(within(head).getByRole("button", { name: "删除拓展" })).toBeTruthy();
	});
});
