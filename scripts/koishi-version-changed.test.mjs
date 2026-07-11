import { describe, expect, it } from "vite-plus/test";
import { decide, versionOf } from "./koishi-version-changed.mjs";

/**
 * 发版触发从「push main」改成「push dev 且 koishi 版本号变了」。
 *
 * 判据必须是 **version 字段本身**,不能是「koishi/package.json 变了」—— 那个文件被
 * `vp pack`(exports: true)自动回写:每次构建都可能刷新 `inlinedDependencies` /
 * `exports`。拿文件变动当发版信号,等于每次构建都发一版。
 *
 * detect 只是省 CI 的快速门,不是安全闸。真正兜底的仍是 publish.mjs 的 registry
 * 幂等(重跑 workflow 时 before 没变,还会判 changed) —— 所以拿不准时一律放行,
 * 让第二道去把关。
 */
describe("versionOf", () => {
	it("读出 version", () => {
		expect(versionOf('{"name":"x","version":"5.0.0-alpha.9"}')).toBe("5.0.0-alpha.9");
	});

	it("JSON 坏掉 / 没有 version → null(读不出来就不是一次可信的比较)", () => {
		expect(versionOf("{ 这不是 json")).toBeNull();
		expect(versionOf('{"name":"x"}')).toBeNull();
		expect(versionOf("")).toBeNull();
	});
});

describe("decide", () => {
	it("版本号变了 → 发", () => {
		const d = decide({ before: "5.0.0-alpha.8", after: "5.0.0-alpha.9" });
		expect(d.changed).toBe(true);
	});

	// 这是最要紧的一条:构建回写 package.json 的其它字段时,version 没动,不许发。
	it("版本号没变 → 不发(哪怕 package.json 的其它字段被构建改过)", () => {
		expect(decide({ before: "5.0.0-alpha.9", after: "5.0.0-alpha.9" }).changed).toBe(false);
	});

	it("当前版本读不出来 → 不发(异常状态,宁可不发)", () => {
		expect(decide({ before: "5.0.0", after: null }).changed).toBe(false);
	});

	// 首次 push 分支 / force push 后,github.event.before 是全零,取不到基线。
	// 此时放行,交给 registry 幂等 —— 漏发要人工补,误发撤不回来,但误发这条路被第二道堵死了。
	it("拿不到基线 → 放行,由 registry 幂等把关", () => {
		expect(decide({ before: null, after: "5.0.0" }).changed).toBe(true);
	});

	it("每种判定都带得出理由(CI 日志里要看得懂为什么发/不发)", () => {
		for (const c of [
			{ before: "1.0.0", after: "1.0.1" },
			{ before: "1.0.0", after: "1.0.0" },
			{ before: null, after: "1.0.0" },
			{ before: "1.0.0", after: null },
		]) {
			expect(decide(c).reason).toBeTruthy();
		}
	});
});
