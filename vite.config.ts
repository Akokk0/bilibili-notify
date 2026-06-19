import { defineConfig } from "vite-plus";
import { configDefaults } from "vitest/config";

export default defineConfig({
	test: {
		// worktree 放在 .claude/worktrees 内,会被 vp 的文件系统测试发现扫到(包含其它
		// 分支的整个包副本),从仓库根跑 `vp test` 会把那些副本也跑一遍。在 vitest 默认
		// 排除基础上追加 .claude,只跑当前分支自己的测试。
		exclude: [...configDefaults.exclude, "**/.claude/**"],
	},
});
