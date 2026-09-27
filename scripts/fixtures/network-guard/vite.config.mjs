import { defineConfig, mergeConfig } from "vite-plus";
import rootConfig from "../../../vite.config.ts";

// scripts/network-guard.test.mjs 的接线夹具:沿用根配置(含 setupFiles 里的测试拦外网),
// 只把要跑的文件换成本目录的夹具 —— 夹具不叫 *.test.*,根配置的全量运行不会碰它们。
export default mergeConfig(
	rootConfig,
	defineConfig({ test: { include: ["scripts/fixtures/network-guard/*.fixture.mjs"] } }),
);
