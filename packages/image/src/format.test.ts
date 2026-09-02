import { describe, expect, it } from "vite-plus/test";
import { numberToStr } from "./format";

describe("numberToStr", () => {
	it("万以下原样,万 / 亿一位小数", () => {
		expect(numberToStr(0)).toBe("0");
		expect(numberToStr(9999)).toBe("9999");
		expect(numberToStr(65000)).toBe("6.5万");
		expect(numberToStr(10_000)).toBe("1.0万");
		expect(numberToStr(123_456_789)).toBe("1.2亿");
	});
});
