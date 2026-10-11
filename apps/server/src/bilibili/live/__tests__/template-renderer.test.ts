/**
 * 单元测试 — `LiveTemplateRenderer.renderLiveSummary` 的越界守卫(P2-D)。
 *
 * 公共导出 renderLiveSummary 此前无条件索引 topSenders[0..4],直播弹幕发送者
 * 不足 5 人时(很常见)`undefined[0]` 直接抛 TypeError,整条直播总结推送失败。
 * 修复后缺位安全降级为空名 / 0 条。
 */

import { describe, expect, it } from "vite-plus/test";
import { LiveTemplateRenderer } from "../template-renderer";

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
		expect(r.renderLiveStreaming({ sub: sub(), master, diffTime: "2小时", watched: 34_000 })).toBe(
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
			r.renderLiveStreaming({
				sub: sub({ customLiveStreaming: "{name}|{time}|{watched}|{follower}" }),
				master,
				diffTime: "1分",
				watched: undefined,
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
