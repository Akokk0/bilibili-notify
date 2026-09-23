// @vitest-environment jsdom

/**
 * 声明式列表的卡(ADR-0019 决策 21 / 26 / 29 / 32):每一项一张卡,卡上的每一块归三处之一 ——
 * **清单**声明的(标题、方块、字段行、停用 / 启用)、**视图**交来的(状态、药丸、副标题、按钮、
 * 积木)、**BN** 自己画的(删除、图例、「已停用 / 拓展关着 / 状态未知」这三句盖章)。
 *
 * 值得钉的:
 * - 🔴 **拓展关着也能增删改**(决策 32):卡照常画、钮照常在,只是没有状态。今天桥「关着就压暗成
 *   一行一条、不给按钮」那一档随之退役。
 * - 🔴 **停用的项由 BN 盖成「已停用」**,拓展报什么都不算(决策 26)。
 * - 🔴 **密钥全文不上屏**:只露头尾各四位,连 DOM 里都没有全文。
 * - 图例只在**真有三态格**时挂、只挂一次(决策 27)。
 */

import type { ExtensionView } from "@bilibili-notify/contract";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("../../../../services/api", () => ({
	api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
	ApiError: class extends Error {},
}));

import { api } from "../../../../services/api";
import {
	BRIDGE,
	cardOf,
	findCard,
	HOME,
	KOISHI_PNG,
	LINKS_FIELD,
	OFFICE,
	renderDetailPage,
	renderList,
	TOKEN,
} from "./list-harness";

beforeEach(() => {
	vi.mocked(api.get).mockReset();
	vi.mocked(api.patch).mockReset();
	vi.mocked(api.post).mockReset();
	vi.mocked(api.patch).mockResolvedValue({});
});
afterEach(() => {
	cleanup();
});

describe("一项一张卡", () => {
	it("按存着的顺序,标题是清单指的那一格", async () => {
		renderList({ items: [OFFICE, HOME] });
		await screen.findByText("家里那台");
		const cards = [...document.querySelectorAll("[data-list-card]")];
		expect(cards.map((card) => card.getAttribute("data-list-card"))).toEqual(["c2", "c1"]);
		expect(within(cardOf("c2")).getByText("机房那台")).toBeTruthy();
	});

	/** 方块印的是**选中那个选项**的图 —— 当 `<img>` 画(决策 31),读屏器念「koishi 接入」。 */
	it("方块:选中那个选项的图", async () => {
		renderList({ items: [HOME] });
		const mark = await screen.findByRole("img", { name: "koishi 接入" });
		expect(mark.querySelector("img")?.getAttribute("src")).toBe(KOISHI_PNG);
	});

	/**
	 * 选项没图(或者图不是图片 data URL —— 面板比服务端旧的那几秒可能碰上)就退回两个字母,
	 * 不去对家点名。
	 */
	it("方块:选项没图 → 两个字母", async () => {
		const plain = {
			...LINKS_FIELD,
			fields: LINKS_FIELD.fields.map((field) =>
				field.type === "enum"
					? {
							...field,
							options: [
								{ value: "koishi", label: "koishi", icon: "https://evil.example/k.png" },
								{ value: "astrbot", label: "AstrBot" },
							],
						}
					: field,
			),
		};
		renderList({ ext: { ...BRIDGE, settings: { fields: [plain] } }, items: [OFFICE, HOME] });
		const astrbot = await screen.findByRole("img", { name: "astrbot 接入" });
		expect(astrbot.querySelector("img")).toBeNull();
		expect(astrbot.textContent).toBe("as");
		const koishi = screen.getByRole("img", { name: "koishi 接入" });
		expect(koishi.querySelector("img")).toBeNull();
		expect(koishi.textContent).toBe("ko");
	});

	it("没声明 mark 就没有方块", async () => {
		const { mark: _, ...unmarked } = LINKS_FIELD;
		renderList({ ext: { ...BRIDGE, settings: { fields: [unmarked] } }, items: [HOME] });
		await screen.findByText("家里那台");
		expect(within(cardOf("c1")).queryByRole("img")).toBeNull();
	});
});

/** 视图里 c1 那一项:四样都交了 —— 状态、药丸、副标题、上下两段积木。 */
function viewOf(item: NonNullable<ExtensionView["items"]>[string][string]): ExtensionView {
	return { items: { links: { c1: item } } };
}

const CONNECTED = viewOf({
	status: { tone: "ok", text: "已连接" },
	pill: "koishi",
	subtitle: ["客厅那台 koishi v0.1.0 · ", { time: Date.now() - 12 * 60_000, suffix: "连上" }],
	lead: [{ type: "notice", tone: "warn", text: "这条接入配的是 koishi,连进来的却自报 astrbot。" }],
	blocks: [
		{
			type: "table",
			title: "它驮着的 bot",
			count: true,
			columns: [
				{ kind: "icon" },
				{ kind: "text", width: 210 },
				{ kind: "tristate", label: "@全体" },
			],
			rows: [[{ fallback: "qq" }, { text: "小粉", sub: "onebot · 2854196310" }, "yes"]],
		},
	],
});

/** 卡右上那句状态(点 + 字)。 */
function statusOf(id: string): string | null {
	return cardOf(id).querySelector("[data-list-status]")?.textContent ?? null;
}

/** 卡角那抹光用的是哪个颜色。 */
function accentOf(id: string): string {
	const glow = cardOf(id).querySelector(".pointer-events-none") as HTMLElement | null;
	return glow?.getAttribute("style") ?? "";
}

describe("卡上的状态", () => {
	it("状态、药丸、副标题都是视图交来的", async () => {
		renderList({ items: [HOME], view: CONNECTED });
		expect(await within(await findCard("c1")).findByText("已连接")).toBeTruthy();
		expect(statusOf("c1")).toBe("已连接");
		expect(within(cardOf("c1")).getByText("koishi", { selector: "span:not([role])" })).toBeTruthy();
		// 时刻在浏览器里画 —— 服务端算好的「12 分钟前」发过来就冻住了
		expect(within(cardOf("c1")).getByText(/12 分钟前连上/)).toBeTruthy();
	});

	it("卡角的颜色跟状态的语气走", async () => {
		renderList({
			items: [
				HOME,
				OFFICE,
				{ ...HOME, id: "c3", name: "三号" },
				{ ...HOME, id: "c4", name: "四号" },
			],
			view: {
				items: {
					links: {
						c1: { status: { tone: "ok", text: "已连接" } },
						c2: { status: { tone: "warn", text: "连上了,但对不上" } },
						c3: { status: { tone: "error", text: "登录失效" } },
					},
				},
			},
		});
		await within(await findCard("c1")).findByText("已连接");
		expect(accentOf("c1")).toContain("--color-bn-success");
		expect(accentOf("c2")).toContain("--color-bn-warning");
		expect(accentOf("c3")).toContain("--color-bn-danger");
		// 视图里没有这一项:不盖章,角光退回中性灰
		expect(statusOf("c4")).toBeNull();
		expect(accentOf("c4")).toContain("--color-bn-inactive");
	});

	/** 🔴 停用的项由 BN 盖成「已停用」(决策 26)—— 拓展报的「已连接」不算数。 */
	it("停用的项盖成「已停用」,视图报什么都不算", async () => {
		renderList({ items: [{ ...HOME, enabled: false }], view: CONNECTED });
		await findCard("c1");
		await waitFor(() => expect(statusOf("c1")).toBe("已停用"));
		// 等状态那一口真的回来了再看 —— 不然「已连接」只是还没到
		expect(await within(await findCard("c1")).findByText(/12 分钟前连上/)).toBeTruthy();
		expect(within(cardOf("c1")).queryByText("已连接")).toBeNull();
		expect(accentOf("c1")).toContain("--color-bn-inactive");
	});

	/**
	 * 拓展关着:没有视图可问(问了也是 404),卡上只剩 BN 自己画的部分,统一写「拓展关着」(决策 32)。
	 * 停用的项照样是「已停用」—— 那是主人自己拨的,比「拓展关着」更具体。
	 */
	it("拓展关着:统一写「拓展关着」,不去问状态", async () => {
		renderList({
			ext: { ...BRIDGE, enabled: false, state: "disabled" },
			items: [HOME, { ...OFFICE, enabled: false }],
			view: CONNECTED,
		});
		await screen.findByText("家里那台");
		expect(statusOf("c1")).toBe("拓展关着");
		expect(statusOf("c2")).toBe("已停用");
		expect(api.get).not.toHaveBeenCalledWith("/api/ext/bridge/status");
		expect(within(cardOf("c1")).queryByText("koishi", { selector: "span:not([role])" })).toBeNull();
	});

	/** 开着却没跑起来:面板不替拓展猜,写「状态未知」(决策 24 的五处之一)。 */
	it("开着却没跑起来:「状态未知」", async () => {
		renderList({ ext: { ...BRIDGE, state: "failed" }, items: [HOME], view: CONNECTED });
		await screen.findByText("家里那台");
		expect(statusOf("c1")).toBe("状态未知");
		expect(api.get).not.toHaveBeenCalledWith("/api/ext/bridge/status");
	});

	/** 状态那一口出错(不是 404):同样「状态未知」,视图里的东西一样都不画 —— 旧的那份不作数。 */
	it("状态那一口出错:「状态未知」,视图的东西不画", async () => {
		renderList({ items: [HOME], view: new Error("连接中断") });
		await findCard("c1");
		await waitFor(() => expect(statusOf("c1")).toBe("状态未知"));
		expect(within(cardOf("c1")).queryByText(/连上/)).toBeNull();
	});

	/**
	 * 先读到过、再读出错:react-query 还攥着出错之前那一份 —— 不作数,视图交的东西一样都不画。
	 * 与头卡、拓展列表上那一行同一把尺子(`liveViewOf`);404 也一样,只是不盖「状态未知」。
	 */
	it.each([
		["出错", Object.assign(new Error("连接中断"), { status: 500 }), "状态未知"],
		["404", Object.assign(new Error("not found"), { status: 404 }), null],
	])("先读到过视图、再读%s:旧的那份一样都不画", async (_what, failure, status) => {
		const { qc } = renderList({ items: [HOME], view: CONNECTED });
		const card = await findCard("c1");
		await within(card).findByText(/12 分钟前连上/);

		const answer = vi.mocked(api.get).getMockImplementation();
		vi.mocked(api.get).mockImplementation(async (url: string) => {
			if (url === "/api/ext/bridge/status") throw failure;
			return answer?.(url);
		});
		await qc.invalidateQueries({ queryKey: ["extension-status", "bridge"] });
		await waitFor(() => expect(statusOf("c1")).toBe(status));
		expect(within(card).queryByText(/12 分钟前连上/)).toBeNull();
		expect(within(card).queryByText(/连进来的却自报 astrbot/)).toBeNull();
		expect(within(card).queryByText("它驮着的 bot")).toBeNull();
	});

	/** 跑着但没交过视图(404):那不是出错,卡上就没有状态这一句 —— 不许说「状态未知」吓人。 */
	it("跑着但没交过视图(404):不盖章", async () => {
		renderList({ items: [HOME] });
		await waitFor(() => expect(api.get).toHaveBeenCalledWith("/api/ext/bridge/status"));
		await screen.findByText("家里那台");
		expect(statusOf("c1")).toBeNull();
	});
});

describe("卡的正文", () => {
	/**
	 * `lead` 在字段行**上面**、`blocks` 在下面(决策 26)—— 桥今天就是「对不上」的提示在 token
	 * 行上、bot 表在下。
	 */
	it("顺序:lead → 字段行 → blocks", async () => {
		renderList({ items: [HOME], view: CONNECTED });
		const card = await findCard("c1");
		const lead = await within(card).findByText(/连进来的却自报 astrbot/);
		const row = card.querySelector('[data-field-row="token"]');
		const table = within(card).getByText("它驮着的 bot");
		expect(row).toBeTruthy();
		const follows = (a: Node, b: Node) =>
			Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
		expect(follows(lead, row as Node)).toBe(true);
		expect(follows(row as Node, table)).toBe(true);
	});

	/**
	 * 字段行底下的表另起一段,中间一道发丝线 —— 今天桥卡上 token 行与「它驮着的 bot」之间就是
	 * 这一道(决策 33:迁移前后逐块比,多一处少一处都算)。提示条不要这一道。
	 */
	it("blocks 里的表上面一道发丝线,提示条与 lead 不要", async () => {
		renderList({ items: [HOME], view: CONNECTED });
		const card = await findCard("c1");
		const table = await within(card).findByText("它驮着的 bot");
		const rules = card.querySelectorAll("[data-table-rule]");
		expect(rules).toHaveLength(1);
		const row = card.querySelector('[data-field-row="token"]') as Node;
		const rule = rules[0] as Node;
		expect(row.compareDocumentPosition(rule) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		expect(rule.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		cleanup();
		renderList({ items: [HOME], view: viewOf({ lead: CONNECTED.items?.links?.c1?.blocks }) });
		const leadOnly = await findCard("c1");
		await within(leadOnly).findByText("它驮着的 bot");
		expect(leadOnly.querySelector("[data-table-rule]")).toBeNull();
	});
});

/** 装一个非安全上下文:没有 `navigator.clipboard`,只有老式 `execCommand`。 */
function pretendInsecureContext(): ReturnType<typeof vi.fn> {
	vi.stubGlobal("navigator", {
		...navigator,
		clipboard: undefined,
		userAgent: navigator.userAgent,
	});
	const execCommand = vi.fn().mockReturnValue(true);
	Object.defineProperty(document, "execCommand", {
		value: execCommand,
		configurable: true,
		writable: true,
	});
	return execCommand;
}

describe("字段行", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		Reflect.deleteProperty(document, "execCommand");
	});

	/** 🔴 掩码留头尾各四位 —— 两条接入才分得出谁是谁,而全文哪儿都没有(属性里也没有)。 */
	it("密钥只露头尾,全文不进 DOM", async () => {
		renderList({ items: [HOME, OFFICE] });
		const row = (await findCard("c1")).querySelector('[data-field-row="token"]') as HTMLElement;
		expect(row.textContent).toContain(`0123${"•".repeat(24)}cdef`);
		expect(within(row).getByText("token")).toBeTruthy();
		expect(document.body.innerHTML).not.toContain(TOKEN);
		expect(document.body.innerHTML).not.toContain(OFFICE.token);
	});

	/** 「重新生成」跟在它讲的那一格后面,不散在卡头那一排。 */
	it("「复制」与「重新生成」都在这一行上,读屏器念得出是哪条的哪一格", async () => {
		renderList({ items: [HOME] });
		const row = (await findCard("c1")).querySelector('[data-field-row="token"]') as HTMLElement;
		expect(within(row).getByRole("button", { name: "复制 家里那台 的 token" })).toBeTruthy();
		const regenerate = within(row).getByRole("button", { name: "重新生成 家里那台 的 token" });
		expect(regenerate.textContent).toBe("重新生成");
		expect(regenerate.querySelector("svg")).toBeTruthy();
	});

	it("复制的是全文,按完变「已复制」", async () => {
		const writeText = vi.fn().mockResolvedValue(undefined);
		vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
		renderList({ items: [HOME] });
		await findCard("c1");
		fireEvent.click(screen.getByRole("button", { name: "复制 家里那台 的 token" }));
		await waitFor(() => expect(writeText).toHaveBeenCalledWith(TOKEN));
		expect(await screen.findByText("已复制")).toBeTruthy();
	});

	/**
	 * 🔴 BN 常经 `http://<内网 IP>:8787` 打开,那里 `navigator.clipboard` 根本不存在 —— 裸写法
	 * 按下去静默无事,而拓展页恰恰最常从内网 IP 打开。
	 */
	it("非安全上下文里复制也真的复制到", async () => {
		const execCommand = pretendInsecureContext();
		renderList({ items: [HOME] });
		await findCard("c1");
		fireEvent.click(screen.getByRole("button", { name: "复制 家里那台 的 token" }));
		await waitFor(() => expect(execCommand).toHaveBeenCalledWith("copy"));
	});

	/**
	 * 🔴 脱敏备份恢复回来的项必然是空的生成值(那条路把它抹掉了)。一句「生成一个」却不给那颗
	 * 钮,等于请人做一件他在这一页上做不到的事。
	 */
	it("生成的那一格空着:红字说清怎么回事,钮就在旁边", async () => {
		renderList({ items: [{ ...HOME, token: "" }] });
		const row = (await findCard("c1")).querySelector('[data-field-row="token"]') as HTMLElement;
		expect(row.textContent).toContain(
			"这条接入还没有 token —— 脱敏备份恢复回来的就是这样,生成一个新的。",
		);
		expect(within(row).getByRole("button", { name: "重新生成 家里那台 的 token" })).toBeTruthy();
		expect(within(row).queryByRole("button", { name: /复制/ })).toBeNull();
	});

	it("标题、方块、停用那几格不再重复画一行", async () => {
		renderList({ items: [HOME] });
		const card = await findCard("c1");
		const rows = [...card.querySelectorAll("[data-field-row]")];
		expect(rows.map((row) => row.getAttribute("data-field-row"))).toEqual(["token"]);
	});

	/** 别的格只读地摆一行:名字 + 值。枚举念选项名,数字带单位,等宽的用等宽字。 */
	it("别的格:名字 + 值,只读", async () => {
		const withExtras = {
			...LINKS_FIELD,
			fields: [
				...LINKS_FIELD.fields,
				{ key: "host", type: "string" as const, label: "主机", monospace: true },
				{ key: "retry", type: "number" as const, label: "重试", unit: "次", default: 3 },
				{
					key: "mode",
					type: "enum" as const,
					label: "模式",
					options: [
						{ value: "fast", label: "快" },
						{ value: "safe", label: "稳" },
					],
				},
				{ key: "loud", type: "boolean" as const, label: "大声" },
				{ key: "memo", type: "string" as const, label: "备注" },
			],
		};
		renderList({
			ext: { ...BRIDGE, settings: { fields: [withExtras] } },
			items: [{ ...HOME, host: "10.0.0.2", mode: "safe", loud: true }],
		});
		const card = await findCard("c1");
		const row = (key: string) => card.querySelector(`[data-field-row="${key}"]`) as HTMLElement;
		expect(row("host").textContent).toBe("主机10.0.0.2");
		expect(within(row("host")).getByText("10.0.0.2").className).toContain("font-mono");
		expect(row("retry").textContent).toBe("重试3 次");
		expect(row("mode").textContent).toBe("模式稳");
		expect(row("loud").textContent).toBe("大声是");
		expect(row("memo").textContent).toBe("备注—");
		expect(within(row("mode")).getByText("稳").className).not.toContain("font-mono");
		expect(within(card).queryByRole("textbox")).toBeNull();
	});
});

describe("图例", () => {
	/**
	 * 页上一出现三态格,BN 就在**列表头**挂一次图例(决策 27)—— 卡里的表不再各挂一份。
	 * 它不是装饰:三个记号里两个是空心圈,不说明就只能猜。
	 */
	it("卡里有三态列的表 → 标题行挂一次,卡里不挂", async () => {
		renderList({ items: [HOME, OFFICE], view: CONNECTED });
		await within(await findCard("c1")).findByText("它驮着的 bot");
		const legends = screen.getAllByRole("list", { name: "图例" });
		expect(legends).toHaveLength(1);
		expect(legends[0]?.closest("[data-list-card]")).toBeNull();
	});

	it("三态表挂在 lead 里也算", async () => {
		const tableFirst = viewOf({ lead: CONNECTED.items?.links?.c1?.blocks });
		renderList({ items: [HOME], view: tableFirst });
		await within(await findCard("c1")).findByText("它驮着的 bot");
		expect(screen.getAllByRole("list", { name: "图例" })).toHaveLength(1);
	});

	it("没有三态格就不挂", async () => {
		renderList({
			items: [HOME],
			view: viewOf({
				status: { tone: "ok", text: "已连接" },
				blocks: [{ type: "table", columns: [{ kind: "mono" }], rows: [["abc"]] }],
			}),
		});
		await within(await findCard("c1")).findByText("已连接");
		expect(screen.queryByRole("list", { name: "图例" })).toBeNull();
	});
});

describe("标题行", () => {
	it("小标题是整格的名字,旁边一颗「新建{一项叫什么}」", async () => {
		renderList({ items: [HOME] });
		await screen.findByText("家里那台");
		expect(screen.getByText("桥接入")).toBeTruthy();
		const add = screen.getByRole("button", { name: "新建接入" });
		expect(add.querySelector("svg")).toBeTruthy();
		// 标题行是卡外的兄弟节点,不在任何一张卡里
		expect(add.closest("[data-list-card]")).toBeNull();
	});

	/** 🔴 拓展关着也能新建(决策 32):「装好 → 填 → 启用」。今天桥关着时这颗钮是藏起来的。 */
	it("拓展关着也在", async () => {
		renderList({ ext: { ...BRIDGE, enabled: false, state: "disabled" }, items: [HOME] });
		expect(await screen.findByRole("button", { name: "新建接入" })).toBeTruthy();
	});
});

describe("一条都没有", () => {
	/** 空态讲的是**接下来干什么** —— 那句由清单的 `description` 交,开工的钮就地给。 */
	it("说「还没有」、接着清单那句说明、就地一颗开工的钮", async () => {
		renderList({ items: [] });
		const lead = await screen.findByText("还没有桥接入。");
		const box = lead.closest("[data-list-empty]") as HTMLElement;
		expect(box).toBeTruthy();
		expect(box.textContent).toContain(LINKS_FIELD.description);
		expect(within(box).getByRole("button", { name: "新建第一条接入" })).toBeTruthy();
		// 空着就没有标题行 —— 那一屏自己带着开工的钮
		expect(screen.queryByText("桥接入")).toBeNull();
		expect(screen.queryByRole("button", { name: "新建接入" })).toBeNull();
	});

	/** 🔴 关着的时候照样请人建(决策 32)—— 建好了,打开拓展就用得上。 */
	it("拓展关着也请人建", async () => {
		renderList({ ext: { ...BRIDGE, enabled: false, state: "disabled" }, items: [] });
		expect(await screen.findByRole("button", { name: "新建第一条接入" })).toBeTruthy();
	});
});

describe("名单读不到", () => {
	/**
	 * 🔴 **「读不到」不许画成「没有」**:空态那一屏请人建一条,而原来那几条其实都在 —— 主人照着
	 * 建完才发现它们又回来了(或者这一发根本存不进去)。
	 */
	it("说读不到与那句原因,不画空态、不请人新建", async () => {
		renderList({ items: null });
		expect((await screen.findByRole("alert")).textContent).toBe("读不到桥接入:配置读不出来:500");
		expect(screen.queryByText("还没有桥接入。")).toBeNull();
		expect(screen.queryByRole("button", { name: /新建/ })).toBeNull();
	});

	it("还在读的时候什么都不画 —— 不闪一下空态", async () => {
		renderList({ items: "pending" });
		await waitFor(() => expect(api.get).toHaveBeenCalledWith("/api/globals"));
		expect(screen.queryByText("还没有桥接入。")).toBeNull();
		expect(screen.queryByRole("button", { name: /新建/ })).toBeNull();
		expect(document.querySelector("[data-list-card]")).toBeNull();
	});
});

describe("「配置」页签", () => {
	/** 设置里只有一格列表的拓展(迁过去的桥就是)也得有「配置」—— 不然那份名单无处可管。 */
	it("只有一格列表也有,里面是那一节", async () => {
		renderDetailPage({ items: [HOME] });
		expect(await screen.findByText("家里那台")).toBeTruthy();
		expect(screen.getByText("桥接入")).toBeTruthy();
	});
});
