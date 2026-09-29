import { defineConfig, mergeConfig } from "vite-plus";
import rootConfig from "../../../../vite.config.ts";

// scripts/__tests__/error-body-guard.test.mjs 的接线夹具:沿用根配置(含 setupFiles 里的错误体守卫),
// 把要跑的文件换成本目录的夹具(不叫 *.test.*,根配置的全量运行不会碰它们),并把守卫认作
// 「服务端源码」的根指到本目录的 server/ —— 夹具本身不在 apps/server/src 底下。
export default mergeConfig(
	rootConfig,
	defineConfig({
		test: {
			include: ["scripts/__tests__/fixtures/error-body-guard/*.fixture.mjs"],
			env: {
				BN_ERROR_BODY_GUARD_SERVER_ROOT: "scripts/__tests__/fixtures/error-body-guard/server",
			},
		},
	}),
);
