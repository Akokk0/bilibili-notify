import type { WsTicketStore } from "../auth/ws-ticket.js";
import type { ConfigStore } from "../config/store.js";
import type { SecretCellsReader } from "../push/connection-settings.js";
import type { AppRuntime } from "../runtime/bootstrap.js";
import type { HelpEntry } from "../runtime/command-help.js";
import type { PuppeteerAdapter } from "../runtime/puppeteer.js";

/**
 * Shared dependency bag passed to each route module's factory. Avoids a global
 * singleton; instead each `create<Foo>Route(deps)` closes over what it needs.
 */
export interface RouteDeps {
	runtime: AppRuntime;
	store: ConfigStore;
	/**
	 * 连接的 `settings` 下发打码要问的「哪些格是密钥」:适配器 `settingsSchema` 上的标记 + 拓展声明的键。
	 * 与备份脱敏吃同一份(`index.ts` 里造一份、两处共用)。
	 */
	connectionSecrets: SecretCellsReader;
	/**
	 * Puppeteer adapter shared with the engine + cards/preview routes. Null when
	 * `BN_CHROME_PATH` / `chromePath` is unset; the globals enable-check uses
	 * this presence to gate `cardStyle.enabled = true` saves.
	 */
	puppeteer: PuppeteerAdapter | null;
	/**
	 * WS upgrade 鉴权 ticket 签发器。`POST /api/ws/ticket` 调 issue();
	 * `ws/server.ts` upgrade handler 调 consume() 完成一次性鉴权。null = basicAuth
	 * 未启用,WS 直接放行(同 REST 路径)。
	 */
	wsTicketStore: WsTicketStore | null;
	/**
	 * 私聊指令注册表(主名 + 内置别名)。globals PATCH 用它做别名冲突检查,
	 * `GET /api/commands` 用它把「你可以在私聊里敲这些」列给面板。
	 *
	 * 可选:路由测试大多不关心指令,省掉时冲突检查退化成「别名之间互查」。
	 *
	 * 形状就是 {@link HelpEntry} —— 这曾是同一六字段形状的第三份手抄
	 * (CommandDef / HelpEntry / 这里),给指令元数据加字段时路由层会被漏掉。
	 */
	commands?: readonly HelpEntry[];
}
