import type { WsTicketStore } from "../auth/ws-ticket.js";
import type { ConfigStore } from "../config/store.js";
import type { AppRuntime } from "../runtime/bootstrap.js";
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
}
