// @vitest-environment jsdom

/**
 * 更新完那一下的换装 —— **动画本身只能靠眼睛看**(devtools「播放更新动画」),这里钉的是
 * 它的另一半:绝不许把「更新好了」这件事卡住,也绝不许在卡上留下东西。
 *
 * 真会发生的几种:用户开了「减少动态」、壳子没有 Web Animations API、卡始终没出现、演到一半
 * 切页或又更新了一个。任何一种让 `onDone` 不被调用,那一格就永远挂着,下一次更新再也不演;
 * 任何一种没把借来的样式还回去,卡片就永久多一格内联样式 —— 而门禁一行都不会红。
 */

import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EXT_CARD_ANCHOR } from "../install-flight";
import { UpdateFlight } from "../update-flight";

function cardInDom(id: string) {
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

interface FakeAnim {
	el: Element;
	options: KeyframeAnimationOptions | undefined;
	onfinish: (() => void) | null;
	oncancel: (() => void) | null;
	cancelled: boolean;
	cancel(): void;
}

/**
 * 桩一套**不会自己结束**的动画,并记下每一条挂在谁身上 —— jsdom 本来没有 WAAPI,不桩的话
 * 当场走降级路径收摊,真动画那条路一行都跑不到。
 */
function stubAnimate(): FakeAnim[] {
	const anims: FakeAnim[] = [];
	Object.defineProperty(Element.prototype, "animate", {
		configurable: true,
		writable: true,
		value(this: Element, _frames: unknown, options?: KeyframeAnimationOptions) {
			const anim: FakeAnim = {
				el: this,
				options,
				onfinish: null,
				oncancel: null,
				cancelled: false,
				cancel() {
					anim.cancelled = true;
					anim.oncancel?.();
				},
			};
			anims.push(anim);
			return anim;
		},
	});
	return anims;
}

/** 飞在页面上的那颗球(挂在 body 上、position: fixed)。 */
function ball(): HTMLElement | null {
	return document.body.querySelector<HTMLElement>(':scope > div[aria-hidden="true"]');
}

/** 一段换装。`outcome` 不给 = 还没装完(永远不落定)。 */
const update = (id: string, from?: DOMRect, outcome: Promise<boolean> = new Promise(() => {})) => ({
	kind: "update" as const,
	id,
	from,
	outcome,
});

/** 卡片自己身上的那几条(下沉、爆开 / 回原样)。 */
const onCard = (anims: FakeAnim[], card: Element) => anims.filter((anim) => anim.el === card);
/** 光点那几条(挂在 span 上)—— 只有「爆」才有。 */
const sparks = (anims: FakeAnim[]) => anims.filter((anim) => anim.el.tagName === "SPAN");

describe("更新完那一下的换装", () => {
	beforeEach(() => matchMedia(false));
	afterEach(() => {
		cleanup();
		document.body.innerHTML = "";
		// 桩过 animate 的那条别漏给下一条 —— 下一条测的可能正是「没有 WAAPI」。
		Reflect.deleteProperty(Element.prototype, "animate");
		vi.restoreAllMocks();
	});

	it("开了「减少动态」→ 不演,当场收摊,卡上什么都不多", async () => {
		matchMedia(true);
		// 🔴 动画接口桩上:不桩的话 jsdom 走「没有 WAAPI」那条路也会当场收摊,删掉减少动态的
		// 判断这条照样绿 —— 等于没钉。
		const anims = stubAnimate();
		const card = cardInDom("bridge");
		const done = vi.fn();

		render(<UpdateFlight motion={update("bridge")} onDone={done} />);

		await waitFor(() => expect(done).toHaveBeenCalled());
		expect(card.childElementCount).toBe(0);
		expect(ball()).toBeNull();
		expect(anims).toHaveLength(0);
	});

	/** jsdom 就没有 `element.animate` —— 这一条同时替真实的老壳子把关。 */
	it("没有 Web Animations API → 不卡住,卡上与页面上都不留东西", async () => {
		const card = cardInDom("bridge");
		const done = vi.fn();

		render(<UpdateFlight motion={update("bridge")} onDone={done} />);

		await waitFor(() => expect(done).toHaveBeenCalled());
		expect(card.childElementCount).toBe(0);
		expect(card.style.position).toBe("");
		expect(ball()).toBeNull();
	});

	it("卡始终没出现 → 等够了静默收摊,不留一颗停在半空的球", async () => {
		const done = vi.fn();
		let now = 1_000;
		vi.spyOn(performance, "now").mockImplementation(() => {
			now += 2_500;
			return now;
		});

		render(<UpdateFlight motion={update("nobody")} onDone={done} />);

		await waitFor(() => expect(done).toHaveBeenCalled());
		expect(ball()).toBeNull();
	});

	/**
	 * 🔴 **一直蓄到装完**:下载那几秒正是「蓄」。没落定之前不许爆、也不许收摊 —— 光一圈接一圈
	 * 地走,卡沉着。
	 */
	it("还没装完 → 一直蓄着:光一圈接一圈,不爆、不收摊", async () => {
		const anims = stubAnimate();
		const card = cardInDom("bridge");
		const done = vi.fn();

		render(<UpdateFlight motion={update("bridge")} onDone={done} minChargeMs={0} />);
		await waitFor(() => expect(card.childElementCount).toBe(1));
		await new Promise((resolve) => setTimeout(resolve, 30));

		expect(anims.some((anim) => anim.options?.iterations === Number.POSITIVE_INFINITY)).toBe(true);
		expect(onCard(anims, card)).toHaveLength(1);
		expect(sparks(anims)).toHaveLength(0);
		expect(done).not.toHaveBeenCalled();
	});

	/**
	 * 装成了:从沉底那一帧爆开、落回原位;**卡片那条放完**就收摊 —— 光环与球摘掉、借来的定位
	 * 还回去、停在末帧的「下沉」也停掉(不停的话卡永远陷着)。
	 */
	it("装成了 → 爆开、光点迸出;落地收摊,卡不留下沉、不留光环", async () => {
		const anims = stubAnimate();
		const card = cardInDom("bridge");
		const done = vi.fn();

		render(
			<UpdateFlight
				motion={update("bridge", undefined, Promise.resolve(true))}
				onDone={done}
				minChargeMs={0}
			/>,
		);
		await waitFor(() => expect(onCard(anims, card)).toHaveLength(2));
		const [sink, landing] = onCard(anims, card);
		expect(sparks(anims).length).toBeGreaterThan(0);
		expect(card.style.position).toBe("relative");
		expect(done).not.toHaveBeenCalled();

		landing?.onfinish?.();

		expect(sink?.cancelled).toBe(true);
		expect(card.childElementCount).toBe(0);
		expect(card.style.position).toBe("");
		expect(ball()).toBeNull();
		expect(done).toHaveBeenCalledTimes(1);
	});

	it("没装成 → 不爆、不迸光点:光环淡出,卡回原样后收摊", async () => {
		const anims = stubAnimate();
		const card = cardInDom("bridge");
		const done = vi.fn();

		render(
			<UpdateFlight
				motion={update("bridge", undefined, Promise.resolve(false))}
				onDone={done}
				minChargeMs={0}
			/>,
		);
		await waitFor(() => expect(onCard(anims, card)).toHaveLength(2));
		expect(sparks(anims)).toHaveLength(0);

		onCard(anims, card)[1]?.onfinish?.();

		expect(onCard(anims, card)[0]?.cancelled).toBe(true);
		expect(card.childElementCount).toBe(0);
		expect(done).toHaveBeenCalledTimes(1);
	});

	/** 装得再快也得看得见蓄过力 —— 当场爆开的话,那一圈光根本来不及走。 */
	it("装得飞快也至少蓄满那一段才爆", async () => {
		const anims = stubAnimate();
		const card = cardInDom("bridge");

		render(
			<UpdateFlight
				motion={update("bridge", undefined, Promise.resolve(true))}
				onDone={vi.fn()}
				minChargeMs={300}
			/>,
		);
		await waitFor(() => expect(card.childElementCount).toBe(1));
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(onCard(anims, card)).toHaveLength(1);

		await waitFor(() => expect(onCard(anims, card)).toHaveLength(2), { timeout: 2000 });
	});

	/** 演到一半被拆(切页、马上又更新一个)—— 没还原的话卡片永久多一格内联样式,门禁全绿。 */
	it("演到一半被拆:挂上去的摘掉、借的还回去、动画都停下,也不说演完了", async () => {
		const anims = stubAnimate();
		const card = cardInDom("bridge");
		const done = vi.fn();
		const view = render(<UpdateFlight motion={update("bridge")} onDone={done} />);
		await waitFor(() => expect(card.childElementCount).toBe(1));

		view.unmount();

		expect(card.childElementCount).toBe(0);
		expect(card.style.position).toBe("");
		expect(ball()).toBeNull();
		expect(anims.every((anim) => anim.cancelled)).toBe(true);
		expect(done).not.toHaveBeenCalled();
	});

	it("卡自己本来就是定位容器 → 不借,也就不会还错", async () => {
		stubAnimate();
		const card = cardInDom("bridge");
		card.style.position = "absolute";
		const view = render(<UpdateFlight motion={update("bridge")} onDone={vi.fn()} />);
		await waitFor(() => expect(card.childElementCount).toBe(1));
		// 演的时候就得是它自己那一格 —— 只看收摊之后的话,借了再还也是 absolute。
		expect(card.style.position).toBe("absolute");

		view.unmount();

		expect(card.style.position).toBe("absolute");
	});

	/** 球从按下的「更新」钮起飞;devtools 直接放的没有起点,就从卡片上方落下来。 */
	it("球的起点:有「更新」钮就从它中心起飞,没有就在卡片正上方", async () => {
		stubAnimate();
		cardInDom("bridge");
		const from = { left: 100, top: 300, width: 40, height: 20 } as DOMRect;
		const first = render(<UpdateFlight motion={update("bridge", from)} onDone={vi.fn()} />);
		await waitFor(() => expect(ball()).not.toBeNull());
		// 球径 22:中心 (120, 310) 往左上各退 11。
		expect(ball()?.style.left).toBe("109px");
		expect(ball()?.style.top).toBe("299px");
		first.unmount();

		render(<UpdateFlight motion={update("bridge")} onDone={vi.fn()} />);
		await waitFor(() => expect(ball()).not.toBeNull());
		// jsdom 里卡的位置是 0:正上方 150px 处,同样退 11。
		expect(ball()?.style.left).toBe("-11px");
		expect(ball()?.style.top).toBe("-161px");
	});

	it("没有要演的东西时什么都不做", () => {
		const done = vi.fn();
		render(<UpdateFlight motion={null} onDone={done} />);
		expect(done).not.toHaveBeenCalled();
	});
});
