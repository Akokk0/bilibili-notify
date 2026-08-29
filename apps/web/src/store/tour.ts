import { create } from "zustand";

/**
 * 「带我做」导览的开关状态。进度卡(入口按钮)与左下角伴随窗跨组件共享。
 *
 * 持久化走 localStorage(per-browser 的轻量偏好,与进度卡 dismissed 存 server
 * 不同 —— 跳过导览不该跨设备生效,换台电脑重新带一遍反而是对的)。读写都
 * try/catch:隐私模式等场景 localStorage 会直接抛。
 */

const LS_KEY = "bn-tour-active";

function readInitial(): boolean {
	try {
		return localStorage.getItem(LS_KEY) === "1";
	} catch {
		return false;
	}
}

function persist(active: boolean) {
	try {
		localStorage.setItem(LS_KEY, active ? "1" : "0");
	} catch {
		// 存不了就只活在本次会话,无碍
	}
}

interface TourStore {
	active: boolean;
	start: () => void;
	stop: () => void;
}

export const useTourStore = create<TourStore>((set) => ({
	active: readInitial(),
	start: () => {
		persist(true);
		set({ active: true });
	},
	stop: () => {
		persist(false);
		set({ active: false });
	},
}));
