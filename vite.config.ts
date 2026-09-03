// 测试 runtime 全部从 `vite-plus/test` import(vite-plus 0.2.x 把 vitest API 正式
// re-export),configDefaults 也走 vite-plus,故本仓测试代码对 vitest 零直接 import,
// package.json 也不声明 vitest —— vite-plus 精确锁定并自带一份;root 再声明一个不同
// 版本只会装出第二份(见 pnpm-workspace.yaml 的 lockstep 注释)。
// 历史:hoisted 布局年代顶层 vite 槽被 koishi 控制台的 vite 5 占着,root 直接声明 vitest
// 是让 pnpm 给它嵌套一份 vite 6 的锚点。koishi 与 hoisted 都已不在,锚点随之撤掉。
import { configDefaults, defineConfig } from "vite-plus";

export default defineConfig({
	test: {
		// worktree 放在 .claude/worktrees 内,会被 vp 的文件系统测试发现扫到(包含其它
		// 分支的整个包副本),从仓库根跑 `vp test` 会把那些副本也跑一遍。在 vitest 默认
		// 排除基础上追加 .claude,只跑当前分支自己的测试。
		exclude: [...configDefaults.exclude, "**/.claude/**"],
	},
});
