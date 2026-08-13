import type { WsTicketStore } from "../auth/ws-ticket.js";
import type { ConfigStore } from "../config/store.js";
import type { QQSessionRegistry } from "../platforms/qq-official.js";
import type { AppRuntime } from "../runtime/bootstrap.js";
import type { HelpEntry } from "../runtime/command-help.js";
import type { StandalonePuppeteer } from "../runtime/puppeteer.js";

/**
 * Shared dependency bag passed to each route module's factory. Avoids a global
 * singleton; instead each `create<Foo>Route(deps)` closes over what it needs.
 */
export interface RouteDeps {
	runtime: AppRuntime;
	store: ConfigStore;
	/**
	 * Puppeteer adapter shared with the engine + cards/preview routes. Null when
	 * `BN_CHROME_PATH` / `chromePath` is unset; the globals enable-check uses
	 * this presence to gate `cardStyle.enabled = true` saves.
	 */
	puppeteer: StandalonePuppeteer | null;
	/**
	 * WS upgrade 鉴权 ticket 签发器。`POST /api/auth/ws-ticket` 调 issue();
	 * `ws/server.ts` upgrade handler 调 consume() 完成一次性鉴权。null = basicAuth
	 * 未启用,WS 直接放行(同 REST 路径)。
	 */
	wsTicketStore: WsTicketStore | null;
	/**
	 * QQ 官方机器人网关发现表(群/C2C openid)。`/api/qq/sessions/:id` 读它。null =
	 * 未启用 QQ adapter(路由仍挂载,返回空列表)。
	 */
	qqSessionRegistry: QQSessionRegistry | null;
	/**
	 * 私聊指令注册表(主名 + 内置别名)。globals PATCH 用它做别名冲突检查,
	 * `GET /api/commands` 用它把「你可以在私聊里敲这些」列给面板。
	 *
	 * 可选:路由测试大多不关心指令,省掉时冲突检查退化成「别名之间互查」。
	 *
	 * 形状就是 {@link HelpEntry} —— 这曾是同一六字段形状的第三份手抄
	 * (CommandSpec / HelpEntry / 这里),给指令元数据加字段时路由层会被漏掉。
	 */
	commands?: readonly HelpEntry[];
}
