import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { DevtoolsProvider, Logger } from "@bilibili-notify/internal";
import type {
	ExtensionContext,
	ExtensionDevtoolsContext,
} from "@bilibili-notify/internal/extension";
import { EXTENSION_DEVTOOLS_ENTRY_FILE } from "../extensions/discover.js";
import { extensionMountPrefix } from "../extensions/mount.js";
import { errorMessageOf } from "../util/error-message.js";
import type { DevtoolsProviderRegistry } from "./providers.js";

export interface DevEntryAttacherOptions {
	providers: Pick<DevtoolsProviderRegistry, "claim">;
	address: () => string | undefined;
	/** 不给就用这个拓展自己的日志器;宿主入口走后者。 */
	logger?: Logger;
	/** 只给测试换掉动态 import。 */
	importModule?: (specifier: string) => Promise<unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
	return (
		((typeof value === "object" && value !== null) || typeof value === "function") &&
		typeof (value as { then?: unknown }).then === "function"
	);
}

/** 返回第一处不合规的原因;通过就是 undefined。 */
function invalidProvider(value: unknown): string | undefined {
	if (!isRecord(value) || !Array.isArray(value.scenarios)) {
		return "devtools() 要交回带 scenarios 数组的 provider";
	}
	for (const scenario of value.scenarios) {
		if (!isRecord(scenario)) return "scenarios 里有不是对象的条目";
		const id = typeof scenario.id === "string" ? scenario.id : "(没有 id)";
		if (typeof scenario.run !== "function") return `场景 ${id} 没有 run()`;
		if (!Array.isArray(scenario.params)) return `场景 ${id} 的 params 不是数组`;
		for (const param of scenario.params) {
			if (!isRecord(param)) return `场景 ${id} 有不是对象的参数`;
			const key = typeof param.key === "string" ? param.key : "(没有 key)";
			if (param.kind !== "text" && param.kind !== "number" && param.kind !== "enum") {
				return `场景 ${id} 的参数 ${key} 是 ${String(param.kind)};开发入口只收 text / number / enum`;
			}
		}
	}
	return undefined;
}

/**
 * 造装载器在拓展启动后调的那一条钩子。
 *
 * 入口文件名由宿主定;每次按文件内容指纹 import,文件变了 URL 才变。开发 provider 与
 * 拓展共用 `ctx.signal`:停用、卸载、重载都会经 registry 的 dispose 撤下它的场景。
 */
export function createDevEntryAttacher(options: DevEntryAttacherOptions) {
	const importModule = options.importModule ?? ((specifier: string) => import(specifier));

	return async (started: { id: string; dir: string; ctx: ExtensionContext }): Promise<void> => {
		if (started.ctx.signal.aborted) return;
		const logger = options.logger ?? started.ctx.logger;
		const file = join(started.dir, EXTENSION_DEVTOOLS_ENTRY_FILE);
		let source: Buffer;
		try {
			source = await readFile(file);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") {
				logger.info(`没有 ${EXTENSION_DEVTOOLS_ENTRY_FILE};发行包不带开发入口,不挂开发场景`);
				return;
			}
			logger.warn(`开发入口读不了:${errorMessageOf(err)}`);
			return;
		}

		try {
			const print = createHash("sha256").update(source).digest("hex");
			const url = `${pathToFileURL(file).href}?v=${print.slice(0, 16)}`;
			const mod = (await importModule(url)) as { devtools?: unknown };
			if (typeof mod.devtools !== "function") {
				logger.warn(`${EXTENSION_DEVTOOLS_ENTRY_FILE} 没有导出 devtools()`);
				return;
			}
			if (started.ctx.signal.aborted) return;

			const mountUrl = () => {
				const address = options.address();
				return address === undefined
					? undefined
					: `http://${address}${extensionMountPrefix(started.id)}`;
			};
			const ctx: ExtensionDevtoolsContext = { ...started.ctx, mountUrl };
			const provider = mod.devtools(ctx);
			if (isThenable(provider)) {
				// 整包拒在下一行的 warn 里说了;那个 Promise 日后要是 reject,别让它变成没人接的 rejection。
				void Promise.resolve(provider).catch(() => {});
				logger.warn("devtools() 要同步交回 provider,不能交回 Promise");
				return;
			}
			const why = invalidProvider(provider);
			if (why !== undefined) {
				logger.warn(why);
				return;
			}
			if (started.ctx.signal.aborted) return;

			const claim = options.providers.claim(started.id, provider as DevtoolsProvider);
			const onAbort = () => claim.dispose();
			started.ctx.signal.addEventListener("abort", onAbort, { once: true });
			if (started.ctx.signal.aborted) onAbort();
		} catch (err) {
			logger.warn(`开发入口没挂上:${errorMessageOf(err)}`);
		}
	};
}
