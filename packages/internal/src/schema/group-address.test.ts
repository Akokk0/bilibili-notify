/**
 * `groupAddressOf` —— 一个推送目标的「群地址」。
 *
 * 这原是**刻画测试**,写它是因为 `targets.ts` 上那段注释警告过、却没人守着的事:
 *
 *   > 各处自己按平台写一个 switch 的话,以后接进来的新平台会在一处落进 default、
 *   > 另一处被列出来,群配了却永远匹配不上,还不报错。
 *
 * 那时地址是每平台一套 `session`,`groupAddressOf` 与 `groupSessionFor` 是一对反函数,
 * 两头各写一个 switch —— 失配就发生在两个 switch 之间。**地址收成一格 `address` 之后
 * 反函数没有了**,那一类失配从结构上消失,这个文件也就从「守住两头对齐」变成守住
 * 剩下的那一句:**`scope` 说它是群,`address` 才是群地址。**
 *
 * 按词表遍历而不是逐平台手写这一点保留:词表里新加一档(桥接那档正在路上),
 * 它自动进这些用例。
 */

import { describe, expect, it } from "vite-plus/test";
import { INBOUND_CAPABLE_PLATFORMS } from "../constants";
import { groupAddressOf, type PushTarget, PushTargetSchema } from "./targets";

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";

function target(over: Record<string, unknown>): PushTarget {
	return PushTargetSchema.parse({
		id: UUID_A,
		name: "来源群",
		connectionId: UUID_B,
		enabled: true,
		...over,
	});
}

/** cast 是**故意的**:词表里加了新平台时 TS 不会自动放行,但这里要的正是让它进到运行期来撞。 */
function groupTarget(platform: string, address: string): PushTarget {
	return target({ kind: "session", scope: "group", platform, address });
}

describe("groupAddressOf —— 群目标的地址", () => {
	it.each(INBOUND_CAPABLE_PLATFORMS)("%s:群目标读得回自己的地址", (platform) => {
		expect(groupAddressOf(groupTarget(platform, "1145141919"))).toBe("1145141919");
	});

	it.each(INBOUND_CAPABLE_PLATFORMS)("%s:地址不是恒定值,换一个也读得回来", (platform) => {
		// 只验一个固定串的话,`return "1145141919"` 这种写死也能过。
		expect(groupAddressOf(groupTarget(platform, "9008"))).toBe("9008");
	});

	it("每个可入站的平台都必须有群地址,不许落进 default", () => {
		for (const platform of INBOUND_CAPABLE_PLATFORMS) {
			expect(
				groupAddressOf(groupTarget(platform, "1")),
				`${platform} 落进了 default`,
			).toBeDefined();
		}
	});

	it("单向终点没有群地址", () => {
		// webhook 那族只有出站没有回程,它连 address 这一格都没有 —— 这里返回 undefined
		// 是对的,不是漏写。
		expect(
			groupAddressOf(target({ kind: "endpoint", scope: "group", platform: "feishu" })),
		).toBeUndefined();
	});

	it("私聊目标没有群地址 —— 有地址不等于有群", () => {
		// 收成一格之后这条是**唯一**还能出错的地方:address 这一格对私聊装的是那个人的
		// id,照样是个非空串。只看「有没有 address」就会把私聊当成群。
		const priv = target({
			kind: "session",
			scope: "private",
			platform: "onebot",
			address: "10001",
		});
		expect(groupAddressOf(priv)).toBeUndefined();
	});

	it("子频道目标没有群地址", () => {
		const channel = target({
			kind: "session",
			scope: "channel",
			platform: "qq-official",
			address: "c1",
			parentAddress: "g1",
		});
		expect(groupAddressOf(channel)).toBeUndefined();
	});

	it("地址还没填的群目标算没有 —— 空串不是一个能投递的地址", () => {
		expect(groupAddressOf(groupTarget("onebot", ""))).toBeUndefined();
	});
});
