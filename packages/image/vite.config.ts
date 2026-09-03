import { defineConfig } from "vite-plus";

export default defineConfig({
	pack: {
		entry: ["src/index.ts"],
		format: ["esm"],
		dts: true,
		clean: true,
		outDir: "lib",
		exports: true,
		// 这里**刻意不开 `shims`**。
		//
		// 曾经开着:image-renderer.ts 用裸 `__dirname` 去找 static/*.js(词云脚本),
		// 而这个包是 ESM,源码里没有那个变量,靠 shims 给产物注入一个补上。
		// 代价是它只补产物 —— dev 服务器把工作区包直接映到各包的 src,tsx 加载的是
		// 源码,于是「生成词云」在开发时必炸而生产全绿,查起来极其别扭。
		//
		// 现在改成 `dirname(fileURLToPath(import.meta.url))`(见 image-renderer.ts 的
		// ASSET_DIR),源码与两种产物都成立,不需要任何注入。有一条测试盯着源码里
		// 不许再出现裸 `__dirname`。
		deps: { onlyBundle: false },
		copy: [{ from: "src/static", to: "lib" }],
	},
});
