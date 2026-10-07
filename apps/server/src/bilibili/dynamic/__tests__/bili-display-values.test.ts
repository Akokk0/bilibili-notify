/**
 * B 站「排好的字」→ 数字的两个解析(㉑c 第 3 步,ADR-0021 决策 24:计数全程是数字,只在出口排一次版)。
 *
 * 接口给的播放 / 弹幕数是数字或「1.8万」这种成品字,时长是「16:07」这种成品字。`Post` 里它们都是数字,
 * 排版归 internal 的 `formatCount` / `formatClock` —— 这两个解析是 B 站原始数据到 `Post` 的翻译的一部分,
 * 认不得的一律回 `undefined`(那一格就不画),**绝不回 NaN**。
 *
 * 另钉一条往返:`formatCount` / `formatClock` 的产出再解析、再排版,字不变。链接预览的老办法就是先排成字
 * 再让卡片解析回去,这条保证那条路在换成「数字直接进」之前也不会失真。
 */

import { formatClock, formatCount } from "@bilibili-notify/internal";
import { describe, expect, it } from "vite-plus/test";
import { parseClock, parseCount } from "../bili-display-values";

describe("parseCount", () => {
	it.each([
		[0, 0],
		[129, 129],
		[65_000, 65_000],
		[12_345.6, 12_345.6],
		["0", 0],
		["129", 129],
		["  2654 ", 2654],
		["1.8万", 18_000],
		["12.3万", 123_000],
		["1万", 10_000],
		["100万", 1_000_000],
		["0.5万", 5000],
		["1.2亿", 120_000_000],
		["3亿", 300_000_000],
	])("%j → %d", (input, expected) => {
		expect(parseCount(input)).toBe(expected);
	});

	it("「万」「亿」乘出来的数取整,不留浮点尾巴", () => {
		// 0.07 * 1e4 是 700.0000000000001,1.15 * 1e8 是 114999999.99999999,2.3 * 1e8 是 229999999.99999997
		expect(parseCount("0.07万")).toBe(700);
		expect(parseCount("1.15亿")).toBe(115_000_000);
		expect(parseCount("2.3亿")).toBe(230_000_000);
	});

	it.each([
		"",
		"   ",
		"--",
		"abc",
		"万",
		"1.8w",
		"1.8万人",
		"10万+",
		"1,234",
		"-5",
		"-1.8万",
		"1.8.9万",
		"1e5",
		"NaN",
		"Infinity",
	])("认不得的字 %j → undefined", (input) => {
		expect(parseCount(input)).toBeUndefined();
	});

	it.each([undefined, null, -1, Number.NaN, Number.POSITIVE_INFINITY, true, {}, []])(
		"不是数字也不是字符串 / 不合理的数 %j → undefined",
		(input) => {
			expect(parseCount(input)).toBeUndefined();
		},
	);

	it("解析不出来就是 undefined,不是 NaN", () => {
		for (const bad of ["", "abc", "万", "1.8w"]) {
			expect(Number.isNaN(parseCount(bad) as number)).toBe(false);
		}
	});

	it("往返:formatCount 排出来的字解析回去再排,字不变", () => {
		for (const n of [0, 7, 129, 9999, 10_000, 12_345, 18_000, 65_000, 999_999, 123_456_789]) {
			const text = formatCount(n);
			const back = parseCount(text);
			expect(back, text).toBeDefined();
			expect(formatCount(back as number), text).toBe(text);
		}
	});

	it("接口给整数「万」时,排版补上小数位(「1万」→「1.0万」)", () => {
		expect(formatCount(parseCount("1万") as number)).toBe("1.0万");
		expect(formatCount(parseCount("100万") as number)).toBe("100.0万");
		expect(formatCount(parseCount("1.8万") as number)).toBe("1.8万");
	});
});

describe("parseClock", () => {
	it.each([
		["0:00", 0],
		["00:00", 0],
		["00:29", 29],
		["0:29", 29],
		["16:07", 967],
		["59:59", 3599],
		["75:30", 4530],
		["1:02:03", 3723],
		["01:02:03", 3723],
		["10:00:00", 36_000],
		["  16:07 ", 967],
	])("%j → %d 秒", (input, expected) => {
		expect(parseClock(input)).toBe(expected);
	});

	it.each([
		"",
		"   ",
		"16",
		"16:7",
		"16:60",
		"1:60:00",
		"1:02:60",
		"1:2:03",
		"1:02:03:04",
		":30",
		"16:",
		"-1:00",
		"1.5:00",
		"16:07.5",
		"abc",
		"一分钟",
		"16：07",
	])("非法 %j → undefined", (input) => {
		expect(parseClock(input)).toBeUndefined();
	});

	it.each([undefined, null, 967, Number.NaN, {}, []])(
		"不是字符串 %j → undefined(秒数本来就是数字,不需要解析)",
		(input) => {
			expect(parseClock(input)).toBeUndefined();
		},
	);

	it("往返:formatClock 排出来的字解析回去再排,字不变", () => {
		for (const sec of [0, 1, 29, 59, 60, 967, 3599, 3600, 3723, 36_000]) {
			const text = formatClock(sec);
			const back = parseClock(text);
			expect(back, text).toBe(sec);
			expect(formatClock(back as number), text).toBe(text);
		}
	});

	it("前导零在排版时消失(「00:29」→「0:29」),秒数不变", () => {
		expect(formatClock(parseClock("00:29") as number)).toBe("0:29");
		expect(formatClock(parseClock("01:02:03") as number)).toBe("1:02:03");
		expect(formatClock(parseClock("16:07") as number)).toBe("16:07");
	});
});
