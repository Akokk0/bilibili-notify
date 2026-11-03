import { t as serverText } from "../i18n/index.js";
/**
 * 图库的同源读口 `GET /api/images/<ref>`(ADR-0036 决策 5 下 10-03 的 🔗)。
 *
 * 只读、只这一个口:写入口留在各自业务里(聊天上传、抓图服务),不开通用上传口,免得绕过各家的规矩。
 * 按内容起名的东西永远不变,所以缓存一年且 `immutable`;`private` 是因为它在登录闸后面。
 */

import { fail } from "@bilibili-notify/internal";
import { Hono } from "hono";
import { respondFailure } from "./respond-failure.js";
import type { RouteDeps } from "./types.js";

const IMAGE_CACHE_CONTROL = "private, max-age=31536000, immutable";

export function createImagesRoute(deps: RouteDeps): Hono {
	const app = new Hono();
	app.get("/:ref", async (c) => {
		// 引用不合规矩时图库不碰盘、直接回 undefined —— 和文件不在一样答 404。
		const image = await deps.runtime.imageStore.read(c.req.param("ref"));
		if (!image)
			return respondFailure(c, fail("not_found", serverText("service.routes.images.text.1")));
		return c.body(new Uint8Array(image.bytes), 200, {
			"Content-Type": image.mime,
			"Cache-Control": IMAGE_CACHE_CONTROL,
		});
	});
	return app;
}
