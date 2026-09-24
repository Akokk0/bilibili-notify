/**
 * 单元测试 — `LiveTemplateRenderer.renderLiveSummary` 的越界守卫(P2-D)。
 *
 * 公共导出 renderLiveSummary 此前无条件索引 topSenders[0..4],直播弹幕发送者
 * 不足 5 人时(很常见)`undefined[0]` 直接抛 TypeError,整条直播总结推送失败。
 * 修复后缺位安全降级为空名 / 0 条。
 */

import { describe, expect, it } from "vite-plus/test";
import { applyTemplate, LiveTemplateRenderer, renderLiveText } from "../template-renderer";

/**
 * 回归守护 — P2:applyTemplate 单遍替换 + 裸键双语法。
 * vars 以裸键给出,模板里 `{name}`(主)与 legacy `-name`(兼容)都被替换。
 * 不变量:① 用户可控值含 token(`{link}`/`-link`)不被二次替换(token 注入);
 * ② 前缀 token(legacy `-follower`)不吞噬更长 token(`-follower_change`);
 * ③ `\n` 仍展开为真换行;④ koishi 旧存档的 `-key` 写法继续生效。
 */
describe("applyTemplate — 单遍替换 + 裸键双语法 (P2)", () => {
	it("用户值含 token 不被二次替换(token 注入防护)", () => {
		const out = applyTemplate("{name} 开播 {link}", {
			name: "黑客{link}注入",
			link: "https://live/1",
		});
		expect(out).toBe("黑客{link}注入 开播 https://live/1");
	});

	it("前缀 token 不吞噬更长 token(含 legacy `-` 写法)", () => {
		const out = applyTemplate("粉丝{follower} 变化{follower_change}", {
			follower: "100",
			follower_change: "+5",
		});
		expect(out).toBe("粉丝100 变化+5");
		const legacy = applyTemplate("粉丝-follower 变化-follower_change", {
			follower: "100",
			follower_change: "+5",
		});
		expect(legacy).toBe("粉丝100 变化+5");
	});

	it("`\\n` 展开为真换行;未知 token 原样保留", () => {
		expect(applyTemplate("{name}\\n{x}", { name: "A" })).toBe("A\n{x}");
	});

	it("legacy `-key` 与新 `{key}` 同模板混用都被替换(koishi 旧存档兼容)", () => {
		expect(applyTemplate("-name / {name}", { name: "绫" })).toBe("绫 / 绫");
	});
});

const TPL = "发言-dmc人 弹幕-dca条 | 1:-un1=-dc1 2:-un2=-dc2 3:-un3=-dc3 4:-un4=-dc4 5:-un5=-dc5";

describe("LiveTemplateRenderer.renderLiveSummary — topSenders <5 守卫", () => {
	const r = new LiveTemplateRenderer();

	it("topSenders 仅 2 人 → 不抛,缺位渲染为空名/0", () => {
		const out = r.renderLiveSummary({
			template: TPL,
			senderCount: 2,
			master: undefined,
			danmakuCount: 15,
			topSenders: [
				["alice", 10],
				["bob", 5],
			],
		});
		expect(out).toContain("1:alice=10");
		expect(out).toContain("2:bob=5");
		expect(out).toContain("3:=0");
		expect(out).toContain("5:=0");
		expect(out).toContain("发言2人 弹幕15条");
	});

	it("topSenders 为空 → 不抛,全部空名/0", () => {
		expect(() =>
			r.renderLiveSummary({
				template: TPL,
				senderCount: 0,
				master: undefined,
				danmakuCount: 0,
				topSenders: [],
			}),
		).not.toThrow();
	});

	it("topSenders 恰 5 人 → 全部正常填充(回归)", () => {
		const out = r.renderLiveSummary({
			template: TPL,
			senderCount: 5,
			master: undefined,
			danmakuCount: 99,
			topSenders: [
				["u1", 9],
				["u2", 8],
				["u3", 7],
				["u4", 6],
				["u5", 5],
			],
		});
		expect(out).toContain("1:u1=9");
		expect(out).toContain("5:u5=5");
	});
});

/**
 * 刻画 —— B 站那三句直播文案今天怎么出(抽出中立的渲染之前先钉住):模板按 per-UP → 全局 → 默认取,
 * 每一种只认自己那几个变量(开播不认 `{watched}`、正在直播不认 `{follower}`……),粉丝数变化带正负号。
 */
describe("LiveTemplateRenderer — B 站三句直播文案(刻画)", () => {
	const r = new LiveTemplateRenderer();
	const master = {
		username: "晨风",
		userface: "",
		roomId: 1,
		liveOpenFollowerNum: 0,
		liveEndFollowerNum: 0,
		liveFollowerChange: 0,
		medalName: "",
	};
	const sub = (custom: Record<string, string | undefined> = {}) =>
		({ customLiveMsg: { enable: true, ...custom } }) as unknown as Parameters<
			LiveTemplateRenderer["renderLiveStart"]
		>[0]["sub"];

	it("没有任何覆盖 → 默认模板", () => {
		expect(r.renderLiveStart({ sub: sub(), master, diffTime: "5秒", followerNum: "1.2万" })).toBe(
			"晨风 开播啦，当前粉丝数：1.2万",
		);
		expect(r.renderLiveOngoing({ sub: sub(), master, diffTime: "2小时", watched: "3.4万" })).toBe(
			"晨风 正在直播，已播 2小时，累计观看：3.4万",
		);
		expect(r.renderLiveEnd({ sub: sub(), master, diffTime: "3小时", followerChange: 12_345 })).toBe(
			"晨风 下播啦，本次直播了 3小时，粉丝变化 +1.2万",
		);
	});

	it("per-UP 覆盖优先于全局;每一种只认自己那几个变量", () => {
		const globalCustom = { enable: true, customLiveStart: "全局 {name}" };
		expect(
			r.renderLiveStart({
				sub: sub({ customLiveStart: "{name}|{time}|{follower}|{watched}|{follower_change}" }),
				globalCustom,
				master,
				diffTime: "5秒",
				followerNum: "100",
			}),
		).toBe("晨风|5秒|100|{watched}|{follower_change}");
		expect(
			r.renderLiveStart({ sub: sub(), globalCustom, master, diffTime: "5秒", followerNum: "1" }),
		).toBe("全局 晨风");
		expect(
			r.renderLiveOngoing({
				sub: sub({ customLive: "{name}|{time}|{watched}|{follower}" }),
				master,
				diffTime: "1分",
				watched: "暂未获取到",
			}),
		).toBe("晨风|1分|暂未获取到|{follower}");
		expect(
			r.renderLiveEnd({
				sub: sub({ customLiveEnd: "{name}|{time}|{follower_change}|{follower}" }),
				master,
				diffTime: "1分",
				followerChange: -35,
			}),
		).toBe("晨风|1分|-35|{follower}");
	});
});

/**
 * 三句直播文案的**中立渲染**(ADR-0019 决策 65 / 67):吃中立的值,B 站与拓展订阅的直播共用。数字排成
 * 「1.2万」、粉丝数变化带正负号,平台给的成品文字原样;没有的格子空着(决策 56:拓展没报过资料,粉丝那格
 * 就空着)。模板没给就是默认那句。
 */
describe("renderLiveText — 中立的三句直播文案", () => {
	it("数字排成卡片同款的写法;没给模板就用默认那句", () => {
		expect(
			renderLiveText("liveStart", undefined, { name: "甲", time: "5秒", follower: 12_345 }),
		).toBe("甲 开播啦，当前粉丝数：1.2万");
		expect(
			renderLiveText("liveOngoing", undefined, { name: "甲", time: "2小时", watched: 23_456 }),
		).toBe("甲 正在直播，已播 2小时，累计观看：2.3万");
		expect(
			renderLiveText("liveEnd", undefined, { name: "甲", time: "3小时", followerChange: 128 }),
		).toBe("甲 下播啦，本次直播了 3小时，粉丝变化 +128");
		expect(
			renderLiveText("liveEnd", undefined, { name: "甲", time: "3小时", followerChange: -12_000 }),
		).toBe("甲 下播啦，本次直播了 3小时，粉丝变化 -1.2万");
	});

	it("没有的格子空着,不写 undefined / 0", () => {
		expect(renderLiveText("liveStart", undefined, { name: "甲", time: "5秒" })).toBe(
			"甲 开播啦，当前粉丝数：",
		);
		expect(renderLiveText("liveOngoing", "{watched}|{time}", { name: "甲", time: "" })).toBe("|");
		expect(renderLiveText("liveEnd", "[{follower_change}]", { name: "甲", time: "1分" })).toBe(
			"[]",
		);
	});

	it("文字原样;每一种只认自己那几个变量", () => {
		expect(
			renderLiveText("liveStart", "{name}|{follower}|{watched}|{follower_change}", {
				name: "甲",
				time: "1分",
				follower: "12万",
				watched: 1,
				followerChange: 1,
			}),
		).toBe("甲|12万|{watched}|{follower_change}");
		expect(
			renderLiveText("liveOngoing", "{watched}|{follower}", {
				name: "甲",
				time: "1分",
				watched: "暂未获取到",
				follower: 1,
			}),
		).toBe("暂未获取到|{follower}");
		expect(
			renderLiveText("liveEnd", "{follower_change}|{follower}", {
				name: "甲",
				time: "1分",
				followerChange: "+5",
				follower: 1,
			}),
		).toBe("+5|{follower}");
	});
});
