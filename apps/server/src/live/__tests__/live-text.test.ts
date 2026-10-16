/**
 * 单元测试 — 三句直播文案的中立渲染:`applyTemplate` 的单遍替换与 `renderLiveText`。
 * (从 `bilibili/live/__tests__/template-renderer.test.ts` 跟着源文件搬来。)
 */

import { describe, expect, it } from "vite-plus/test";
import {
	applyTemplate,
	renderLiveSummary,
	renderLiveText,
	renderSpecialDanmaku,
	renderSpecialUserEnter,
} from "../live-text";

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
			renderLiveText("liveStreaming", undefined, { name: "甲", time: "2小时", watched: 23_456 }),
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
		expect(renderLiveText("liveEnd", "[{follower_change}]", { name: "甲", time: "1分" })).toBe(
			"[]",
		);
	});

	/**
	 * ㉒d:「正在直播」文案的 `{watched}` 缺数(一帧观看人数都没收到过、拓展没报累计观看)时,**由文字渲染器在出口印
	 * 「暂未获取到」**。从前是直播数据里被写进这句占位、B 站这头原样带来,缺了到这里只印空串。别的两句没有这个变量;
	 * 有数就走 `formatCount`,0 是真数(印「0」,不是占位)。
	 * 验红:把 `renderLiveText` 里缺数时的兜底去掉(印空串),前两条红;让 0 也当缺数,第三条红。
	 */
	it("{watched} 缺数:出口印「暂未获取到」(默认那句与自定义模板都一样)", () => {
		expect(renderLiveText("liveStreaming", undefined, { name: "甲", time: "2小时" })).toBe(
			"甲 正在直播，已播 2小时，累计观看：暂未获取到",
		);
		expect(renderLiveText("liveStreaming", "{watched}|{time}", { name: "甲", time: "" })).toBe(
			"暂未获取到|",
		);
	});

	it("{watched} 有数走 formatCount;0 是真数,印「0」", () => {
		expect(renderLiveText("liveStreaming", "{watched}", { name: "甲", time: "", watched: 0 })).toBe(
			"0",
		);
		expect(
			renderLiveText("liveStreaming", "{watched}", { name: "甲", time: "", watched: 87_334 }),
		).toBe("8.7万");
	});

	it("别的两句没有 {watched} 这个变量:缺数不印占位,有 {watched} 的模板原样留着", () => {
		expect(renderLiveText("liveStart", "{watched}", { name: "甲", time: "" })).toBe("{watched}");
		expect(renderLiveText("liveEnd", "{watched}", { name: "甲", time: "" })).toBe("{watched}");
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
			renderLiveText("liveStreaming", "{watched}|{follower}", {
				name: "甲",
				time: "1分",
				watched: 12_345,
				follower: 1,
			}),
		).toBe("1.2万|{follower}");
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

describe("renderSpecialDanmaku / renderSpecialUserEnter — 占位符 mastername / uname / msg", () => {
	it("特别弹幕:三个占位符,-key 与 {key} 两种写法", () => {
		expect(
			renderSpecialDanmaku({
				template: "-mastername|{uname}|-msg|{msg}",
				viewerName: "小明",
				creatorName: "主播A",
				text: "你好",
			}),
		).toBe("主播A|小明|你好|你好");
	});

	it("特别进场:mastername / uname;msg 不是它的变量,原样留着", () => {
		expect(
			renderSpecialUserEnter({
				template: "{uname} 进了 -mastername {msg}",
				viewerName: "小明",
				creatorName: "主播A",
			}),
		).toBe("小明 进了 主播A {msg}");
	});

	it("观众名里带 token 不被二次替换", () => {
		expect(
			renderSpecialUserEnter({
				template: "{uname}|-mastername",
				viewerName: "{mastername}",
				creatorName: "主播A",
			}),
		).toBe("{mastername}|主播A");
	});
});

/**
 * `renderLiveSummary` 的越界守卫(P2-D):此前无条件索引 topSenders[0..4],直播弹幕发送者不足 5 人时(很常见)
 * `undefined[0]` 直接抛 TypeError,整条直播总结推送失败。修复后缺位安全降级为空名 / 0 条。
 * (从 `bilibili/live/__tests__/template-renderer.test.ts` 搬来。)
 */
const SUMMARY_TPL =
	"发言-dmc人 弹幕-dca条 | 1:-un1=-dc1 2:-un2=-dc2 3:-un3=-dc3 4:-un4=-dc4 5:-un5=-dc5";

describe("renderLiveSummary — topSenders <5 守卫", () => {
	it("topSenders 仅 2 人 → 不抛,缺位渲染为空名/0", () => {
		const out = renderLiveSummary({
			template: SUMMARY_TPL,
			senderCount: 2,
			fanClubName: "",
			viewerChatCount: 15,
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
			renderLiveSummary({
				template: SUMMARY_TPL,
				senderCount: 0,
				fanClubName: "",
				viewerChatCount: 0,
				topSenders: [],
			}),
		).not.toThrow();
	});

	it("topSenders 恰 5 人 → 全部正常填充(回归)", () => {
		const out = renderLiveSummary({
			template: SUMMARY_TPL,
			senderCount: 5,
			fanClubName: "",
			viewerChatCount: 99,
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

	it("粉丝团名字填进 -mdn", () => {
		expect(
			renderLiveSummary({
				template: "牌:-mdn",
				senderCount: 1,
				fanClubName: "小晨",
				viewerChatCount: 1,
				topSenders: [],
			}),
		).toBe("牌:小晨");
	});
});
