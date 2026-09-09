/**
 * `extension.json` —— 拓展包的清单。
 *
 * 清单存在的理由是**它要在代码跑起来之前就能回答问题**(ADR-0012 决策 8):
 * 面板要列出「装了但没启用」的拓展,而没启用就不该 `import()` 它;兼容性不合的拓展要
 * 「不加载 + 说清楚为什么」,而不是「加载了、注册到一半炸掉」;失败记账要拿得到身份,
 * 可偏偏最容易炸的就是 import 那一步 —— 炸了的话代码里的导出根本取不到。
 *
 * 所以这份 schema 校验的是**一段谁都没执行过的 JSON**,它必须自己把话说全。
 */

import { describe, expect, it } from "vite-plus/test";
import {
	EXTENSION_API_VERSION,
	type ExtensionManifest,
	ExtensionManifestSchema,
} from "./extension-manifest";

function manifest(over: Record<string, unknown> = {}): unknown {
	return {
		id: "bridge",
		name: "机器人框架桥接",
		description: "把 koishi / AstrBot 里已经配好的机器人借给 BN 用。",
		version: "1.0.0",
		apiVersion: EXTENSION_API_VERSION,
		provides: ["push"],
		...over,
	};
}

describe("ExtensionManifestSchema", () => {
	it("一份最小清单 —— 光靠它就能把拓展列在面板上,不必先加载代码", () => {
		const r = ExtensionManifestSchema.safeParse(manifest());
		expect(r.success).toBe(true);
		const m = r.data as ExtensionManifest;
		expect(m.id).toBe("bridge");
		expect(m.version).toBe("1.0.0");
		expect(m.apiVersion).toBe(EXTENSION_API_VERSION);
		expect(m.provides).toEqual(["push"]);
		// 图标是可选的 —— 没有就退回灰方章,不是拒绝加载的理由。
		expect(m.icon).toBeUndefined();
	});

	/**
	 * id 同时是**三个地方的一段**:URL(`/ext/:id/*`)、装载目录
	 * (`<dataDir>/extensions/<id>/`)、失败记账的键。所以它比「非空字符串」要严得多,
	 * 而且必须**在清单校验这一步**拦住 —— 放过去之后每一处都得自己防一遍。
	 */
	describe("id", () => {
		it.each(["bridge", "douyin-source", "x2"])("%s —— 收下", (id) => {
			expect(ExtensionManifestSchema.safeParse(manifest({ id })).success).toBe(true);
		});

		it.each([
			["..", "路径穿越:装载目录是 <dataDir>/extensions/<id>/"],
			[".", "同上"],
			["a/b", "斜杠会把 /ext/:id/* 劈成两段"],
			["a b", "空格进 URL 要转义,转义完就跟目录名对不上了"],
			["Bridge", "大写:macOS / Windows 的文件系统不分大小写,Bridge 与 bridge 会撞同一个目录"],
			["-lead", "连字符开头 / 结尾:肉眼难认,复制粘贴容易掉"],
			["trail-", "同上"],
			["a".repeat(65), "长度没上限的话它会变成一段没人读得完的 URL"],
			["", "空"],
		])("%s —— 拒(%s)", (id) => {
			expect(ExtensionManifestSchema.safeParse(manifest({ id })).success).toBe(false);
		});
	});

	it("清单必须自报宿主契约版本 —— 缺了就没法在执行之前判兼容", () => {
		const r = ExtensionManifestSchema.safeParse(manifest({ apiVersion: undefined }));
		expect(r.success).toBe(false);
	});

	/**
	 * 版本号是**失败记账的另一半**(ADR-0012 后果段:按 id + 版本记账,连续失败自动停用)。
	 * 记账的键要能比大小、要能一眼看出「换过版本了」,所以它得是个真 semver,不是随手一串。
	 */
	describe("version", () => {
		it.each(["1.0.0", "0.1.2", "1.0.0-alpha.1", "10.20.30"])("%s —— 收下", (version) => {
			expect(ExtensionManifestSchema.safeParse(manifest({ version })).success).toBe(true);
		});

		it.each(["1", "1.0", "v1.0.0", "latest", "1.0.0.0"])("%s —— 拒", (version) => {
			expect(ExtensionManifestSchema.safeParse(manifest({ version })).success).toBe(false);
		});
	});

	it("图标有长度上限 —— 清单是要进签名摘要、还要随列表发到面板的那份", () => {
		const small = `<svg viewBox="0 0 16 16"><path d="M0 0h16v16H0z"/></svg>`;
		expect(ExtensionManifestSchema.safeParse(manifest({ icon: small })).success).toBe(true);
		expect(ExtensionManifestSchema.safeParse(manifest({ icon: "x".repeat(64_001) })).success).toBe(
			false,
		);
	});

	it("多出来的字段丢掉而不是拒绝 —— 版本不合的拓展也得列得出来,才有地方写「为什么没加载」", () => {
		const r = ExtensionManifestSchema.safeParse(manifest({ futureField: "?" }));
		expect(r.success).toBe(true);
		expect(r.data).not.toHaveProperty("futureField");
	});

	it("开哪一口必须写清楚,而且不能一口都不开", () => {
		expect(ExtensionManifestSchema.safeParse(manifest({ provides: [] })).success).toBe(false);
		expect(
			ExtensionManifestSchema.safeParse(manifest({ provides: ["subscription"] })).success,
		).toBe(true);
		expect(
			ExtensionManifestSchema.safeParse(manifest({ provides: ["kitchen-sink"] })).success,
		).toBe(false);
	});
});
