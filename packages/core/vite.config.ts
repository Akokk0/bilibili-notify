import { resolve } from "node:path";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

const root = import.meta.dirname;

export default defineConfig({
	plugins: [vue()],
	root,
	build: {
		outDir: resolve(root, "dist"),
		emptyOutDir: true,
		lib: {
			entry: resolve(root, "client/index.ts"),
			formats: ["es"],
			fileName: "index",
		},
		rollupOptions: {
			external: ["vue", "@koishijs/client"],
		},
	},
});
