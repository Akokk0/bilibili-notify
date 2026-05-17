import type { BilibiliAPI } from "@bilibili-notify/api";
import type { Subscription } from "@bilibili-notify/internal";
import type { BilibiliPush } from "@bilibili-notify/push";
import type { StorageManager } from "@bilibili-notify/storage";
import type { Context, Logger } from "koishi";

/** Load cookies from disk into the API jar; mark "login info loaded" if absent. */
export async function loadInitialCookies(
	api: BilibiliAPI,
	storageMgr: StorageManager,
	logger: Logger,
): Promise<void> {
	logger.debug("[cookie] 正在从磁盘加载 Cookie...");
	let cookieData = null;
	try {
		cookieData = await storageMgr.cookieStore.load();
	} catch (e) {
		logger.warn(`[cookie] 读取 cookie 文件失败: ${e}`);
	}
	if (cookieData) {
		logger.debug("[cookie] 找到 Cookie 文件，正在写入 jar...");
		await api.loadCookies(cookieData);
	} else {
		logger.debug("[cookie] 未找到 Cookie 文件，标记为待登录状态");
		api.markLoginInfoLoaded();
	}
}

/** Probe the cookie jar for a `bili_jct` entry — the de-facto login marker. */
export function hasLoginCookie(api: BilibiliAPI | null): boolean {
	const cookiesJson = api?.getCookiesJson();
	if (!cookiesJson || cookiesJson === "[]") return false;
	try {
		const cookies: { key: string }[] = JSON.parse(cookiesJson);
		return cookies.some((c) => c.key === "bili_jct");
	} catch {
		return false;
	}
}

/**
 * Warn (and notify the master) when a subscription requires the dynamic/live
 * sub-plugin but it is not currently registered on the koishi context.
 */
export async function warnMissingPlugins(
	ctx: Context,
	push: BilibiliPush | null,
	logger: Logger,
	subs: Subscription[],
): Promise<void> {
	if (!push) return;
	// 只看 dynamic 这一路由项 —— 此前 Object.values(routing).some(非空) 让
	// 任一特性(含纯直播 live/wordcloud)非空即判 needDynamic,纯直播订阅会
	// 误报"动态插件未运行"私信骚扰主人。与下方 needLive 的精确枚举对称。
	const needDynamic = subs.some(
		(s) => (s.routing.dynamic ?? []).length > 0 && s.overrides.features?.dynamic !== false,
	);
	const needLive = subs.some((s) => {
		const liveFeatures: Array<keyof typeof s.routing> = [
			"live",
			"liveEnd",
			"liveGuardBuy",
			"superchat",
			"wordcloud",
			"liveSummary",
		];
		return liveFeatures.some((f) => (s.routing[f] ?? []).length > 0);
	});
	if (needDynamic && !ctx.get("bilibili-notify-dynamic")) {
		const msg =
			"[bilibili-notify] 警告：有订阅开启了动态通知，但动态插件（koishi-plugin-bilibili-notify-dynamic）未运行，请检查是否已安装并启用该插件。";
		logger.warn(`[warn] ${msg}`);
		await push.sendPrivateMsg(msg);
	}
	if (needLive && !ctx.get("bilibili-notify-live")) {
		const msg =
			"[bilibili-notify] 警告：有订阅开启了直播通知，但直播插件（koishi-plugin-bilibili-notify-live）未运行，请检查是否已安装并启用该插件。";
		logger.warn(`[warn] ${msg}`);
		await push.sendPrivateMsg(msg);
	}
}
