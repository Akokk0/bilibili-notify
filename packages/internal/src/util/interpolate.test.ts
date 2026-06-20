import { describe, expect, it, vi } from "vite-plus/test";
import { interpolate } from "./interpolate";

describe("interpolate()", () => {
	it("replaces flat variables", () => {
		expect(interpolate("Hello {name}!", { name: "world" })).toBe("Hello world!");
	});

	it("supports nested path lookup", () => {
		expect(interpolate("{user.name} ({user.age})", { user: { name: "ak", age: 18 } })).toBe(
			"ak (18)",
		);
	});

	it("keeps unknown variable raw and reports via onMissing", () => {
		const onMissing = vi.fn();
		const out = interpolate("{exists} / {missing}", { exists: "ok" }, onMissing);
		expect(out).toBe("ok / {missing}");
		expect(onMissing).toHaveBeenCalledWith("missing");
	});

	it("does not crash when path traverses non-object", () => {
		const out = interpolate("{a.b.c}", { a: 1 });
		expect(out).toBe("{a.b.c}");
	});

	// 回归守护 — P1:原型链泄露 + 对象值噪声。
	// {constructor}/{__proto__}/{toString} 必须**不命中**继承成员;
	// 对象/函数值必须走 onMissing 原样保留,绝不渲染成 "[object Object]"/函数源码。
	describe("原型链/非 primitive 防护 (P1)", () => {
		it("拒绝 __proto__ / constructor / prototype 段名(原型污染面)", () => {
			const onMissing = vi.fn();
			const out = interpolate("{__proto__} {constructor} {a.constructor}", { a: {} }, onMissing);
			expect(out).toBe("{__proto__} {constructor} {a.constructor}");
			expect(onMissing).toHaveBeenCalledWith("__proto__");
			expect(onMissing).toHaveBeenCalledWith("constructor");
			expect(onMissing).toHaveBeenCalledWith("a.constructor");
		});

		it("不命中继承属性 toString(只认自有属性)", () => {
			const out = interpolate("{toString}", { x: 1 });
			expect(out).toBe("{toString}");
			expect(out).not.toContain("function");
		});

		it("对象/函数值不渲染成 [object Object]/源码,走 onMissing", () => {
			const onMissing = vi.fn();
			const out = interpolate("{persona} {fn}", { persona: { name: "x" }, fn: () => 1 }, onMissing);
			expect(out).toBe("{persona} {fn}");
			expect(out).not.toContain("[object Object]");
			expect(onMissing).toHaveBeenCalledWith("persona");
			expect(onMissing).toHaveBeenCalledWith("fn");
		});

		it("primitive(含 0 / false / bigint)仍正常插值", () => {
			expect(interpolate("{n}/{b}/{g}", { n: 0, b: false, g: 9n })).toBe("0/false/9");
		});
	});
});
