/**
 * 数字与时间的排版只有一份(data-model「数字、时间与「不知道」」,1.0 第 2 期 ⑪,10-02 主人定口径)。
 * 期望值都是手写的字面量,不照着实现再算一遍。
 */

import { describe, expect, it } from "vite-plus/test";
import { formatAgo, formatAmount, formatClock, formatCount, formatDuration } from "../format";

describe("formatCount", () => {
	it("卡片口径:万和亿都一位小数、保留「.0」、万以下原样不加千分位", () => {
		expect(formatCount(0)).toBe("0");
		expect(formatCount(9500)).toBe("9500");
		expect(formatCount(10000)).toBe("1.0万");
		expect(formatCount(12345)).toBe("1.2万");
		expect(formatCount(999999)).toBe("100.0万");
		expect(formatCount(1000000)).toBe("100.0万");
		expect(formatCount(123456789)).toBe("1.2亿");
		expect(formatCount(300000000)).toBe("3.0亿");
	});

	it("快到一亿时进位成亿,不写「10000.0万」", () => {
		expect(formatCount(99999999)).toBe("1.0亿");
		expect(formatCount(99940000)).toBe("9994.0万");
	});

	it("负数按绝对值压缩", () => {
		expect(formatCount(-1234)).toBe("-1234");
		expect(formatCount(-12345)).toBe("-1.2万");
		expect(formatCount(-300000000)).toBe("-3.0亿");
	});

	it("带正负号:正数加「+」、负数普通的「-」、零就是「0」", () => {
		expect(formatCount(1234, { signed: true })).toBe("+1234");
		expect(formatCount(12345, { signed: true })).toBe("+1.2万");
		expect(formatCount(0, { signed: true })).toBe("0");
		expect(formatCount(-1234, { signed: true })).toBe("-1234");
		expect(formatCount(-12345, { signed: true })).toBe("-1.2万");
	});

	it("紧凑档(统计表):百万以上取整到万,万以下取整,其余同卡片口径", () => {
		expect(formatCount(10000, { compact: true })).toBe("1.0万");
		expect(formatCount(20000, { compact: true })).toBe("2.0万");
		expect(formatCount(999999, { compact: true })).toBe("100.0万");
		expect(formatCount(15473000, { compact: true })).toBe("1547万");
		expect(formatCount(300000000, { compact: true })).toBe("3.0亿");
		expect(formatCount(9999.6, { compact: true })).toBe("1.0万");
		expect(formatCount(1234.4, { compact: true })).toBe("1234");
		expect(formatCount(-82000, { compact: true, signed: true })).toBe("-8.2万");
	});
});

describe("formatAgo", () => {
	const NOW = Date.parse("2026-10-02T12:00:00.000Z");
	const before = (ms: number) => NOW - ms;

	it("一分钟以内(连同未来的时刻)都是「刚刚」", () => {
		expect(formatAgo(before(30_000), NOW)).toBe("刚刚");
		expect(formatAgo(NOW + 5 * 60_000, NOW)).toBe("刚刚");
	});

	it("分钟、小时、天,数字和单位之间带空格,不改写成日期", () => {
		expect(formatAgo(before(5 * 60_000), NOW)).toBe("5 分钟前");
		expect(formatAgo(before(59 * 60_000), NOW)).toBe("59 分钟前");
		expect(formatAgo(before(2 * 3_600_000), NOW)).toBe("2 小时前");
		expect(formatAgo(before(26 * 3_600_000), NOW)).toBe("1 天前");
		expect(formatAgo(before(40 * 86_400_000), NOW)).toBe("40 天前");
	});

	it("收 ISO 字符串", () => {
		expect(formatAgo("2026-10-02T11:55:00.000Z", NOW)).toBe("5 分钟前");
	});

	it("解析不了 → undefined,缺值的说法由各处自己写", () => {
		expect(formatAgo("not a date", NOW)).toBeUndefined();
		expect(formatAgo(Number.NaN, NOW)).toBeUndefined();
	});
});

describe("formatDuration", () => {
	const START = "2026-10-02T10:00:00.000Z";
	const after = (seconds: number) => Date.parse(START) + seconds * 1000;

	it("天 / 小时 / 分 / 秒,是零的那一位不写", () => {
		expect(formatDuration(START, after(3725))).toBe("1小时2分5秒");
		expect(formatDuration(START, after(59))).toBe("59秒");
		expect(formatDuration(START, after(90061))).toBe("1天1小时1分1秒");
		expect(formatDuration(START, after(7200))).toBe("2小时");
	});

	it("最大的单位到天,不用年和月", () => {
		expect(formatDuration(START, after(40 * 86400 + 5))).toBe("40天5秒");
		expect(formatDuration(START, after(400 * 86400))).toBe("400天");
	});

	it("零是「0秒」,倒过来的带负号", () => {
		expect(formatDuration(START, START)).toBe("0秒");
		expect(formatDuration(START, after(-7200))).toBe("-2小时");
	});

	it("收毫秒与 ISO 混着传,不满一秒的零头舍掉", () => {
		expect(formatDuration(Date.parse(START), "2026-10-02T12:13:05.900Z")).toBe("2小时13分5秒");
	});
});

describe("formatClock", () => {
	it("一小时以内 m:ss,以上 h:mm:ss,小时不换天", () => {
		expect(formatClock(59)).toBe("0:59");
		expect(formatClock(3725)).toBe("1:02:05");
		expect(formatClock(90061)).toBe("25:01:01");
	});

	it("负数与 NaN 都写「0:00」", () => {
		expect(formatClock(-5)).toBe("0:00");
		expect(formatClock(Number.NaN)).toBe("0:00");
	});
});

/**
 * **观看人数:`formatCount` 与 B 站原来排的字(`WATCHED_CHANGE` 的 `text_small`)差多少**(1.0 第 2 期 ㉒d)。
 *
 * ㉒d 起 B 站观看人数传精确数 `num`,排版归 `formatCount`(面板「正在直播」那一列、文字模板的 `{watched}`、下播卡的
 * 「累计观看人数」),不再沿用 B 站排好的字。这张表是给主人看的对照 —— **如实列,不为了对上去改 `formatCount`**:
 * - `formatCount` 那一列是现状,断言钉着;
 * - `bili` 那一列:`certain: true` 的是仓库里有**真实录制帧**为证的(`apps/server/src/bilibili/live/protocol/__tests__/fixtures/payloads.json`
 *   的 `WATCHED_CHANGE`:`num: 87334` ↔ `text_small: "8.7万"`),断言两边相同;`certain: false` 的是我按 B 站惯例
 *   的**推测**,仓库里没有录制帧能证实,只写在这里供人核对,**不进断言**(`bili` 写的是我的推测值)。
 *
 * 已知的差别方向(都出在「万」那一档的写法上):`formatCount` 恒保留一位小数(「1.0万」),并且用 `toFixed` 四舍五入;
 * B 站的 `text_small` 据我所知整万时不带「.0」(「1万」),取舍(进位还是截断)未知。
 */
describe("观看人数:formatCount 与 B 站 text_small 的对照(㉒d)", () => {
	const ROWS: ReadonlyArray<{ num: number; formatCount: string; bili: string; certain: boolean }> =
		[
			// 真实录制帧。
			{ num: 87_334, formatCount: "8.7万", bili: "8.7万", certain: true },
			// 以下 B 站一列是推测,不进断言。
			{ num: 12_000, formatCount: "1.2万", bili: "1.2万", certain: false },
			{ num: 9_999, formatCount: "9999", bili: "9999", certain: false },
			{ num: 10_000, formatCount: "1.0万", bili: "1万", certain: false },
			{ num: 123_456_789, formatCount: "1.2亿", bili: "1.2亿", certain: false },
			{ num: 0, formatCount: "0", bili: "0", certain: false },
		];

	it("formatCount 这一列(现状)", () => {
		for (const row of ROWS) expect(formatCount(row.num), String(row.num)).toBe(row.formatCount);
	});

	it("有真实录制帧为证的那一行:与 B 站排的字相同", () => {
		for (const row of ROWS.filter((r) => r.certain)) {
			expect(formatCount(row.num), String(row.num)).toBe(row.bili);
		}
	});
});

/**
 * 金额(㉓b,data-model「会员、醒目留言与特别关注」的「金额」):按币种排,固定中文环境、不加千分位。
 * 期望值都是手写的字面量(含币种符号的写法),不照着 `Intl` 再算一遍。
 */
describe("formatAmount", () => {
	it("人民币整数:「¥30」「¥2000」,没有千分位", () => {
		expect(formatAmount(30, "CNY")).toBe("¥30");
		expect(formatAmount(2000, "CNY")).toBe("¥2000");
	});

	it("小数照写、不补零:「¥30.5」;币种符号按币种:美元「US$30」、日元「JP¥30」", () => {
		expect(formatAmount(30.5, "CNY")).toBe("¥30.5");
		expect(formatAmount(30, "USD")).toBe("US$30");
		expect(formatAmount(30, "JPY")).toBe("JP¥30");
	});

	it("币种代码不合法(`Intl` 会抛 RangeError)→ 不抛,退成「金额 + 空格 + 币种原文」,多余的空格去掉", () => {
		expect(formatAmount(30, "NOT-A-CODE")).toBe("30 NOT-A-CODE");
		expect(formatAmount(30.5, "12")).toBe("30.5 12");
		// 空串也是不合法的币种:只剩金额,不留尾随空格。
		expect(formatAmount(30, "")).toBe("30");
	});

	// 「不知道」在出口缺了就是空串(data-model「数字、时间与「不知道」」);`Intl` 会写出「¥NaN」「¥∞」,
	// 那是比空着更糟的东西。合法与不合法的币种都一样。
	it("金额不是有限的数(NaN / ±Infinity)→ 空串,不抛、不写「NaN」「∞」", () => {
		expect(formatAmount(Number.NaN, "CNY")).toBe("");
		expect(formatAmount(Number.POSITIVE_INFINITY, "CNY")).toBe("");
		expect(formatAmount(Number.NEGATIVE_INFINITY, "USD")).toBe("");
		expect(formatAmount(Number.NaN, "NOT-A-CODE")).toBe("");
	});
});
