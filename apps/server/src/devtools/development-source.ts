import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { EXTENSION_API_RANGE, fail, ok } from "@bilibili-notify/internal";
import { manifestWithSettingsFields } from "@bilibili-notify/internal/extension/build";
import { createServer } from "@voidzero-dev/vite-plus-core";
import type { DevelopmentExtensionEntry } from "../extensions/discover.js";
import { parseHostExtensionManifest } from "../extensions/identity.js";

/** 每工程一个源码模块环境；不加载作者的打包配置、不监听HTTP、不输出dist。 */
export async function openDevelopmentSource(
	directory: string,
	reservedKeys: readonly string[],
	changed: () => void,
) {
	const server = await createServer({
		root: directory,
		configFile: false,
		envFile: false,
		publicDir: false,
		appType: "custom",
		mode: "development",
		logLevel: "silent",
		server: {
			middlewareMode: true,
			hmr: false,
			ws: false,
			watch: { ignored: ["**/dist/**", "**/artifacts/**", "**/.bn/**"] },
		},
		optimizeDeps: { noDiscovery: true, include: [] },
	});
	const onChange = (event: string, file: string) => {
		const path = relative(directory, file).replaceAll("\\", "/");
		if (
			["extension.json", "tsconfig.json", "package.json"].includes(path) ||
			path.startsWith("locales/") ||
			server.moduleGraph.getModulesByFile(file)?.size ||
			(event === "add" && path.startsWith("src/"))
		)
			changed();
	};
	server.watcher.on("all", onChange);
	return {
		async read() {
			try {
				const raw: unknown = JSON.parse(await readFile(join(directory, "extension.json"), "utf8"));
				const basic = parseHostExtensionManifest(raw, EXTENSION_API_RANGE, reservedKeys);
				if (!basic.ok) return fail("invalid", "工程清单无效或与宿主契约不兼容");
				server.moduleGraph.invalidateAll();
				const mod = await server.ssrLoadModule("/src/index.ts");
				if (typeof mod.activate !== "function")
					return fail("invalid", "src/index.ts需要具名导出activate()");
				const checked = parseHostExtensionManifest(
					manifestWithSettingsFields(raw, mod),
					EXTENSION_API_RANGE,
					reservedKeys,
				);
				if (!checked.ok) return fail("invalid", "源码导出的设置与清单无效");
				const entry: DevelopmentExtensionEntry = {
					entry: join(directory, "src/index.ts"),
					manifest: checked.manifest,
					revision: randomUUID(),
					load: async () => mod,
				};
				return ok({ entry });
			} catch (error) {
				return fail(
					"invalid",
					`开发拓展源码加载失败：${error instanceof Error ? error.message : String(error)}`,
				);
			}
		},
		devtools: () => server.ssrLoadModule("/src/devtools/index.ts"),
		async dispose() {
			server.watcher.off("all", onChange);
			await server.close();
		},
	};
}
