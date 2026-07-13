import { create } from "zustand";

/**
 * Top-right `<AlertShell>` 红色告警面板的数据源。被 `engine-error` WS 事件喂养
 * (apps/server/src/ws/channels.ts → log channel)。
 *
 * 与 push-events 的 ToastShell 区分：
 *   - 不自动消失（错误需要用户主动确认 / 调查）
 *   - 红色 + Icon.alert 样式，占据右上角
 *   - 最多保留 MAX_ITEMS 条，超出按时间淘汰最早一条
 *   - dismiss(id) 单条关、clear() 全部清
 */

export interface AlertItem {
	/** uuid - in-app generated（事件本身没有 id）；用于 dismiss key */
	id: string;
	/** 逻辑发射源：dynamic-engine / live-engine / image / ai 等 */
	source: string;
	/** 错误正文 */
	message: string;
	/** 进入 store 时间（ms timestamp）；用于排序展示 */
	receivedAt: number;
}

interface AlertState {
	items: AlertItem[];
	push(view: Omit<AlertItem, "id" | "receivedAt">): void;
	dismiss(id: string): void;
	clear(): void;
}

const MAX_ITEMS = 20;

let nextId = 1;

export const useAlertStore = create<AlertState>((set) => ({
	items: [],
	push(view) {
		set((s) => {
			const item: AlertItem = {
				id: `alert-${Date.now()}-${nextId++}`,
				source: view.source,
				message: view.message,
				receivedAt: Date.now(),
			};
			// 新条目顶部插入；超过 MAX_ITEMS 截尾。不对 (source,message) 做去重——
			// 同样错误重复出现可能是不同时间点不同实例，主人需要看到次数感。
			return { items: [item, ...s.items].slice(0, MAX_ITEMS) };
		});
	},
	dismiss(id) {
		set((s) => ({ items: s.items.filter((t) => t.id !== id) }));
	},
	clear() {
		set({ items: [] });
	},
}));
