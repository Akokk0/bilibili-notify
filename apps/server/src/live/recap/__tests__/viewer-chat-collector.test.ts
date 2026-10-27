import { describe, expect, it } from "vite-plus/test";
import { ViewerChatCollector } from "../viewer-chat-collector.js";

/**
 * 收集器的**内存规模**面。
 *
 * 这两张表的 key 空间天然无界 —— 词表随弹幕内容涨、发送者表随观众数涨,
 * 一场大主播的长播能往里塞进几万个 key。`stats()` 存在的唯一理由就是让
 * 内存自检日志(`apps/server/src/runtime/memory-probe.ts`)能把这条曲线
 * 和堆用量画在同一行上,回答「堆在涨的时候是不是它在涨」。
 */
describe("ViewerChatCollector.stats", () => {
	it("报出订阅数,以及所有订阅累计的词 / 发送者 key 数", () => {
		const c = new ViewerChatCollector([]);
		c.recordViewerChat("100", "今天天气不错", "alice");
		c.recordViewerChat("100", "今天天气不错", "bob");
		c.recordViewerChat("200", "主播好厉害", "alice");

		const s = c.stats();
		expect(s.subscriptions).toBe(2);
		// 同一个人在两个订阅各占一个 key —— 报的是**内存里的 key 总数**,
		// 不是去重人头数。占内存的就是 key 本身。
		expect(s.senders).toBe(3);
		expect(s.words).toBeGreaterThan(0);
	});

	it("constructor / toString / __proto__ 当词或观众名:计数仍是数字,__proto__ 的那位不丢", () => {
		const c = new ViewerChatCollector([]);
		c.recordViewerChat("100", "constructor", "toString");
		c.recordViewerChat("100", "constructor", "toString");
		c.recordViewerChat("100", "hello", "__proto__");

		const s = c.snapshot("100");
		// 词表与发送者表的键都是外来字符串:不能因为撞上原型上的函数就把计数算成字符串。
		expect(s.viewerChatCount).toBe(3);
		expect(s.senderCount).toBe(2);
		expect(s.sortedWords.every(([, n]) => typeof n === "number")).toBe(true);
		expect(s.topSenders).toEqual([
			["toString", 2],
			["__proto__", 1],
		]);
	});

	it("clear 掉的订阅不再计入", () => {
		const c = new ViewerChatCollector([]);
		c.recordViewerChat("100", "今天天气不错", "alice");
		c.recordViewerChat("200", "主播好厉害", "bob");

		c.clear("100");

		const s = c.stats();
		expect(s.subscriptions).toBe(1);
		expect(s.senders).toBe(1);
	});
});
