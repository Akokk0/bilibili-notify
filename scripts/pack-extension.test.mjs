import { strToU8 } from "fflate";
import { describe, expect, it } from "vite-plus/test";
import { openExtensionPackage } from "../apps/server/src/extensions/install.js";
import { packExtension } from "./pack-extension.mjs";

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

	it("缺一个文件就拒", () => {
		expect(() => packExtension({ "index.mjs": files["index.mjs"] })).toThrow(/extension\.json/);
	});
});
