import type { ExtensionLiveSnapshot } from "@bilibili-notify/contract";
import type {
	Disposable,
	LiveDetails,
	MessageBus,
	ServiceContext,
} from "@bilibili-notify/internal";
import { createKeyedCoalescer } from "../util/keyed-coalescer.js";

/**
 * 在播表(ADR-0019 决策 12 / 57 / 61)—— 首页「正在直播」里这几行从这里来。
 *
 * 按**订阅自己的 id** 记「此刻在播」与直播那几格 —— 周期「正在直播」卡(`live-push.ts`)、场次(`live-sessions.ts`)
 * 记这一场最后一份,也都从这里取,不另存。**写表的只有场次引擎**(`LiveSessionEngine.apply` 先写表、再改场次),
 * 表自己不听上报:
 * - `replace`:开播 → 整行换新,这一场从这儿算起;
 * - `merge`:直播状态 `isLive: true` → 报了的格盖上去、没报的留着(不在表里就进表 —— BN 中途重启过也接得上);
 * - `remove`:下播、直播状态 `isLive: false` → 出表。**开播 / 下播卡与推送不在这里**,这里只管「现在在不在播」;
 *   BN 不拿状态的翻转去猜开播 / 下播(决策 53 / 57)。
 *
 * 表自己还听总线两处,为的是作废(场次引擎在同一刻也各自收场):
 * - `extension-stopped`:它名下的全部出表(决策 61)—— 拓展重新跑起来之后靠直播状态上报接上;
 * - `subscription-changed`:订阅删了、停用了 → 出表(决策 62:停用的不进首页在播)。
 *
 * 行里装的是 {@link LiveDetails}(中立形状,图一律是图库引用):封面与头像由来源(拓展经 `bindExtensionLive`)
 * 先存进图库再交,表里只有引用。
 *
 * 表一变就在总线上发 `extension-live-changed`,合并过(见 {@link LIVE_CHANGED_COALESCE_MS})。
 * 🔴 **不发 `live-state-changed`**:那是统计的 B 站适配按 uid 订着记场次的口;拓展订阅的场次走
 * `extension-live-session`(`live-sessions.ts`)。
 *
 * 只在内存:拓展开机第一轮查基线时也报直播状态(决策 57),BN 重启之后表自己会满回来。
 */

/**
 * 「在播表变了」按窗口合并:第一处变化起算,窗口里的变化只在尾沿发**一次**,窗口不因为又变了一处
 * 往后推(同 `STATUS_CHANGED_COALESCE_MS` 那条道理:一直在变的表那样永远发不出去)。
 *
 * 为什么是 1 秒:直播状态可能每轮都报、一轮里几十条订阅挨着报,每一发都会让开着的面板整份重拉一次
 * `/api/live/listening`;一秒一发兜得住一轮,而进表 / 出表晚一秒到面板,人眼里仍是「当场变了」。
 */
export const LIVE_CHANGED_COALESCE_MS = 1_000;

/** 整张表就一个合并窗口,单键的合并器用的那个键。 */
const CHANGED_KEY = "live-changed";

/** 表里的一行:一条订阅此刻在播。 */
export interface LiveTableEntry {
	subscriptionId: string;
	/** 哪个来源报的 —— 拓展停了,它名下的按这一格出表。 */
	sourceKey: string;
	/**
	 * 开播时刻(毫秒)。开播信号带了才有;只收到过直播状态时,来源报了才有 —— BN 不拿「收到的时刻」冒充,
	 * 那会把这场的时长吞掉一截。留着给下播补开播时刻、重启补推(决策 56 / 57)。
	 */
	startedAt?: number;
	/** 直播那几格(中立形状,图是图库引用)。 */
	details: LiveDetails;
	/** 最后一次收到关于它的上报(毫秒)—— 周期「正在直播」判「上次推送之后收到过新状态」要用(决策 61)。 */
	updatedAt: number;
}

export interface LiveTable extends Disposable {
	/** 此刻在播的,按进表的先后。 */
	list(): readonly LiveTableEntry[];
	get(subscriptionId: string): LiveTableEntry | undefined;
	/** 开播:整行换新,上一场留下的格一概不带(漏了下播的那场也在这儿收尾)。次序跟着这一场的开播走。 */
	replace(
		subscriptionId: string,
		sourceKey: string,
		startedAt: number | undefined,
		details: LiveDetails,
	): void;
	/** 在播的直播状态:报了的格盖上去、没报的留着;不在表里就进表。 */
	merge(
		subscriptionId: string,
		sourceKey: string,
		startedAt: number | undefined,
		details: LiveDetails,
	): void;
	/** 下播、或报了不在播:出表。 */
	remove(subscriptionId: string): void;
}

export interface CreateLiveTableOptions {
	bus: MessageBus;
	/** 合并「变了」那一发用的定时器 —— 宿主的 ServiceContext(关机时一起清)。 */
	timers: Pick<ServiceContext, "setTimeout">;
	/** 只有测试会换。 */
	now?: () => number;
}

/** 报了的那几格(没报的不带这个键 —— 合并时才不会拿「没报」盖掉已有的)。 */
function reported(details: LiveDetails): LiveDetails {
	return Object.fromEntries(
		Object.entries(details).filter(([, cell]) => cell !== undefined),
	) as LiveDetails;
}

/**
 * 面板上的那一行(`GET /api/live/listening`)。「在播表变了没有」也照它比 —— 面板看不见的格(此刻在线、
 * 封面、点赞、链接、最后更新时刻)变了不惊动面板。人数那一列是累计观看(决策 75),与 B 站那几行同一个
 * 口径;此刻在线每轮都在变,放进来就是每轮让面板白重取一次。
 */
export function extensionLiveSnapshot(entry: LiveTableEntry): ExtensionLiveSnapshot {
	return {
		kind: "extension",
		subscriptionId: entry.subscriptionId,
		extensionId: entry.sourceKey,
		isLive: true,
		title: entry.details.title,
		areaName: entry.details.category,
		startedAt: entry.startedAt === undefined ? undefined : new Date(entry.startedAt).toISOString(),
		totalViewers: entry.details.totalViewers,
	};
}

/** 这一行在面板上长什么样,拿来比「变没变」。没有这一行是空串。 */
function faceOf(entry: LiveTableEntry | undefined): string {
	return entry ? JSON.stringify(extensionLiveSnapshot(entry)) : "";
}

export function createLiveTable(opts: CreateLiveTableOptions): LiveTable {
	const { bus, timers } = opts;
	const now = opts.now ?? Date.now;
	const entries = new Map<string, LiveTableEntry>();
	let disposed = false;
	/** 窗口里挂着的那一发;整张表就这一个键。 */
	const changed = createKeyedCoalescer({
		windowMs: LIVE_CHANGED_COALESCE_MS,
		onFire: () => bus.emit("extension-live-changed"),
		setTimer: (fn, ms) => timers.setTimeout(fn, ms),
	});

	function markChanged(): void {
		changed.touch(CHANGED_KEY);
	}

	/** 换掉(或删掉)一行;面板看得见的变了就记一笔。 */
	function put(subscriptionId: string, next: LiveTableEntry | undefined): void {
		if (disposed) return;
		const before = faceOf(entries.get(subscriptionId));
		if (next) entries.set(subscriptionId, next);
		else entries.delete(subscriptionId);
		if (faceOf(next) !== before) markChanged();
	}

	const watches: Disposable[] = [
		bus.on("extension-stopped", ({ extensionId }) => {
			for (const entry of [...entries.values()]) {
				if (entry.sourceKey === extensionId) put(entry.subscriptionId, undefined);
			}
		}),
		bus.on("subscription-changed", ({ ops }) => {
			for (const op of ops) {
				if (op.kind === "remove" || (op.kind === "update" && !op.sub.enabled)) {
					put(op.sub.id, undefined);
				}
			}
		}),
	];

	return {
		list: () => [...entries.values()],
		get: (subscriptionId) => entries.get(subscriptionId),
		replace(subscriptionId, sourceKey, startedAt, details) {
			if (disposed) return;
			// 先删再放,次序跟着这一场的开播走。
			entries.delete(subscriptionId);
			put(subscriptionId, {
				subscriptionId,
				sourceKey,
				...(startedAt === undefined ? {} : { startedAt }),
				details: reported(details),
				updatedAt: now(),
			});
		},
		merge(subscriptionId, sourceKey, startedAt, details) {
			const prev = entries.get(subscriptionId);
			const at = startedAt ?? prev?.startedAt;
			put(subscriptionId, {
				subscriptionId,
				sourceKey,
				...(at === undefined ? {} : { startedAt: at }),
				details: { ...prev?.details, ...reported(details) },
				updatedAt: now(),
			});
		},
		remove: (subscriptionId) => put(subscriptionId, undefined),
		dispose() {
			disposed = true;
			for (const watch of watches) watch.dispose();
			changed.cancelAll();
		},
	};
}
