/**
 * 一个目标是哪个平台 —— 取自它挂着的那条连接(ADR-0024 决策 9),不看目标自己那一格。
 *
 * 夹具里目标自己的 `platform` 故意写成和连接不一样:读错了来源,这里就红。
 */

import { describe, expect, it } from "vite-plus/test";
import { chatIdentityOf, type PushTarget, platformOfTarget } from "../targets.js";

const CONN_A = "11111111-1111-4111-8111-111111111111";
const CONN_B = "22222222-2222-4222-8222-222222222222";
const TARGET = "33333333-3333-4333-8333-333333333333";

const connections = [
	{ id: CONN_A, platform: "onebot" },
	{ id: CONN_B, platform: "qq-official" },
];

const target = (over: Record<string, unknown>): PushTarget =>
	({
		id: TARGET,
		name: "t",
		connectionId: CONN_A,
		enabled: true,
		// 与连接对不上 —— 读它就会读错。
		platform: "feishu",
		...over,
	}) as unknown as PushTarget;

describe("platformOfTarget —— 平台取自连接", () => {
	it("连接在 → 回连接的平台", () => {
		expect(platformOfTarget({ connectionId: CONN_A }, connections)).toBe("onebot");
		expect(platformOfTarget({ connectionId: CONN_B }, connections)).toBe("qq-official");
	});

	it("连接不在 → undefined", () => {
		expect(platformOfTarget({ connectionId: "ghost" }, connections)).toBeUndefined();
		expect(platformOfTarget({ connectionId: CONN_A }, [])).toBeUndefined();
	});

	it("目标自己那格 platform 与连接不同 → 以连接为准", () => {
		expect(platformOfTarget(target({ connectionId: CONN_B }), connections)).toBe("qq-official");
	});
});

describe("chatIdentityOf —— 主人身份的平台取自连接", () => {
	it("平台来自连接,不是目标自己那一格", () => {
		expect(
			chatIdentityOf(target({ kind: "session", scope: "private", address: "10001" }), connections),
		).toEqual({ platform: "onebot", address: "10001" });
	});

	it("连接不在了 → 没有身份(谁都不认)", () => {
		expect(
			chatIdentityOf(
				target({ kind: "session", scope: "private", address: "10001", connectionId: "ghost" }),
				connections,
			),
		).toBeUndefined();
	});
});
