// @vitest-environment jsdom

/**
 * 拓展页上演动画的那一处 —— 这里钉的是**页面被拆时,那一格里当时那一段跟着收掉**。
 *
 * 两段动画演到一半被拆都不说演完了(各自的测试钉着),而那一格是模块级的:页面不收的话,
 * 那一段就一直挂着,回到拓展页从头再演一遍 —— 换装的结果早就落定了,演出来的是一段假的
 * 「蓄 → 落」;传送则把那张卡再藏一次、从一个早已不在的起点再飞一次。
 */

import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { type CardMotion, useCardMotionStore } from "../card-motion";
import { CardMotionStage } from "../card-motion-stage";
import { EXT_CARD_ANCHOR } from "../install-flight";

const FROM = { left: 10, top: 400, width: 300, height: 200 } as DOMRect;

function cardInDom(id: string) {
	const el = document.createElement("div");
	el.setAttribute(EXT_CARD_ANCHOR, id);
	document.body.appendChild(el);
	return el;
}

/**
 * 桩一套**不会自己结束**的动画,记下每一条挂在谁身上 —— jsdom 没有 WAAPI,不桩的话两段都
 * 当场走降级路径收摊(自己把那一格清了),「演到一半」根本造不出来。
 */
function stubAnimate(): Element[] {
	const on: Element[] = [];
	Object.defineProperty(Element.prototype, "animate", {
		configurable: true,
		writable: true,
		value(this: Element) {
			on.push(this);
			return { onfinish: null, oncancel: null, cancel() {} };
		},
	});
	return on;
}

const update = (id: string): CardMotion => ({
	kind: "update",
	id,
	// 永远不落定 —— 一直蓄着,正是「演到一半」。
	outcome: new Promise<boolean>(() => {}),
});

const motion = () => useCardMotionStore.getState().motion;

describe("拓展页上演动画的那一处", () => {
	afterEach(() => {
		cleanup();
		document.body.innerHTML = "";
		Reflect.deleteProperty(Element.prototype, "animate");
		useCardMotionStore.setState({ motion: null });
	});

	it.each<[string, () => CardMotion]>([
		["换装", () => update("bridge")],
		["传送", () => ({ kind: "install", id: "bridge", from: FROM })],
	])("%s演到一半切页 → 那一段跟着收掉,回来不重演", async (_, make) => {
		const animated = stubAnimate();
		cardInDom("bridge");
		useCardMotionStore.getState().play(make());
		const page = render(<CardMotionStage />);
		await waitFor(() => expect(animated.length).toBeGreaterThan(0));

		page.unmount();

		expect(motion()).toBeNull();
		const before = animated.length;
		render(<CardMotionStage />);
		// 要演的话,找卡、起飞都在头几帧里;给足十来帧。
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(animated.length).toBe(before);
	});

	/** 只收自己那一段:页面还挂着时换成下一段,不许把刚放进来的那一段清掉。 */
	it("页面挂着时换下一段 → 新的那一段留着、照演", async () => {
		const animated = stubAnimate();
		cardInDom("bridge");
		const other = cardInDom("other");
		render(<CardMotionStage />);
		act(() => useCardMotionStore.getState().play(update("bridge")));
		await waitFor(() => expect(animated.length).toBeGreaterThan(0));

		const next = update("other");
		act(() => useCardMotionStore.getState().play(next));

		await waitFor(() => expect(animated).toContain(other));
		expect(motion()).toBe(next);
	});
});
