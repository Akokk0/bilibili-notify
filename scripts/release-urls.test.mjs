import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import {
	extensionAssetName,
	extensionPackageUrl,
	extensionReleaseUrl,
	extensionTag,
	payloadAssetName,
	payloadUrl,
	releaseUrl,
} from "./release-urls.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");

/**
 * 发版链两端隔着好几天才各跑一次,名字对不上时谁都不会红。所以这里不是「测函数返回
 * 什么」,而是**去那几个文件里核对它们还在说同一件事** —— 改了资产名却漏改某一处,
 * 这几条立刻红。
 */
describe("载荷资产名只有一份声明", () => {
	// workflow 里 VERSION / REPO 是 shell 变量,核对时按同一份公式代入。写成模板拼接
	// 而不是字面量,免得 lint 把 `${…}` 当成写漏的模板字面量。
	const shellVar = (name) => `$\{${name}}`;
	const withVersion = (s) => s.replaceAll("0.0.0", shellVar("VERSION"));

	it("update-payload.yml 打包与签清单用的名字与声明一致", () => {
		const wf = read(".github/workflows/update-payload.yml");
		expect(wf).toContain(withVersion(payloadAssetName("0.0.0")));
		expect(wf).toContain(withVersion(payloadUrl(shellVar("REPO"), "0.0.0")));
		expect(wf).toContain(withVersion(releaseUrl(shellVar("REPO"), "0.0.0")));
	});

	it("release 正文里给用户念的那个文件名也一致", () => {
		const sh = read(".github/scripts/create-standalone-github-release.sh");
		expect(sh).toContain(withVersion(payloadAssetName("0.0.0")));
	});

	it("撤回脚本不再自己拼 URL", () => {
		const js = read("scripts/revocation.mjs");
		expect(js).toContain("release-urls.mjs");
		expect(js).not.toContain("releases/download");
	});
});

describe("拼出来的地址", () => {
	it("资产名进 download 链接,tag 链接只带版本", () => {
		expect(payloadUrl("Akokk0/bilibili-notify", "0.9.0")).toBe(
			"https://github.com/Akokk0/bilibili-notify/releases/download/v0.9.0/bilibili-notify-payload-0.9.0.zip",
		);
		expect(releaseUrl("Akokk0/bilibili-notify", "0.9.0")).toBe(
			"https://github.com/Akokk0/bilibili-notify/releases/tag/v0.9.0",
		);
	});

	it("拓展的 tag 带 `/` 与 `@`,进 URL 要整段转义;`gh` 那头要的是原样", () => {
		expect(extensionTag("bridge", "0.0.2")).toBe("ext/bridge@0.0.2");
		expect(extensionAssetName("bridge", "0.0.2")).toBe("bridge-0.0.2.zip");
		expect(extensionPackageUrl("o/r", "bridge", "0.0.2")).toBe(
			"https://github.com/o/r/releases/download/ext%2Fbridge%400.0.2/bridge-0.0.2.zip",
		);
		expect(extensionReleaseUrl("o/r", "bridge", "0.0.2")).toBe(
			"https://github.com/o/r/releases/tag/ext%2Fbridge%400.0.2",
		);
	});
});

/** 同上一段的理由:拓展那条链也是「发布那天」与「客户端下载那天」隔开的。 */
describe("拓展包的名字只有一份声明", () => {
	const shellVar = (name) => `$\{${name}}`;
	const wf = () => read(".github/workflows/extension-release.yml");

	it("workflow 不再自己拼资产名与下载地址", () => {
		expect(wf()).not.toContain("releases/download");
		expect(wf()).not.toContain(extensionAssetName(shellVar("ID"), shellVar("VERSION")));
	});

	it("`gh release create` 用的 tag 与声明的是同一个形状", () => {
		expect(wf()).toContain(`tag="${extensionTag(shellVar("ID"), shellVar("VERSION"))}"`);
	});

	it("打包脚本的默认输出名也来自这份声明", () => {
		expect(read("scripts/pack-extension.mjs")).toContain("extensionAssetName");
	});
});
