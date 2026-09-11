/**
 * 「谁」的三坐标 —— 主人身份的比对。
 *
 * 这块从前是一个裸字符串加一句 `===`。`targets.ts` 上的注释一直写着「**绝不能跨平台
 * 比对**:两个命名空间里的字符串撞上就等于认错人」,但没有任何东西校验它 —— 真正兜着
 * 它的是「一条连接只驮一个平台」这个前提,而那个前提正被这次重构拆掉。
 *
 * 认错人的后果是私聊指令层整条链路对陌生人开放:改配置、发推送、批准锐评。所以这里
 * 逐条钉住,而不是「反正撞上的概率很低」。
 */

import { describe, expect, it } from "vite-plus/test";
import { type ChatIdentity, chatIdentityOf, type PushTarget, sameChatIdentity } from "./targets.js";

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";

const target = (over: Record<string, unknown>): PushTarget =>
	({
		id: UUID_A,
		name: "主人",
		connectionId: UUID_B,
		enabled: true,
		...over,
	}) as unknown as PushTarget;

const id = (over: Partial<ChatIdentity> = {}): ChatIdentity => ({
	platform: "onebot",
	address: "10001",
	...over,
});

describe("chatIdentityOf —— 从主人那条私聊目标取两坐标", () => {
	it("私聊会话目标 → 平台 + 地址", () => {
		expect(
			chatIdentityOf(
				target({ kind: "session", scope: "private", platform: "onebot", address: "10001" }),
			),
		).toEqual({ platform: "onebot", address: "10001" });
	});

	it("群目标没有身份 —— 群地址不是人,拿它当主人等于把整个群当主人", () => {
		expect(
			chatIdentityOf(
				target({ kind: "session", scope: "group", platform: "onebot", address: "88888" }),
			),
		).toBeUndefined();
	});

	it("单向终点没有身份", () => {
		expect(
			chatIdentityOf(target({ kind: "endpoint", scope: "channel", platform: "feishu" })),
		).toBeUndefined();
	});

	it("地址还没填的私聊目标没有身份 —— 空串不该跟「没给平台」撞上", () => {
		expect(
			chatIdentityOf(
				target({ kind: "session", scope: "private", platform: "onebot", address: "" }),
			),
		).toBeUndefined();
	});

	it("没配主人 → 没有身份", () => {
		expect(chatIdentityOf(undefined)).toBeUndefined();
	});
});

describe("sameChatIdentity —— 认不认这个人", () => {
	it("平台与地址都对上才是同一个人", () => {
		expect(sameChatIdentity(id(), id())).toBe(true);
	});

	it("🔴 地址相同但平台不同 → 不是同一个人", () => {
		// 这一条就是这次改动的全部意义。从前两边都塌成 "10001",`===` 直接放行,
		// 陌生人在另一个平台上顶着同一个号就拿到了主人的整条指令链路。
		expect(sameChatIdentity(id(), id({ platform: "qq-official" }))).toBe(false);
	});

	it("平台相同但地址不同 → 不是", () => {
		expect(sameChatIdentity(id(), id({ address: "20002" }))).toBe(false);
	});

	/**
	 * 身份**没有 bot 那一格**(ADR-0012 决策 45):一条连接就是一个 bot,同一个平台上同一个
	 * 地址就是同一个人 —— 两个 bot 各看见他一次也还是他。多出来的键不参与比对。
	 */
	it("同平台同地址就是同一个人 —— 谁看见的不重要", () => {
		const seenByA = { ...id(), botId: "bot-a" } as ChatIdentity;
		const seenByB = { ...id(), botId: "bot-b" } as ChatIdentity;
		expect(sameChatIdentity(seenByA, seenByB)).toBe(true);
	});

	it("没配主人 → 谁都不认", () => {
		expect(sameChatIdentity(undefined, id())).toBe(false);
	});

	it("坐标缺一格 → 谁都不认,而不是当通配", () => {
		expect(sameChatIdentity(id({ platform: "" }), id({ platform: "" }))).toBe(false);
		expect(sameChatIdentity(id({ address: "" }), id({ address: "" }))).toBe(false);
	});
});
