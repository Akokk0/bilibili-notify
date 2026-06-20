import { describe, expect, it } from "vite-plus/test";
import { formatLocalTime } from "../Logs";

describe("formatLocalTime", () => {
	it("返回浏览器本地时区的 yyyy-MM-dd HH:MM:SS.sss 字面格式", () => {
		const out = formatLocalTime("2026-05-20T01:02:03.004Z");
		expect(out).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/);
	});

	it("毫秒位永远 3 位 padding(避免出现 :3 而非 :003)", () => {
		const out = formatLocalTime("2026-05-20T01:02:03.004Z");
		const ms = out.split(".")[1];
		expect(ms).toHaveLength(3);
	});

	it("月/日 一位数也 padding 成 2 位(2026-01-05 不是 2026-1-5)", () => {
		const out = formatLocalTime("2026-01-05T12:00:00.000Z");
		const [date] = out.split(" ");
		const [, mo, day] = date.split("-");
		expect(mo).toHaveLength(2);
		expect(day).toHaveLength(2);
	});

	it("ISO 解析失败时回退到原字符串(T → 空格)", () => {
		expect(formatLocalTime("not-an-iso")).toBe("not-an-iso");
		expect(formatLocalTime("2026-05-20Tinvalid")).toBe("2026-05-20 invalid");
	});
});
