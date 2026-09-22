// @vitest-environment jsdom

/**
 * 声明式列表的写(ADR-0019 决策 21 / 22 / 29 / 30):停用 / 启用、视图给的「改成 ×」、重新生成、
 * 删除 —— 每一下都是一发 `PATCH /api/globals`,把**整份**列表写回去。
 *
 * 值得钉的:
 * - 🔴 **整份写回、每条原样**:改哪一格就只动哪一格,项里 BN 不认识的键一个都不许丢。
 * - 🔴 **一发还在路上时整节的钮都点不动**:基线是渲染那一刻算的,第二发会把第一发按回去。
 * - 🔴 **「改设置」的按钮只改它那几格**,碰不到 BN 管的 `id`。
 * - 有旧钥匙时「重新生成」先问一句;空着的不问。删除先问一句,点名是哪一条、删了会怎样。
 * - 没写进去时,原因摆在按得到它的那一屏上(确认框里、页面上),不是「点了没反应」。
 */

import type { ExtensionView } from "@bilibili-notify/contract";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("../../../../services/api", async (importOriginal) => ({
	api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
	// 面板按 `instanceof ApiError` 认服务端的错 —— 用真的那个类,替身比它宽松的话测的就不是那条路。
	ApiError: (await importOriginal<typeof import("../../../../services/api")>()).ApiError,
}));

import { ApiError, api } from "../../../../services/api";
import { extensionStatusKey } from "../view-query";
import {
	BRIDGE,
	findCard,
	HOME,
	LINKS_FIELD,
	OFFICE,
	renderList,
	savedItems,
	TOKEN,
} from "./list-harness";

/** 一条带着 BN 不认识的键的项 —— 整份写回时它必须原样回去。 */
const HOME_WITH_EXTRA = { ...HOME, addedBy: "拓展自己放的" };

const MISMATCH: ExtensionView = {
	items: {
		links: {
			c1: {
				status: { tone: "warn", text: "连上了,但对不上" },
				buttons: [
					{ label: "改成 AstrBot", set: { bridgeKind: "astrbot", id: "hijacked", bogus: 1 } },
					{ label: "踢下线", action: "kick" },
				],
				lead: [
					{
						type: "notice",
						tone: "warn",
						text: "这条接入配的是 koishi,连进来的却自报 astrbot。",
						button: { label: "就用 AstrBot", set: { bridgeKind: "astrbot" } },
					},
				],
			},
		},
	},
};

beforeEach(() => {
	vi.mocked(api.get).mockReset();
	vi.mocked(api.patch).mockReset();
	vi.mocked(api.post).mockReset();
	vi.mocked(api.patch).mockResolvedValue({});
});
afterEach(() => {
	cleanup();
});

describe("停用 / 启用", () => {
	it("停用:只翻那一格,整份写回、每条原样", async () => {
		renderList({ items: [HOME_WITH_EXTRA, OFFICE] });
		await userEvent.click(await screen.findByRole("button", { name: "停用 家里那台" }));
		await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(1));
		expect(savedItems()).toEqual([{ ...HOME_WITH_EXTRA, enabled: false }, OFFICE]);
	});

	it("停用着的那条:钮叫「启用」,按下去翻回来", async () => {
		renderList({ items: [{ ...HOME, enabled: false }] });
		const enable = await screen.findByRole("button", { name: "启用 家里那台" });
		expect(enable.textContent).toBe("启用");
		await userEvent.click(enable);
		await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(1));
		expect(savedItems()).toEqual([{ ...HOME, enabled: true }]);
	});

	/** 🔴 拓展关着照样能改(决策 32)。 */
	it("拓展关着也写得进去", async () => {
		renderList({ ext: { ...BRIDGE, enabled: false, state: "disabled" }, items: [HOME] });
		await userEvent.click(await screen.findByRole("button", { name: "停用 家里那台" }));
		await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(1));
		expect(savedItems()).toEqual([{ ...HOME, enabled: false }]);
	});

	it("没声明 toggle 就没有这颗钮", async () => {
		const { toggle: _, ...untoggled } = LINKS_FIELD;
		renderList({ ext: { ...BRIDGE, settings: { fields: [untoggled] } }, items: [HOME] });
		await screen.findByRole("button", { name: "删除 家里那台" });
		expect(screen.queryByRole("button", { name: /停用|启用/ })).toBeNull();
	});

	/** 写成功之后重读名单与状态 —— 按完那一下就该看见结果,不用等 WS。 */
	it("写完重读名单与状态", async () => {
		renderList({ items: [HOME], view: MISMATCH });
		await screen.findByText("连上了,但对不上");
		const reads = (url: string) =>
			vi.mocked(api.get).mock.calls.filter(([called]) => called === url).length;
		const before = { globals: reads("/api/globals"), status: reads("/api/ext/bridge/status") };
		await userEvent.click(screen.getByRole("button", { name: "停用 家里那台" }));
		await waitFor(() => expect(reads("/api/globals")).toBeGreaterThan(before.globals));
		await waitFor(() => expect(reads("/api/ext/bridge/status")).toBeGreaterThan(before.status));
	});

	/**
	 * 名单那一口:宿主写完就经 WS 发了失效帧(在回 HTTP 之前),在飞的那一发一定是写之后的 ——
	 * 并过去,不取消重发。🔴 状态那一口**照旧取消重发**:宿主不替它发帧,在飞的那一发可能是写之前
	 * 发出去的,并过去就拿着写之前的样子。
	 */
	it("写完:名单已经在重读就并过去;状态照旧再读一次", async () => {
		const { qc } = renderList({ items: [HOME], view: MISMATCH });
		await screen.findByText("连上了,但对不上");
		const reads = (url: string) =>
			vi.mocked(api.get).mock.calls.filter(([called]) => called === url).length;
		const answer = vi.mocked(api.get).getMockImplementation();
		const pending: Array<() => void> = [];
		vi.mocked(api.get).mockImplementation(
			(url: string) =>
				new Promise((resolve, reject) => {
					pending.push(() => answer?.(url).then(resolve, reject));
				}),
		);
		vi.mocked(api.patch).mockImplementation(async () => {
			void qc.invalidateQueries({ queryKey: ["globals"] });
			void qc.invalidateQueries({ queryKey: extensionStatusKey("bridge") });
			return {};
		});
		const before = { globals: reads("/api/globals"), status: reads("/api/ext/bridge/status") };
		await userEvent.click(screen.getByRole("button", { name: "停用 家里那台" }));
		await waitFor(() => expect(reads("/api/globals")).toBe(before.globals + 1));
		await new Promise((settle) => setTimeout(settle, 30));
		expect(reads("/api/globals")).toBe(before.globals + 1);
		expect(reads("/api/ext/bridge/status")).toBe(before.status + 2);
		for (const release of pending) release();
	});
});

describe("视图给的按钮", () => {
	/**
	 * 🔴 「改设置」的按钮改的是**这一项**、**只改它那几格**(决策 22):`id` 是 BN 的(决策 29),
	 * 没声明的键也不归一颗按钮管。
	 */
	it("「改成 ×」:只改它那几格,碰不到 id 与没声明的键", async () => {
		renderList({ items: [HOME_WITH_EXTRA, OFFICE], view: MISMATCH });
		await userEvent.click(await screen.findByRole("button", { name: "改成 AstrBot" }));
		await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(1));
		expect(savedItems()).toEqual([{ ...HOME_WITH_EXTRA, bridgeKind: "astrbot" }, OFFICE]);
	});

	it("积木里的「改设置」按钮改的也是这一项", async () => {
		renderList({ items: [HOME, OFFICE], view: MISMATCH });
		await userEvent.click(await screen.findByRole("button", { name: "就用 AstrBot" }));
		await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(1));
		expect(savedItems()).toEqual([{ ...HOME, bridgeKind: "astrbot" }, OFFICE]);
	});

	it("排在 BN 自己的「停用 / 删除」前面", async () => {
		renderList({ items: [HOME], view: MISMATCH });
		await screen.findByRole("button", { name: "改成 AstrBot" });
		const card = await findCard("c1");
		const labels = within(card)
			.getAllByRole("button")
			.map((button) => button.getAttribute("aria-label") ?? button.textContent);
		const head = labels.slice(0, 4);
		expect(head).toEqual(["改成 AstrBot", "踢下线", "停用 家里那台", "删除 家里那台"]);
	});

	/** 调拓展的那种:POST 那个动作;没成就把服务端那句原话摆在这张卡上。 */
	it("调拓展:POST 那个动作,没成把原话摆在卡上", async () => {
		vi.mocked(api.post).mockRejectedValue(new Error("拓展没接这个动作"));
		renderList({ items: [HOME], view: MISMATCH });
		await userEvent.click(await screen.findByRole("button", { name: "踢下线" }));
		await waitFor(() => expect(api.post).toHaveBeenCalledWith("/api/ext/bridge/actions/kick"));
		const card = await findCard("c1");
		expect((await within(card).findByRole("alert")).textContent).toBe(
			"「踢下线」没成:拓展没接这个动作",
		);
		expect(api.patch).not.toHaveBeenCalled();
	});
});

describe("重新生成", () => {
	it("有旧值:先问一句,点名是哪一条,这一下一个字都不写", async () => {
		renderList({ items: [HOME, OFFICE] });
		await userEvent.click(
			await screen.findByRole("button", { name: "重新生成 家里那台 的 token" }),
		);
		const dialog = await screen.findByRole("dialog");
		expect(within(dialog).getByText("重新生成token?")).toBeTruthy();
		expect(dialog.textContent).toContain(
			"「家里那台」的旧 token 立刻作废 —— 正用着它的那一头会当场断开,得把新的复制过去重新填。",
		);
		expect(api.patch).not.toHaveBeenCalled();
	});

	it("取消:原样不动", async () => {
		renderList({ items: [HOME] });
		await userEvent.click(
			await screen.findByRole("button", { name: "重新生成 家里那台 的 token" }),
		);
		await userEvent.click(
			within(await screen.findByRole("dialog")).getByRole("button", { name: "取消" }),
		);
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(api.patch).not.toHaveBeenCalled();
	});

	it("确认才换:写回的是一把新的 32 位钥匙,只动那一格", async () => {
		renderList({ items: [HOME_WITH_EXTRA, OFFICE] });
		await userEvent.click(
			await screen.findByRole("button", { name: "重新生成 家里那台 的 token" }),
		);
		await userEvent.click(
			within(await screen.findByRole("dialog")).getByRole("button", { name: "重新生成" }),
		);
		await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(1));
		const [home, office] = savedItems();
		expect(home?.token).toMatch(/^[0-9a-f]{32}$/);
		expect(home?.token).not.toBe(TOKEN);
		expect(home).toEqual({ ...HOME_WITH_EXTRA, token: home?.token });
		expect(office).toEqual(OFFICE);
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
	});

	/** 空着的不问:没有旧钥匙可作废,它恰恰是最该顺手按下去的那一颗。 */
	it("空着:不问,当场就生成", async () => {
		renderList({ items: [{ ...HOME, token: "" }] });
		await userEvent.click(
			await screen.findByRole("button", { name: "重新生成 家里那台 的 token" }),
		);
		await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(1));
		expect(savedItems()[0]?.token).toMatch(/^[0-9a-f]{32}$/);
		expect(screen.queryByRole("dialog")).toBeNull();
	});
});

describe("删除", () => {
	/** 删了会怎样那句由清单的 `removeWarning` 交 —— 那是安全提示,通用说法说不出来(决策 29)。 */
	it("先问一句:点名是哪一条,说清删了会怎样", async () => {
		renderList({ items: [HOME, OFFICE] });
		await userEvent.click(await screen.findByRole("button", { name: "删除 家里那台" }));
		const dialog = await screen.findByRole("dialog");
		expect(within(dialog).getByText("删掉这条接入?")).toBeTruthy();
		expect(dialog.textContent).toContain(`「家里那台」删掉之后,${LINKS_FIELD.removeWarning}`);
		expect(api.patch).not.toHaveBeenCalled();
	});

	it("没声明 removeWarning:说「连同它的设置一起删掉」", async () => {
		const { removeWarning: _, ...plain } = LINKS_FIELD;
		renderList({ ext: { ...BRIDGE, settings: { fields: [plain] } }, items: [HOME] });
		await userEvent.click(await screen.findByRole("button", { name: "删除 家里那台" }));
		expect((await screen.findByRole("dialog")).textContent).toContain(
			"「家里那台」连同它的设置一起删掉。",
		);
	});

	it("确认才删:写回的名单少了那一条,别的原样", async () => {
		renderList({ items: [HOME, OFFICE] });
		await userEvent.click(await screen.findByRole("button", { name: "删除 家里那台" }));
		await userEvent.click(
			within(await screen.findByRole("dialog")).getByRole("button", { name: "删除" }),
		);
		await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(1));
		expect(savedItems()).toEqual([OFFICE]);
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
	});
});

describe("一发还在路上", () => {
	/**
	 * 🔴 名单整份写回,基线是**渲染那一刻**算出来的。前一发还没回来时点第二下,第二发带的名单
	 * 里第一下的改动还是旧值 —— 两发都成功,而第一下被静默抹掉。
	 */
	it("整节的钮都点不动 —— 后一发会把前一发按回去", async () => {
		vi.mocked(api.patch).mockReturnValue(new Promise(() => {}));
		renderList({ items: [HOME, OFFICE], view: MISMATCH });
		await screen.findByRole("button", { name: "改成 AstrBot" });
		await userEvent.click(screen.getByRole("button", { name: "停用 机房那台" }));
		await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(1));

		for (const name of [
			"新建接入",
			"停用 家里那台",
			"删除 家里那台",
			"删除 机房那台",
			"重新生成 家里那台 的 token",
			"改成 AstrBot",
			"就用 AstrBot",
			"踢下线",
		]) {
			expect((screen.getByRole("button", { name }) as HTMLButtonElement).disabled, name).toBe(true);
		}
		await userEvent.click(screen.getByRole("button", { name: "停用 家里那台" }));
		expect(api.patch).toHaveBeenCalledTimes(1);
	});

	it("确认框里按第二下不发第二发", async () => {
		vi.mocked(api.patch).mockReturnValue(new Promise(() => {}));
		renderList({ items: [HOME] });
		await userEvent.click(await screen.findByRole("button", { name: "删除 家里那台" }));
		const dialog = await screen.findByRole("dialog");
		await userEvent.click(within(dialog).getByRole("button", { name: "删除" }));
		const busy = await within(dialog).findByRole("button", { name: "删除中…" });
		await userEvent.click(busy);
		expect(api.patch).toHaveBeenCalledTimes(1);
	});
});

describe("写不进去的时候", () => {
	it("停用失败:把服务端那句话摆在页面上", async () => {
		vi.mocked(api.patch).mockRejectedValue(new Error("配置文件是只读的"));
		renderList({ items: [HOME] });
		await userEvent.click(await screen.findByRole("button", { name: "停用 家里那台" }));
		expect((await screen.findByRole("alert")).textContent).toBe("这次没写进去:配置文件是只读的");
	});

	it("删除失败:原因就摆在确认框里,框不关", async () => {
		vi.mocked(api.patch).mockRejectedValue(new Error("配置文件是只读的"));
		renderList({ items: [HOME] });
		await userEvent.click(await screen.findByRole("button", { name: "删除 家里那台" }));
		const dialog = await screen.findByRole("dialog");
		await userEvent.click(within(dialog).getByRole("button", { name: "删除" }));
		expect(await within(dialog).findByText("删不掉:配置文件是只读的")).toBeTruthy();
		expect(screen.getByText("这次没写进去:配置文件是只读的")).toBeTruthy();
	});

	it("重新生成失败:确认框里说「换不了」", async () => {
		vi.mocked(api.patch).mockRejectedValue(new Error("配置文件是只读的"));
		renderList({ items: [HOME] });
		await userEvent.click(
			await screen.findByRole("button", { name: "重新生成 家里那台 的 token" }),
		);
		const dialog = await screen.findByRole("dialog");
		await userEvent.click(within(dialog).getByRole("button", { name: "重新生成" }));
		expect(await within(dialog).findByText("换不了:配置文件是只读的")).toBeTruthy();
	});

	/**
	 * 照清单校验不过的 400 没有一句现成的 message —— 不拆开的话主人看到的是「PATCH /api/globals
	 * → 400」。拆开后落在列表里的点名是哪一条的哪一格,落在别处的照路径说。
	 */
	it("照清单校验不过:说清是哪一条的哪一格", async () => {
		vi.mocked(api.patch).mockRejectedValue(
			new ApiError(
				400,
				{
					error: "validation_failed",
					scope: "globals",
					issues: [
						{
							path: ["extensions", "bridge", "settings", "links", 1, "name"],
							message: "这一格必填",
						},
						{ path: ["extensions", "bridge", "settings", "cookie"], message: "这一格必填" },
					],
				},
				"PATCH /api/globals → 400",
			),
		);
		renderList({ items: [HOME, OFFICE] });
		await userEvent.click(await screen.findByRole("button", { name: "停用 家里那台" }));
		expect((await screen.findByRole("alert")).textContent).toBe(
			"这次没写进去:「机房那台」的 名字:这一格必填;cookie:这一格必填",
		);
	});

	/** 上一发的错说的是上一发:开一个新框时它就过时了,不许摆进新框里冒充这一下的。 */
	it("上一发的错不带进新开的确认框", async () => {
		vi.mocked(api.patch).mockRejectedValueOnce(new Error("配置文件是只读的"));
		renderList({ items: [HOME] });
		await userEvent.click(await screen.findByRole("button", { name: "停用 家里那台" }));
		await screen.findByText("这次没写进去:配置文件是只读的");
		await userEvent.click(screen.getByRole("button", { name: "删除 家里那台" }));
		const dialog = await screen.findByRole("dialog");
		expect(within(dialog).queryByText(/删不掉/)).toBeNull();
	});
});
