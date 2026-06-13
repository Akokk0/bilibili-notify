import { readFileSync } from "node:fs";
import tailwind from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const pagePkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as {
	version: string;
};
const pageVersion = process.env.BN_ASTRBOT_PAGE_VERSION || pagePkg.version;

export default defineConfig({
	base: "./",
	define: {
		__ASTRBOT_PAGE_VERSION__: JSON.stringify(pageVersion),
	},
	plugins: [react(), tailwind()],
	build: {
		outDir: "../core/pages/dashboard",
		emptyOutDir: true,
		assetsDir: "assets",
		// 稳定文件名(不带 content-hash):产物是 checked-in 的,hash 命名会让每次重建变成
		// 删旧+加新的 git churn、跨分支合并还堆陈旧资产。AstrBot 经短时 asset token 做 cache-bust,
		// 不依赖文件名 hash,故稳定名安全。
		rollupOptions: {
			output: {
				entryFileNames: "assets/[name].js",
				chunkFileNames: "assets/[name].js",
				assetFileNames: "assets/[name][extname]",
			},
		},
	},
	server: {
		port: 5174,
		proxy: {
			"/api": {
				target: "http://127.0.0.1:8787",
				configure(proxy) {
					proxy.on("error", (err, _req, res) => {
						if ("writeHead" in res && !res.headersSent) {
							res.writeHead(503, { "content-type": "application/json" });
							res.end(
								JSON.stringify({
									error: "sidecar_unreachable",
									message: `AstrBot sidecar (127.0.0.1:8787) 未启动: ${err.message}`,
								}),
							);
						}
					});
				},
			},
		},
	},
});
