/**
 * 桥交给面板的视图(ADR-0019 决策 20 / 26–31)—— 今天面板里为桥手写的那些派生(四种样子、
 * 「对不上」、bot 表、没连上的提示),迁过去以后由桥自己算好交出去。
 *
 * 这里钉的是**算出来的是什么**;画成什么样归 BN 的通用渲染器(那边有它自己的测试)。
 */

import { describe, expect, it } from "vite-plus/test";
import type { BridgeBot } from "../contract.js";
import { platformIcon } from "../platform-icons.js";
import type { BridgeSession } from "../server.js";
import type { BridgeLink } from "../settings.js";
import { bridgeView } from "../view.js";

const PNG =
	"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

function link(over: Partial<BridgeLink> = {}): BridgeLink {
	return {
		id: "a1",
		name: "客厅那台 koishi",
		bridgeKind: "koishi",
		token: "0123456789abcdef0123456789abcdef",
		enabled: true,
		...over,
	};
}

function bot(over: Partial<BridgeBot> = {}): BridgeBot {
	return {
		botId: "b1",
		platform: "onebot",
		name: "小粉",
		selfId: "2854196310",
		capabilities: {
			atAll: "supported",
			inbound: "supported",
			forward: "unknown",
			miniAppCard: "supported",
			shareCardLinks: "unsupported",
			markdown: "unsupported",
		},
		...over,
	};
}

function session(over: Partial<BridgeSession> = {}): BridgeSession {
	return {
		linkId: "a1",
		kind: "koishi",
		name: "客厅那台 koishi",
		version: "0.1.0",
		bots: [bot()],
		connectedAt: 1_790_061_520_000,
		origin: "http://192.168.1.20:8787",
		remoteAddress: "192.168.1.5",
		...over,
	};
}

const item = (links: BridgeLink[], sessions: Record<string, BridgeSession>, id = "a1") =>
	bridgeView(links, (linkId) => sessions[linkId]).items?.links?.[id];

describe("bridgeView", () => {
	it("连上了:已连接、种类当药丸、副标题是「名字 v版本 · N 分钟前连上 · 来自 地址」", () => {
		const view = item([link()], { a1: session() });
		expect(view?.status).toEqual({ tone: "ok", text: "已连接" });
		expect(view?.pill).toBe("koishi");
		expect(view?.subtitle).toEqual([
			"客厅那台 koishi v0.1.0",
			" · ",
			{ time: 1_790_061_520_000, suffix: "连上" },
			" · ",
			"来自 192.168.1.5",
		]);
		expect(view?.lead ?? []).toEqual([]);
		expect(view?.buttons ?? []).toEqual([]);
	});

	it("连上了:bot 表 —— 图标先用插件报的,没有查桥自己的小表,都没有退回两个字", () => {
		const table = item([link()], {
			a1: session({
				bots: [
					bot({ botId: "1", platform: "telegram", icon: PNG }),
					bot({ botId: "2", platform: "onebot" }),
					bot({ botId: "3", platform: "kook", name: undefined, selfId: undefined }),
				],
			}),
		})?.blocks?.[0];
		if (table?.type !== "table") throw new Error("应该是一张表");
		expect(table.title).toBe("它驮着的 bot");
		expect(table.count).toBe(true);
		expect(table.columns.map((c) => ("label" in c ? c.label : c.kind))).toEqual([
			"icon",
			"text",
			"@全体",
			"收私聊指令",
			"合并转发",
			"小程序卡",
			"分享卡链接",
			"markdown",
		]);
		expect(table.rows.map((row) => row[0])).toEqual([
			{ image: PNG, fallback: "te" },
			{ image: platformIcon("onebot"), fallback: "on" },
			{ fallback: "ko" },
		]);
		// 没有名字就用 botId;第二行是「平台 · 账号」。
		expect(table.rows[2]?.[1]).toEqual({ text: "3", sub: "kook" });
		expect(table.rows[1]?.slice(2)).toEqual(["yes", "yes", "unknown", "yes", "no", "no"]);
	});

	it("平台叫 constructor / __proto__:方块退回两个字,不把原型链上的东西塞进 icon 格", () => {
		const table = item([link()], {
			a1: session({
				bots: [
					bot({ botId: "1", platform: "constructor" }),
					bot({ botId: "2", platform: "__proto__" }),
				],
			}),
		})?.blocks?.[0];
		if (table?.type !== "table") throw new Error("应该是一张表");
		expect(table.rows.map((row) => row[0])).toEqual([{ fallback: "co" }, { fallback: "__" }]);
	});

	it("连上了、一个 bot 都没有:表还在,空的那句话说清为什么", () => {
		const table = item([link()], { a1: session({ bots: [] }) })?.blocks?.[0];
		if (table?.type !== "table") throw new Error("应该是一张表");
		expect(table.rows).toEqual([]);
		expect(table.empty).toContain("一个 bot 都没有");
	});

	/** 配置里是 koishi,连进来的却自报 astrbot —— token 多半填到另一头的插件里去了。 */
	it("对不上:警告语气、药丸写配置那一种、提示在 token 行上面、带一颗「改成 AstrBot」", () => {
		const view = item([link()], { a1: session({ kind: "astrbot", name: "AstrBot" }) });
		expect(view?.status).toEqual({ tone: "warn", text: "连上了,但对不上" });
		expect(view?.pill).toBe("配置:koishi");
		expect(view?.buttons).toEqual([{ label: "改成 AstrBot", set: { bridgeKind: "astrbot" } }]);
		expect(view?.lead).toHaveLength(1);
		expect(JSON.stringify(view?.lead)).toContain("这条接入配的是 koishi,连进来的却自报 astrbot。");
		expect(JSON.stringify(view?.lead)).toContain("收发照常能用");
	});

	it("没连上:灰、副标题说没有桥连着、底下挂「插件那头要填两样」—— 地址是 BN 在浏览器里现算的", () => {
		const view = item([link()], {});
		expect(view?.status).toEqual({ tone: "off", text: "没连上" });
		expect(view?.subtitle).toBe("现在没有桥用这个 token 连着。");
		const hint = view?.blocks?.[0];
		expect(hint).toMatchObject({ type: "notice", tone: "info" });
		expect(JSON.stringify(hint)).toContain('{"host":"extensionUrl"}');
		expect(JSON.stringify(hint)).toContain("401");
	});

	/**
	 * 停用的接入握手收到的是 503(桥会退避重连),**不是** 401 —— 今天那一页给它挂的是没连上那段
	 * 排错说明,是错的(ADR-0019 决策 24 的五处之一)。状态由 BN 盖成「已停用」,这里只管说对话。
	 */
	it("停用:不挂 401 那段排错说明,副标题讲 503 与退避重连", () => {
		const view = item([link({ enabled: false })], {});
		expect(JSON.stringify(view)).not.toContain("401");
		expect(view?.blocks ?? []).toEqual([]);
		expect(view?.subtitle).toContain("503");
	});

	/**
	 * 停用、而且 token 是空的(脱敏备份恢复回来就是这样):空 token 永远不匹配,桥连过来收到的
	 * 是 **401** 不是 503 —— 插件按协议把 401 当成配置错、不再重连,光启用回不来。这时还说
	 * 「503、退避重连、启用就回来」就是在骗人。
	 */
	it("停用且没有 token:不讲 503 与启用就回来,讲 401、得先生成 token 填过去", () => {
		const view = item([link({ enabled: false, token: "" })], {});
		const said = JSON.stringify(view?.subtitle);
		expect(said).not.toContain("503");
		expect(said).not.toContain("退避重连");
		expect(said).not.toContain("启用就回来");
		expect(said).toContain("401");
		expect(said).toContain("生成");
	});

	it("列表页那一行:连着的会话一共驮着几个 bot", () => {
		const view = bridgeView(
			[link(), link({ id: "a2" }), link({ id: "a3" })],
			(id) =>
				({
					a1: session({ bots: [bot(), bot({ botId: "2" })] }),
					a2: session({ linkId: "a2", bots: [bot()] }),
				})[id],
		);
		expect(view.summary).toEqual({ tone: "ok", text: [{ b: "3" }, " 个 bot 在线"] });
	});

	/**
	 * 🔴 对端报什么这里就画什么,而视图 schema 一格超限,宿主就把**整份视图**换成一条错误提示
	 * —— 一个对端报一个超长名字,所有接入的状态、bot 表、列表页那句「N 个 bot 在线」一起没了。
	 * 下面的数照抄 `packages/internal/src/schema/extension-view.ts`(桥够不到那份 schema):
	 * 表格字 / 第二行 ≤ 200、一张表 ≤ 200 行、一段字里的每片 ≤ 2000。
	 */
	describe("对端报来的东西超限:截在桥这一侧,别让一格拖垮整份视图", () => {
		const long = (n: number, ch = "长") => ch.repeat(n);

		it("超长的 bot 名、平台、账号:表格那一格截到 200,末尾一个省略号", () => {
			const table = item([link()], {
				a1: session({
					bots: [bot({ name: long(500), platform: long(150, "p"), selfId: long(150, "9") })],
				}),
			})?.blocks?.[0];
			if (table?.type !== "table") throw new Error("应该是一张表");
			const cell = table.rows[0]?.[1] as { text: string; sub: string };
			expect(cell.text).toHaveLength(200);
			expect(cell.text.endsWith("…")).toBe(true);
			expect(cell.text.startsWith(long(199))).toBe(true);
			expect(cell.sub.length).toBeLessThanOrEqual(200);
			expect(cell.sub.endsWith("…")).toBe(true);
		});

		it("截的时候不把一个 emoji 劈成半个", () => {
			const table = item([link()], {
				a1: session({ bots: [bot({ name: "😀".repeat(300) })] }),
			})?.blocks?.[0];
			if (table?.type !== "table") throw new Error("应该是一张表");
			const cell = table.rows[0]?.[1] as { text: string };
			expect(cell.text.length).toBeLessThanOrEqual(200);
			expect(cell.text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
			expect(cell.text.endsWith("…")).toBe(true);
		});

		it("超长的会话名、版本、来源地址:副标题每一片都截到 2000", () => {
			const view = item([link()], {
				a1: session({ name: long(3000), version: long(3000, "1"), remoteAddress: long(3000, "a") }),
			});
			const runs = view?.subtitle;
			if (!Array.isArray(runs)) throw new Error("副标题应该是一串片段");
			const strings = runs.filter((run): run is string => typeof run === "string");
			for (const run of strings) expect(run.length).toBeLessThanOrEqual(2000);
			expect(strings.filter((run) => run.endsWith("…"))).toHaveLength(2);
		});

		it("201 个 bot:表里画 200 行,表下面说一句还有 1 个没列;列表页那句照旧按全数", () => {
			const bots = Array.from({ length: 201 }, (_, i) => bot({ botId: `b${i}`, name: `bot ${i}` }));
			const view = bridgeView([link()], () => session({ bots }));
			const blocks = view.items?.links?.a1?.blocks ?? [];
			const table = blocks[0];
			if (table?.type !== "table") throw new Error("应该是一张表");
			expect(table.rows).toHaveLength(200);
			expect(table.rows[199]?.[1]).toMatchObject({ text: "bot 199" });
			const rest = blocks[1];
			expect(rest).toMatchObject({ type: "notice", tone: "info" });
			expect(JSON.stringify(rest)).toContain("还有 1 个");
			expect(view.summary).toEqual({ tone: "ok", text: [{ b: "201" }, " 个 bot 在线"] });
		});

		it("正好 200 个:不多说那一句", () => {
			const bots = Array.from({ length: 200 }, (_, i) => bot({ botId: `b${i}` }));
			const blocks = item([link()], { a1: session({ bots }) })?.blocks ?? [];
			expect(blocks).toHaveLength(1);
		});
	});

	it("页级:BN 地址一行(值由 BN 在浏览器里现算)", () => {
		const page = bridgeView([], () => undefined).page;
		expect(page).toEqual([
			{
				type: "copy",
				label: "BN 地址",
				value: { host: "extensionUrl" },
				note: expect.arrayContaining([{ b: "桥那台机器" }, { mono: "127.0.0.1" }]),
			},
		]);
	});
});
