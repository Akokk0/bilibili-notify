import { strFromU8, strToU8 } from "fflate";
import { describe, expect, it } from "vite-plus/test";
import { EXTENSION_DOC_MAX_BYTES as LOADER_DOC_MAX_BYTES } from "../apps/server/src/extensions/discover.js";
import { openExtensionPackage } from "../apps/server/src/extensions/install.js";
import { EXTENSION_DOC_MAX_BYTES, packExtension } from "./pack-extension.mjs";

/** 发版侧打的包,装载那头得拆得开 —— 两边各测各的,等于两边各自复述自己的想法。 */
describe("packExtension", () => {
	const files = {
		"extension.json": strToU8(
			JSON.stringify({
				id: "bridge",
				name: "机器人框架桥接",
				description: "x",
				version: "0.0.2",
				apiVersion: 1,
				provides: ["push"],
			}),
		),
		"index.mjs": strToU8("export default { activate() {} };"),
	};

	it("打出来的 zip 装载那头拆得开;同样的产物打出同样的字节(sha256 可复现)", () => {
		const a = packExtension(files);
		const b = packExtension(files);
		expect(a.sha256).toBe(b.sha256);
		expect(a.size).toBe(a.zip.byteLength);
		const opened = openExtensionPackage(a.zip);
		expect(opened.ok).toBe(true);
		if (opened.ok) expect(opened.pkg.manifest.version).toBe("0.0.2");
	});

	/**
	 * 文档跟着包走 —— 官方拓展发出去那一刻就得带上,不然市场上装下来还是没有说明。
	 * 两份都可选:不带照样打得出来。
	 */
	it("带上 README / CHANGELOG 就打进包,装载那头拆得出来", () => {
		const withDocs = packExtension({
			...files,
			"README.md": strToU8("# 机器人框架桥接"),
			"CHANGELOG.md": strToU8("## [0.0.2]"),
		});
		const opened = openExtensionPackage(withDocs.zip);
		expect(opened.ok).toBe(true);
		if (!opened.ok) return;
		expect(strFromU8(opened.pkg.docs.readme)).toContain("机器人框架桥接");
		expect(strFromU8(opened.pkg.docs.changelog)).toContain("[0.0.2]");
		// 带了文档,sha256 照样得可复现 —— 索引里钉的就是它。
		expect(packExtension({ ...files, "README.md": strToU8("# 机器人框架桥接") }).sha256).toBe(
			packExtension({ ...files, "README.md": strToU8("# 机器人框架桥接") }).sha256,
		);
	});

	it("不带文档也打得出来 —— 文档是可选的", () => {
		const opened = openExtensionPackage(packExtension(files).zip);
		expect(opened.ok).toBe(true);
		if (opened.ok) expect(opened.pkg.docs.readme).toBeUndefined();
	});

	/**
	 * 🔴 **这道闸必须在打包这头,不能只在拆包那头。** 只有拆包拦的话:README 涨过上限 →
	 * CI 全绿 → 建**不可变**的 release、sha256 进签名索引 → 此后每个用户点安装都得到
	 * 「包拆不开」,而条目钉死在那个 release 上,只能升版号重发。构建全绿、只在用户那儿炸,
	 * 正是这个仓最怕的那一种。
	 */
	it("文档过大 → 当场拒,不发一个装不上的包出去", () => {
		const huge = new Uint8Array(LOADER_DOC_MAX_BYTES + 1);
		expect(() => packExtension({ ...files, "README.md": huge })).toThrow(/README\.md/);
	});

	/** 两头各写一份数,漂了就是「打得进、拆不开」—— 所以两头对着钉。 */
	it("打包这头的上限与装载那头是同一个数", () => {
		expect(EXTENSION_DOC_MAX_BYTES).toBe(LOADER_DOC_MAX_BYTES);
	});

	it("缺一个文件就拒", () => {
		expect(() => packExtension({ "index.mjs": files["index.mjs"] })).toThrow(/extension\.json/);
	});
});
