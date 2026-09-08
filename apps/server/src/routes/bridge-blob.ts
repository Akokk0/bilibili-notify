import type { Logger } from "@bilibili-notify/internal";
import { Hono } from "hono";
import type { BridgeBlobStore } from "../bridge/blob.js";

export interface BridgeBlobRouteOptions {
	store: BridgeBlobStore;
	logger: Logger;
}

/**
 * `GET /bridge/blob/:id` —— `send` 帧里那条图片 URL 背后的口。
 *
 * **不在 `/api/*` 底下**,所以 dashboard 那套鉴权中间件够不着它 —— 这是有意的:桥手里
 * 只有一条 URL,没有会话。凭据是 id 本身(128 位随机、取过即焚、短 TTL,见 `bridge/blob.ts`)。
 */
export function createBridgeBlobRoute(opts: BridgeBlobRouteOptions): Hono {
	const app = new Hono();

	app.get("/:id", (c) => {
		const id = c.req.param("id");
		const blob = opts.store.take(id);
		if (!blob) {
			// 取过了 / 过期了 / 根本没有 —— 三种都是 404,而且都值得留一行:桥那侧看到的
			// 只是「图没发出去」,分不清是自己重试了还是慢了一步。
			opts.logger.debug(`[bridge] blob ${id} 取不到(取过了 / 过期了 / 没这个 id)`);
			return c.json({ ok: false, err: "not found" }, 404);
		}
		return new Response(blob.buffer, {
			headers: {
				"Content-Type": blob.mime,
				// 一次性的东西被谁缓存一份,取过即焚就等于没焚。
				"Cache-Control": "no-store",
			},
		});
	});

	return app;
}
