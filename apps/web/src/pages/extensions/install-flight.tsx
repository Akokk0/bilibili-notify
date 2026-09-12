/**
 * 装完那一下的「传送」——市场那张卡缩成一颗球,飞到它在上面那一排里的新位置再展开。
 *
 * 为什么值得做:市场里点完「安装」,那张卡**当场消失**(已装的不在市场里露面),而新卡出现在
 * 页面上半、常常在视野外 —— 看起来像「点了一下什么都没发生」。这段动画就是把「它去哪儿了」
 * 这件事演给人看。
 *
 * 三条硬约束:
 * - **落点先滚进视野再飞**。球飞出屏幕等于没飞,人只看到消失。
 * - **`prefers-reduced-motion` 一律直接收摊**。这是纯装饰,不能拿它挡住任何信息。
 * - **没有 Web Animations API 也得活**(jsdom、老壳)。拿不到 `animate` 就当动画放完了 ——
 *   动画失败绝不能把「装好了」这件事卡住。
 */

import { useEffect, useRef } from "react";

/** 一次传送:装好的那个 id,以及它起飞时在屏幕上的位置。 */
export interface InstallFlight {
	id: string;
	from: DOMRect;
}

/** 已装卡片的锚点属性名 —— 落点靠它找。两边都从这儿取,别各写各的字符串。 */
export const EXT_CARD_ANCHOR = "data-ext-card";

const BALL = 26;
/** 等落点出现的上限:refetch + 渲染。等不到就静默收摊,不留一颗停在半空的球。 */
const WAIT_FOR_LANDING_MS = 4000;

function reducedMotion(): boolean {
	return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

/**
 * 那颗球。只在飞的时候存在,飞完自己摘掉。
 *
 * 用 `position: fixed` + `transform` 走:两头的卡分处两个滚动位置,拿 `top/left` 做动画会
 * 在飞行途中被滚动带偏。
 */
function makeBall(from: DOMRect): HTMLDivElement {
	const ball = document.createElement("div");
	ball.setAttribute("aria-hidden", "true");
	ball.style.cssText = [
		"position:fixed",
		`left:${from.left}px`,
		`top:${from.top}px`,
		`width:${from.width}px`,
		`height:${from.height}px`,
		"border-radius:var(--radius-bn-card,14px)",
		"background:radial-gradient(circle at 50% 45%, color-mix(in srgb, var(--color-bn-pink) 85%, white), var(--color-bn-pink))",
		"box-shadow:0 0 0 1px color-mix(in srgb, var(--color-bn-pink) 40%, transparent), 0 8px 28px color-mix(in srgb, var(--color-bn-pink) 45%, transparent)",
		"pointer-events:none",
		// 叠放走分层表(theme.css),不写裸数字:压得住吸顶栏,让开弹窗与 toast。
		"z-index:var(--z-bn-overlay)",
		"will-change:transform,border-radius,opacity",
	].join(";");
	return ball;
}

/**
 * 起点卡的中心 → 终点卡的中心,球缩到 `BALL` 那么大时的位移。
 *
 * 缩放是以**元素中心**为锚点的(`transform-origin: center`),所以位移只按两个中心算,
 * 不用管缩放比例。
 */
function deltaOf(from: DOMRect, to: DOMRect): { dx: number; dy: number } {
	return {
		dx: to.left + to.width / 2 - (from.left + from.width / 2),
		dy: to.top + to.height / 2 - (from.top + from.height / 2),
	};
}

function scaleFor(from: DOMRect): number {
	return BALL / Math.max(from.width, from.height, 1);
}

/**
 * 传送本体 —— 挂在拓展页上,`flight` 一非空就跑一次,跑完调 `onDone` 把它清掉。
 *
 * 🔴 **落点是等出来的,不是算出来的**:卡是 `invalidateQueries` 重取回来之后才挂上的,
 * 这个组件第一次渲染时它还不在 DOM 里。所以按帧找,找到才起飞。
 */
export function InstallFlight({
	flight,
	onDone,
}: {
	flight: InstallFlight | null;
	onDone: () => void;
}) {
	const doneRef = useRef(onDone);
	doneRef.current = onDone;

	useEffect(() => {
		if (!flight) return;
		if (reducedMotion()) {
			doneRef.current();
			return;
		}

		let cancelled = false;
		let raf = 0;
		let ball: HTMLDivElement | null = null;
		const finish = () => {
			if (cancelled) return;
			ball?.remove();
			ball = null;
			doneRef.current();
		};

		const startedAt = performance.now();
		const hunt = () => {
			if (cancelled) return;
			const landing = document.querySelector<HTMLElement>(
				`[${EXT_CARD_ANCHOR}="${CSS.escape(flight.id)}"]`,
			);
			if (!landing) {
				if (performance.now() - startedAt > WAIT_FOR_LANDING_MS) return finish();
				raf = requestAnimationFrame(hunt);
				return;
			}
			// 先把落点带进视野,再量它 —— 量完才滚的话,量到的是滚动前那个位置。
			// `?.` 不是摆设:jsdom 里没有这个方法,而这段代码在测试里要跑得过去。
			landing.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
			raf = requestAnimationFrame(() => {
				if (cancelled) return;
				fly(landing);
			});
		};

		const fly = (landing: HTMLElement) => {
			const to = landing.getBoundingClientRect();
			const { dx, dy } = deltaOf(flight.from, to);
			const s = scaleFor(flight.from);
			ball = makeBall(flight.from);
			document.body.appendChild(ball);

			// 没有 WAAPI 就别演 —— 装好了这件事不能被一段装饰卡住。
			if (typeof ball.animate !== "function") return finish();

			const anim = ball.animate(
				[
					{ transform: "translate(0px,0px) scale(1)", borderRadius: "14px", opacity: 1 },
					// 先在原地缩成球,再走 —— 先走后缩看起来像卡片被拖走,不像传送。
					{ transform: `translate(0px,0px) scale(${s})`, borderRadius: "999px", offset: 0.3 },
					// 中途抬一点,飞出一道弧;落点通常在上方,抬的是「出发那一侧」。
					{
						transform: `translate(${dx * 0.5}px,${dy * 0.5 - 42}px) scale(${s})`,
						borderRadius: "999px",
						offset: 0.65,
					},
					{
						transform: `translate(${dx}px,${dy}px) scale(${s})`,
						borderRadius: "999px",
						opacity: 1,
					},
				],
				{ duration: 620, easing: "cubic-bezier(.66,0,.34,1)", fill: "forwards" },
			);

			anim.onfinish = () => {
				if (cancelled) return;
				// 落地:球散掉的同时,真卡从小长回原尺寸 —— 两段重叠才像「展开」,不像两件事。
				ball?.animate(
					[
						{ opacity: 1 },
						{ opacity: 0, transform: `translate(${dx}px,${dy}px) scale(${s * 2.2})` },
					],
					{
						duration: 220,
						easing: "ease-out",
						fill: "forwards",
					},
				);
				landing.animate?.(
					[
						{ transform: "scale(.72)", opacity: 0.35 },
						{ transform: "scale(1.03)", opacity: 1, offset: 0.7 },
						{ transform: "scale(1)", opacity: 1 },
					],
					{ duration: 380, easing: "cubic-bezier(.34,1.56,.64,1)" },
				);
				window.setTimeout(finish, 240);
			};
			anim.oncancel = finish;
		};

		raf = requestAnimationFrame(hunt);
		return () => {
			cancelled = true;
			cancelAnimationFrame(raf);
			ball?.remove();
		};
	}, [flight]);

	return null;
}
