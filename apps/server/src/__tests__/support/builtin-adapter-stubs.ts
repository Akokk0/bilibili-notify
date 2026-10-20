/**
 * 路由与配置仓测试用的「内置适配器替身」:三个内置适配器的**真壳**(`adapterKey`、`settingsSchema`、
 * `listConnectionCandidates` 都是真工厂出的),但 `start` / `stop` 是空的 —— 不连网、不开监听。
 *
 * 配置仓按在场适配器的 `settingsSchema` 验 `settings`、`POST /api/connections` 要适配器在场并从候选抄快照,
 * 测试要这两件事成立时,把它们登记进 `runtime.adapterRegistry` 即可。
 */

import type { Disposable, Logger, PlatformAdapter } from "@bilibili-notify/internal";
import { createOnebotAdapter } from "../../platforms/onebot.js";
import { createQQOfficialAdapter, createQQSessionRegistry } from "../../platforms/qq-official.js";
import { createWebhookAdapter } from "../../platforms/webhook.js";
import type { PlatformAdapterRegistry } from "../../push/registry.js";
import { fakeAdapterContext } from "./adapter-ctx.js";
import { fixedLocale } from "./fixed-locale.js";

const quiet: Logger = { info() {}, warn() {}, error() {}, debug() {} };
/** 工厂创建时只会登记一个关停钩子;适配器永不 start,钩子也就永不触发。 */
const quietServiceCtx = { onDispose() {} } as never;

/** 三个内置适配器的真壳,`start` / `stop` 换成空操作。 */
export function builtinAdapterStubs(): PlatformAdapter[] {
	// 工厂只在 start 里才用得上的依赖(serviceCtx、入站回调)这里永远不会被碰到。
	const real: PlatformAdapter[] = [
		createOnebotAdapter({
			logger: quiet,
			serviceCtx: quietServiceCtx,
		}),
		createQQOfficialAdapter({
			logger: quiet,
			serviceCtx: quietServiceCtx,
			registry: createQQSessionRegistry(),
			locale: fixedLocale(),
		}),
		createWebhookAdapter({ logger: quiet }),
	];
	return real.map((adapter) => ({ ...adapter, start() {}, stop() {} }));
}

/** 把三个内置适配器的替身登记进这张表;回撤销它们的把手。 */
export function registerBuiltinAdapterStubs(registry: PlatformAdapterRegistry): Disposable[] {
	return builtinAdapterStubs().map((adapter) =>
		registry.register(adapter, fakeAdapterContext().ctx),
	);
}
