import { describe, expect, it } from "vite-plus/test";
import { LiveTemplateRenderer } from "../template-renderer";

/**
 * 刻画 —— B 站那三句直播文案今天怎么出(抽出中立的渲染之前先钉住):模板按 per-UP → 全局 → 默认取,
 * 每一种只认自己那几个变量(开播不认 `{watched}`、正在直播不认 `{follower}`……),粉丝数变化带正负号。
 * (弹幕总结的 `renderLiveSummary` 已搬到 `live/live-text.ts`,它的测试跟着在 `live/__tests__/live-text.test.ts`。)
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
