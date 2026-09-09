import type { Server as HttpServer, IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { Disposable } from "@bilibili-notify/internal";
import { EXTENSION_MOUNT_PREFIX, extensionMountPrefix } from "./mount.js";

/** 一条落到某个拓展名下的 WS upgrade。 */
export interface ExtensionUpgrade {
	/** 原样的请求 —— `ws` 的 `handleUpgrade` 吃的就是这三样。 */
	req: IncomingMessage;
	socket: Duplex;
	head: Buffer;
	/**
	 * 去掉 `/ext/<id>` 之后那一段(至少是 `/`)。
	 *
	 * 单给一格而**不改 `req.url`**:`upgrade` 事件上还挂着别的监听器(面板那条 `/ws`),
	 * 改掉它等于在别人脚下换地板。
	 */
	path: string;
}

export type ExtensionUpgradeHandler = (upgrade: ExtensionUpgrade) => void;

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

/** `/ext/<id>/...` → `id`;不在这个前缀底下就是 `null`。 */
function extensionIdOf(url: string): string | null {
	const path = url.split("?")[0] ?? "";
	if (!path.startsWith(`${EXTENSION_MOUNT_PREFIX}/`)) return null;
	// 精确到一段:`/ext/bridgefoo` 不是 `bridge` 的。
	const rest = path.slice(EXTENSION_MOUNT_PREFIX.length + 1);
	const id = rest.split("/")[0] ?? "";
	return id.length > 0 ? id : null;
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
	const table = new Map<string, ExtensionUpgradeHandler>();
	let attached: HttpServer | undefined;

	const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
		const id = extensionIdOf(req.url ?? "");
		// 🔴 不是 `/ext/*` 的**什么都不做**(不是 destroy):面板那条 `/ws` 也挂在同一台
		// server 上,得留给它自己的处理器。
		if (id === null) return;
		const handler = table.get(id);
		if (!handler) {
			// 落在我们的前缀里却没人认领 —— 明确回绝,别把连接吊死在那儿。
			reject(socket);
			return;
		}
		const prefix = extensionMountPrefix(id);
		const path = (req.url ?? "").split("?")[0]?.slice(prefix.length) || "/";
		handler({ req, socket, head, path });
	};

	return {
		register(id, handler) {
			if (table.has(id)) throw new Error(`extension ${id} already claimed its upgrade path`);
			table.set(id, handler);
			return {
				dispose() {
					// 只删自己那一行:重挂过之后 dispose 一个旧把手不该把新主人踢掉。
					if (table.get(id) === handler) table.delete(id);
				},
			};
		},
		attach(httpServer) {
			attached?.off("upgrade", onUpgrade);
			attached = httpServer;
			httpServer.on("upgrade", onUpgrade);
		},
	};
}
