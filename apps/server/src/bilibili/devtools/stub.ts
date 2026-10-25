import type { DevtoolsProvider } from "../../devtools/providers.js";
import type { BiliSourceDeps } from "../source.js";
import type { BiliDevtoolsDeps } from "./index.js";

/**
 * 构建产物里的 B 站 devtools —— 也就是没有。
 *
 * `apps/server/vite.config.ts` 在**任何**构建里把 `./bilibili/devtools/index.js` 解析到这个
 * 文件:恒交出空的一包场景、原样透传的两层壳,整个 `bilibili/devtools/` 从产物里连根消失,也不会去登记
 * 直播连接的观察钩子。签名照抄真的那份,类型从 `./index.js` 拿的是 `import type`,擦掉之后
 * 不会把真模块牵进来。
 */
export function createBiliDevtools(_deps: BiliDevtoolsDeps): {
	provider: DevtoolsProvider;
	devShells: NonNullable<BiliSourceDeps["devShells"]>;
} {
	return {
		provider: { scenarios: [] },
		devShells: { api: (real) => real, auth: (real) => real },
	};
}
