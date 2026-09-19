/**
 * 引擎 → 推送层那一跳的守卫。
 *
 * 隔壁 `live-type-to-feature.test.ts` 钉的是**翻译表本身**（5 → wordcloud、3 → 允许 @全体、
 * 9 → live-end）。这份钉的是**那张表真的被用上了** —— 两件事，两条测试。
 *
 * 为什么非要单独一条：2026-09-19 实测过，把适配器里的 `liveBroadcastOpts(type, o)` 整个
 * 换成裸的 `{ pushId, role }`，**219 个测试文件、3173 条全绿**。那一句里揣着三样东西，
 * 掉了都是静默的：
 *
 *   - `extra`       掉了 → 附加项的按目标收窄全失效，词云 / 总结回到「订了下播就全收」
 *   - `allowAtAll`  掉了 → 「每条直播推送都 @全体」那个修过的 bug 直接回归
 *   - `kind`        掉了 → 历史把周期「正在直播」记成开播
 *
 * 判据照 `wiring-needs-its-own-guard` 那条:把接线剪断,这里必须红。
 */

import type { BroadcastOptions } from "@bilibili-notify/push";
import { describe, expect, it, vi } from "vite-plus/test";
import { makeDynamicPushLike, makeLivePushLike } from "../runtime/engines";

/** 只拦 `broadcastToFeature`，把它收到的第四个参数（选项）原样记下来。 */
function makePushSpy() {
	const opts: Array<BroadcastOptions | undefined> = [];
	const features: string[] = [];
	const push = {
		broadcastToFeature: vi.fn(async (_uid: string, feature: string, _p: unknown, o?: unknown) => {
			features.push(feature);
			opts.push(o as BroadcastOptions | undefined);
			return [];
		}),
		sendPrivateMsg: vi.fn(async () => {}),
		sendErrorMsg: vi.fn(async () => {}),
	};
	return { push, opts, features };
}

// biome-ignore lint/suspicious/noExplicitAny: 适配器收的是引擎那侧的枚举与段，这里只关心转出来的选项
const anyPush = (p: ReturnType<typeof makePushSpy>["push"]) => p as any;

describe("直播引擎那侧的 PushLike 真的用上了翻译表", () => {
	it("词云(5):附加项键、下播特性、live-end 类、不 @全体 —— 四样一个都不能少", async () => {
		const { push, opts, features } = makePushSpy();
		await makeLivePushLike(anyPush(push)).broadcastToTargets("100", "词云", 5, {
			pushId: "p1",
			role: "extra",
		});
		expect(features).toEqual(["liveEnd"]);
		expect(opts[0]).toMatchObject({
			extra: "wordcloud",
			kind: "live-end",
			allowAtAll: false,
			role: "extra",
			pushId: "p1",
		});
	});

	it("AI 总结(10):同上，换一把附加项键", async () => {
		const { push, opts } = makePushSpy();
		await makeLivePushLike(anyPush(push)).broadcastToTargets("100", "总结", 10, {
			pushId: "p1",
			role: "extra",
		});
		expect(opts[0]).toMatchObject({ extra: "liveSummary", kind: "live-end" });
	});

	it("开播(3):允许 @全体，且**不带**附加项键 —— 带了整张卡会被收窄掉", async () => {
		const { push, opts } = makePushSpy();
		await makeLivePushLike(anyPush(push)).broadcastToTargets("100", "开播", 3);
		expect(opts[0]?.allowAtAll).toBe(true);
		expect(opts[0]?.extra).toBeUndefined();
	});

	it("周期「正在直播」(0):抑制 @全体、历史单列一类 —— 这是修过的 bug，别让它悄悄回来", async () => {
		const { push, opts } = makePushSpy();
		await makeLivePushLike(anyPush(push)).broadcastToTargets("100", "正在直播", 0);
		expect(opts[0]).toMatchObject({ allowAtAll: false, kind: "live-ongoing" });
	});

	it("下播卡本体(9):不带附加项键", async () => {
		const { push, opts } = makePushSpy();
		await makeLivePushLike(anyPush(push)).broadcastToTargets("100", "下播", 9);
		expect(opts[0]?.extra).toBeUndefined();
		expect(opts[0]?.kind).toBe("live-end");
	});

	it("分条那条路(开播序列)走的是同一张表", async () => {
		const { push, opts } = makePushSpy();
		await makeLivePushLike(anyPush(push)).broadcastSequenceToTargets("100", ["一", "二"], 3);
		expect(opts[0]).toMatchObject({ allowAtAll: true, kind: "live" });
	});
});

describe("动态引擎那侧的 PushLike 真的用上了翻译表", () => {
	it("图集(dynamic-images)是附加项:抑制 @全体、跟主卡同一个 pushId", async () => {
		const { push, opts, features } = makePushSpy();
		await makeDynamicPushLike(anyPush(push)).broadcastDynamic(
			"100",
			[{ type: "text", text: "动态" }],
			"dynamic-images",
			{
				pushId: "p1",
			},
		);
		expect(features).toEqual(["dynamic"]);
		// 掉了就是一条 DRAW 动态在主卡与图集各 @ 一次。
		expect(opts[0]).toMatchObject({ allowAtAll: false, role: "extra", pushId: "p1" });
	});

	it("主卡(dynamic)不抑制 @全体", async () => {
		const { push, opts } = makePushSpy();
		await makeDynamicPushLike(anyPush(push)).broadcastDynamic(
			"100",
			[{ type: "text", text: "动态" }],
			"dynamic",
			{
				pushId: "p1",
			},
		);
		expect(opts[0]?.allowAtAll).toBeUndefined();
		expect(opts[0]?.role).toBeUndefined();
	});
});
