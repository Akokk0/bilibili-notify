import { describe, expect, it } from "vite-plus/test";
import * as real from "../index.js";
import * as stub from "../stub.js";

/**
 * 正式版里顶替 `./devtools/index.js` 的空桩(`vite.config.ts` 的换桩表):交出的东西是空的,
 * 形状与真的那份一致 —— `src/index.ts` 一行不用改。
 */

describe("devtools 空桩", () => {
	it("导出的名字与真的入口一一对应", () => {
		expect(Object.keys(stub).sort()).toEqual(Object.keys(real).sort());
	});

	it("createDevtools 恒回 null", () => {
		expect(stub.createDevtools({} as never)).toBeNull();
	});

	it("overridableApi 原样透传:交回去的就是真对象,盖不上任何方法", () => {
		const target = { ping: () => "pong" };
		const dev = stub.overridableApi(target);
		expect(dev.api).toBe(target);
		dev.override("ping", () => "盖上了");
		expect(dev.api.ping()).toBe("pong");
	});
});
