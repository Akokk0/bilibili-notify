import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 「每个前端的裸 `vite` 都解析到 Vite+ 的 core,koishi 那边仍是 vite 5」这条不变量的守卫。
 *
 * 本仓不能照抄 vite-plus README 的全局 `overrides: vite: npm:...` —— 那会把
 * @koishijs/client 的 vite 5 一起顶成 vite 8。所以 pnpm-workspace.yaml 里是**三条带
 * 作用域的** override,一个前端一条。漏掉任何一条,那个前端就静默拿到真 vite,
 * 而**构建和测试都不会报错**(真 vite 也能跑),只有到了运行期才见鬼。
 *
 * 原先钉住这件事的是 apps/desktop 把自己的 vite.config.ts 放进 tsconfig include
 * (ba62103e:「so the tailwind/react plugins type-check against one vite instance」)。
 * 那道闸已经废了:hoisted 布局下顶层 `node_modules/vite` 只能站一个版本,被 koishi 的
 * vite 5 占着,于是 @vitejs/plugin-react 和 @tailwindcss/vite 各自嵌套一份 core 副本。
 * 副本**字节相同、路径不同**,TS 就当成两个身份,`Plugin` 与 `PluginOption` 只能走结构
 * 比对并撑爆递归上限(TS2321 Excessive stack depth)。也就是说它对「版本对不对」根本
 * 不敏感,却会为「副本摆在哪」长期误报 —— 换成这里的直接断言,顺带把原先没人管的
 * apps/web 和 astrbot/page 一起覆盖了。
 */

/** 吃 Vite+ 的前端。新增前端要同步加进来,并在 pnpm-workspace.yaml 补一条 override。 */
export const VITE_PLUS_FRONTENDS = ["apps/web", "apps/desktop"];

/** override 把裸 `vite` 指向的真实包名。 */
export const VITE_PLUS_CORE = "@voidzero-dev/vite-plus-core";

/**
 * 判定一组「包 → 它解析到的 vite」是否满足不变量。纯函数,不碰磁盘。
 *
 * @param entries `{ pkg, resolved }[]`,resolved 为 `{ name, version }`,解析不到给 null
 * @returns 人话描述的问题清单;空数组 = 通过
 */
export function auditViteAlias(entries) {
	const problems = [];
	for (const { pkg, resolved } of entries) {
		if (resolved === null || resolved === undefined) {
			problems.push(`${pkg}: 解析不到 vite`);
			continue;
		}
		if (resolved.name !== VITE_PLUS_CORE) {
			// 最要紧的一条:漏了 override 就长这样,而且没有任何别的东西会报警。
			problems.push(
				`${pkg}: 解析到 ${resolved.name}(应为 ${VITE_PLUS_CORE}),多半是漏了一条 override`,
			);
		}
	}
	// 版本也要齐。三条 override 是分开写的,升级时漏改一条会让前端之间版本劈叉,
	// 那正是 pnpm-workspace.yaml 里 lockstep 第 2 条防的事。
	const versions = new Set(
		entries.filter((e) => e.resolved?.name === VITE_PLUS_CORE).map((e) => e.resolved.version),
	);
	if (versions.size > 1) {
		problems.push(`前端之间 ${VITE_PLUS_CORE} 版本不一致: ${[...versions].sort().join(", ")}`);
	}
	return problems;
}

/** 从 `dir` 出发按 Node 语义解析裸 `vite`,返回 `{ name, version }`;解析不到给 null。 */
export function resolveViteFrom(dir) {
	try {
		const require = createRequire(join(dir, "package.json"));
		const manifest = require("vite/package.json");
		return { name: manifest.name, version: manifest.version };
	} catch {
		return null;
	}
}

/** 仓库根。 */
export function repoRoot() {
	return dirname(dirname(fileURLToPath(import.meta.url)));
}
