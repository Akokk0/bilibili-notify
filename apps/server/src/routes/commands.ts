/**
 * `GET /api/commands` —— 把私聊指令注册表列给面板。
 *
 * 注册表本来就是**可序列化的声明**(主名 / 别名 / 签名 / 说明),所以这个接口几乎是
 * 白拿的,而且**永不过期**:面板上的指令卡片直接照它渲染,不必再手写一份清单 ——
 * 手写的那份必然与实现脱节。
 *
 * 同时它解决可发现性:主人在网页上就能看见「你可以在私聊里敲这些」,而不必先知道
 * 有这么个东西存在才敲得出来。
 *
 * 每条同时给出 `defaultAliases`(代码里内置的)和 `aliases`(此刻真正生效的)——
 * 面板要靠这两者的差异画出「已改过 / 恢复默认」。
 */

import { Hono } from "hono";
import { effectiveAliases } from "../runtime/command-dispatcher.js";
import { renderUsage } from "../runtime/command-help.js";
import type { RouteDeps } from "./types.js";

export function createCommandsRoute(deps: RouteDeps): Hono {
	const app = new Hono();

	app.get("/", (c) => {
		const cfg = deps.store.getGlobals().commands;
		return c.json({
			enabled: cfg.enabled,
			prefix: cfg.prefix,
			commands: (deps.commands ?? []).map((spec) => ({
				name: spec.name,
				defaultAliases: spec.aliases ?? [],
				aliases: effectiveAliases(spec, cfg.aliases),
				// 面板要印的是**给人看的**用法(`<时长>`),不是写给解析器的签名
				// (`<duration:duration|时长>`)—— 后者三段里有两段跟用户无关。
				// 渲染规则与私聊帮助共用一份,免得两处印出不同的东西。
				usage: renderUsage(spec.signature),
				example: spec.example ?? "",
				description: spec.description ?? "",
				details: spec.details ?? "",
			})),
		});
	});

	return app;
}
