/**
 * 拓展卡片上**现在演哪一段** —— 装完的「传送」(`install-flight.tsx`)或更新完的「换装」
 * (`update-flight.tsx`)。
 *
 * 为什么是模块级的一格,而不是装拓展那个 hook 里的局部状态:演的人不止一个。市场装 / 卡上
 * 更新成功之后要演,devtools 的「播放安装动画 / 播放更新动画」也要演 —— 后者不装东西,够不着
 * 那个 hook 的局部状态。页面只管照这一格画,谁放进来的都一样。
 *
 * 一次只演一段:新的一段放进来,旧的那段由组件的清理收摊(卡的样式照样还原)。
 */

import { create } from "zustand";
import type { InstallFlight } from "./install-flight";

export type CardMotion =
	| ({ kind: "install" } & InstallFlight)
	| {
			kind: "update";
			/** 换装的是哪张卡。 */
			id: string;
			/** 那颗球从哪儿起飞(按下的「更新」钮)。不给就从卡片上方落下来。 */
			from?: DOMRect;
	  };

interface CardMotionStore {
	motion: CardMotion | null;
	play(motion: CardMotion): void;
	/**
	 * 演完收摊。**只收自己那一段**:上一段的收尾晚到一步的话,不许把刚放进来的下一段清掉
	 * —— 那一段就一帧都没演。
	 */
	clear(motion: CardMotion): void;
}

export const useCardMotionStore = create<CardMotionStore>((set) => ({
	motion: null,
	play: (motion) => set({ motion }),
	clear: (motion) => set((state) => (state.motion === motion ? { motion: null } : state)),
}));
