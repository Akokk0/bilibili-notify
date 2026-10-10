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
		expect(stub.createBiliDevtools({} as never)).toEqual({ scenarios: [] });
	});
});
