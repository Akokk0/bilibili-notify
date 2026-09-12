// @vitest-environment jsdom

/**
 * 装完那一下的传送 —— **动画本身只能靠眼睛看**,这里钉的是它的另一半:
 * 它绝不许把「装好了」这件事卡住。
 *
 * 三条都是真会发生的:用户开了「减少动态」、壳子没有 Web Animations API、
 * 落点因为某种原因始终没出现。任何一条让 `onDone` 不被调用,那次传送的状态就永远挂着,
 * 下一次装完再也不会飞 —— 而且门禁一行都不会红。
 */

import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EXT_CARD_ANCHOR, InstallFlight } from "../install-flight";

const FROM = { left: 10, top: 400, width: 300, height: 200 } as DOMRect;

function landingInDom(id: string) {
	const el = document.createElement("div");
	el.setAttribute(EXT_CARD_ANCHOR, id);
	document.body.appendChild(el);
	return el;
}

function matchMedia(reduce: boolean) {
	Object.defineProperty(window, "matchMedia", {
		writable: true,
		value: (query: string) => ({
			matches: reduce,
			media: query,
			addEventListener() {},
			removeEventListener() {},
		}),
	});
}

describe("装完那一下的传送", () => {
	beforeEach(() => matchMedia(false));
	afterEach(() => {
		cleanup();
		document.body.innerHTML = "";
		// 桩过 animate 的那条别漏给下一条 —— 下一条测的正是「没有 WAAPI」。
		Reflect.deleteProperty(Element.prototype, "animate");
	});

	it("开了「减少动态」→ 不飞,当场收摊", async () => {
		matchMedia(true);
		landingInDom("bridge");
		const done = vi.fn();

		render(<InstallFlight flight={{ id: "bridge", from: FROM }} onDone={done} />);

		await waitFor(() => expect(done).toHaveBeenCalled());
		expect(document.querySelector('[aria-hidden="true"][style*="position: fixed"]')).toBeNull();
	});

	/** jsdom 就没有 `element.animate` —— 这一条同时替真实的老壳子把关。 */
	it("没有 Web Animations API → 不卡住,也不留下一颗停在半空的球", async () => {
		landingInDom("bridge");
		const done = vi.fn();

		render(<InstallFlight flight={{ id: "bridge", from: FROM }} onDone={done} />);

		await waitFor(() => expect(done).toHaveBeenCalled());
		expect(document.body.querySelectorAll("div[aria-hidden=true]").length).toBe(0);
	});

	/**
	 * 🔴 球还在飞、卡已经站在落点上的话,传送的因果就反了 —— 所以找到落点先藏起来。
	 * 而**藏了必须还**:这是这段装饰唯一会留下永久损伤的地方。
	 */
	it("飞完把落点还原,不留一张隐形的卡", async () => {
		const landing = landingInDom("bridge");
		const done = vi.fn();

		render(<InstallFlight flight={{ id: "bridge", from: FROM }} onDone={done} />);

		await waitFor(() => expect(done).toHaveBeenCalled());
		expect(landing.style.opacity).toBe("");
	});

	/**
	 * 🔴 真浏览器那条路:动画放完要**先撤掉内联的 opacity:0 再演展开**。不撤的话动画一结束
	 * 就落回那个 0,卡永久隐形 —— 而 jsdom 走的是降级路径,碰不到这一句,所以非得把动画
	 * 桩出来不可(这条正是「破坏了却没红」逼出来的)。
	 */
	it("走到真动画那条路:落地之后落点是看得见的", async () => {
		const anims: { onfinish: (() => void) | null }[] = [];
		Object.defineProperty(Element.prototype, "animate", {
			configurable: true,
			writable: true,
			value: () => {
				const a = { onfinish: null, oncancel: null, cancel() {} };
				anims.push(a);
				return a;
			},
		});
		const landing = landingInDom("bridge");
		const done = vi.fn();

		render(<InstallFlight flight={{ id: "bridge", from: FROM }} onDone={done} />);
		await waitFor(() => expect(landing.style.opacity).toBe("0"));
		await waitFor(() => expect(anims.length).toBeGreaterThan(0));

		anims[0]?.onfinish?.();

		expect(landing.style.opacity).toBe("");
		await waitFor(() => expect(done).toHaveBeenCalled());
	});

	/** 飞到一半被拆(切页、马上再装一个)——没还原的话那张卡隐形到下次刷新,门禁全绿。 */
	it("飞到一半被拆,落点照样还原", async () => {
		// 🔴 桩一个**永不结束**的动画:jsdom 本来没有 WAAPI,不桩的话会当场走降级路径收摊,
		// 这条测试就只是在跟 waitFor 抢时间 —— 撞上了绿、撞不上红,等于没钉。
		Object.defineProperty(Element.prototype, "animate", {
			configurable: true,
			writable: true,
			value: () => ({ onfinish: null, oncancel: null, cancel() {} }),
		});
		const done = vi.fn();
		const view = render(<InstallFlight flight={{ id: "bridge", from: FROM }} onDone={done} />);
		const landing = landingInDom("bridge");

		await waitFor(() => expect(landing.style.opacity).toBe("0"));
		expect(done).not.toHaveBeenCalled();

		view.unmount();

		expect(landing.style.opacity).toBe("");
	});

	it("没有要飞的东西时什么都不做", () => {
		const done = vi.fn();
		render(<InstallFlight flight={null} onDone={done} />);
		expect(done).not.toHaveBeenCalled();
	});
});
