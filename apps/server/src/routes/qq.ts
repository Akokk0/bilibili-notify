import type { QQOfficialAdapterConfig } from "@bilibili-notify/internal";
import { Hono } from "hono";
import { fetchQQGuildChannels } from "../platforms/qq-official.js";
import type { RouteDeps } from "./types.js";

/**
 * `/api/qq` — QQ 官方机器人面板辅助数据(只读)。
 *
 * - `GET /sessions/:adapterId` — 网关从入站事件捞到的群/C2C 会话(openid),供建 target
 *   时的选择器(QQ 无「列我加入的群」接口,只能让机器人先被 @ 一次)。内存发现表,不落盘。
 * - `GET /guilds/:adapterId`   — REST 枚举该 adapter 能见的频道服务器 + 文字子频道,供频道
 *   scope target 选择器。每次实时拉(一次性 token)。
 */
export function createQQRoute(deps: RouteDeps): Hono {
	const app = new Hono();
	const log = deps.runtime.serviceCtx.logger;

	app.get("/sessions/:adapterId", (c) => {
		const id = c.req.param("adapterId");
		return c.json(deps.qqSessionRegistry?.list(id) ?? []);
	});

	app.get("/guilds/:adapterId", async (c) => {
		const id = c.req.param("adapterId");
		const adapter = deps.store.getAdapters().find((a) => a.id === id);
		if (!adapter || adapter.platform !== "qq-official") {
			return c.json({ error: "not_found", message: "qq-official adapter not found", id }, 404);
		}
		try {
			const guilds = await fetchQQGuildChannels(adapter.config as QQOfficialAdapterConfig);
			return c.json(guilds);
		} catch (err) {
			log.warn(`GET /api/qq/guilds/${id} failed: ${String(err)}`);
			return c.json({ error: "enumerate_failed", message: String(err) }, 502);
		}
	});

	return app;
}
