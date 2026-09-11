import type { Server as HttpServer, IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { ExtensionUpgradeHandler } from "@bilibili-notify/extension";
import type { Disposable } from "@bilibili-notify/internal";
import { createClaimTable } from "./claim-table.js";
import { EXTENSION_MOUNT_PREFIX, extensionMountPrefix } from "./mount.js";

export type { ExtensionUpgrade, ExtensionUpgradeHandler } from "@bilibili-notify/extension";

export interface ExtensionUpgrades {
	/** 认领 `/ext/<id>` 底下的 upgrade。同一个 id 已经有主人时抛。 */
	register(id: string, handler: ExtensionUpgradeHandler): Disposable;
	/**
	 * 挂到这台 HTTP server 上 —— **挂上之前谁都收不到**。
	 *
	 * 两段式是装配顺序逼出来的:HTTP server 要等 `serve()` 才有,而拓展在那之前就装载好了。
	 * 再挂一次会先把上一台的监听摘掉。
	 */
	attach(httpServer: HttpServer): void;
}

/**
 * `/ext/<id>/...` → 这条 upgrade 归谁(`id`),以及**剥掉前缀**之后那一段(至少是 `/`)。
 * 不在这个前缀底下就是 `null`。
 *
 * 两样一起给:分两处各切一次的话,「前缀到哪儿为止」就有了两份写法,而它们只会在
 * 某种边角 URL 上才分道扬镳。
 */
function extensionIdOf(url: string): { id: string; path: string } | null {
	const full = url.split("?")[0] ?? "";
	if (!full.startsWith(`${EXTENSION_MOUNT_PREFIX}/`)) return null;
	// 精确到一段:`/ext/bridgefoo` 不是 `bridge` 的。
	const id = full.slice(EXTENSION_MOUNT_PREFIX.length + 1).split("/")[0] ?? "";
	if (id.length === 0) return null;
	return { id, path: full.slice(extensionMountPrefix(id).length) || "/" };
}

function reject(socket: Duplex): void {
	try {
		socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
	} catch {
		// 尽力而为,下面要 destroy
	}
	try {
		socket.destroy();
	} catch {
		// 已经没了
	}
}

/**
 * 拓展的 WS upgrade 分发 —— 与 HTTP 那张挂载表同一个形状,同一条纪律。
 *
 * 宿主只回答「这条 upgrade 归谁」,握手与鉴权全在拓展那一侧(ADR-0012 决策 26):
 * 桥的 401(token 不对,别重连)与 503(眼下不收,退避重连)是**协议语义**,宿主不该懂。
 */
export function createExtensionUpgrades(): ExtensionUpgrades {
	const table = createClaimTable<ExtensionUpgradeHandler>(
		(id) => `extension ${id} already claimed its upgrade path`,
	);
	let attached: HttpServer | undefined;

	const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
		const claim = extensionIdOf(req.url ?? "");
		// 🔴 不是 `/ext/*` 的**什么都不做**(不是 destroy):面板那条 `/ws` 也挂在同一台
		// server 上,得留给它自己的处理器。
		if (claim === null) return;
		const handler = table.get(claim.id);
		if (!handler) {
			// 落在我们的前缀里却没人认领 —— 明确回绝,别把连接吊死在那儿。
			reject(socket);
			return;
		}
		handler({ req, socket, head, path: claim.path });
	};

	return {
		register: (id, handler) => table.claim(id, handler),
		attach(httpServer) {
			attached?.off("upgrade", onUpgrade);
			attached = httpServer;
			httpServer.on("upgrade", onUpgrade);
		},
	};
}
