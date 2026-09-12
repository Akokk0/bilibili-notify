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

	it("没有要飞的东西时什么都不做", () => {
		const done = vi.fn();
		render(<InstallFlight flight={null} onDone={done} />);
		expect(done).not.toHaveBeenCalled();
	});
});
