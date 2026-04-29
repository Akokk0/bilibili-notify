import { isDeepStrictEqual } from "node:util";
import {
	BilibiliAPI,
	BiliLoginStatus,
	type MySelfInfoData,
	type UserCardInfoData,
} from "@bilibili-notify/api";
import { BILIBILI_NOTIFY_TOKEN } from "@bilibili-notify/internal";
import { BilibiliPush, type SubItem, type Subscriptions } from "@bilibili-notify/push";
import { StorageManager } from "@bilibili-notify/storage";
import { type FlatSubConfigItem, SubscriptionManager } from "@bilibili-notify/subscription";
// biome-ignore lint/correctness/noUnusedImports: module augmentation for koishi help commands
import {} from "@koishijs/plugin-help";
import type { Notifier } from "@koishijs/plugin-notifier";
import { type Awaitable, type Context, h, type Logger, Service } from "koishi";
import QRCode from "qrcode";
import { biliCommands, statusCommands, sysCommands } from "./commands";
import type { BilibiliNotifyConfig } from "./config";
import type { SubChange, SubscriptionOp } from "./types";

const SERVICE_NAME = "bilibili-notify";

/** Diff two SubItem snapshots and return a typed SubChange array. */
function diffSubItems(prev: SubItem, next: SubItem): SubChange[] {
	const result: SubChange[] = [];

	// Live-scope changes
	const liveChange: Record<string, unknown> = { scope: "live" };
	if (prev.live !== next.live) liveChange.live = next.live;
	if (prev.liveEnd !== next.liveEnd) liveChange.liveEnd = next.liveEnd;
	if (prev.uname !== next.uname) liveChange.uname = next.uname;
	if (prev.roomId !== next.roomId) liveChange.roomId = next.roomId;
	for (const key of [
		"customCardStyle",
		"customLiveMsg",
		"customGuardBuy",
		"customLiveSummary",
		"customSpecialDanmakuUsers",
		"customSpecialUsersEnterTheRoom",
		"specialUsers",
	] as const) {
		if (!isDeepStrictEqual(prev[key], next[key])) liveChange[key] = next[key];
	}
	if (Object.keys(liveChange).length > 1) result.push(liveChange as SubChange);

	// Dynamic-scope changes
	if (prev.dynamic !== next.dynamic) result.push({ scope: "dynamic", dynamic: next.dynamic });

	// Target-scope changes
	if (!isDeepStrictEqual(prev.target, next.target))
		result.push({ scope: "target", target: next.target });

	return result;
}

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
	private currentSubs: Subscriptions | null = null;

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

	subList(): string {
		const map = this.subManager;
		if (!map.size) return "没有订阅任何UP";
		let table = "";
		for (const [uid, sub] of map) {
			const flags = [sub.dynamic ? "已订阅动态" : "", sub.live ? "已订阅直播" : ""]
				.filter(Boolean)
				.join(" ");
			table += `[UID:${uid}] 「${sub.uname}」 ${flags}\n`;
		}
		return table.trim();
	}

	protected async start(): Promise<void> {
		this.serverLogger.info("[start] 正在启动中...");

		this.storageMgr = new StorageManager(this.ctx.baseDir, this.ctx);
		await this.storageMgr.init();

		// Persist refreshed cookies
		this.ctx.on("bilibili-notify/cookies-refreshed", async (data) => {
			try {
				await this.storageMgr.cookieStore.save(data);
				this.serverLogger.debug("[cookie] Cookie 已自动刷新并保存");
			} catch (e) {
				this.serverLogger.error(`[cookie] 保存刷新后的 cookie 失败：${e}`);
			}
		});

		this.ctx.on("bilibili-notify/plugin-error", (source, message) => {
			this.serverLogger.warn(`[${source}] ${message}`);
		});

		sysCommands.call(this);

		if (!(await this.registerPlugin())) {
			this.serverLogger.error("[module] 启动模块失败，请检查配置后重试");
		}
	}

	protected stop(): Awaitable<void> {
		this.disposePlugin();
	}

	/**
	 * 向持有 BILIBILI_NOTIFY_TOKEN 的友好插件暴露 api / push / subs 实例。
	 * 第三方插件无法获取此令牌，因此无法访问内部实例。
	 */
	getInternals(token: symbol): {
		api: BilibiliAPI;
		push: BilibiliPush;
		subs: Subscriptions | null;
		addSub: (params: {
			uid: string;
			name: string;
			platform: string;
			target: string;
			dynamic?: boolean;
			dynamicAtAll?: boolean;
			live?: boolean;
			liveAtAll?: boolean;
			liveGuardBuy?: boolean;
			superchat?: boolean;
			wordcloud?: boolean;
			liveSummary?: boolean;
		}) => Promise<string>;
		removeSub: (uid: string) => string;
		updateSub: (params: {
			uid: string;
			dynamic?: boolean;
			dynamicAtAll?: boolean;
			live?: boolean;
			liveAtAll?: boolean;
			liveGuardBuy?: boolean;
			superchat?: boolean;
			wordcloud?: boolean;
			liveSummary?: boolean;
		}) => Promise<string>;
	} | null {
		if (token !== BILIBILI_NOTIFY_TOKEN || !this.api || !this.push) return null;
		return {
			api: this.api,
			push: this.push,
			subs: this.currentSubs,
			addSub: (p) => this.addSub(p),
			removeSub: (uid) => this.removeSub(uid),
			updateSub: (p) => this.updateSub(p),
		};
	}

	private async addSub(params: {
		uid: string;
		name: string;
		platform: string;
		target: string;
		dynamic?: boolean;
		dynamicAtAll?: boolean;
		live?: boolean;
		liveAtAll?: boolean;
		liveGuardBuy?: boolean;
		superchat?: boolean;
		wordcloud?: boolean;
		liveSummary?: boolean;
	}): Promise<string> {
		if (this.config.advancedSub)
			return "订阅失败：高级订阅模式下不支持通过 AI 管理订阅，操作未执行";
		if (!this.subMgr) return "订阅失败：插件未就绪，操作未执行";

		const existing = this.config.subs?.find((s) => s.uid.split(",")[0].trim() === params.uid);
		if (existing) return `订阅失败：UID ${params.uid} 已在订阅列表中（昵称：${existing.name}）`;

		const item: FlatSubConfigItem = {
			name: params.name,
			uid: params.uid,
			dynamic: params.dynamic ?? true,
			dynamicAtAll: params.dynamicAtAll ?? false,
			live: params.live ?? true,
			liveAtAll: params.liveAtAll ?? false,
			liveGuardBuy: params.liveGuardBuy ?? false,
			superchat: params.superchat ?? false,
			wordcloud: params.wordcloud ?? true,
			liveSummary: params.liveSummary ?? true,
			platform: params.platform,
			target: params.target,
		};

		const addedSub = await this.subMgr.addEntry(item);
		if (!addedSub) return `订阅失败：${params.name}（UID: ${params.uid}）操作未执行，请查看日志`;

		const newConfig = { ...this.config, subs: [...(this.config.subs ?? []), item] };
		this.config = newConfig;
		this.selfCtx.emit("bilibili-notify/update-config", newConfig);
		this.syncCurrentSubs();
		this.updateSubNotifier();
		this.selfCtx.emit("bilibili-notify/subscription-changed", [{ type: "add", sub: addedSub }]);

		this.serverLogger.info(`[subscribe] 已添加订阅：${params.name}（UID: ${params.uid}）`);
		return `已成功订阅 ${params.name}（UID: ${params.uid}）`;
	}

	private async updateSub(params: {
		uid: string;
		dynamic?: boolean;
		dynamicAtAll?: boolean;
		live?: boolean;
		liveAtAll?: boolean;
		liveGuardBuy?: boolean;
		superchat?: boolean;
		wordcloud?: boolean;
		liveSummary?: boolean;
	}): Promise<string> {
		if (this.config.advancedSub)
			return "更新订阅失败：高级订阅模式下不支持通过 AI 管理订阅，操作未执行";
		if (!this.subMgr) return "更新订阅失败：插件未就绪，操作未执行";

		const flatSubs = this.config.subs ?? [];
		const idx = flatSubs.findIndex((s) => s.uid.split(",")[0].trim() === params.uid);
		if (idx === -1) return `更新订阅失败：未找到 UID 为 ${params.uid} 的订阅，操作未执行`;

		const existing = flatSubs[idx];
		// Snapshot before updateEntry mutates the object in-place via Object.assign
		const rawPrev = this.subMgr.subManager.get(params.uid);
		const prevSub = rawPrev ? structuredClone(rawPrev) : null;
		const updatedItem: FlatSubConfigItem = {
			...existing,
			...(params.dynamic !== undefined && { dynamic: params.dynamic }),
			...(params.dynamicAtAll !== undefined && { dynamicAtAll: params.dynamicAtAll }),
			...(params.live !== undefined && { live: params.live }),
			...(params.liveAtAll !== undefined && { liveAtAll: params.liveAtAll }),
			...(params.liveGuardBuy !== undefined && { liveGuardBuy: params.liveGuardBuy }),
			...(params.superchat !== undefined && { superchat: params.superchat }),
			...(params.wordcloud !== undefined && { wordcloud: params.wordcloud }),
			...(params.liveSummary !== undefined && { liveSummary: params.liveSummary }),
		};

		const nextSub = this.subMgr.updateEntry(updatedItem);
		if (!nextSub) return `更新订阅失败：UID ${params.uid} 不在运行中的订阅管理器内，操作未执行`;

		const newFlatSubs = [...flatSubs];
		newFlatSubs[idx] = updatedItem;
		const newConfig = { ...this.config, subs: newFlatSubs };
		this.config = newConfig;
		this.selfCtx.emit("bilibili-notify/update-config", newConfig);
		this.syncCurrentSubs();
		this.updateSubNotifier();
		if (prevSub) {
			const changes = diffSubItems(prevSub, nextSub);
			if (changes.length) {
				this.selfCtx.emit("bilibili-notify/subscription-changed", [
					{ type: "update", uid: params.uid, changes },
				]);
			}
		}

		this.serverLogger.info(`[update] 已更新订阅：${existing.name}（UID: ${params.uid}）`);
		return `已成功更新 ${existing.name}（UID: ${params.uid}）的订阅设置`;
	}

	private removeSub(uid: string): string {
		if (this.config.advancedSub)
			return "取消订阅失败：高级订阅模式下不支持通过 AI 管理订阅，操作未执行";
		if (!this.subMgr) return "取消订阅失败：插件未就绪，操作未执行";

		const flatItem = this.config.subs?.find((s) => s.uid.split(",")[0].trim() === uid);
		if (!flatItem) return `取消订阅失败：未找到 UID 为 ${uid} 的订阅，操作未执行`;

		const removedSub = this.subMgr.removeEntry(uid);
		if (!removedSub) return `取消订阅失败：UID ${uid} 不在运行中的订阅管理器内，操作未执行`;

		const newConfig = {
			...this.config,
			subs: (this.config.subs ?? []).filter((s) => s !== flatItem),
		};
		this.config = newConfig;
		this.selfCtx.emit("bilibili-notify/update-config", newConfig);
		this.syncCurrentSubs();
		this.updateSubNotifier();
		this.selfCtx.emit("bilibili-notify/subscription-changed", [{ type: "delete", uid }]);

		this.serverLogger.info(`[unsubscribe] 已移除订阅：${removedSub.uname}（UID: ${uid}）`);
		return `已成功取消订阅 ${removedSub.uname}（UID: ${uid}）`;
	}

	/** Rebuild currentSubs from the subManager (uid-keyed). */
	private syncCurrentSubs(): void {
		if (!this.subMgr?.subManager.size) {
			this.currentSubs = null;
			return;
		}
		const result: Subscriptions = {};
		for (const [uid, sub] of this.subMgr.subManager) {
			result[uid] = sub;
		}
		this.currentSubs = result;
	}

	/** Compute ops by diffing two subManager snapshots. Used for advanced-sub full reload. */
	private diffSubManagers(
		prev: Map<string, SubItem>,
		next: Map<string, SubItem>,
	): SubscriptionOp[] {
		const ops: SubscriptionOp[] = [];
		for (const [uid] of prev) {
			if (!next.has(uid)) ops.push({ type: "delete", uid });
		}
		for (const [uid, sub] of next) {
			const prevSub = prev.get(uid);
			if (!prevSub) {
				ops.push({ type: "add", sub });
			} else {
				const changes = diffSubItems(prevSub, sub);
				if (changes.length) ops.push({ type: "update", uid, changes });
			}
		}
		return ops;
	}

	async registerPlugin(): Promise<boolean> {
		if (this.running) return false;
		try {
			this.api = new BilibiliAPI(
				this.selfCtx,
				{
					logLevel: this.config.logLevel,
					userAgent: this.config.userAgent,
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
			this.serverLogger.debug("[module] BilibiliAPI 启动完成");
			this.push.start();
			this.serverLogger.debug("[module] BilibiliPush 启动完成");

			this.subMgr = new SubscriptionManager(this.api, this.push, this.selfCtx);

			this.running = true;

			this.registerConsoleEvents();
			biliCommands.call(this);
			statusCommands.call(this);

			await this.initCookies();
			this.serverLogger.debug(
				`[cookie] Cookie 加载完成，登录状态：${this.isLoggedIn() ? "已登录" : "未登录"}`,
			);

			if (!this.isLoggedIn()) {
				this.serverLogger.info("[login] 账号未登录，请在控制台扫码登录");
				this.selfCtx.emit("bilibili-notify/login-status-report", {
					status: BiliLoginStatus.NOT_LOGIN,
					msg: "账号未登录，请点击「扫码登录」",
				});
				return true;
			}

			await this.reportAccountInfo();
			await this.loadInitialSubscriptions();
		} catch (e) {
			this.serverLogger.error(`[module] 注册模块失败：${e}`);
			return false;
		}
		return true;
	}

	disposePlugin(): boolean {
		if (!this.running && !this.api && !this.push) return false;
		this.serverLogger.debug("[stop] 正在清理插件资源...");
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
		this.serverLogger.debug("[stop] 插件资源清理完成");
		return true;
	}

	async restartPlugin(): Promise<boolean> {
		if (!this.running) {
			this.serverLogger.warn("[restart] 插件目前没有运行，请使用 bn start 启动插件");
			return false;
		}
		this.disposePlugin();
		return new Promise((resolve) => {
			this.selfCtx.setTimeout(() => {
				this.registerPlugin()
					.then(resolve)
					.catch((e) => {
						this.serverLogger.error(`[restart] 重启插件失败：${e}`);
						resolve(false);
					});
			}, 1000);
		});
	}

	// ---- Cookie management ----

	private async initCookies(): Promise<void> {
		if (!this.api) return;
		this.serverLogger.debug("[cookie] 正在从磁盘加载 Cookie...");
		let cookieData = null;
		try {
			cookieData = await this.storageMgr.cookieStore.load();
		} catch (e) {
			this.serverLogger.warn(`[cookie] 读取 cookie 文件失败: ${e}`);
		}
		if (cookieData) {
			this.serverLogger.debug("[cookie] 找到 Cookie 文件，正在写入 jar...");
			await this.api.loadCookies(cookieData);
		} else {
			this.serverLogger.debug("[cookie] 未找到 Cookie 文件，标记为待登录状态");
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
			this.serverLogger.warn(`[account] 获取账号信息失败: ${e}`);
		}
	}

	// ---- Subscription loading ----

	private async loadInitialSubscriptions(): Promise<void> {
		if (this.config.advancedSub) {
			this.serverLogger.info("[sub] 开启高级订阅，等待接收订阅配置...");
			this.selfCtx.emit("bilibili-notify/ready-to-receive");
		} else {
			if (this.config.subs?.length) {
				this.serverLogger.debug(`[sub] 从配置加载 ${this.config.subs.length} 个订阅项`);
				const subs = SubscriptionManager.fromFlatConfig(this.config.subs);
				if (!this.subMgr) return;
				await this.subMgr.loadSubscriptions(subs, { isReload: false });
				this.syncCurrentSubs();
				this.updateSubNotifier();
				const ops: SubscriptionOp[] = [...this.subMgr.subManager.values()].map((sub) => ({
					type: "add" as const,
					sub,
				}));
				if (ops.length) {
					this.selfCtx.emit("bilibili-notify/subscription-changed", ops);
				}
			} else {
				this.serverLogger.info("[sub] 初始化完毕，但未添加任何订阅");
			}
		}
	}

	// ---- Console notifier ----

	private updateSubNotifier(): void {
		if (!this.subMgr) return;
		if (this.subNotifier) this.subNotifier.dispose();
		const subInfo = this.subList();
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
		this.selfCtx.on("bilibili-notify/subscription-changed", async (_ops) => {
			await this.selfCtx.sleep(5000);
			if (this.currentSubs) {
				await this.warnMissingPlugins(this.currentSubs);
			}
		});

		this.selfCtx.console.addListener("bilibili-notify/start-login", async () => {
			this.serverLogger.info("[login] 触发登录事件");
			await this.startLoginFlow();
		});

		this.selfCtx.console.addListener("bilibili-notify/reset-key", async () => {
			this.serverLogger.info("[login] 触发重置密钥事件");
			try {
				await this.storageMgr.cookieStore.resetKey();
				this.selfCtx.emit("bilibili-notify/login-status-report", {
					status: BiliLoginStatus.NOT_LOGIN,
					msg: "密钥已重置，cookie 已清除，请重新扫码登录",
				});
			} catch (e) {
				this.serverLogger.error(`[login] 重置密钥失败：${e}`);
			}
		});

		this.selfCtx.console.addListener("bilibili-notify/request-cors", async (url: string) => {
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

		if (this.config.advancedSub) {
			this.selfCtx.on("bilibili-notify/advanced-sub", async (subs: Subscriptions) => {
				if (!Object.keys(subs).length) {
					this.serverLogger.info("[sub] 订阅加载完毕，但未添加任何订阅");
					return;
				}
				if (!this.subMgr) return;
				const prevSubManager = new Map(this.subMgr.subManager);
				await this.subMgr.loadSubscriptions(subs, { isReload: prevSubManager.size > 0 });
				this.syncCurrentSubs();
				this.updateSubNotifier();
				const ops = this.diffSubManagers(prevSubManager, this.subMgr.subManager);
				if (ops.length) {
					this.selfCtx.emit("bilibili-notify/subscription-changed", ops);
				}
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
			this.serverLogger.error(`[login] 获取登录二维码失败：${e}`);
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
					this.serverLogger.error(`[login] 生成二维码失败：${err}`);
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
			this.serverLogger.error(`[login] 获取登录状态失败：${e}`);
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
			const cookiesJson = this.api.getCookiesJson();
			if (!cookiesJson || cookiesJson === "[]") {
				this.serverLogger.error("[login] 登录成功但未获取到任何 cookie，放弃保存");
				this.selfCtx.emit("bilibili-notify/login-status-report", {
					status: BiliLoginStatus.LOGIN_FAILED,
					msg: "登录成功但未获取到 cookie，请重试",
				});
				return;
			}
			try {
				const refreshToken = (loginContent.data.refresh_token as string) ?? "";
				await this.storageMgr.cookieStore.save({ cookiesJson, refreshToken });
			} catch (e) {
				this.serverLogger.error(`[login] 保存 cookie 失败：${e}`);
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
			this.serverLogger.warn(`[warn] ${msg}`);
			await this.push.sendPrivateMsg(msg);
		}
		if (needLive && !this.selfCtx.get("bilibili-notify-live")) {
			const msg =
				"[bilibili-notify] 警告：有订阅开启了直播通知，但直播插件（koishi-plugin-bilibili-notify-live）未运行，请检查是否已安装并启用该插件。";
			this.serverLogger.warn(`[warn] ${msg}`);
			await this.push.sendPrivateMsg(msg);
		}
	}
}

export default BilibiliNotifyServerManager;
