/**
 * 单元测试 — `LiveTemplateRenderer.renderLiveSummary` 的越界守卫(P2-D)。
 *
 * 公共导出 renderLiveSummary 此前无条件索引 topSenders[0..4],直播弹幕发送者
 * 不足 5 人时(很常见)`undefined[0]` 直接抛 TypeError,整条直播总结推送失败。
 * 修复后缺位安全降级为空名 / 0 条。
 */

import { describe, expect, it } from "vite-plus/test";
import { applyTemplate, LiveTemplateRenderer } from "../template-renderer";

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
