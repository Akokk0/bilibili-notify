import type { BridgeSessionDTO, ExtensionDTO } from "@bilibili-notify/contract";
import { isExtensionEnabled } from "@bilibili-notify/internal";
import { Hono } from "hono";
import type { BridgeServer } from "../bridge/server.js";
import type { ConfigStore } from "../config/store.js";
import { EXTENSIONS } from "../extensions/registry.js";

export interface ExtensionsRouteOptions {
	store: ConfigStore;
	/** `/bridge` 端点。**现取** —— 它比路由晚挂上 HTTP server,但对象本身早就有了。 */
	bridge: () => BridgeServer | undefined;
}

/**
 * 拓展页要的两样东西:有哪些模块(以及开没开),和桥接模块的活口状态。
 *
 * 开关本身不在这儿改 —— 它住 `globals.extensions`,走 `PATCH /api/globals`,与别的全局
 * 设置同一条路。这里只读。
 */
export function createExtensionsRoute(opts: ExtensionsRouteOptions): Hono {
	const app = new Hono();

	app.get("/", (c) => {
		const globals = opts.store.getGlobals();
		const extensions: ExtensionDTO[] = EXTENSIONS.map((def) => ({
			...def,
			enabled: isExtensionEnabled(globals, def.id),
		}));
		return c.json({ extensions });
	});

	app.get("/bridge", (c) => {
		const server = opts.bridge();
		// **从配置那一头看起**,不是从活着的会话:面板最需要看见的恰恰是「配了但没连上」
		// 那条,而那条在会话表里根本不存在。
		const sessions: BridgeSessionDTO[] = opts.store
			.getConnections()
			.filter((connection) => connection.kind === "bridge")
			.map((connection) => {
				const live = server?.getSession(connection.id);
				if (!live) return { connectionId: connection.id, connected: false, bots: [] };
				return {
					connectionId: connection.id,
					connected: true,
					kind: live.kind,
					name: live.name,
					version: live.version,
					connectedAt: live.connectedAt,
					bots: [...live.bots],
				};
			});
		return c.json({ sessions });
	});

	return app;
}
