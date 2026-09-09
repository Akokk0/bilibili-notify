import type { BridgeSessionDTO, ExtensionDTO } from "@bilibili-notify/contract";
import { isExtensionEnabled } from "@bilibili-notify/internal";
import { Hono } from "hono";
import { asBridgeConnection } from "../bridge/connection.js";
import type { BridgeServer } from "../bridge/server.js";
import type { ConfigStore } from "../config/store.js";
import type { ExtensionEntry } from "../extensions/loader.js";

export interface ExtensionsRouteOptions {
	store: ConfigStore;
	/** `/bridge` 端点。**现取** —— 它比路由晚挂上 HTTP server,但对象本身早就有了。 */
	bridge: () => BridgeServer | undefined;
	/**
	 * 开机那一趟扫出来 + 加载出来的结果。**现取**,理由同上。
	 *
	 * 没有写死的清单了 —— 拓展是**装进来的**,盘上有什么就是什么(ADR-0012)。
	 */
	extensions: () => readonly ExtensionEntry[];
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
		const extensions: ExtensionDTO[] = opts.extensions().map((entry) => ({
			id: entry.id,
			// 清单读不出来时退回目录名 —— 卡片总得印点什么,而目录名正是那时唯一的身份。
			name: entry.manifest?.name ?? entry.id,
			description: entry.manifest?.description,
			version: entry.manifest?.version,
			provides: entry.manifest?.provides,
			icon: entry.manifest?.icon,
			// 开关与状态是**两件事**:开着却没跑(连败停用 / 清单坏了)正是最该看见的一格。
			enabled: isExtensionEnabled(globals, entry.id),
			state: entry.state,
			detail: entry.detail,
		}));
		return c.json({ extensions });
	});

	app.get("/bridge", (c) => {
		const server = opts.bridge();
		// **从配置那一头看起**,不是从活着的会话:面板最需要看见的恰恰是「配了但没连上」
		// 那条,而那条在会话表里根本不存在。
		const sessions: BridgeSessionDTO[] = opts.store
			.getConnections()
			.map((raw) => asBridgeConnection(raw))
			.filter((connection) => connection !== null)
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
