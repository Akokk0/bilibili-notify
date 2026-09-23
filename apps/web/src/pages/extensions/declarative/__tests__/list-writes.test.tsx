// @vitest-environment jsdom

/**
 * 声明式列表的写(ADR-0019 决策 21 / 22 / 29 / 30 / 35):停用 / 启用、视图给的「改成 ×」、重新生成、
 * 删除 —— 每一下都是一发 `PATCH /api/ext/:id/settings`,带版本号,**只说这一下改了什么**。
 *
 * 值得钉的:
 * - 🔴 **一步一项**:改哪一项就 `update` 哪一项、只带改的那几格;删是 `remove`。不整份写回 ——
 *   两发交错会丢一发,别的项上 BN 不认识的键也会被抹掉。
 * - 🔴 **一发还在路上时整节的钮都点不动**,写成之后下一发带的是**回应里的**版本号 —— 否则第二下
 *   拿着旧版本号撞 409。
 * - 🔴 **「改设置」的按钮只改它那几格**,碰不到 BN 管的 `id`。
 * - 版本号对不上(409):重读一遍、说清「设置在你打开之后被改过了」,不把别人刚写的盖掉。
 * - 照清单 / 拓展校验不过(400):按 id 点名是哪一条的哪一格。
 * - 有旧钥匙时「重新生成」先问一句;空着的不问。删除先问一句,点名是哪一条、删了会怎样。
 */

import type { ExtensionPanelView } from "@bilibili-notify/contract";
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
	answerPatch,
	BRIDGE,
	changeBehindTheBack,
	findCard,
	HOME,
	LINKS_FIELD,
	OFFICE,
	renderList,
	sentOps,
	sentWrite,
	servedRevision,
	servedSettings,
	settingsReads,
	shown,
	TOKEN,
	updatedValues,
} from "./list-harness";

/** 一条带着 BN 不认识的键的项 —— 只动一格的写不许碰到它。 */
const HOME_WITH_EXTRA = { ...HOME, addedBy: "拓展自己放的" };

const MISMATCH: ExtensionPanelView = shown({
	items: {
		links: {
			c1: {
				status: { tone: "warn", text: "连上了,但对不上" },
				buttons: [
					{
						kind: "set",
						label: "改成 AstrBot",
						set: { bridgeKind: "astrbot", id: "hijacked", bogus: 1 },
					},
					{ kind: "action", label: "踢下线", action: "kick" },
				],
				lead: [
					{
						type: "notice",
						tone: "warn",
						text: "这条接入配的是 koishi,连进来的却自报 astrbot。",
						button: { kind: "set", label: "就用 AstrBot", set: { bridgeKind: "astrbot" } },
					},
				],
			},
		},
	},
});

/** 服务端照清单 / 拓展校验不过时那份 400(`issues` 从设置那一层数,列表项按 id)。 */
function invalid(issues: unknown[]): ApiError {
	return new ApiError(
		400,
		{ error: "validation_failed", message: "不合规矩", issues },
		"PATCH /api/ext/bridge/settings → 400",
	);
}

beforeEach(() => {
	vi.mocked(api.get).mockReset();
	vi.mocked(api.patch).mockReset();
	vi.mocked(api.post).mockReset();
	vi.mocked(api.patch).mockImplementation(answerPatch);
});
afterEach(() => {
	cleanup();
});

describe("停用 / 启用", () => {
	it("停用:一步 update,只带那一格,带着读到的版本号", async () => {
		renderList({ items: [HOME_WITH_EXTRA, OFFICE] });
		const revision = servedRevision();
		await userEvent.click(await screen.findByRole("button", { name: "停用 家里那台" }));
		await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(1));
		expect(sentWrite()).toEqual({
			revision,
			ops: [{ op: "update", list: "links", id: "c1", values: { enabled: false } }],
		});
		// 别的键(拓展自己放的)与别的项都还在 —— 那是服务端按这一步套上去的结果
		expect(servedSettings().links).toEqual([{ ...HOME_WITH_EXTRA, enabled: false }, OFFICE]);
	});

	it("停用着的那条:钮叫「启用」,按下去翻回来", async () => {
		renderList({ items: [{ ...HOME, enabled: false }] });
		const enable = await screen.findByRole("button", { name: "启用 家里那台" });
		expect(enable.textContent).toBe("启用");
		await userEvent.click(enable);
		await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(1));
		expect(sentOps()).toEqual([
			{ op: "update", list: "links", id: "c1", values: { enabled: true } },
		]);
	});

	/** 🔴 拓展关着照样能改(决策 32)。 */
	it("拓展关着也写得进去", async () => {
		renderList({ ext: { ...BRIDGE, enabled: false, state: "disabled" }, items: [HOME] });
		await userEvent.click(await screen.findByRole("button", { name: "停用 家里那台" }));
		await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(1));
		expect(sentOps()).toEqual([
			{ op: "update", list: "links", id: "c1", values: { enabled: false } },
		]);
	});

	it("没声明 toggle 就没有这颗钮", async () => {
		const { toggle: _, ...untoggled } = LINKS_FIELD;
		renderList({ ext: { ...BRIDGE, settings: { fields: [untoggled] } }, items: [HOME] });
		await screen.findByRole("button", { name: "删除 家里那台" });
		expect(screen.queryByRole("button", { name: /停用|启用/ })).toBeNull();
	});

	/**
	 * 按完那一下就该看见结果,不用等 WS:设置换成 PATCH 回来的那份(与 GET 同形,不必再读一遍),
	 * 状态重读一次。
	 */
	it("写完:设置换成回应里那份、不再重读;状态重读", async () => {
		renderList({ items: [HOME], view: MISMATCH });
		await screen.findByText("连上了,但对不上");
		const reads = (url: string) =>
			vi.mocked(api.get).mock.calls.filter(([called]) => called === url).length;
		const before = { settings: settingsReads(), status: reads("/api/ext/bridge/status") };
		await userEvent.click(screen.getByRole("button", { name: "停用 家里那台" }));
		await screen.findByRole("button", { name: "启用 家里那台" });
		await waitFor(() => expect(reads("/api/ext/bridge/status")).toBeGreaterThan(before.status));
		expect(settingsReads()).toBe(before.settings);
	});

	/**
	 * 设置那一口:WS 那一帧已经发起的重读取消掉、换成回应,不再多读一遍。🔴 状态那一口**照旧
	 * 取消重发**:在飞的那一发可能是写之前发出去的,并过去就拿着写之前的样子。
	 */
	it("写完:设置在飞的重读取消掉、不再多读;状态照旧再读一次", async () => {
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
		vi.mocked(api.patch).mockImplementation(async (url: string, body?: unknown) => {
			void qc.invalidateQueries({ queryKey: ["ext-settings", "bridge"] });
			void qc.invalidateQueries({ queryKey: extensionStatusKey("bridge") });
			return answerPatch(url, body);
		});
		const before = { settings: settingsReads(), status: reads("/api/ext/bridge/status") };
		await userEvent.click(screen.getByRole("button", { name: "停用 家里那台" }));
		await waitFor(() => expect(settingsReads()).toBe(before.settings + 1));
		await new Promise((settle) => setTimeout(settle, 30));
		expect(settingsReads()).toBe(before.settings + 1);
		expect(reads("/api/ext/bridge/status")).toBe(before.status + 2);
		for (const release of pending) release();
	});
});

describe("视图给的按钮", () => {
	/**
	 * 🔴 「改设置」的按钮改的是**这一项**、**只改它那几格**(决策 22):`id` 是 BN 的(决策 29),
	 * 没声明的键也不归一颗按钮管。
	 */
	it("「改成 ×」:update 这一项,只带它那几格,碰不到 id 与没声明的键", async () => {
		renderList({ items: [HOME_WITH_EXTRA, OFFICE], view: MISMATCH });
		await userEvent.click(await screen.findByRole("button", { name: "改成 AstrBot" }));
		await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(1));
		expect(sentOps()).toEqual([
			{ op: "update", list: "links", id: "c1", values: { bridgeKind: "astrbot" } },
		]);
	});

	it("积木里的「改设置」按钮改的也是这一项", async () => {
		renderList({ items: [HOME, OFFICE], view: MISMATCH });
		await userEvent.click(await screen.findByRole("button", { name: "就用 AstrBot" }));
		await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(1));
		expect(sentOps()).toEqual([
			{ op: "update", list: "links", id: "c1", values: { bridgeKind: "astrbot" } },
		]);
	});

	it("排在 BN 自己的「编辑 / 停用 / 删除」前面", async () => {
		renderList({ items: [HOME], view: MISMATCH });
		await screen.findByRole("button", { name: "改成 AstrBot" });
		const card = await findCard("c1");
		const labels = within(card)
			.getAllByRole("button")
			.map((button) => button.getAttribute("aria-label") ?? button.textContent);
		expect(labels.slice(0, 5)).toEqual([
			"改成 AstrBot",
			"踢下线",
			"编辑 家里那台",
			"停用 家里那台",
			"删除 家里那台",
		]);
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

	it("确认才换:update 那一格,是一把新的 32 位钥匙", async () => {
		renderList({ items: [HOME_WITH_EXTRA, OFFICE] });
		await userEvent.click(
			await screen.findByRole("button", { name: "重新生成 家里那台 的 token" }),
		);
		await userEvent.click(
			within(await screen.findByRole("dialog")).getByRole("button", { name: "重新生成" }),
		);
		await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(1));
		const [op] = sentOps();
		expect(op).toEqual({
			op: "update",
			list: "links",
			id: "c1",
			values: { token: expect.stringMatching(/^[0-9a-f]{32}$/) },
		});
		expect(updatedValues().token).not.toBe(TOKEN);
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
	});

	/** 空着的不问:没有旧钥匙可作废,它恰恰是最该顺手按下去的那一颗。 */
	it("空着:不问,当场就生成", async () => {
		renderList({ items: [{ ...HOME, token: "" }] });
		await userEvent.click(
			await screen.findByRole("button", { name: "重新生成 家里那台 的 token" }),
		);
		await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(1));
		expect(sentOps()).toEqual([
			{
				op: "update",
				list: "links",
				id: "c1",
				values: { token: expect.stringMatching(/^[0-9a-f]{32}$/) },
			},
		]);
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

	it("确认才删:一步 remove 那一条,卡跟着没了", async () => {
		renderList({ items: [HOME, OFFICE] });
		await userEvent.click(await screen.findByRole("button", { name: "删除 家里那台" }));
		await userEvent.click(
			within(await screen.findByRole("dialog")).getByRole("button", { name: "删除" }),
		);
		await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(1));
		expect(sentOps()).toEqual([{ op: "remove", list: "links", id: "c1" }]);
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(screen.queryByText("家里那台")).toBeNull();
		expect(screen.getByText("机房那台")).toBeTruthy();
	});
});

describe("一发还在路上", () => {
	/**
	 * 🔴 前一发还没回来时点第二下,第二发带的还是写之前的版本号 —— 服务端回 409,第二下白按。
	 * 整节的钮串行:写回期间一律点不动。
	 */
	it("整节的钮都点不动", async () => {
		vi.mocked(api.patch).mockReturnValue(new Promise(() => {}));
		renderList({ items: [HOME, OFFICE], view: MISMATCH });
		await screen.findByRole("button", { name: "改成 AstrBot" });
		await userEvent.click(screen.getByRole("button", { name: "停用 机房那台" }));
		await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(1));

		for (const name of [
			"新建接入",
			"编辑 家里那台",
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

/** 从这一刻起,设置那一口的重读一律挂着 —— 写完之后看得见的,只能是 PATCH 的回应。 */
function holdSettingsReads() {
	const answer = vi.mocked(api.get).getMockImplementation();
	if (!answer) throw new Error("GET 还没摆好");
	vi.mocked(api.get).mockImplementation((url: string) =>
		url === "/api/ext/bridge/settings" ? new Promise(() => {}) : answer(url),
	);
}

/** 这一发 PATCH 先攥住,`finish()` 才照假服务端回答。 */
function holdNextPatch() {
	let finish = () => {};
	vi.mocked(api.patch).mockImplementationOnce(
		(url: string, body?: unknown) =>
			new Promise((resolve, reject) => {
				finish = () => answerPatch(url, body).then(resolve, reject);
			}),
	);
	return () => finish();
}

describe("写完之后", () => {
	/**
	 * 🔴 钮一松开,下一发的版本号就得是写后的那个:回应在这一发结束之前收进缓存,不等重读 ——
	 * 重读可能还在路上(WS 帧与 HTTP 回应走两条连接,谁先到没保证)。否则第二下带着写之前的
	 * 版本号撞 409,第一下之后的每一下都白按。
	 */
	it("停用一条、写完立刻停用另一条:第二发带的是回应里的版本号,两条都停用", async () => {
		renderList({ items: [HOME, OFFICE] });
		await screen.findByRole("button", { name: "停用 家里那台" });
		const first = servedRevision();
		holdSettingsReads();
		const finish = holdNextPatch();
		const office = screen.getByRole("button", { name: "停用 机房那台" }) as HTMLButtonElement;
		await userEvent.click(screen.getByRole("button", { name: "停用 家里那台" }));
		await waitFor(() => expect(office.disabled).toBe(true));
		finish();
		await waitFor(() => expect(office.disabled).toBe(false));
		const afterFirst = servedRevision();
		await userEvent.click(office);
		await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(2));
		expect(sentWrite(0).revision).toBe(first);
		expect(sentWrite(1).revision).toBe(afterFirst);
		await waitFor(() =>
			expect(servedSettings().links).toEqual([
				{ ...HOME, enabled: false },
				{ ...OFFICE, enabled: false },
			]),
		);
	});

	it("新建之后立刻停用另一条:刚建的那条还在", async () => {
		renderList({ items: [HOME] });
		await userEvent.click(await screen.findByRole("button", { name: "新建接入" }));
		holdSettingsReads();
		const dialog = await screen.findByRole("dialog");
		await userEvent.type(within(dialog).getByRole("textbox", { name: "名字" }), "公司那台");
		await userEvent.click(within(dialog).getByRole("button", { name: "创建" }));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		const home = screen.getByRole("button", { name: "停用 家里那台" }) as HTMLButtonElement;
		await waitFor(() => expect(home.disabled).toBe(false));
		await userEvent.click(home);
		await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(2));
		expect(sentWrite(1).revision).not.toBe(sentWrite(0).revision);
		await waitFor(() => expect(servedSettings().links).toHaveLength(2));
		const [first, created] = servedSettings().links as Record<string, unknown>[];
		expect(first).toEqual({ ...HOME, enabled: false });
		expect(created?.name).toBe("公司那台");
		expect(screen.getByText("公司那台")).toBeTruthy();
	});

	/**
	 * 写之前就发出去的那一发重读(窗口聚焦、上一帧 WS)晚到:收回应之前得先把它取消掉,
	 * 否则它一落地,缓存又回到写之前的样子。
	 */
	it("更早发出的设置重读晚到,盖不回写之前的样子", async () => {
		const { qc } = renderList({ items: [HOME] });
		await screen.findByRole("button", { name: "停用 家里那台" });
		const answer = vi.mocked(api.get).getMockImplementation();
		if (!answer) throw new Error("GET 还没摆好");
		const stale = await answer("/api/ext/bridge/settings");
		let release = () => {};
		vi.mocked(api.get).mockImplementation((url: string) =>
			url === "/api/ext/bridge/settings"
				? new Promise((resolve) => {
						release = () => resolve(stale);
					})
				: answer(url),
		);
		void qc.invalidateQueries({ queryKey: ["ext-settings", "bridge"] });
		await userEvent.click(screen.getByRole("button", { name: "停用 家里那台" }));
		await screen.findByRole("button", { name: "启用 家里那台" });
		release();
		await new Promise((settle) => setTimeout(settle, 30));
		expect(screen.getByRole("button", { name: "启用 家里那台" })).toBeTruthy();
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
	 * 校验不过的 400:`issues` 的路径从设置那一层数、列表项**按 id** 点名 —— 落在这一格列表上的
	 * 说成「哪一条的哪一格」,落在别处的照路径说。拆不开就只剩「→ 400」这种线格式噪音。
	 */
	it("校验不过:按 id 说清是哪一条的哪一格", async () => {
		vi.mocked(api.patch).mockRejectedValue(
			invalid([
				{ op: 0, path: ["links", "c2", "name"], message: "这一格必填" },
				{ path: ["cookie"], message: "这一格必填" },
			]),
		);
		renderList({ items: [HOME, OFFICE] });
		await userEvent.click(await screen.findByRole("button", { name: "停用 家里那台" }));
		expect((await screen.findByRole("alert")).textContent).toBe(
			"这次没写进去:「机房那台」的 名字:这一格必填;cookie:这一格必填",
		);
	});

	/**
	 * 🔴 版本号对不上(别的标签页刚写过一笔):重读一遍、说清为什么没写进去 —— 不拿着旧版本号
	 * 硬写(那会把别人刚写的盖掉),也不装作「点了没反应」。重读之后再按一下就写得进去。
	 */
	it("409:重读一遍,说「设置在你打开之后被改过了」;再按一下带新的版本号", async () => {
		renderList({ items: [HOME, OFFICE] });
		await screen.findByRole("button", { name: "停用 家里那台" });
		changeBehindTheBack((settings) => {
			(settings.links as { name: string }[])[1].name = "机房那台(改过)";
		});
		const reads = settingsReads();
		await userEvent.click(screen.getByRole("button", { name: "停用 家里那台" }));
		expect((await screen.findByRole("alert")).textContent).toBe(
			"这次没写进去:设置在你打开之后被改过了 —— 已经重新读了一遍,看一眼现在的样子再改",
		);
		await waitFor(() => expect(settingsReads()).toBe(reads + 1));
		expect(await screen.findByText("机房那台(改过)")).toBeTruthy();
		expect(servedSettings().links).toEqual([HOME, { ...OFFICE, name: "机房那台(改过)" }]);

		await userEvent.click(screen.getByRole("button", { name: "停用 家里那台" }));
		await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(2));
		expect(sentWrite(1).revision).not.toBe(sentWrite(0).revision);
		await waitFor(() =>
			expect((servedSettings().links as { enabled: boolean }[])[0]?.enabled).toBe(false),
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
