import type { HistoryEntryView } from "@bilibili-notify/contract";
import { create } from "zustand";

/**
 * Right-bottom toast queue fed by the `push-events / history-recorded` WS event.
 * Each item auto-dismisses after `AUTO_DISMISS_MS`. The queue is capped at
 * `MAX_VISIBLE`; older items get pushed off the top when the cap is exceeded so
 * a burst of pushes doesn't bury the user's screen.
 */

/**
 * 推送 toast 的载荷就是历史那一行(与 `/api/history` 同一形状):一次推送 × 一个目标,
 * 里面是消息列表与四态。`history-updated` 到来时同 id 换掉整份 view,卡上换字不重弹。
 */
export type PushEventView = HistoryEntryView;

/**
 * 不是推送事件的那种通知(目前只有「有新版本」)。借同一条队列、同一个壳:
 * 少一套右下角的东西。带 `action` 就在卡上出一个按钮,点了跳过去。
 */
export interface NoticeView {
	/** 同 id 只留一张 —— 打开面板那次自动检查和手动检查会撞出同一条。 */
	id: string;
	title: string;
	body?: string;
	/** 站内路由(可带 hash)。 */
	action?: { label: string; to: string };
}

/** ms timestamp when this toast arrived in-app; used for stable ordering. */
interface Received {
	receivedAt: number;
}

/** 推送卡不把 view 摊平进来:它自己带一个 `kind`(推送类型),会撞上这里的判别字段。 */
export type ToastItem =
	| (Received & { kind: "push"; id: string; view: PushEventView })
	| (NoticeView & Received & { kind: "notice" });

interface ToastState {
	items: ToastItem[];
	push(view: PushEventView): void;
	/** 同 id 的推送卡还在就原地换成新 view(位置与计时不动);已经关了就不再弹。 */
	replace(view: PushEventView): void;
	notify(notice: NoticeView): void;
	dismiss(id: string): void;
	clear(): void;
}

const MAX_VISIBLE = 5;
export const AUTO_DISMISS_MS = 5_000;

/**
 * Deduplicate by id in case the same envelope arrives twice (e.g. WS reconnect
 * resubscribes before the server has filtered), then cap the queue.
 *
 * 满了先挤**最老的推送**,通知卡最后才轮到:推送是流水,少一条无所谓;「有新版」一年
 * 才几回,而它偏偏在面板一打开时入队 —— 那正是 SC / 舰长刷屏几秒烧掉五条推送的时候,
 * 按入队顺序从头丢的话第一个没的就是它。
 */
function enqueue(items: ToastItem[], next: ToastItem): ToastItem[] {
	const queue = [...items.filter((t) => t.id !== next.id), next];
	while (queue.length > MAX_VISIBLE) {
		const oldestPush = queue.findIndex((t) => t.kind === "push");
		queue.splice(oldestPush === -1 ? 0 : oldestPush, 1);
	}
	return queue;
}

export const useToastStore = create<ToastState>((set) => ({
	items: [],
	push(view) {
		set((s) => ({
			items: enqueue(s.items, { kind: "push", id: view.id, view, receivedAt: Date.now() }),
		}));
	},
	replace(view) {
		set((s) => ({
			items: s.items.map((t) => (t.kind === "push" && t.id === view.id ? { ...t, view } : t)),
		}));
	},
	notify(notice) {
		set((s) => ({
			items: enqueue(s.items, { ...notice, kind: "notice", receivedAt: Date.now() }),
		}));
	},
	dismiss(id) {
		set((s) => ({ items: s.items.filter((t) => t.id !== id) }));
	},
	clear() {
		set({ items: [] });
	},
}));
