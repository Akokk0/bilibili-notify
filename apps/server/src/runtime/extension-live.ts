import type { ExtensionLiveSnapshot } from "@bilibili-notify/contract";
import type {
	Disposable,
	MessageBus,
	ServiceContext,
	SubscriptionReportDelivery,
} from "@bilibili-notify/internal";

/**
 * 拓展订阅的在播表(ADR-0019 决策 12 / 57 / 61)—— 首页「正在直播」里拓展那几行从这里来。
 *
 * 按**订阅自己的 id** 记「此刻在播」与直播那几格。只听总线:
 * - `subscription-reported`:开播 → 进表(整行换新,这一场从这儿算起);下播 → 出表;直播状态
 *   `live: true` → 报了的格盖上去、没报的留着(不在表里就进表 —— BN 中途重启过也接得上),
 *   `live: false` → 出表。**开播 / 下播卡与推送不在这里**,这里只管「现在在不在播」;BN 不拿状态的
 *   翻转去猜开播 / 下播(决策 53 / 57)。
 * - `extension-stopped`:它名下的全部出表(决策 61)—— 拓展重新跑起来之后靠直播状态上报接上。
 * - `subscription-changed`:订阅删了、停用了 → 出表(决策 62:停用的不进首页在播)。
 *
 * 表一变就在总线上发 `extension-live-changed`,合并过(见 {@link EXTENSION_LIVE_COALESCE_MS})。
 * 🔴 **不发 `live-state-changed`**:统计按 uid 订着那一个记场次,而统计不含拓展(决策 12)。
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
export const EXTENSION_LIVE_COALESCE_MS = 1_000;

/** 表里的一行:一条拓展订阅此刻在播。 */
export interface ExtensionLiveRow {
	subscriptionId: string;
	/** 哪个拓展报的 —— 拓展停了,它名下的按这一格出表。 */
	extensionId: string;
	/**
	 * 开播时刻(毫秒)。开播事件必带;只收到过直播状态时,拓展报了才有 —— BN 不拿「收到的时刻」冒充,
	 * 那会把这场的时长吞掉一截。留着给下播补开播时刻、重启补推(决策 56 / 57)。
	 */
	startedAt?: number;
	title?: string;
	/** 封面的字节(拓展交的,BN 核过)。首页不画,留给周期「正在直播」与重启补推出卡。 */
	cover?: Uint8Array;
	/** 分区。 */
	category?: string;
	viewers?: number;
	likes?: number;
	/** 直播间链接。 */
	url?: string;
	/** 最后一次收到关于它的上报(毫秒)—— 周期「正在直播」判「上次推送之后收到过新状态」要用(决策 61)。 */
	updatedAt: number;
}

/** 直播那几格 —— 三种直播上报都能带,进表的就是这几样。 */
type LiveDetails = Partial<
	Pick<ExtensionLiveRow, "startedAt" | "title" | "cover" | "category" | "viewers" | "likes" | "url">
>;

export interface ExtensionLiveTable extends Disposable {
	/** 此刻在播的,按进表的先后。 */
	list(): readonly ExtensionLiveRow[];
	get(subscriptionId: string): ExtensionLiveRow | undefined;
}

export interface CreateExtensionLiveTableOptions {
	bus: MessageBus;
	/** 合并「变了」那一发用的定时器 —— 宿主的 ServiceContext(关机时一起清)。 */
	timers: Pick<ServiceContext, "setTimeout">;
	/** 只有测试会换。 */
	now?: () => number;
}

/** 报了的那几格(没报的不带这个键 —— 合并时才不会拿「没报」盖掉已有的)。 */
function detailsOf(value: LiveDetails): LiveDetails {
	const { startedAt, title, cover, category, viewers, likes, url } = value;
	const picked: LiveDetails = { startedAt, title, cover, category, viewers, likes, url };
	return Object.fromEntries(
		Object.entries(picked).filter(([, cell]) => cell !== undefined),
	) as LiveDetails;
}

/**
 * 面板上的那一行(`GET /api/live/listening`)。「在播表变了没有」也照它比 —— 面板看不见的格(封面、
 * 点赞、链接、最后更新时刻)变了不惊动面板。
 */
export function extensionLiveSnapshot(row: ExtensionLiveRow): ExtensionLiveSnapshot {
	return {
		kind: "extension",
		subscriptionId: row.subscriptionId,
		extensionId: row.extensionId,
		isLive: true,
		title: row.title,
		areaName: row.category,
		startedAt: row.startedAt === undefined ? undefined : new Date(row.startedAt).toISOString(),
		viewers: row.viewers,
	};
}

/** 这一行在面板上长什么样,拿来比「变没变」。没有这一行是空串。 */
function faceOf(row: ExtensionLiveRow | undefined): string {
	return row ? JSON.stringify(extensionLiveSnapshot(row)) : "";
}

export function createExtensionLiveTable(
	opts: CreateExtensionLiveTableOptions,
): ExtensionLiveTable {
	const { bus, timers } = opts;
	const now = opts.now ?? Date.now;
	const rows = new Map<string, ExtensionLiveRow>();
	/** 窗口里挂着的那一发。 */
	let pending: Disposable | undefined;

	function markChanged(): void {
		if (pending) return;
		pending = timers.setTimeout(() => {
			pending = undefined;
			bus.emit("extension-live-changed");
		}, EXTENSION_LIVE_COALESCE_MS);
	}

	/** 换掉(或删掉)一行;面板看得见的变了就记一笔。 */
	function put(subscriptionId: string, next: ExtensionLiveRow | undefined): void {
		const before = faceOf(rows.get(subscriptionId));
		if (next) rows.set(subscriptionId, next);
		else rows.delete(subscriptionId);
		if (faceOf(next) !== before) markChanged();
	}

	function apply(delivery: SubscriptionReportDelivery): void {
		const { extensionId, report } = delivery;
		for (const subscriptionId of delivery.subscriptionIds) {
			switch (report.kind) {
				case "liveStart":
					// 新的一场:整行换新,上一场留下的格一概不带(漏了下播的那场也在这儿收尾)。先删再放,
					// 次序跟着这一场的开播走。
					rows.delete(subscriptionId);
					put(subscriptionId, {
						subscriptionId,
						extensionId,
						...detailsOf(report.value),
						updatedAt: now(),
					});
					break;
				case "liveEnd":
					put(subscriptionId, undefined);
					break;
				case "liveStatus": {
					if (!report.value.live) {
						put(subscriptionId, undefined);
						break;
					}
					const prev = rows.get(subscriptionId);
					put(subscriptionId, {
						...(prev ?? { subscriptionId }),
						extensionId,
						...detailsOf(report.value),
						updatedAt: now(),
					});
					break;
				}
				default:
					// 作品、资料更新与在播无关。
					return;
			}
		}
	}

	const watches: Disposable[] = [
		bus.on("subscription-reported", apply),
		bus.on("extension-stopped", (id) => {
			for (const row of [...rows.values()]) {
				if (row.extensionId === id) put(row.subscriptionId, undefined);
			}
		}),
		bus.on("subscription-changed", (ops) => {
			for (const op of ops) {
				if (op.type === "remove" || (op.type === "update" && !op.sub.enabled)) {
					put(op.sub.id, undefined);
				}
			}
		}),
	];

	return {
		list: () => [...rows.values()],
		get: (subscriptionId) => rows.get(subscriptionId),
		dispose() {
			for (const watch of watches) watch.dispose();
			pending?.dispose();
			pending = undefined;
		},
	};
}
