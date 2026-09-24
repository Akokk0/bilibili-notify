import {
	type Disposable,
	isExtensionSubscription,
	type MessageBus,
} from "@bilibili-notify/internal";
import { CronTime } from "cron";
import { type StatsSubscription, statsFileKey } from "./file-key.js";
import type { StatsRecorderCore } from "./recorder.js";
import type { StatsPostKind } from "./store.js";

/**
 * 统计的**拓展适配**(ADR-0020 决策 17):把订阅源拓展的上报与拓展直播的场次翻成记录器的中立调用,按
 * **订阅 id** 记(决策 2 / 16)。平台的规矩只写在这里:
 *
 *   - **记谁**(决策 4):订阅在、启用着就记,**与推送开关无关** —— 统计记的是「UP 做了什么」。停用的不记,
 *     哪怕它的资料照样报上来(ADR-0019 决策 62:资料更新的投递含停用的订阅)。
 *   - `subscription-reported` 的作品 → 带视频的记 `video`、其余记 `post`(决策 5),时刻是发布时刻;
 *     同一条作品报几次只留一行(去重在 store)。
 *   - `extension-live-session` → 开一场 / 关一场(决策 6):场次边界(断流接续、没报下播又开播、拓展停了、
 *     停用、关机)由 `runtime/extension-live-sessions.ts` 算、与推送共用,这里不另算。每种结束原因都是「观测
 *     到此为止」,都关;**删了的除外** —— 文件跟着订阅一起删,不再写一帧把它重新写出来。
 *   - 峰值(决策 7)照抄结束帧带的 `totalViewers`:本场报过的最大累计观看,也由场次那边算(一场报过什么只有
 *     它全看得见);没带(平台只报此刻在线)这一场就不带峰值。
 *   - 资料里的粉丝数 → 粉丝时序(决策 8),不密过 B 站粉丝轮询的间隔({@link fansSampleGapMs})。
 *   - 收到任何上报 → 一条「在记」(决策 9 / 16),最密 10 分钟一条(记录器管)。
 *   - 订阅删了 → 四份文件全删;停用的留着(决策 10)。
 */
export interface ExtensionStatsSourceOptions {
	bus: MessageBus;
	recorder: StatsRecorderCore;
	/** 当前全部订阅(B 站的会被跳过)。按它判「这条拓展订阅还在、启用着」;订阅一变就重查。 */
	subscriptions: () => readonly StatsSubscription[];
	/** B 站粉丝轮询的 cron(`globals.app.fansCron`,现取)。 */
	fansCron: () => string;
}

/** 作品的中立种类(决策 5):发了视频是「投稿」,其余(图文、纯文字)是「动态」。 */
export function extensionPostKind(post: { video?: unknown }): StatsPostKind {
	return post.video === undefined ? "post" : "video";
}

/** cron 读不出来时拓展粉丝的间隔 —— 与默认的 `fansCron`(`*\/10 * * * *`)同一个数。 */
export const DEFAULT_FANS_SAMPLE_GAP_MS = 10 * 60_000;

/** 往后看几次触发。够跨过一个小时的边界(`*\/7` 那种在整点处只隔 4 分钟),算一次也就几毫秒。 */
const CRON_LOOKAHEAD = 32;

const gapCache = new Map<string, number>();

/**
 * B 站粉丝轮询两次采样之间**最短**隔多久:取 cron 往后几次触发里相邻两次的最小间隔 —— 「不密过它」要比的是它
 * 最密的地方(`0 9,21 * * *` 是 12 小时,`*\/10 9-17 * * *` 是 10 分钟)。读不出来(面板上是自由文本框,
 * 粉丝轮询那头这时也起不来)就按 {@link DEFAULT_FANS_SAMPLE_GAP_MS}。按表达式缓存。
 */
export function fansSampleGapMs(cron: string): number {
	const cached = gapCache.get(cron);
	if (cached !== undefined) return cached;
	let gap = DEFAULT_FANS_SAMPLE_GAP_MS;
	try {
		const fires = new CronTime(cron).sendAt(CRON_LOOKAHEAD);
		let min = Number.POSITIVE_INFINITY;
		for (let i = 1; i < fires.length; i++) {
			const prev = fires[i - 1];
			const next = fires[i];
			if (prev && next) min = Math.min(min, next.toMillis() - prev.toMillis());
		}
		if (Number.isFinite(min) && min > 0) gap = min;
	} catch {
		// 读不出来:用默认间隔。
	}
	gapCache.set(cron, gap);
	return gap;
}

/** 毫秒 → 盘上的 ISO。 */
const iso = (ms: number) => new Date(ms).toISOString();

export function attachExtensionStatsSource(opts: ExtensionStatsSourceOptions): Disposable {
	const { bus, recorder } = opts;
	/** 交给记录器开着的场次(文件键)。关的时候只关这里有的 —— 一场恰好一帧下播。 */
	const open = new Set<string>();
	const handles: Disposable[] = [];

	/**
	 * 订阅 id → 启用着没有,只收拓展订阅。惰性建、订阅一变就作废;查不到时重建一次(刚加的不必等作废通知)。
	 * 资料更新可能一口气报一百条,不能每条都把整份订阅深拷一遍。
	 */
	let enabledById: Map<string, boolean> | undefined;
	const buildIndex = () => {
		const index = new Map<string, boolean>();
		for (const sub of opts.subscriptions()) {
			if (isExtensionSubscription(sub)) index.set(sub.id, sub.enabled);
		}
		return index;
	};
	/** 这条拓展订阅启用着吗;不是拓展订阅(或不在了)是 `undefined`。 */
	const enabledOf = (id: string): boolean | undefined => {
		enabledById ??= buildIndex();
		if (!enabledById.has(id)) enabledById = buildIndex();
		return enabledById.get(id);
	};

	handles.push(
		bus.on("subscription-reported", (delivery) => {
			const { report } = delivery;
			for (const id of delivery.subscriptionIds) {
				if (enabledOf(id) !== true) continue;
				const key = statsFileKey({ id });
				recorder.recordSeen(key);
				switch (report.kind) {
					case "post":
						recorder.recordPost(key, {
							id: report.value.id,
							kind: extensionPostKind(report.value),
							ts: iso(report.value.publishedAt),
						});
						break;
					case "profile":
						if (report.value.fans !== undefined) {
							recorder.recordFans(key, report.value.fans, fansSampleGapMs(opts.fansCron()));
						}
						break;
					// 直播那三种不在这里:场次与本场累计观看由 `extension-live-session` 带来(下面那个监听)。
				}
			}
		}),
	);

	handles.push(
		bus.on("extension-live-session", (event) => {
			const key = statsFileKey({ id: event.subscriptionId });
			if (event.phase === "start") {
				if (enabledOf(event.subscriptionId) !== true) return;
				open.add(key);
				recorder.openSession(key, event.startedAt);
				return;
			}
			if (!open.delete(key)) return;
			if (event.reason === "removed" || enabledOf(event.subscriptionId) === undefined) {
				// 订阅删了:文件随它一起删(下面那条 `subscription-changed`),不写一帧把它重新写出来。
				recorder.forget(key);
				return;
			}
			recorder.closeSession(key, event.at, event.totalViewers);
		}),
	);

	handles.push(
		bus.on("subscription-changed", (ops) => {
			enabledById = undefined;
			for (const op of ops) {
				// B 站那一支由 B 站适配删;这里只管拓展这一支。停用的文件留着。
				if (op.type !== "remove" || !isExtensionSubscription(op.sub)) continue;
				const key = statsFileKey(op.sub);
				open.delete(key);
				recorder.drop(key);
			}
		}),
	);

	return {
		dispose() {
			for (const h of handles) h.dispose();
			handles.length = 0;
			open.clear();
		},
	};
}
