import { describe, expect, it } from "vite-plus/test";
import { buildPublishArgs, resolveDistTag } from "./publish.mjs";

describe("resolveDistTag", () => {
	it("pre 模式返回 pre.json 里的 tag", () => {
		expect(resolveDistTag({ mode: "pre", tag: "alpha" })).toBe("alpha");
		expect(resolveDistTag({ mode: "pre", tag: "next" })).toBe("next");
	});

	it("退出 pre 模式后回到 latest", () => {
		expect(resolveDistTag({ mode: "exit", tag: "alpha" })).toBe("latest");
	});

	it("没有 pre.json 时为 latest", () => {
		expect(resolveDistTag(null)).toBe("latest");
		expect(resolveDistTag(undefined)).toBe("latest");
	});

	it("pre 模式但缺 tag 字段时回退 latest", () => {
		expect(resolveDistTag({ mode: "pre" })).toBe("latest");
	});
});

describe("buildPublishArgs", () => {
	it("基础参数:recursive + tag + access public + no-git-checks", () => {
		expect(buildPublishArgs({ tag: "latest", provenance: false })).toEqual([
			"publish",
			"-r",
			"--tag",
			"latest",
			"--access",
			"public",
			"--no-git-checks",
		]);
	});

	it("provenance 为 true 时追加 --provenance", () => {
		expect(buildPublishArgs({ tag: "alpha", provenance: true })).toContain("--provenance");
	});

	it("provenance 为 false 时不带 --provenance", () => {
		expect(buildPublishArgs({ tag: "alpha", provenance: false })).not.toContain("--provenance");
	});
});
