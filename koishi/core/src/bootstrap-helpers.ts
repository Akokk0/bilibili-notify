import type { BilibiliAPI } from "@bilibili-notify/api";
import {
	DEFAULT_FEATURE_FLAGS,
	type FeatureKey,
	type Subscription,
} from "@bilibili-notify/internal";
import type { BilibiliPush } from "@bilibili-notify/push";
import type { StorageManager } from "@bilibili-notify/storage";
import type { Context, Logger } from "koishi";

const LIVE_PLUGIN_FEATURES = [
	"live",
	"liveEnd",
	"liveGuardBuy",
	"superchat",
	"wordcloud",
	"liveSummary",
	"specialDanmaku",
	"specialUserEnter",
] as const satisfies readonly FeatureKey[];

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

function subscriptionUsesFeature(sub: Subscription, feature: FeatureKey): boolean {
	return (
		sub.enabled &&
		(sub.routing[feature] ?? []).length > 0 &&
		(sub.overrides.features?.[feature] ?? DEFAULT_FEATURE_FLAGS[feature])
	);
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
	const needDynamic = subs.some((s) => subscriptionUsesFeature(s, "dynamic"));
	const needLive = subs.some((s) =>
		LIVE_PLUGIN_FEATURES.some((f) => subscriptionUsesFeature(s, f)),
	);
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
