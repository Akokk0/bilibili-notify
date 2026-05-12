import { create } from "zustand";

/**
 * Right-bottom toast queue fed by the `push-events / history-recorded` WS event.
 * Each item auto-dismisses after `AUTO_DISMISS_MS`. The queue is capped at
 * `MAX_VISIBLE`; older items get pushed off the top when the cap is exceeded so
 * a burst of pushes doesn't bury the user's screen.
 */

export type PushEventSource =
	| "dynamic"
	| "live"
	| "sc"
	| "guard"
	| "special-danmaku"
	| "special-enter"
	| "live-summary";

export interface PushEventView {
	id: string;
	ts: string;
	source: PushEventSource;
	uid: string;
	subscriptionId: string;
	targetIds: string[];
	ok: boolean;
	text?: string;
	imageRef?: string;
}

export interface ToastItem extends PushEventView {
	/** ms timestamp when this toast arrived in-app; used for stable ordering. */
	receivedAt: number;
}

interface ToastState {
	items: ToastItem[];
	push(view: PushEventView): void;
	dismiss(id: string): void;
	clear(): void;
}

export const MAX_VISIBLE = 5;
export const AUTO_DISMISS_MS = 5_000;

export const useToastStore = create<ToastState>((set) => ({
	items: [],
	push(view) {
		set((s) => {
			const next: ToastItem = { ...view, receivedAt: Date.now() };
			// Deduplicate by entry id in case the same envelope arrives twice
			// (e.g. WS reconnect resubscribes before the server has filtered).
			const without = s.items.filter((t) => t.id !== view.id);
			const merged = [...without, next];
			return { items: merged.slice(-MAX_VISIBLE) };
		});
	},
	dismiss(id) {
		set((s) => ({ items: s.items.filter((t) => t.id !== id) }));
	},
	clear() {
		set({ items: [] });
	},
}));
