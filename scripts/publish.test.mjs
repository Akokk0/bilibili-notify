import { describe, expect, it } from "vite-plus/test";
import { buildPublishArgs, isAlreadyPublished, resolveDistTag } from "./publish.mjs";

/**
 * changesets 已弃用(内部包不再发 npm,只剩 koishi 一个包要发)。dist-tag 不再从
 * .changeset/pre.json 读,改为**从版本号自己推导** —— 与独立端的 v<VERSION> tag
 * 方案同一套心智:prerelease → 用它的 id 作 tag(5.0.0-alpha.9 → alpha),纯 semver
 * → latest。
 *
 * 幂等同样关键:发布挂在 push dev 上,由 `koishi-version-changed.mjs` 判「版本号变了」
 * 才启动 —— 但那只是省 CI 的快速门,workflow 被**重跑**时它会再判一次 changed。所以
 * 发布前还得问一次 registry,版本已存在就安静跳过,不能让 npm 的「版本已存在」把 CI 染红。
 */
describe("resolveDistTag", () => {
	it("prerelease 版本用它自己的 id 作 dist-tag", () => {
		expect(resolveDistTag("5.0.0-alpha.9")).toBe("alpha");
		expect(resolveDistTag("5.0.0-beta.1")).toBe("beta");
		expect(resolveDistTag("6.0.0-rc.0")).toBe("rc");
	});

	it("纯 semver 发到 latest", () => {
		expect(resolveDistTag("5.0.0")).toBe("latest");
		expect(resolveDistTag("5.1.2")).toBe("latest");
	});

	it("带 build 元数据不影响判定", () => {
		expect(resolveDistTag("5.0.0+build.1")).toBe("latest");
		expect(resolveDistTag("5.0.0-alpha.1+build.1")).toBe("alpha");
	});

	it("prerelease 段没有可用 id 时回退 latest(绝不误发 latest 之外的怪 tag)", () => {
		expect(resolveDistTag("5.0.0-1")).toBe("latest");
	});
});

describe("isAlreadyPublished", () => {
	it("registry 上已有该版本 → 跳过", () => {
		expect(isAlreadyPublished(["5.0.0-alpha.8", "5.0.0-alpha.9"], "5.0.0-alpha.9")).toBe(true);
	});

	it("registry 上没有 → 发布", () => {
		expect(isAlreadyPublished(["5.0.0-alpha.8"], "5.0.0-alpha.9")).toBe(false);
	});

	it("包还没发过(拿不到版本列表)→ 发布", () => {
		expect(isAlreadyPublished(null, "5.0.0-alpha.9")).toBe(false);
		expect(isAlreadyPublished([], "5.0.0-alpha.9")).toBe(false);
	});
});

describe("buildPublishArgs", () => {
	it("只发 koishi 一个包:npm publish + tag + access public", () => {
		expect(buildPublishArgs({ tag: "latest", provenance: false })).toEqual([
			"publish",
			"--tag",
			"latest",
			"--access",
			"public",
		]);
	});

	it("provenance 为 true 时追加 --provenance", () => {
		expect(buildPublishArgs({ tag: "alpha", provenance: true })).toContain("--provenance");
	});

	it("provenance 为 false 时不带 --provenance", () => {
		expect(buildPublishArgs({ tag: "alpha", provenance: false })).not.toContain("--provenance");
	});
});
