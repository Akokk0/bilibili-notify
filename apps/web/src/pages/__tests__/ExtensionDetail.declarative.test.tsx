// @vitest-environment jsdom

/**
 * v2 拓展的详情页照声明画(ADR-0019 决策 19 / 25 / 32):头卡正文是视图的页级积木,「配置」
 * 页签里是照清单画的设置表单。v1 没有面板:头卡里一句通用的话,不摆「配置」。
 *
 * 值得钉的:
 * - **按契约档位分岔**,不按 id —— 桥的手写页退役之后,叫 bridge 的 v1 也只有那句通用的话。
 * - 🔴 **拓展关着设置照样能改**(决策 32):「装好 → 填 → 启用」这个顺序靠它才走得通。
 * - 关着与没跑起来**分开说**:前者是主人自己刚拨的开关,后者要去查日志。
 */

import type {
	ExtensionDTO,
	ExtensionsResponse,
	ExtensionView,
	RestartAbility,
} from "@bilibili-notify/contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { api } from "../../services/api";
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
		if (url === "/api/ext") return { extensions: [ext], restart } satisfies ExtensionsResponse;
		// 设置走拓展自己的口(ADR-0019 决策 35)—— `/api/globals` 里已经没有这一格了。
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

/**
 * 盘上换了代码、这个进程干净地换不上(ADR-0012 决策 47)。头卡里摆那块「两条出路」—— 跑着旧的
 * 那一档与开着却没跑那一档都要;**没有新代码时一颗也不给**(生产上不给随手漏模块的口子)。
 */
describe("新版等着换上", () => {
	const STAGED: ExtensionDTO = { ...DOUYIN, staged: { version: "0.2.0" } };

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
		renderDetail({ ext: STAGED, restart: { can: false, reason: "unsupervised" } });
		const head = await headCard();
		expect(within(head).queryByRole("button", { name: "重启 BN" })).toBeNull();
		expect(within(head).getByText(/自己在终端里停掉再起一次/)).toBeTruthy();
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

describe("v1 拓展:没有面板", () => {
	/**
	 * 🔴 叫 bridge 的也一样 —— 手写的桥页退役了(决策 19),这一页不再认得任何具体拓展。
	 * 按 id 留一条岔路的话,它会悄悄接着画一块已经不存在的面板。
	 */
	it.each(["legacy", "bridge"])(
		"%s:头卡里是那句通用的话,不摆「配置」,不问状态,删除确认里没有桥的那句",
		async (id) => {
			const legacy: ExtensionDTO = {
				id,
				name: "老拓展",
				description: "还停在 v1",
				version: "1.0.0",
				apiVersion: 1,
				provides: ["push"],
				enabled: true,
				state: "running",
				dir: `/data/extensions/${id}`,
			};
			renderDetail({ ext: legacy, settings: { links: [] } });
			const head = await headCard("老拓展");
			expect(within(head).getByText("v1.0.0 · 这个拓展没有交上来自己的面板。")).toBeTruthy();
			// 版本号印在正文那句里,底下那句就不再重复
			expect(within(head).getByText(/^卸掉它/)).toBeTruthy();
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
