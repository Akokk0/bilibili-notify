// @vitest-environment jsdom

/**
 * 视图不合规矩时面板怎么画(ADR-0019 决策 40)—— **按主人看的单位降级**:页上坏一块只换掉那一块、
 * 列表坏一项那张卡写「状态未知」加同一条提示、摘要坏了就不画;好的照画。
 *
 * 「坏了」由宿主判、由宿主标(`{ fault }`,与拓展交的 `{ block }` / `{ view }` 并列),面板只照着画:
 * 那句原话(哪一块、为什么)是拓展作者与主人唯一能照着查的线索,不许吞成一句「出错了」。
 */

import type { ExtensionDTO, ExtensionPanelView } from "@bilibili-notify/contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("../../../../services/api", async (importOriginal) => ({
	api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
	ApiError: (await importOriginal<typeof import("../../../../services/api")>()).ApiError,
}));

import { api } from "../../../../services/api";
import { DeclarativeHead, ExtensionSummary } from "../extension-page";
import { answerPatch, cardOf, findCard, HOME, OFFICE, renderList } from "./list-harness";

const DOUYIN: ExtensionDTO = {
	id: "douyin",
	name: "抖音订阅",
	version: "0.1.0",
	apiVersion: 2,
	provides: ["subscription"],
	enabled: true,
	state: "running",
	dir: "/data/extensions/douyin",
};

/** 一张带图标格的表 —— 图按键从字典里取。 */
const PNG =
	"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

function renderWith(view: ExtensionPanelView, node: ReactNode) {
	vi.mocked(api.get).mockImplementation(async (url: string) => {
		if (url === "/api/ext/douyin/status") return view;
		throw new Error(`没有这个口:${url}`);
	});
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
}

beforeEach(() => {
	vi.mocked(api.get).mockReset();
	vi.mocked(api.patch).mockReset();
	vi.mocked(api.patch).mockImplementation(answerPatch);
});
afterEach(() => {
	cleanup();
});

describe("页上按块", () => {
	it("坏一块换成一条红提示(哪一块、为什么),前后的好块照画", async () => {
		renderWith(
			{
				page: [
					{ block: { type: "notice", tone: "info", text: "登录有效" } },
					{
						fault: { where: "页上第 2 块(表格)", reason: "rows.0.0: 这一格是 text,那一列是 icon" },
					},
					{
						block: {
							type: "table",
							columns: [{ kind: "icon" }, { kind: "text" }],
							rows: [
								[
									{ kind: "icon", image: "qq", fallback: "qq" },
									{ kind: "text", text: "小粉" },
								],
							],
						},
					},
				],
				images: { qq: PNG },
			},
			<DeclarativeHead ext={DOUYIN} />,
		);
		const alert = await screen.findByRole("alert");
		expect(alert.textContent).toBe(
			"页上第 2 块(表格)画不出来:rows.0.0: 这一格是 text,那一列是 icon",
		);
		expect(screen.getByText("登录有效")).toBeTruthy();
		expect(screen.getByText("小粉")).toBeTruthy();
		// 次序照拓展交的:提示夹在两块中间
		const follows = (a: Node, b: Node) =>
			Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
		expect(follows(screen.getByText("登录有效"), alert)).toBe(true);
		expect(follows(alert, screen.getByText("小粉"))).toBe(true);
		// 图按键从字典里取
		expect(document.querySelector("img")?.getAttribute("src")).toBe(PNG);
	});

	it("全是好块 —— 一条提示都没有", async () => {
		renderWith(
			{ page: [{ block: { type: "notice", tone: "info", text: "登录有效" } }] },
			<DeclarativeHead ext={DOUYIN} />,
		);
		await screen.findByText("登录有效");
		expect(screen.queryByRole("alert")).toBeNull();
	});
});

describe("摘要单独", () => {
	it("宿主判它坏了就不下发 —— 列表页那一行不说;有就照画", async () => {
		const { unmount } = renderWith(
			{ page: [{ block: { type: "notice", tone: "info", text: "登录有效" } }] },
			<ExtensionSummary ext={DOUYIN} standalone />,
		);
		await waitFor(() => expect(api.get).toHaveBeenCalledWith("/api/ext/douyin/status"));
		expect(document.body.textContent).toBe("");
		unmount();
		renderWith(
			{ summary: { tone: "ok", text: "12 位作者在看" } },
			<ExtensionSummary ext={DOUYIN} standalone />,
		);
		expect(await screen.findByText("12 位作者在看")).toBeTruthy();
	});
});

describe("列表按项", () => {
	/** 坏项那张卡写「状态未知」加同一条提示(决策 40);它交的药丸、副标题、积木一样都不画。 */
	it("坏一项:那张卡「状态未知」+ 一条红提示;别的卡照画", async () => {
		renderList({
			items: [HOME, OFFICE],
			view: {
				items: {
					links: {
						c1: { fault: { where: "这一项", reason: "status.tone: 只认 ok / warn / error / off" } },
						c2: { view: { status: { tone: "ok", text: "已连接" }, pill: "astrbot" } },
					},
				},
			},
		});
		const home = await findCard("c1");
		const alert = await within(home).findByRole("alert");
		expect(alert.textContent).toBe("这一项画不出来:status.tone: 只认 ok / warn / error / off");
		expect(home.querySelector("[data-list-status]")?.textContent).toBe("状态未知");
		const office = cardOf("c2");
		expect(office.querySelector("[data-list-status]")?.textContent).toBe("已连接");
		expect(within(office).queryByRole("alert")).toBeNull();
		// 坏项那张卡上 BN 自己的东西照常:字段行、停用、删除都在
		expect(home.querySelector('[data-field-row="token"]')).toBeTruthy();
		expect(within(home).getByRole("button", { name: "删除 家里那台" })).toBeTruthy();
	});

	/** 停用是主人自己拨的,比「状态未知」更具体(决策 26);提示照样摆着 —— 它说的是拓展交的东西。 */
	it("停用的坏项:仍盖「已停用」,提示照摆", async () => {
		renderList({
			items: [{ ...HOME, enabled: false }],
			view: {
				items: { links: { c1: { fault: { where: "这一项", reason: "lead.0: 不认识「chart」" } } } },
			},
		});
		const home = await findCard("c1");
		expect((await within(home).findByRole("alert")).textContent).toContain("不认识「chart」");
		expect(home.querySelector("[data-list-status]")?.textContent).toBe("已停用");
	});
});
