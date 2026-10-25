import { describe, expect, it } from "vite-plus/test";
import * as real from "../index.js";
import * as stub from "../stub.js";

/**
 * 正式版里顶替 `./bilibili/devtools/index.js` 的空桩(`vite.config.ts` 的换桩表):恒交出空的
 * 场景组,形状与真的那份一致。
 */

describe("B 站 devtools 空桩", () => {
	it("导出的名字与真的入口一一对应", () => {
		expect(Object.keys(stub).sort()).toEqual(Object.keys(real).sort());
	});

	it("createBiliDevtools 恒交出空的场景组", () => {
		expect(stub.createBiliDevtools({} as never).provider).toEqual({ scenarios: [] });
	});

	// 从前核心 devtools 桩里 `overridableApi` 的那条透传测试搬到这里:壳现在由 B 站 devtools 建,生产里交给来源的是真对象。
	it("开发壳原样透传:交回去的就是真对象,盖不上任何方法", () => {
		const { devShells } = stub.createBiliDevtools({} as never);
		const api = { ping: () => "pong" };
		const auth = { state: () => "real" };
		expect(devShells.api(api as never)).toBe(api);
		expect(devShells.auth(auth as never)).toBe(auth);
	});
});
