import tailwind from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type PluginOption } from "vite";

// 启动页(launcher)的 vite 工程。Tauri 侧接线在 src-tauri/tauri.conf.json:
// dev 用 devUrl 指到这里的 dev server(beforeDevCommand 拉起),build 产物落
// ../dist 由 frontendDist 消费。端口 strictPort —— devUrl 是写死的,漂了就白等。
// plugins 那句 `as PluginOption[]` 去不得。hoisted 布局下顶层 vite 槽被 koishi 的
// vite 5 占着,两个插件各自嵌套一份 Vite+ core 副本 —— 内容字节相同、路径不同,TS 就
// 当成两个身份,只能走结构比对并撑爆递归上限(TS2321 Excessive stack depth)。断言给了
// 目标类型,这段深比对就不做了。两个类型确实是兼容的(Plugin[] 本就是合法的
// PluginOption),所以这不是在盖住真错误。
// 注意只有断言有效:写成 `const plugins: PluginOption[] = [...]` 照样炸,报错只是挪到
// 那一行 —— 实测过,别改成那种「更干净」的写法。
// 这个错 `vp run typecheck` 抓不到(三个前端的 tsconfig 都只 include src),但**编辑器
// 会报**,所以必须在源码里治。scripts/vite-alias.test.mjs 钉住「每个前端的 vite 都是
// 同一份 core」那条不变量。
export default defineConfig({
	plugins: [react(), tailwind()] as PluginOption[],
	server: {
		port: 1421,
		strictPort: true,
	},
	build: {
		outDir: "dist",
	},
});
