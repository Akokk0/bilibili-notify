import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * 从某个目录往上找最近的 `package.json`。
 *
 * bundle 形态一步就到(产物是平的,`package.json` 与 `index.mjs` 同级);源码 / dev
 * 形态要从 `src/routes/` 往上爬两层才够到 `apps/server/package.json`;桌面壳把 `lib/`
 * 外置,再往上一层。`maxDepth` 是刹车:找不到就认输回 `null`,绝不一路爬到 `/` 去捡
 * 别人的 `package.json` —— 报一个别的包的版本号比报 "dev" 更能骗人。
 *
 * 只牵 node 内建:`boot.mjs` 那个入口也用它(读镜像自带的版本号),而那个入口存在的
 * 全部意义就是在加载服务端之前只牵最少的东西 —— 它刻意不 import `routes/health.ts`。
 */
export function findNearestPackageJson(startDir: string, maxDepth: number): string | null {
	let dir = startDir;
	for (let i = 0; i <= maxDepth; i++) {
		const candidate = join(dir, "package.json");
		if (existsSync(candidate)) return candidate;
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
	return null;
}
