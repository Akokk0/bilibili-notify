import tailwind from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// 启动页(launcher)的 vite 工程。Tauri 侧接线在 src-tauri/tauri.conf.json:
// dev 用 devUrl 指到这里的 dev server(beforeDevCommand 拉起),build 产物落
// ../dist 由 frontendDist 消费。端口 strictPort —— devUrl 是写死的,漂了就白等。
// before* 两条命令写的是 `../../node_modules/.bin/vp` 而不是裸 `vp`,别嫌啰嗦改回去:
// tauri 解析它们时会逐级向上收集 node_modules/.bin,而本仓嵌在另一个项目里,外层那份
// 旧 vp 会排在前面被选中(实测打出 VITE+ v0.2.1)。scripts/tauri-before-command.test.mjs
// 钉住这件事,那里写了完整的踩坑经过。
// 这里的 `vite` 经 pnpm-workspace.yaml 的作用域 override 解析到 Vite+ core;
// scripts/vite-alias.test.mjs 钉住「每个前端的 vite 都是同一份 core」那条不变量。
// (hoisted 年代这里的 plugins 必须 `as PluginOption[]`:同一份 core 在磁盘上有多份
// 副本,TS 把它们当成两个身份而撑爆递归上限。isolated 布局下只有一份,断言撤了。)
export default defineConfig({
	plugins: [react(), tailwind()],
	server: {
		port: 1421,
		strictPort: true,
	},
	build: {
		outDir: "dist",
	},
});
