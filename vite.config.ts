// 测试 runtime 全部从 `vite-plus/test` import(vite-plus 0.2.x 把 vitest API 正式
// re-export),configDefaults 也走 vite-plus,故本仓测试代码对 vitest 零直接 import。
// 但 package.json **仍保留** `vitest` 直接依赖,删不得:本仓 nodeLinker:hoisted +
// koishi 锁 vite5,顶层 hoist 的就是 vite5(无 `vite/module-runner`)。root 直接声明
// vitest 是 lockfile 把 vite6 精确喂给 vitest 的锚点;删掉后重解析会让 vitest 落到
// 顶层 vite5 → 测试启动即 ERR_PACKAGE_PATH_NOT_EXPORTED。
import { configDefaults, defineConfig } from "vite-plus";

export default defineConfig({
	test: {
		// worktree 放在 .claude/worktrees 内,会被 vp 的文件系统测试发现扫到(包含其它
		// 分支的整个包副本),从仓库根跑 `vp test` 会把那些副本也跑一遍。在 vitest 默认
		// 排除基础上追加 .claude,只跑当前分支自己的测试。
		exclude: [...configDefaults.exclude, "**/.claude/**"],
	},
});
