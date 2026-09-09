/**
 * 取图口的 HTTP 那一半 —— `send` 帧里那条图片 URL 背后的东西。
 *
 * **不在 `/api/*` 底下**,所以 dashboard 那套鉴权中间件够不着它 —— 这是有意的:桥手里
 * 只有一条 URL,没有会话。凭据是 id 本身(128 位随机、取过即焚、短 TTL,见 `blob.ts`)。
 *
 * 手写而不是拿 Hono 起一个:拓展会被打成自包含的 `index.mjs`,为了一条 `GET /blob/:id`
 * 把整个框架内联进拓展包不划算 —— 而 `ctx.mount()` 交过来的本来就是标准
 * `Request → Response`,一个正则就够。
 */

import type { ExtensionContext, ExtensionFetchHandler } from "@bilibili-notify/extension";
import { BRIDGE_BLOB_SEGMENT, type BridgeBlobStore } from "./blob.js";

export interface BridgeBlobRouteOptions {
	store: BridgeBlobStore;
	logger: ExtensionContext["logger"];
}

/** `<挂载点>/blob/<id>`,id 那一段不许再有斜杠。 */
const BLOB_PATH = new RegExp(`^${BRIDGE_BLOB_SEGMENT}/([^/]+)/?$`);

function notFound(): Response {
	return Response.json({ ok: false, err: "not found" }, { status: 404 });
}

/**
 * 拓展的总入口。今天只有取图这一条路 —— 别的路径一律 404,而不是漏给下一层:
 * `/ext/bridge/*` 整段都是这个拓展的,没有下一层。
 */
export function createBridgeFetchHandler(opts: BridgeBlobRouteOptions): ExtensionFetchHandler {
	return (req) => {
		if (req.method !== "GET") return notFound();
		const path = new URL(req.url).pathname;
		const id = BLOB_PATH.exec(path)?.[1];
		if (id === undefined) return notFound();

		const blob = opts.store.take(id);
		if (!blob) {
			// 取过了 / 过期了 / 根本没有 —— 三种都是 404,而且都值得留一行:桥那侧看到的
			// 只是「图没发出去」,分不清是自己重试了还是慢了一步。
			opts.logger.debug(`blob ${id} 取不到(取过了 / 过期了 / 没这个 id)`);
			return notFound();
		}
		return new Response(blob.buffer, {
			headers: {
				"Content-Type": blob.mime,
				// 一次性的东西被谁缓存一份,取过即焚就等于没焚。
				"Cache-Control": "no-store",
			},
		});
	};
}
