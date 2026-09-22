/**
 * 「播放安装动画 / 播放更新动画」—— 拓展卡片上那两段动画,不装东西也能反复看。
 *
 * 做法是往 `card-motion` 那一格里放一段,与真装 / 真更新成功之后放进去的**同一个形状**;
 * 拓展页照那一格演,谁放的它不认。所以这里只管两件事:演**哪张卡**、从**哪儿**起飞。
 *
 * 卡是**从页面上找**的(`EXT_CARD_ANCHOR`,与动画找落点同一个属性),不问服务端:动画要落在
 * 一张真画着的卡上,表里有而页上没画的卡(不在拓展页)演不出来 —— 那一段会干等落点到超时,
 * 看起来就是「按了没反应」。所以找不到就只回一句话,那一格一下都不碰。
 */

import { EXT_UPDATE_BUTTON, useCardMotionStore } from "../pages/extensions/card-motion";
import { EXT_CARD_ANCHOR } from "../pages/extensions/install-flight";
import type { WebDevScenario } from "./registry";

/** 卡还没排版(量出来是 0)时起点用的身材 —— 大约一张拓展卡那么大。 */
const FALLBACK_CARD = { width: 340, height: 200 };
/** 起点离视口底边留多少。 */
const BOTTOM_GAP = 24;

const ID_PARAM = {
	key: "id",
	label: "拓展 id",
	kind: "text",
	default: "",
	placeholder: "留空 = 页上第一张",
} as const;

/** 页上找那张卡;找不到时回一句给主人看的话。 */
function findCard(
	params: Record<string, string | number>,
): { ok: true; id: string; el: HTMLElement } | { ok: false; why: string } {
	const cards = [...document.querySelectorAll<HTMLElement>(`[${EXT_CARD_ANCHOR}]`)];
	if (cards.length === 0) {
		return { ok: false, why: "页上一张拓展卡都没有 —— 先打开「拓展」页(得装着至少一个拓展)再按。" };
	}
	const want = String(params.id ?? "").trim();
	// 比属性值而不是拼选择器:id 里有引号 / 方括号也不会把选择器拼坏。
	const el = want === "" ? cards[0] : cards.find((c) => c.getAttribute(EXT_CARD_ANCHOR) === want);
	if (!el) {
		const onPage = cards.map((c) => c.getAttribute(EXT_CARD_ANCHOR)).join("、");
		return { ok: false, why: `页上没有 ${want} 这张卡(页上有:${onPage})。` };
	}
	return { ok: true, id: el.getAttribute(EXT_CARD_ANCHOR) ?? want, el };
}

export const installMotion: WebDevScenario = {
	id: "web.ext-install-motion",
	group: "web",
	title: "播放安装动画",
	icon: "download",
	desc: "在拓展页上把「传送」演一遍:一颗球从视口底部正中(真的是从市场里那张卡)飞到指定的已装卡片。只演动画,什么都不装、不刷新列表。要先打开拓展页;系统开着「减少动态」时不演。",
	params: [ID_PARAM],
	run(params) {
		const found = findCard(params);
		if (!found.ok) return found.why;
		// 起点:与落点卡一样大、贴着视口底部居中。真的起点是下面市场那一节里的一张卡,
		// 位置因人因滚动而异 —— 这里只要一个「从下面飞上去」的看得见的起点。
		const box = found.el.getBoundingClientRect();
		const width = box.width > 0 ? box.width : FALLBACK_CARD.width;
		const height = box.height > 0 ? box.height : FALLBACK_CARD.height;
		const from = new DOMRect(
			(window.innerWidth - width) / 2,
			Math.max(0, window.innerHeight - height - BOTTOM_GAP),
			width,
			height,
		);
		useCardMotionStore.getState().play({ kind: "install", id: found.id, from });
		return `往 ${found.id} 传送了一次(没装任何东西)。`;
	},
};

export const updateMotion: WebDevScenario = {
	id: "web.ext-update-motion",
	group: "web",
	title: "播放更新动画",
	icon: "sparkle",
	desc: "在拓展页上把「换装」演一遍:卡上画着「更新」钮就从那颗钮起飞,没有就从卡片上方落下来;先「蓄」几秒(真更新时那是下载),再按挑的结果画圈打勾或淡出。只演动画,什么都不更新、版本号不变;系统开着「减少动态」时不演。想从钮上起飞就先跑一次「拓展有更新」。",
	params: [
		ID_PARAM,
		{ key: "charge", label: "蓄几秒(假装下载)", kind: "number", default: 2, min: 0, max: 30 },
		{
			key: "result",
			label: "结果",
			kind: "enum",
			options: [
				{ value: "landed", label: "装成了(画圈打勾)" },
				{ value: "failed", label: "没装成(淡出)" },
			],
			default: "landed",
		},
	],
	run(params) {
		const found = findCard(params);
		if (!found.ok) return found.why;
		// 只认**这张卡里**的那颗「更新」钮 —— 有新版时才画。别的卡上那颗与这次无关。认的是
		// 标记不是文字:文案一改,按文字找就悄悄退回「从上方落下」。
		const button = found.el.querySelector<HTMLElement>(`[${EXT_UPDATE_BUTTON}]`);
		// 真更新的换装一直蓄到装完;这里没有真的装,就假装装了这么几秒再按挑的结果落定。
		const seconds = typeof params.charge === "number" ? params.charge : 2;
		const landed = params.result !== "failed";
		const outcome = new Promise<boolean>((resolve) => {
			setTimeout(() => resolve(landed), seconds * 1000);
		});
		useCardMotionStore
			.getState()
			.play(
				button
					? { kind: "update", id: found.id, from: button.getBoundingClientRect(), outcome }
					: { kind: "update", id: found.id, outcome },
			);
		return button
			? `给 ${found.id} 演了一次换装(从「更新」钮起飞;没更新任何东西)。`
			: `给 ${found.id} 演了一次换装(卡上没有「更新」钮,球从上方落下;没更新任何东西)。`;
	},
};
