/**
 * **行上那颗「N 条」胶囊数的是什么**(ADR-0017 决策 14、15)。
 *
 * 重推是**追加进原行**的,所以行会越补越长。这颗胶囊要是数 `messages.length`,一个 3 条
 * 的行补过一次就写「5 条」,而展开逐条看到的号只有 1/2/3 —— 面板自己跟自己对不上。
 *
 * 数的是「这次推送**本来**要发几条」:没有 `retryOf` 的那些。补几次都不变。
 *
 * ⚠️ 这是一句本地可见的事实(`retryOf` 缺省 = 不是重投),**不是**决策 16 那条
 * 「每一号只认最后那次尝试」的判定 —— 那条只在服务端有一份,面板不许重做。
 */

import type { HistoryEntryView } from "@bilibili-notify/contract";
import { describe, expect, it } from "vite-plus/test";
import { hasDetails, messageCountOf } from "../push-row";

function entry(messages: HistoryEntryView["messages"]): HistoryEntryView {
	return {
		id: "h1",
		pushId: "p1",
		ts: "2026-09-20T08:00:00.000Z",
		kind: "live-end",
		status: "delivered",
		uid: "u1",
		subscriptionId: "s1",
		targetId: "t1",
		messages,
		unameSnapshot: "某UP",
	};
}

const main = { text: "下播了", role: "main" as const, ok: true };
const extra = (ok: boolean) => ({ text: "词云", role: "extra" as const, ok });

describe("messageCountOf — 数的是「本来要发几条」", () => {
	it("没补过的行:就是消息条数", () => {
		expect(messageCountOf(entry([main, extra(true)]))).toBe(2);
	});

	it("🔴 补过的行:补进来的那几条不算新的一条", () => {
		const row = entry([main, extra(false), extra(false), { ...extra(true), retryOf: 1 }]);
		expect(messageCountOf(row)).toBe(3);
	});

	it("🔴 补了两轮也还是那个数 —— 行会变长,这个数不变", () => {
		const row = entry([
			main,
			extra(false),
			{ ...extra(false), retryOf: 1 },
			{ ...extra(true), retryOf: 1 },
		]);
		expect(messageCountOf(row)).toBe(2);
	});
});

describe("hasDetails — 补过的行照旧点得开", () => {
	// 一条本体补过一次 = 行里两条,但「本来」只有一条。点开要能看见那两次尝试。
	it("🔴 本来只有一条、但补过 → 仍然有的可看", () => {
		const row = entry([
			{ ...main, ok: false },
			{ ...main, retryOf: 0 },
		]);
		expect(hasDetails(row)).toBe(true);
	});
});
