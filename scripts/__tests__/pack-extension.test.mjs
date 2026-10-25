import { strFromU8, strToU8 } from "fflate";
import { describe, expect, it } from "vite-plus/test";
import { EXTENSION_DOC_MAX_BYTES as LOADER_DOC_MAX_BYTES } from "../../apps/server/src/extensions/discover.js";
import {
	MAX_EXTENSION_PACKAGE_BYTES as LOADER_PACKAGE_MAX_BYTES,
	openExtensionPackage,
} from "../../apps/server/src/extensions/install.js";
import {
	EXTENSION_LOCALE_FILE_MAX_BYTES as LOADER_LOCALE_FILE_MAX_BYTES,
	EXTENSION_LOCALES_TOTAL_MAX_BYTES as LOADER_LOCALES_TOTAL_MAX_BYTES,
} from "../../apps/server/src/extensions/locales.js";
import { LOCALES } from "../../packages/internal/src/i18n.ts";
import {
	EXTENSION_DOC_MAX_BYTES,
	EXTENSION_LOCALE_FILE_MAX_BYTES,
	EXTENSION_LOCALES_TOTAL_MAX_BYTES,
	EXTENSION_PACKAGE_LOCALES,
	EXTENSION_PACKAGE_MAX_BYTES,
	packExtension,
} from "../pack-extension.mjs";

/** 发版侧打的包,装载那头得拆得开 —— 两边各测各的,等于两边各自复述自己的想法。 */
describe("packExtension", () => {
	const files = {
		"extension.json": strToU8(
			JSON.stringify({
				id: "bridge",
				name: "机器人框架桥接",
				description: "x",
				version: "0.0.2",
				apiVersion: 3,
				contributes: { push: { label: "桥接", shortLabel: "桥", color: "#fb7299" } },
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
	});

	describe("译文", () => {
		const locales = {
			"locales/zh-CN.json": strToU8('{"status.connected":"已连接"}'),
			"locales/en.json": strToU8('{"status.connected":"Connected"}'),
		};

		it("带上 locales/ 就打进包,装载那头拆得出来", () => {
			const opened = openExtensionPackage(packExtension({ ...files, ...locales }).zip);
			expect(opened.ok).toBe(true);
			if (!opened.ok) return;
			expect(strFromU8(opened.pkg.locales["zh-CN"])).toContain("已连接");
			expect(strFromU8(opened.pkg.locales.en)).toContain("Connected");
		});

		it("译文不是 JSON → 当场拒", () => {
			expect(() =>
				packExtension({ ...files, "locales/zh-CN.json": strToU8('{"status.connected":') }),
			).toThrow(/locales\/zh-CN\.json/);
		});

		it("一份译文超过 256 KB → 当场拒", () => {
			expect(() =>
				packExtension({ ...files, "locales/zh-CN.json": new Uint8Array(256 * 1024 + 1) }),
			).toThrow(/locales\/zh-CN\.json/);
		});

		it("locales/ 合计超过 2 MB → 当场拒", () => {
			const huge = {};
			for (const code of ["ko", "fr", "de", "es", "it", "pt", "ru", "ar", "hi"]) {
				huge[`locales/${code}.json`] = strToU8(JSON.stringify({ text: "x".repeat(250 * 1024) }));
			}
			expect(() => packExtension({ ...files, ...huge })).toThrow(/locales\//);
		});

		it("只打语言表里的语言码", () => {
			const opened = openExtensionPackage(
				packExtension({
					...files,
					...locales,
					"locales/ko.json": strToU8('{"hello":"안녕"}'),
				}).zip,
			);
			expect(opened.ok).toBe(true);
			if (!opened.ok) return;
			expect(Object.keys(opened.pkg.locales).sort()).toEqual(["en", "zh-CN"]);
		});
	});

	/**
	 * 🔴 **同一进程里把同样的输入打两次,只证明了 `packExtension` 是个纯函数。**
	 *
	 * 索引里钉的 sha256 要在**别的机器、别的时刻、别的键序**下也对得上,而那三样这里一样
	 * 都量不到:把固定时间戳换成 `new Date()`(DOS 时间 2 秒精度,同一次调用里当然相等),
	 * 或者把文档的固定顺序换成「按调用方给的键序」,原先那条都照样绿。下面两条各钉一头。
	 */
	it("键序不影响字节 —— 调用方怎么摆都打出同一份包", () => {
		const a = packExtension({
			"README.md": strToU8("# 说明"),
			"CHANGELOG.md": strToU8("## [0.0.2]"),
			...files,
		});
		const b = packExtension({
			...files,
			"CHANGELOG.md": strToU8("## [0.0.2]"),
			"README.md": strToU8("# 说明"),
		});
		expect(a.sha256).toBe(b.sha256);
	});

	/**
	 * 时间戳钉死:摘要写成字面量,换成 `new Date()` 当场红。
	 *
	 * 拿字面量而不是现算 —— 现算等于拿实现复述实现。四个时区(UTC / 东八 / 西五 / +14)
	 * 实跑过同一个值,`reproducible-zip.mjs` 的 `asLocalFields` 正是为此存在的。
	 * 夹具内容变了这条也会红:那时候把新值填回来就是,别改成现算。
	 */
	it("同样的输入永远打出同样的字节", () => {
		expect(packExtension(files).sha256).toBe(
			"0bfff187d7aa62e61b56b63021a7fc346158a2ab50c651ce780e68d2fae18c02",
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
		expect(EXTENSION_LOCALE_FILE_MAX_BYTES).toBe(LOADER_LOCALE_FILE_MAX_BYTES);
		expect(EXTENSION_LOCALES_TOTAL_MAX_BYTES).toBe(LOADER_LOCALES_TOTAL_MAX_BYTES);
		expect(EXTENSION_PACKAGE_MAX_BYTES).toBe(LOADER_PACKAGE_MAX_BYTES);
		expect(EXTENSION_PACKAGE_LOCALES).toEqual([...LOCALES]);
	});

	it("缺一个文件就拒", () => {
		expect(() => packExtension({ "index.mjs": files["index.mjs"] })).toThrow(/extension\.json/);
	});
});
