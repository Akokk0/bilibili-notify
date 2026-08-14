import tailwind from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// 启动页(launcher)的 vite 工程。Tauri 侧接线在 src-tauri/tauri.conf.json:
// dev 用 devUrl 指到这里的 dev server(beforeDevCommand 拉起),build 产物落
// ../dist 由 frontendDist 消费。端口 strictPort —— devUrl 是写死的,漂了就白等。
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
