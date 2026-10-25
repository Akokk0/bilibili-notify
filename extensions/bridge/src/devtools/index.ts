/**
 * 桥的**开发入口** —— 只在开发版、拓展起来之后由宿主加载(清单 `contributes.devtools`),
 * 打成包里单独一份 `devtools.mjs`,不进发行包。
 *
 * 契约:导出 `devtools(ctx)`,同步交回一包场景;模块顶层不存状态(每调一次新起一份闭包);
 * 拓展停用 / 卸载 / 重载时 `ctx.signal` 中止,假桥的连接跟着断。
 */

import type { DevtoolsProvider, ExtensionDevtoolsContext } from "@bilibili-notify/extension";
import { bridgeScenarios } from "./scenarios.js";

export function devtools(ctx: ExtensionDevtoolsContext): DevtoolsProvider {
	const { scenarios, teardown } = bridgeScenarios(ctx);
	// 宿主撤场景靠 `ctx.signal`,但假桥连着的那条 socket 要我们自己放手。
	ctx.signal.addEventListener("abort", teardown, { once: true });
	return { scenarios };
}
