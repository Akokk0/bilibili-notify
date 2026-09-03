import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { findNearestPackageJson } from "../nearest-package-json.js";

/**
 * 「我是哪份载荷」这个问题有两个问法 —— health 路由报版本号、boot.mjs 读镜像自带的
 * 版本号 —— 都走这一个向上找的实现。它答错的方式只有一种:一路爬到根去捡别人的
 * package.json,报一个别的包的版本号比报 "dev" 更能骗人。
 */
describe("findNearestPackageJson", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "bn-nearest-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("bundle 形态:package.json 就在入口旁边", () => {
		writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "1.0.0" }));
		expect(findNearestPackageJson(dir, 6)).toBe(join(dir, "package.json"));
	});

	it("源码形态:从深处一层层往上,取最近的那个", () => {
		mkdirSync(join(dir, "src", "routes"), { recursive: true });
		writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "1.0.0" }));
		expect(findNearestPackageJson(join(dir, "src", "routes"), 6)).toBe(join(dir, "package.json"));
	});

	it("桌面壳形态:lib/ 外置,package.json 在上一层 —— boot 那两层余量够到", () => {
		mkdirSync(join(dir, "lib"), { recursive: true });
		writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "1.0.0" }));
		expect(findNearestPackageJson(join(dir, "lib"), 2)).toBe(join(dir, "package.json"));
	});

	it("一路到刹车都没有 → null,不会摸到别人的 package.json", () => {
		mkdirSync(join(dir, "a", "b"), { recursive: true });
		expect(findNearestPackageJson(join(dir, "a", "b"), 2)).toBeNull();
	});
});
