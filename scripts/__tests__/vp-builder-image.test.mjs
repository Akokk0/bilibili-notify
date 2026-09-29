import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { repoRoot } from "../vite-alias.mjs";

/**
 * Docker builder 镜像跟着根 `vite-plus` 走,不用每次升级去改 Dockerfile:
 *
 * - 发版构建(`.github/actions/build-push-image-digest`)从根 package.json 读出 vite-plus 的
 *   精确版本,拼成 `VP_BUILDER_IMAGE` 以 build-arg 传进去 —— 所以根声明必须是精确版本,
 *   写成范围的话拼出来的 tag 根本不存在。
 * - Dockerfile 里的默认值只给本地手动 `docker build` 兜底,写大版本浮动 tag。它唯一需要
 *   手改的时候是 vite-plus 跨大版本,这里拦的就是那一次忘了改。
 */

const rootVitePlus = () =>
	JSON.parse(readFileSync(join(repoRoot(), "package.json"), "utf8")).devDependencies["vite-plus"];

const dockerfileBuilderTag = () => {
	const dockerfile = readFileSync(join(repoRoot(), "apps/Dockerfile"), "utf8");
	return dockerfile.match(/^ARG VP_BUILDER_IMAGE=ghcr\.io\/voidzero-dev\/vite-plus:(\S+)$/m)?.[1];
};

describe("Docker builder 镜像跟着根 vite-plus 走", () => {
	it("根 vite-plus 是精确版本(发版构建拿它直接拼镜像 tag)", () => {
		expect(rootVitePlus()).toMatch(/^\d+\.\d+\.\d+$/);
	});

	it("Dockerfile 默认值是根 vite-plus 的大版本浮动 tag", () => {
		const major = rootVitePlus().split(".")[0];
		expect(dockerfileBuilderTag()).toBe(major);
	});
});
