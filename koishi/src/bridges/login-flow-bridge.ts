import type { BilibiliAPI } from "@bilibili-notify/api";
import { LoginFlow } from "@bilibili-notify/api";
import type { MessageBus, ServiceContext } from "@bilibili-notify/internal";
import type { CookieData } from "@bilibili-notify/storage";
import type { Context, Logger } from "koishi";
export interface LoginFlowBridgeOptions {
	ctx: Context;
	bus: MessageBus;
	serviceCtx: ServiceContext;
	api: BilibiliAPI;
	logger: Logger;
	healthCheckMs: number;
	saveCookies: (data: CookieData) => Promise<void>;
	resetCookieKey: () => Promise<void>;
}

/**
 * Wraps `LoginFlow` (from @bilibili-notify/api) so the koishi adapter side stays thin.
 *
 * Responsibilities:
 * - Subscribe to console events `bilibili-notify/start-login` and
 *   `bilibili-notify/reset-key`, plus the CORS proxy.
 * - Render QR PNGs via the `qrcode` npm dep (UI concern; LoginFlow takes the data URL).
 *
 * Note: MessageBus → koishi event bridging is automatic. KoishiMessageBus.emit("X")
 * goes straight to ctx.emit("bilibili-notify/X"), so anything listening on the koishi
 * side via ctx.on("bilibili-notify/...") receives LoginFlow's events without an
 * explicit bus.on transformer here. (Adding one creates an infinite loop because the
 * bridge handler would re-emit the same event it just received.)
 */
export class LoginFlowBridge {
	private readonly opts: LoginFlowBridgeOptions;
	readonly flow: LoginFlow;
	// In-flight guard:控制台连点扫码按钮会触发多次 beginLogin / resetCookieKey,
	// 后者会并发申请 cookie key 导致 storage 短窗口里写两份。两个 flag 互不影响。
	private startLoginInFlight = false;
	private resetKeyInFlight = false;

	constructor(opts: LoginFlowBridgeOptions) {
		this.opts = opts;
		this.flow = new LoginFlow({
			serviceCtx: opts.serviceCtx,
			api: opts.api,
			bus: opts.bus,
			healthCheckMs: opts.healthCheckMs,
			saveCookies: opts.saveCookies,
		});
	}

	/** Register console listeners. Cleanup via stop(). */
	install(): void {
		const { ctx } = this.opts;

		// Console events
		ctx.console.addListener("bilibili-notify/start-login", async () => {
			if (this.startLoginInFlight) {
				this.opts.logger.debug("[login] 已有登录流程在进行,忽略重复触发");
				return;
			}
			this.startLoginInFlight = true;
			this.opts.logger.info("[login] 触发登录事件");
			try {
				await this.flow.beginLogin();
			} finally {
				this.startLoginInFlight = false;
			}
		});

		ctx.console.addListener("bilibili-notify/reset-key", async () => {
			if (this.resetKeyInFlight) {
				this.opts.logger.debug("[login] 已有密钥重置在进行,忽略重复触发");
				return;
			}
			this.resetKeyInFlight = true;
			this.opts.logger.info("[login] 触发重置密钥事件");
			try {
				await this.opts.resetCookieKey();
				// P0-2:与 standalone resetCookies 同款 —— 仅删盘密钥不清内存
				// jar,api 仍以 stale 已认证 cookie 发请求至插件重载。
				await this.opts.api.clearCookies();
				this.flow.reportLoggedOut("keyReset");
			} catch (e) {
				this.opts.logger.error(`[login] 重置密钥失败：${e}`);
			} finally {
				this.resetKeyInFlight = false;
			}
		});

		ctx.console.addListener("bilibili-notify/request-cors", async (url: string) => {
			let parsed: URL;
			try {
				parsed = new URL(url);
			} catch {
				throw new Error("无效的 URL");
			}
			if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
				throw new Error("仅支持 http/https 协议");
			}
			const host = parsed.hostname.toLowerCase();
			const allowed =
				host === "bilibili.com" ||
				host === "hdslb.com" ||
				host.endsWith(".bilibili.com") ||
				host.endsWith(".hdslb.com");
			if (!allowed) {
				throw new Error("仅允许 bilibili.com / hdslb.com 域名");
			}
			// P2:① redirect:"error" —— 允许域上的 3xx 跳转会把请求带出白名单
			//   (重定向式 SSRF / DNS-rebinding 旁路),CDN 图片无跨域跳转需求,直接拒。
			// ② 响应体上限 8MB(对齐 image IM2)—— 防超大响应全量入内存 OOM;
			//   Content-Length 可伪造,故声明值与实际字节双重设限。
			// ③ 仅放行 image/* —— 该接口只为 QR/封面取图。
			const MAX_BYTES = 8 * 1024 * 1024;
			const res = await fetch(url, { redirect: "error" });
			const ctype = res.headers.get("content-type") ?? "";
			if (!ctype.startsWith("image/")) {
				throw new Error(`仅允许图片资源(content-type=${ctype || "未知"})`);
			}
			const declared = Number(res.headers.get("content-length"));
			if (Number.isFinite(declared) && declared > MAX_BYTES) {
				throw new Error("远端资源超过 8MB 上限");
			}
			const buffer = await res.arrayBuffer();
			if (buffer.byteLength > MAX_BYTES) {
				throw new Error("远端资源超过 8MB 上限");
			}
			return `data:image/png;base64,${Buffer.from(buffer).toString("base64")}`;
		});
	}

	stop(): void {
		this.flow.stop();
	}
}
