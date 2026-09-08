/**
 * `groupAddressOf` / `groupSessionFor` —— 群地址与 session 的那对反函数。
 *
 * 这是**刻画测试**:它钉的不是新行为,是把动这块之前的现状焊死。写它的直接原因是
 * `targets.ts` 上那段注释警告过的事,当时却没有任何测试守着:
 *
 *   > 各处自己按平台写一个 switch 的话,以后接进来的新平台会在一处落进 default、
 *   > 另一处被列出来,群配了却永远匹配不上,还不报错。
 *
 * 「不报错」正是要害 —— 这类失配不会抛异常、不会让类型红,只会让「回到来源群」这类
 * 功能默默失效。所以下面的用例**按词表遍历**而不是逐个平台手写:词表里新加一档
 * (桥接那档正在路上),它自动进入这些用例,漏了一头当场红。
 */

import { describe, expect, it } from "vite-plus/test";
import { INBOUND_CAPABLE_PLATFORMS } from "../constants";
import { groupAddressOf, groupSessionFor, type PushTarget, PushTargetSchema } from "./targets";

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";

/** 用那对反函数中的一头造一个合法的群目标 —— 另一头能不能读回来正是要验的。 */
function groupTarget(platform: string, address: string): PushTarget {
	// cast 是**故意的**:重载签名只列了今天的两个平台,词表里加了新平台时 TS 不会
	// 自动放行。但这里要的恰恰是让新平台**进到运行期**来撞 —— 靠编译期把它挡在
	// 测试之外,等于让「漏改一头」这件事悄悄绕过守卫。
	const session = groupSessionFor(platform as "onebot", address);
	return PushTargetSchema.parse({
		id: UUID_A,
		name: "来源群",
		adapterId: UUID_B,
		kind: "session",
		scope: "group",
		enabled: true,
		platform,
		session,
	});
}

describe("groupAddressOf / groupSessionFor —— 两头必须认同一个地址", () => {
	it.each(INBOUND_CAPABLE_PLATFORMS)("%s:造出来的 session 读得回原地址", (platform) => {
		const address = "1145141919";
		expect(groupAddressOf(groupTarget(platform, address))).toBe(address);
	});

	it.each(INBOUND_CAPABLE_PLATFORMS)("%s:地址不是恒定值,换一个也读得回来", (platform) => {
		// 只验一个固定串的话,`return "1145141919"` 这种写死也能过。
		expect(groupAddressOf(groupTarget(platform, "9008"))).toBe("9008");
	});

	it("每个可入站的平台都必须有群地址,不许落进 default", () => {
		// 这条是上面那段注释警告的正主:新平台在 groupSessionFor 里被列出来、却在
		// groupAddressOf 的 switch 里落进 default,返回 undefined —— 群配了永不匹配。
		for (const platform of INBOUND_CAPABLE_PLATFORMS) {
			expect(
				groupAddressOf(groupTarget(platform, "1")),
				`${platform} 落进了 default`,
			).toBeDefined();
		}
	});

	it("没有入站的平台没有群地址", () => {
		// webhook 只有出站没有回程,它的 session 是空对象 —— 这里返回 undefined 是对的,
		// 不是漏写。
		const webhook = PushTargetSchema.parse({
			id: UUID_A,
			name: "机器人",
			adapterId: UUID_B,
			kind: "endpoint",
			scope: "group",
			enabled: true,
			platform: "webhook",
			session: {},
		});
		expect(groupAddressOf(webhook)).toBeUndefined();
	});

	it("私聊目标没有群地址 —— 有 session 不等于有群", () => {
		const priv = PushTargetSchema.parse({
			id: UUID_A,
			name: "主人",
			adapterId: UUID_B,
			kind: "session",
			scope: "private",
			enabled: true,
			platform: "onebot",
			session: { userId: "10001" },
		});
		expect(groupAddressOf(priv)).toBeUndefined();
	});

	it("两个平台的 session 键名不同 —— 别被「反正都存了个字符串」蒙混过去", () => {
		// onebot 存 groupId、官机存 groupOpenid。哪天有人图省事把两边统一成一个键,
		// schema 的 .strict() 会拦下来,但这条让「为什么不能统一」留在测试里。
		expect(groupSessionFor("onebot", "42")).toEqual({ groupId: "42" });
		expect(groupSessionFor("qq-official", "42")).toEqual({ groupOpenid: "42" });
	});
});
