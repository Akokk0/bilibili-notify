import type { BilibiliAPI, LoginSnapshot } from "@bilibili-notify/api";
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
 * - Bridge MessageBus events (`auth-lost` / `auth-restored` / `login-status-report` /
 *   `cookies-refreshed`) to the koishi event namespace `bilibili-notify/*`.
 * - Subscribe to console events `bilibili-notify/start-login` and
 *   `bilibili-notify/reset-key`, plus the CORS proxy.
 * - Render QR PNGs via the `qrcode` npm dep (UI concern; LoginFlow takes the data URL).
 */
export class LoginFlowBridge {
	private readonly opts: LoginFlowBridgeOptions;
	readonly flow: LoginFlow;
	private readonly busDisposers: Array<{ dispose(): void }> = [];

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

	/** Wire bus → koishi events + register console listeners. Returns nothing; cleanup via stop(). */
	install(): void {
		const { ctx, bus } = this.opts;

		// Bridge MessageBus → koishi events. The koishi side already declares these in core/index.ts.
		this.busDisposers.push(
			bus.on("login-status-report", (snapshot) => {
				ctx.emit("bilibili-notify/login-status-report", snapshot as LoginSnapshot);
			}),
			bus.on("auth-lost", () => {
				ctx.emit("bilibili-notify/auth-lost");
			}),
			bus.on("auth-restored", () => {
				ctx.emit("bilibili-notify/auth-restored");
			}),
		);

		// Console events
		ctx.console.addListener("bilibili-notify/start-login", async () => {
			this.opts.logger.info("[login] 触发登录事件");
			await this.flow.beginLogin((url) => this.renderQrDataUrl(url));
		});

		ctx.console.addListener("bilibili-notify/reset-key", async () => {
			this.opts.logger.info("[login] 触发重置密钥事件");
			try {
				await this.opts.resetCookieKey();
				this.flow.reportLoggedOut("keyReset");
			} catch (e) {
				this.opts.logger.error(`[login] 重置密钥失败：${e}`);
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
		for (const d of this.busDisposers.splice(0)) d.dispose();
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
