import { describe, expect, it } from "vitest";
import { DanmakuCollector } from "../danmaku-collector.js";

/**
 * 收集器的**内存规模**面。
 *
 * 这两张表的 key 空间天然无界 —— 词表随弹幕内容涨、发送者表随观众数涨,
 * 一场大主播的长播能往里塞进几万个 key。`stats()` 存在的唯一理由就是让
 * 内存自检日志(`apps/server/src/runtime/memory-probe.ts`)能把这条曲线
 * 和堆用量画在同一行上,回答「堆在涨的时候是不是它在涨」。
 */
describe("DanmakuCollector.stats", () => {
	it("报出房间数,以及所有房间累计的词 / 发送者 key 数", () => {
		const c = new DanmakuCollector([]);
		c.recordDanmaku("100", "今天天气不错", "alice");
		c.recordDanmaku("100", "今天天气不错", "bob");
		c.recordDanmaku("200", "主播好厉害", "alice");

		const s = c.stats();
		expect(s.rooms).toBe(2);
		// 同一个人在两个房间各占一个 key —— 报的是**内存里的 key 总数**,
		// 不是去重人头数。占内存的就是 key 本身。
		expect(s.senders).toBe(3);
		expect(s.words).toBeGreaterThan(0);
	});

	it("clear 掉的房间不再计入", () => {
		const c = new DanmakuCollector([]);
		c.recordDanmaku("100", "今天天气不错", "alice");
		c.recordDanmaku("200", "主播好厉害", "bob");

		c.clear("100");

		const s = c.stats();
		expect(s.rooms).toBe(1);
		expect(s.senders).toBe(1);
	});
});
