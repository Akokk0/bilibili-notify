/**
 * 回归守护 — P0-4 fix(security): use one-shot ws-ticket instead of leaking basic-auth into URL
 *
 * TicketStore 是浏览器 WS 鉴权的核心数据结构。三个不变量:
 *   a) issue 出来的 ticket consume 一次 true、再次 false(一次性消费)
 *   b) 超过 TTL → consume false(短时窗口)
 *   c) 未签发的随机字符串 consume false(不乱认)
 *
 * 任一失败 = WS 鉴权失效 / 凭证可重放 / 任意字符串可登录。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWsTicketStore } from "../ws-ticket";

describe("WsTicketStore — P0-4", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("a) consume 一次性:同一 ticket 第一次 true,第二次 false", () => {
		const store = createWsTicketStore({ ttlMs: 30_000 });
		const { ticket } = store.issue();
		expect(store.consume(ticket)).toBe(true);
		expect(store.consume(ticket)).toBe(false);
		store.dispose();
	});

	it("b) TTL 过期后 consume false", () => {
		const store = createWsTicketStore({ ttlMs: 5_000 });
		const { ticket } = store.issue();
		vi.advanceTimersByTime(5_001);
		expect(store.consume(ticket)).toBe(false);
		store.dispose();
	});

	it("c) 未签发的随机字符串 consume 永远 false", () => {
		const store = createWsTicketStore({ ttlMs: 30_000 });
		expect(store.consume("never-issued-token")).toBe(false);
		expect(store.consume("")).toBe(false);
		store.dispose();
	});

	it("两个不同 ticket 互不影响:消费 A 不影响 B", () => {
		const store = createWsTicketStore({ ttlMs: 30_000 });
		const a = store.issue();
		const b = store.issue();
		expect(a.ticket).not.toBe(b.ticket);
		expect(store.consume(a.ticket)).toBe(true);
		expect(store.consume(b.ticket)).toBe(true);
		store.dispose();
	});

	it("WT1:dispose() 清除 sweep 定时器(不泄漏 interval)", () => {
		expect(vi.getTimerCount()).toBe(0);
		const store = createWsTicketStore({ ttlMs: 30_000 });
		expect(vi.getTimerCount()).toBe(1); // sweep interval 已挂上
		store.dispose();
		expect(vi.getTimerCount()).toBe(0); // 旧实现拿不到句柄 → 这里会是 1
	});
});
