/**
 * 引擎 → 推送层那一跳的守卫。
 *
 * 隔壁 `live-type-to-feature.test.ts` 钉的是**翻译表本身**（3 → 允许 @全体、9 → liveEnd）。
 * 这份钉的是**那张表真的被用上了**、锚点真的原样翻过去了 —— 两件事，两条测试。
 *
 * 为什么非要单独一条：2026-09-19 实测过，把适配器里直播那一跳的翻译整个换成裸的转交，
 * **219 个测试文件、3173 条全绿**。那一跳里揣着的东西，掉了都是静默的：
 *
 *   - 锚点的 `extra`  掉了 → 附加项的按目标收窄全失效，词云 / 总结回到「订了下播就全收」
 *   - 锚点的 `role`   掉成本体 → 图集 / 词云又会 @ 一次全体，历史里也分不出本体与附加项
 *   - `allowAtAll`    掉了 → 「每条直播推送都 @全体」那个修过的 bug 直接回归
 *
 * 历史记成什么不另说：⑬f 起历史行记的就是交出去的特性键，补报记开播、周期记正在直播，
 * 都由下面的 `feature` 钉着；交出去的对象里不许再冒出一个单独的「推送种类」。
 *
 * 判据照 `wiring-needs-its-own-guard` 那条:把接线剪断,这里必须红。
 */

import type { NotificationPayload } from "@bilibili-notify/internal";
import type { Push } from "@bilibili-notify/push";
import { describe, expect, it, vi } from "vite-plus/test";
import { boundPostPush } from "../runtime/engines";

/** 只拦 `push`，把交进来的那次推送原样记下来。 */
function makePushSpy() {
	const pushes: Push[] = [];
	const push = {
		push: vi.fn(async (p: Push) => {
			pushes.push(p);
			return [];
		}),
		notifyMaster: vi.fn(async (_payload: string | NotificationPayload) => ({
			ok: true as const,
			latencyMs: 1,
		})),
	};
	return { push, pushes };
}

/** 一个锚点最后交出去的消息(现成的或约定)。 */
const messagesOf = async (push: Push, i: number): Promise<NotificationPayload[] | undefined> =>
	push.anchors[i]?.messages;

describe("作品那一路(boundPostPush)真的把锚点翻过去了", () => {
	it("主卡是本体、图集是不带键的附加项,同一次推送;特性恒为 post,不抑制 @全体", async () => {
		const { push, pushes } = makePushSpy();
		await boundPostPush(
			push,
			"sub-100",
		)([
			{ role: "main", messages: [[{ kind: "text", text: "动态" }]] },
			{
				role: "extra",
				messages: [[{ kind: "image-group", mergeForward: true, images: [{ url: "u1" }] }]],
			},
		]);
		expect(pushes).toHaveLength(1);
		const [sent] = pushes;
		expect(sent).toMatchObject({ subscriptionId: "sub-100", feature: "post" });
		expect(sent?.allowAtAll).toBeUndefined();
		// 图集掉成本体,就是一条 DRAW 动态在主卡与图集各 @ 一次。
		expect(sent?.anchors.map((a) => [a.role, a.extra])).toEqual([
			["main", undefined],
			["extra", undefined],
		]);
		expect(await messagesOf(sent as Push, 0)).toEqual([{ kind: "text", text: "动态" }]);
		expect((await messagesOf(sent as Push, 1))?.[0]?.kind).toBe("image-group");
	});

	it("本体带 AI 版:aiMessages 逐条翻成载荷(现成的与约定都翻),模板版不受影响", async () => {
		const { push, pushes } = makePushSpy();
		await boundPostPush(
			push,
			"sub-100",
		)([
			{
				role: "main",
				messages: [[{ kind: "text", text: "模板" }]],
				aiMessages: [[{ kind: "text", text: "点评一" }], [{ kind: "text", text: "点评二" }]],
			},
			{
				role: "main",
				messages: [[{ kind: "text", text: "模板乙" }]],
				aiMessages: Promise.resolve([[{ kind: "text", text: "约定点评" }]]),
			},
		]);
		const anchors = (pushes[0] as Push).anchors;
		expect(anchors[0]?.messages).toEqual([{ kind: "text", text: "模板" }]);
		expect(anchors[0]?.aiMessages).toEqual([
			{ kind: "text", text: "点评一" },
			{ kind: "text", text: "点评二" },
		]);
		expect(await anchors[1]?.aiMessages).toEqual([{ kind: "text", text: "约定点评" }]);
	});

	it("没有 aiMessages:交出去的锚点也没有这一格(键缺失,不是 undefined 值)", async () => {
		const { push, pushes } = makePushSpy();
		await boundPostPush(
			push,
			"sub-100",
		)([{ role: "main", messages: [[{ kind: "text", text: "动态" }]] }]);
		expect("aiMessages" in ((pushes[0] as Push).anchors[0] as object)).toBe(false);
	});

	it("绑到另一条订阅 id 上(拓展作品):同一跳,订阅 id 随绑", async () => {
		const { push, pushes } = makePushSpy();
		await boundPostPush(
			push,
			"sub-ext",
		)([
			{ role: "main", messages: [[{ kind: "text", text: "一" }], [{ kind: "text", text: "二" }]] },
		]);
		expect(pushes[0]).toMatchObject({ subscriptionId: "sub-ext", feature: "post" });
		expect(await messagesOf(pushes[0] as Push, 0)).toEqual([
			{ kind: "text", text: "一" },
			{ kind: "text", text: "二" },
		]);
	});
});

/**
 * 引擎说的是 B 站 uid,推送链认的是订阅自己的 id(ADR-0019 决策 50)—— 翻译在这条边上做。
 * 剪掉这一跳(适配器把 uid 原样交下去),推送层按 id 一条订阅都找不到,每条推送静默丢掉。
 */
