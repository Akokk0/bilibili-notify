// 测试 runtime 全部从 `vite-plus/test` import(vite-plus 0.2.x 把 vitest API 正式
// re-export),configDefaults 也走 vite-plus,故本仓测试代码对 vitest 零直接 import。
// 但 package.json **仍保留** `vitest` 直接依赖,删不得:本仓 nodeLinker:hoisted +
// koishi 锁 vite5,顶层 hoist 的就是 vite5(无 `vite/module-runner`)。root 直接声明
// vitest 是 lockfile 把 vite6 精确喂给 vitest 的锚点;删掉后重解析会让 vitest 落到
// 顶层 vite5 → 测试启动即 ERR_PACKAGE_PATH_NOT_EXPORTED。
//
// 「vite-plus 自己就依赖 vitest,root 这条是不是冗余了?」—— 不是。vite-plus 0.2.4 确实
// 把 vitest 列为**直接 dependency**,但那只保证 vitest 存在,不保证它拿到对的 vite:
// vitest 的 vite peer 是 ^6||^7||^8,而 hoisted 布局下顶层只有 koishi 的 vite5。root
// 声明 vitest 才让 pnpm 给它嵌套一份自己的 vite6(node_modules/vitest/node_modules/vite)。
//
// **这个坑测不出来,除非你铲掉 node_modules。**删掉 root vitest 后 `vp install` 是绿的、
// `vp test` 245 个文件全过 —— 因为既有 node_modules / lockfile 里还留着旧的正确嵌套。
// 只有 `rm -rf node_modules pnpm-lock.yaml` 重装才会现形(2026-07 在 0.2.4 上实测复现)。
// 也就是说这个改动能骗过本机全部门禁,然后在 CI 的干净克隆上启动即炸。
import { configDefaults, defineConfig } from "vite-plus";

export default defineConfig({
	test: {
		// worktree 放在 .claude/worktrees 内,会被 vp 的文件系统测试发现扫到(包含其它
		// 分支的整个包副本),从仓库根跑 `vp test` 会把那些副本也跑一遍。在 vitest 默认
		// 排除基础上追加 .claude,只跑当前分支自己的测试。
		exclude: [...configDefaults.exclude, "**/.claude/**"],
	},
});
