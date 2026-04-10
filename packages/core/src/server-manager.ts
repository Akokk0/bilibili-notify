import {
	BilibiliAPI,
	BiliLoginStatus,
	type MySelfInfoData,
	type UserCardInfoData,
} from "@bilibili-notify/api";
import { BILIBILI_NOTIFY_TOKEN } from "@bilibili-notify/internal";
import { BilibiliPush, type Subscriptions } from "@bilibili-notify/push";
import { StorageManager } from "@bilibili-notify/storage";
import { SubscriptionManager } from "@bilibili-notify/subscription";
// biome-ignore lint/correctness/noUnusedImports: module augmentation for koishi help commands
import {} from "@koishijs/plugin-help";
import type { Notifier } from "@koishijs/plugin-notifier";
import { type Awaitable, type Context, h, type Logger, Service } from "koishi";
import QRCode from "qrcode";
import { biliCommands, statusCommands, sysCommands } from "./commands";
import type { BilibiliNotifyConfig } from "./config";

const SERVICE_NAME = "bilibili-notify";

class BilibiliNotifyServerManager extends Service<BilibiliNotifyConfig> {
	static readonly [Service.provide] = SERVICE_NAME;

	private readonly serverLogger: Logger = this.ctx.logger(SERVICE_NAME);
	private readonly selfCtx: Context;
	private api: BilibiliAPI | null = null;
	private push: BilibiliPush | null = null;
	private subMgr: SubscriptionManager | null = null;
	private loginTimer?: () => void;
	private subNotifier?: Notifier;
	private running = false;
	storageMgr!: StorageManager;
	currentSubs: Subscriptions | null = null;

	constructor(ctx: Context, config: BilibiliNotifyConfig) {
		super(ctx, SERVICE_NAME);
		this.selfCtx = ctx;
		this.config = config;
		this.serverLogger.level = config.logLevel;
	}

	/** For commands */
	get subManager() {
		return this.subMgr?.subManager ?? new Map();
	}

	subShow(): string {
		return this.subMgr?.subShow() ?? "没有订阅任何UP";
	}

	protected async start(): Promise<void> {
		this.serverLogger.info("正在启动中...");

		this.storageMgr = new StorageManager(this.ctx.baseDir);
		await this.storageMgr.init();

		// Persist refreshed cookies
		this.ctx.on("bilibili-notify/cookies-refreshed", async (data) => {
			try {
				await this.storageMgr.cookieStore.save(data);
				this.serverLogger.debug("Cookie 已自动刷新并保存");
			} catch (e) {
				this.serverLogger.error(`保存刷新后的 cookie 失败：${e}`);
			}
		});

		this.ctx.on("bilibili-notify/plugin-error", (source, message) => {
			this.serverLogger.warn(`[${source}] ${message}`);
		});

		sysCommands.call(this);

		if (!(await this.registerPlugin())) {
			this.serverLogger.error("启动插件失败，请检查配置后重试");
		}
	}

	protected stop(): Awaitable<void> {
		this.disposePlugin();
	}

	/**
	 * 向持有 BILIBILI_NOTIFY_TOKEN 的友好插件暴露 api / push / subs 实例。
	 * 第三方插件无法获取此令牌，因此无法访问内部实例。
	 */
	getInternals(
		token: symbol,
	): { api: BilibiliAPI; push: BilibiliPush; subs: Subscriptions | null } | null {
		if (token !== BILIBILI_NOTIFY_TOKEN || !this.api || !this.push) return null;
		return { api: this.api, push: this.push, subs: this.currentSubs };
	}

	async registerPlugin(): Promise<boolean> {
		if (this.running) return false;
		try {
			this.api = new BilibiliAPI(
				this.selfCtx,
				{
					logLevel: this.config.logLevel,
					userAgent: this.config.userAgent,
					// biome-ignore lint/suspicious/noExplicitAny: schema conditional type
					ai: this.config.ai.enable ? (this.config.ai as any) : undefined,
				},
				(data) => {
					this.selfCtx.emit("bilibili-notify/cookies-refreshed", data);
				},
			);

			this.push = new BilibiliPush(this.selfCtx, {
				logLevel: this.config.logLevel,
				// biome-ignore lint/suspicious/noExplicitAny: schema conditional type
				master: this.config.master as any,
			});

			await this.api.start();
			this.push.start();

			this.subMgr = new SubscriptionManager(this.api, this.push, {
				logger: this.serverLogger,
				sleep: (ms: number) => this.selfCtx.sleep(ms),
			});

			this.running = true;

			this.registerConsoleEvents();
			biliCommands.call(this);
			statusCommands.call(this);

			await this.initCookies();

			if (!this.isLoggedIn()) {
				this.serverLogger.info("账号未登录，请在控制台扫码登录");
				this.selfCtx.emit("bilibili-notify/login-status-report", {
					status: BiliLoginStatus.NOT_LOGIN,
					msg: "账号未登录，请点击「扫码登录」",
				});
				return true;
			}

			await this.reportAccountInfo();
			await this.loadInitialSubscriptions();
		} catch (e) {
			this.serverLogger.error(`注册插件失败：${e}`);
			return false;
		}
		return true;
	}

	disposePlugin(): boolean {
		if (!this.running && !this.api && !this.push) return false;
		this.running = false;
		this.clearLoginTimer();
		if (this.subNotifier) {
			this.subNotifier.dispose();
			this.subNotifier = undefined;
		}
		this.push?.stop();
		this.api?.stop();
		this.push = null;
		this.api = null;
		this.subMgr = null;
		this.currentSubs = null;
		return true;
	}

	async restartPlugin(): Promise<boolean> {
		if (!this.running) {
			this.serverLogger.warn("插件目前没有运行，请使用 bn start 启动插件");
			return false;
		}
		this.disposePlugin();
		return new Promise((resolve) => {
			this.selfCtx.setTimeout(() => {
				this.registerPlugin()
					.then(resolve)
					.catch((e) => {
						this.serverLogger.error(`重启插件失败：${e}`);
						resolve(false);
					});
			}, 1000);
		});
	}

	// ---- Cookie management ----

	private async initCookies(): Promise<void> {
		if (!this.api) return;
		let cookieData = null;
		try {
			cookieData = await this.storageMgr.cookieStore.load();
		} catch (e) {
			this.serverLogger.warn(`读取 cookie 文件失败: ${e}`);
		}
		if (cookieData) {
			await this.api.loadCookies(cookieData);
		} else {
			this.api.markLoginInfoLoaded();
		}
	}

	private isLoggedIn(): boolean {
		const cookiesJson = this.api?.getCookiesJson();
		if (!cookiesJson || cookiesJson === "[]") return false;
		try {
			const cookies: { key: string }[] = JSON.parse(cookiesJson);
			return cookies.some((c) => c.key === "bili_jct");
		} catch {
			return false;
		}
	}

	private clearLoginTimer(): void {
		if (this.loginTimer) {
			this.loginTimer();
			this.loginTimer = undefined;
		}
	}

	// ---- Account info ----

	private async reportAccountInfo(): Promise<void> {
		if (!this.api) return;
		try {
			const personalInfo = (await this.api.getMyselfInfo()) as MySelfInfoData;
			if (personalInfo.code !== 0) {
				this.selfCtx.emit("bilibili-notify/login-status-report", {
					status: BiliLoginStatus.LOGGED_IN,
					msg: "账号已登录，但获取个人信息失败，请检查",
				});
				return;
			}
			const myCardInfo = (await this.api.getUserCardInfo(
				personalInfo.data.mid.toString(),
				true,
			)) as UserCardInfoData;
			this.selfCtx.emit("bilibili-notify/login-status-report", {
				status: BiliLoginStatus.LOGGED_IN,
				msg: "已登录",
				data: myCardInfo.data,
			});
		} catch (e) {
			this.serverLogger.warn(`获取账号信息失败: ${e}`);
		}
	}

	// ---- Subscription loading ----

	private async loadInitialSubscriptions(): Promise<void> {
		if (this.config.advancedSub) {
			this.serverLogger.info("开启高级订阅，等待接收订阅配置...");
			this.selfCtx.emit("bilibili-notify/ready-to-receive");
		} else {
			if (this.config.subs?.length) {
				const subs = SubscriptionManager.fromFlatConfig(this.config.subs);
				if (!this.subMgr) return;
				await this.subMgr.loadSubscriptions(subs);
				this.currentSubs = subs;
				this.updateSubNotifier();
				this.selfCtx.emit("bilibili-notify/subscription-changed", subs);
			} else {
				this.serverLogger.info("初始化完毕，但未添加任何订阅");
			}
		}
	}

	// ---- Console notifier ----

	private updateSubNotifier(): void {
		if (!this.subMgr) return;
		if (this.subNotifier) this.subNotifier.dispose();
		const subInfo = this.subMgr.subShow();
		if (subInfo === "没有订阅任何UP") {
			this.subNotifier = this.selfCtx.notifier.create(subInfo);
		} else {
			const lines = subInfo.split("\n").filter(Boolean);
			const content = h(h.Fragment, [
				h("p", "当前订阅对象："),
				h(
					"ul",
					lines.map((str: string) => h("li", str)),
				),
			]);
			this.subNotifier = this.selfCtx.notifier.create(content);
		}
	}

	// ---- Console events ----

	private registerConsoleEvents(): void {
		// Delay the missing-plugin check so dynamic/live have time to start.
		this.selfCtx.on("bilibili-notify/subscription-changed", async (subs) => {
			await this.selfCtx.sleep(5000);
			await this.warnMissingPlugins(subs);
		});

		this.selfCtx.console.addListener("bilibili-notify/start-login", async () => {
			this.serverLogger.info("触发登录事件");
			await this.startLoginFlow();
		});

		this.selfCtx.console.addListener("bilibili-notify/reset-key", async () => {
			this.serverLogger.info("触发重置密钥事件");
			try {
				await this.storageMgr.cookieStore.resetKey();
				this.selfCtx.emit("bilibili-notify/login-status-report", {
					status: BiliLoginStatus.NOT_LOGIN,
					msg: "密钥已重置，cookie 已清除，请重新扫码登录",
				});
			} catch (e) {
				this.serverLogger.error(`重置密钥失败：${e}`);
			}
		});

		this.selfCtx.console.addListener("bilibili-notify/request-cors", async (url: string) => {
			const res = await fetch(url);
			const buffer = await res.arrayBuffer();
			return `data:image/png;base64,${Buffer.from(buffer).toString("base64")}`;
		});

		if (this.config.advancedSub) {
			this.selfCtx.on("bilibili-notify/advanced-sub", async (subs: Subscriptions) => {
				if (!Object.keys(subs).length) {
					this.serverLogger.info("订阅加载完毕，但未添加任何订阅");
					return;
				}
				if (!this.subMgr) return;
				await this.subMgr.loadSubscriptions(subs);
				this.currentSubs = subs;
				this.updateSubNotifier();
				// Always notify dynamic/live (initial delivery or reload both need this)
				this.selfCtx.emit("bilibili-notify/subscription-changed", subs);
			});
		}
	}

	// ---- Login flow ----

	private async startLoginFlow(): Promise<void> {
		if (!this.api) return;
		// biome-ignore lint/suspicious/noExplicitAny: API response shape
		let qrContent: any;
		try {
			qrContent = await this.api.getLoginQRCode();
		} catch (e) {
			this.serverLogger.error(`获取登录二维码失败：${e}`);
			return;
		}

		if (qrContent.code !== 0) {
			this.selfCtx.emit("bilibili-notify/login-status-report", {
				status: BiliLoginStatus.LOGIN_FAILED,
				msg: "获取二维码失败，请重试",
			});
			return;
		}

		QRCode.toBuffer(
			qrContent.data.url,
			{
				errorCorrectionLevel: "H",
				type: "png",
				margin: 1,
				color: { dark: "#000000", light: "#FFFFFF" },
			},
			(err: Error | null | undefined, buffer: Buffer) => {
				if (err) {
					this.serverLogger.error(`生成二维码失败：${err}`);
					this.selfCtx.emit("bilibili-notify/login-status-report", {
						status: BiliLoginStatus.LOGIN_FAILED,
						msg: "生成二维码失败",
					});
					return;
				}
				this.selfCtx.emit("bilibili-notify/login-status-report", {
					status: BiliLoginStatus.LOGIN_QR,
					msg: "",
					data: `data:image/png;base64,${Buffer.from(buffer).toString("base64")}`,
				});
			},
		);

		this.clearLoginTimer();

		let polling = true;
		this.loginTimer = this.selfCtx.setInterval(async () => {
			if (!polling) return;
			polling = false;
			try {
				await this.pollLoginStatus(qrContent.data.qrcode_key);
			} finally {
				polling = true;
			}
		}, 1000);

		// 二维码有效期约 3 分钟，超时后自动停止轮询
		const QR_TIMEOUT_MS = 3 * 60 * 1000;
		this.selfCtx.setTimeout(() => {
			if (!this.loginTimer) return;
			this.clearLoginTimer();
			this.selfCtx.emit("bilibili-notify/login-status-report", {
				status: BiliLoginStatus.LOGIN_FAILED,
				msg: "二维码已超时（3分钟），请重新登录",
			});
		}, QR_TIMEOUT_MS);
	}

	private async pollLoginStatus(qrcodeKey: string): Promise<void> {
		if (!this.api) return;
		// biome-ignore lint/suspicious/noExplicitAny: API response shape
		let loginContent: any;
		try {
			loginContent = await this.api.getLoginStatus(qrcodeKey);
		} catch (e) {
			this.serverLogger.error(`获取登录状态失败：${e}`);
			return;
		}

		const code: number = loginContent?.data?.code;

		if (code === 86101) {
			this.selfCtx.emit("bilibili-notify/login-status-report", {
				status: BiliLoginStatus.LOGGING_QR,
				msg: "尚未扫码，请扫码",
			});
			return;
		}
		if (code === 86090) {
			this.selfCtx.emit("bilibili-notify/login-status-report", {
				status: BiliLoginStatus.LOGGING_QR,
				msg: "已扫码，但尚未确认，请确认",
			});
			return;
		}
		if (code === 86038) {
			this.clearLoginTimer();
			this.selfCtx.emit("bilibili-notify/login-status-report", {
				status: BiliLoginStatus.LOGIN_FAILED,
				msg: "二维码已失效，请重新登录",
			});
			return;
		}
		if (code === 0) {
			this.clearLoginTimer();
			try {
				const cookiesJson = this.api.getCookiesJson() ?? "[]";
				const refreshToken = (loginContent.data.refresh_token as string) ?? "";
				await this.storageMgr.cookieStore.save({ cookiesJson, refreshToken });
			} catch (e) {
				this.serverLogger.error(`保存 cookie 失败：${e}`);
			}
			this.selfCtx.emit("bilibili-notify/login-status-report", {
				status: BiliLoginStatus.LOGIN_SUCCESS,
				msg: "登录成功，正在加载订阅...",
			});
			await this.reportAccountInfo();
			await this.loadInitialSubscriptions();
			return;
		}
		if (loginContent?.code !== 0) {
			this.clearLoginTimer();
			this.selfCtx.emit("bilibili-notify/login-status-report", {
				status: BiliLoginStatus.LOGIN_FAILED,
				msg: "登录失败，请重试",
			});
		}
	}

	private async warnMissingPlugins(subs: Subscriptions): Promise<void> {
		if (!this.push) return;
		const needDynamic = Object.values(subs).some((s) => s.dynamic);
		const needLive = Object.values(subs).some((s) => s.live);
		if (needDynamic && !this.selfCtx.get("bilibili-notify-dynamic")) {
			const msg =
				"[bilibili-notify] 警告：有订阅开启了动态通知，但动态插件（koishi-plugin-bilibili-notify-dynamic）未运行，请检查是否已安装并启用该插件。";
			this.serverLogger.warn(msg);
			await this.push.sendPrivateMsg(msg);
		}
		if (needLive && !this.selfCtx.get("bilibili-notify-live")) {
			const msg =
				"[bilibili-notify] 警告：有订阅开启了直播通知，但直播插件（koishi-plugin-bilibili-notify-live）未运行，请检查是否已安装并启用该插件。";
			this.serverLogger.warn(msg);
			await this.push.sendPrivateMsg(msg);
		}
	}
}

export default BilibiliNotifyServerManager;
