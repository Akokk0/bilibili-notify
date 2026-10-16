import { describe, expect, it } from "vite-plus/test";
import { creatorOf, parseCreator } from "../creator";

describe("creatorOf / parseCreator —— 「来源键:外部 id」", () => {
	it("拼成来源键加冒号加外部 id", () => {
		expect(creatorOf("bilibili", "123")).toBe("bilibili:123");
		expect(creatorOf("acme.inprocess", "alice-ext")).toBe("acme.inprocess:alice-ext");
	});

	it("按第一个冒号切:外部 id 里自己带冒号的整段留给外部 id", () => {
		expect(parseCreator("bilibili:123")).toEqual({ sourceKey: "bilibili", externalId: "123" });
		expect(parseCreator("acme:sec:uid:1")).toEqual({ sourceKey: "acme", externalId: "sec:uid:1" });
	});

	it("切不出来(没有冒号、任何一半是空的)→ undefined", () => {
		expect(parseCreator("123")).toBeUndefined();
		expect(parseCreator(":123")).toBeUndefined();
		expect(parseCreator("bilibili:")).toBeUndefined();
		expect(parseCreator("")).toBeUndefined();
	});

	it("拼出来的串切回去是原来的两段", () => {
		expect(parseCreator(creatorOf("x.y", "a:b"))).toEqual({ sourceKey: "x.y", externalId: "a:b" });
	});
});
