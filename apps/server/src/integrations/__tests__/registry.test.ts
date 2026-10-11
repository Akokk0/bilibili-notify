/**
 * 登记表的三条规矩(`../registry.ts` 头注释):一个键一个主人、撤下只撤自己那一行、撤下之后可以重来。
 * 三条都是「不这么写就静默出错」的那种,所以各钉一条。
 */

import { describe, expect, it } from "vite-plus/test";
import { createRegistry } from "../registry.js";

const make = () => createRegistry<string>((id) => `${id} 已经有主人了`);

describe("登记表", () => {
	it("登了就查得到,没登的是 undefined", () => {
		const registry = make();
		registry.claim("bilibili", "来源");
		expect(registry.get("bilibili")).toBe("来源");
		expect(registry.get("douyin")).toBeUndefined();
	});

	it("一个键一个主人:已经有人登了再登就抛,原主人不动", () => {
		const registry = make();
		registry.claim("bridge", "旧的");
		expect(() => registry.claim("bridge", "新的")).toThrow("bridge 已经有主人了");
		expect(registry.get("bridge")).toBe("旧的");
	});

	it("撤下之后可以重来", () => {
		const registry = make();
		registry.claim("bridge", "第一次").dispose();
		expect(registry.get("bridge")).toBeUndefined();
		registry.claim("bridge", "第二次");
		expect(registry.get("bridge")).toBe("第二次");
	});

	it("entries 按认领先后列出全表;撤了的不列,重登的排到最后", () => {
		const registry = make();
		registry.claim("a", "甲");
		const b = registry.claim("b", "乙");
		registry.claim("c", "丙");
		expect([...registry.entries()]).toEqual([
			["a", "甲"],
			["b", "乙"],
			["c", "丙"],
		]);
		b.dispose();
		expect([...registry.entries()]).toEqual([
			["a", "甲"],
			["c", "丙"],
		]);
		registry.claim("b", "乙二");
		expect([...registry.entries()].map(([id]) => id)).toEqual(["a", "c", "b"]);
	});

	it("撤下只撤自己那一行:重登之后再 dispose 旧把手,新主人还在", () => {
		const registry = make();
		const old = registry.claim("bridge", "旧的");
		old.dispose();
		registry.claim("bridge", "新的");
		old.dispose();
		expect(registry.get("bridge")).toBe("新的");
	});
});
