import type { BilibiliAPI } from "@bilibili-notify/api";
import { LoginFlow } from "@bilibili-notify/api";
import type { MessageBus, ServiceContext } from "@bilibili-notify/internal";
import type { CookieData } from "@bilibili-notify/storage";
import type { Context, Logger } from "koishi";
import QRCode from "qrcode";

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
				await this.flow.beginLogin((url) => this.renderQrDataUrl(url));
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
			const res = await fetch(url);
			const buffer = await res.arrayBuffer();
			return `data:image/png;base64,${Buffer.from(buffer).toString("base64")}`;
		});
	}

	stop(): void {
		this.flow.stop();
	}

	/** Render a bilibili QR url to a base64 PNG data URL. */
	private renderQrDataUrl(url: string): Promise<string> {
		return new Promise((resolve, reject) => {
			QRCode.toBuffer(
				url,
				{
					errorCorrectionLevel: "H",
					type: "png",
					margin: 1,
					color: { dark: "#000000", light: "#FFFFFF" },
				},
				(err: Error | null | undefined, buffer: Buffer) => {
					if (err) reject(err);
					else resolve(`data:image/png;base64,${Buffer.from(buffer).toString("base64")}`);
				},
			);
		});
	}
}
