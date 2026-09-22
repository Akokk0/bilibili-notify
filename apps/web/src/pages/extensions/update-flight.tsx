/**
 * 更新完那一下的「换装」—— 与装完的「传送」(`install-flight.tsx`)同一套语汇、动静更大。
 *
 * 为什么值得做:卡上按「更新」,此前一声不响 —— 按钮灰一下、回来版本号悄悄变了,看起来像
 * 「点了一下什么都没发生」。更新是一件值得看见的事,但它发生在**原地**(卡不挪窝),所以不能
 * 照搬传送的「飞过去」,改成演「新版灌进这张卡」:
 *
 * 1. **起** —— 一颗与传送同款的粉球从按下的「更新」钮起飞,弧线飞进卡片中心;没有起点
 *    (devtools 直接放)就从卡片上方落下来。
 * 2. **蓄** —— 卡片微微下沉,边框上一道光沿着走满一圈(像进度走完),四周晕出粉光。
 * 3. **爆** —— 一道斜向高光扫过整张卡,卡片弹起放大一点,一圈粉色光点迸出去。
 * 4. **落** —— 带回弹落回原位,光晕退去。
 *
 * 🔴 **只演「新版到货」,不演「已经换上」**:跑着的拓展更新完是「新版等着换上」(ADR-0012
 * 决策 47),并没有生效。所以这段动画**不写版本号**;落地时卡上印的是刷新之后的真相 ——
 * 「v新 等着换上」或者真的新版本号(关着的直接换上)。
 *
 * 硬约束同传送:
 * - **`prefers-reduced-motion` 一律直接收摊**;没有 Web Animations API 也当演完了 ——
 *   装饰绝不许把「更新好了」这件事卡住。
 * - **先把卡带进视野再演**,等滚动停稳了再量,量到的才是演的那个位置。
 * - **演到一半被拆**(切页、马上又更新一个),卡上借来的那格样式照样还回去。
 */

import { useEffect, useRef } from "react";
import type { CardMotion } from "./card-motion";
import { EXT_CARD_ANCHOR } from "./install-flight";

type UpdateMotion = Extract<CardMotion, { kind: "update" }>;

/** 球的直径 —— 比传送那颗小一号:这回它是「灌进去」的东西,不是卡本身。 */
const BALL = 22;
/** 等卡出现的上限。等不到就静默收摊,不留一颗停在半空的球。 */
const WAIT_FOR_CARD_MS = 4000;
/** 等滚动停稳的上限 —— 平滑滚动一般几百毫秒,停不下来也不能一直等。 */
const WAIT_FOR_SCROLL_MS = 700;

/** 四拍的时间表(毫秒)。「蓄」从球快到的时候开始,两段重叠才像一件事。 */
const FLY_MS = 460;
const CARD_DELAY = 420;
const CARD_MS = 1100;
/** 卡片那段里「爆」发生在哪儿(占 CARD_MS 的比例)—— 高光与光点对着它起。 */
const BURST_AT = 0.52;
const BURST = CARD_DELAY + CARD_MS * BURST_AT;
const PARTICLES = 14;

const PINK = "var(--color-bn-pink)";
const RADIUS = "var(--radius-bn-card,14px)";

function reducedMotion(): boolean {
	return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

function center(rect: DOMRect): { x: number; y: number } {
	return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

/** 一块铺满卡片、不挡点击的层 —— 光环、光晕、高光、光点都挂在它底下。 */
function layer(extra: string[] = []): HTMLDivElement {
	const el = document.createElement("div");
	el.setAttribute("aria-hidden", "true");
	el.style.cssText = [
		"position:absolute",
		"inset:0",
		`border-radius:${RADIUS}`,
		"pointer-events:none",
		...extra,
	].join(";");
	return el;
}

/**
 * 那颗球 —— 与传送同一种材质。`position: fixed` + `transform` 走,理由同传送:按钮与卡
 * 处在同一个滚动位置里,但 fixed 才不会被卡片自己的变形带歪。
 */
function makeBall(at: { x: number; y: number }): HTMLDivElement {
	const ball = document.createElement("div");
	ball.setAttribute("aria-hidden", "true");
	ball.style.cssText = [
		"position:fixed",
		`left:${at.x - BALL / 2}px`,
		`top:${at.y - BALL / 2}px`,
		`width:${BALL}px`,
		`height:${BALL}px`,
		"border-radius:999px",
		`background:radial-gradient(circle at 50% 42%, color-mix(in srgb, ${PINK} 70%, white), ${PINK})`,
		`box-shadow:0 0 0 1px color-mix(in srgb, ${PINK} 40%, transparent), 0 6px 22px color-mix(in srgb, ${PINK} 55%, transparent)`,
		"pointer-events:none",
		"z-index:var(--z-bn-overlay)",
		"will-change:transform,opacity",
	].join(";");
	return ball;
}

/**
 * 边框上那道走满一圈的光。一个比卡大的方块铺一圈锥形渐变、原地转一圈,外面那层用遮罩
 * 只露出 2px 的边 —— 于是看起来是一道光沿着卡的圆角边跑,而不是整张卡在转。
 */
function makeRing(card: DOMRect): { ring: HTMLDivElement; beam: HTMLDivElement } {
	const ring = layer(["padding:2px", "overflow:hidden", "opacity:0"]);
	const edge = "linear-gradient(#000 0 0)";
	ring.style.setProperty("mask", `${edge} content-box, ${edge}`);
	ring.style.setProperty("mask-composite", "exclude");
	ring.style.setProperty("-webkit-mask", `${edge} content-box, ${edge}`);
	ring.style.setProperty("-webkit-mask-composite", "xor");

	const size = Math.ceil(Math.hypot(card.width, card.height)) + 8;
	const beam = document.createElement("div");
	beam.style.cssText = [
		"position:absolute",
		"left:50%",
		"top:50%",
		`width:${size}px`,
		`height:${size}px`,
		`margin-left:${-size / 2}px`,
		`margin-top:${-size / 2}px`,
		`background:conic-gradient(from 0deg, transparent 0 55%, color-mix(in srgb, ${PINK} 35%, transparent) 72%, ${PINK} 88%, white 96%, transparent 100%)`,
		"will-change:transform",
	].join(";");
	ring.appendChild(beam);
	return { ring, beam };
}

/** 扫过整张卡的那道斜向高光。 */
function makeShine(): { shine: HTMLDivElement; band: HTMLDivElement } {
	const shine = layer(["overflow:hidden"]);
	const band = document.createElement("div");
	band.style.cssText = [
		"position:absolute",
		"top:-30%",
		"bottom:-30%",
		"left:0",
		"width:42%",
		"background:linear-gradient(105deg, transparent 0%, rgba(255,255,255,0) 28%, rgba(255,255,255,.55) 50%, rgba(255,255,255,0) 72%, transparent 100%)",
		"transform:translateX(-130%)",
		"will-change:transform",
	].join(";");
	shine.appendChild(band);
	return { shine, band };
}

/** 一圈光点:从卡心迸向卡边之外。方向均匀、距离带一点随机,才不像齿轮。 */
function makeParticles(card: DOMRect): Array<{ dot: HTMLSpanElement; dx: number; dy: number }> {
	return Array.from({ length: PARTICLES }, (_, i) => {
		const angle = (i / PARTICLES) * Math.PI * 2 + (Math.random() - 0.5) * 0.35;
		const reach = 18 + Math.random() * 30;
		const size = i % 3 === 0 ? 7 : 5;
		const dot = document.createElement("span");
		dot.style.cssText = [
			"position:absolute",
			"left:50%",
			"top:50%",
			`width:${size}px`,
			`height:${size}px`,
			`margin-left:${-size / 2}px`,
			`margin-top:${-size / 2}px`,
			"border-radius:999px",
			i % 2 === 0 ? `background:${PINK}` : `background:color-mix(in srgb, ${PINK} 55%, white)`,
			"opacity:0",
			"will-change:transform,opacity",
		].join(";");
		return {
			dot,
			dx: Math.cos(angle) * (card.width / 2 + reach),
			dy: Math.sin(angle) * (card.height / 2 + reach),
		};
	});
}

/**
 * 换装本体 —— 挂在拓展页上,`motion` 一非空就演一次,演完调 `onDone`。
 */
export function UpdateFlight({
	motion,
	onDone,
}: {
	motion: UpdateMotion | null;
	onDone: () => void;
}) {
	const doneRef = useRef(onDone);
	doneRef.current = onDone;

	useEffect(() => {
		if (!motion) return;
		if (reducedMotion()) {
			doneRef.current();
			return;
		}

		let cancelled = false;
		let raf = 0;
		const nodes: HTMLElement[] = [];
		const anims: Animation[] = [];
		/**
		 * 卡上借来的那一格:挂光环要它是定位容器。🔴 **借了必须还** —— 演到一半被拆没还原的话,
		 * 卡片布局就永久多了一格内联样式,而门禁全绿。还原因此写在收摊与清理两条路上。
		 */
		let borrowed: { card: HTMLElement; position: string } | null = null;
		const restore = () => {
			for (const node of nodes) node.remove();
			nodes.length = 0;
			if (borrowed) {
				borrowed.card.style.position = borrowed.position;
				borrowed = null;
			}
		};
		const finish = () => {
			if (cancelled) return;
			restore();
			doneRef.current();
		};

		const startedAt = performance.now();
		const hunt = () => {
			if (cancelled) return;
			const card = document.querySelector<HTMLElement>(
				`[${EXT_CARD_ANCHOR}="${CSS.escape(motion.id)}"]`,
			);
			if (!card) {
				if (performance.now() - startedAt > WAIT_FOR_CARD_MS) return finish();
				raf = requestAnimationFrame(hunt);
				return;
			}
			// `?.` 不是摆设:jsdom 里没有这个方法,而这段代码在测试里要跑得过去。
			card.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
			settle(card, card.getBoundingClientRect(), performance.now());
		};

		/** 等滚动停稳:连着两帧量到同一个位置才开演(或者等够了上限)。 */
		const settle = (card: HTMLElement, last: DOMRect, since: number) => {
			raf = requestAnimationFrame(() => {
				if (cancelled) return;
				const now = card.getBoundingClientRect();
				const still = now.top === last.top && now.left === last.left;
				if (still || performance.now() - since > WAIT_FOR_SCROLL_MS) play(card, now);
				else settle(card, now, since);
			});
		};

		const play = (card: HTMLElement, rect: DOMRect) => {
			// 没有 WAAPI 就别演 —— 更新好了这件事不能被一段装饰卡住。
			if (typeof card.animate !== "function") return finish();

			if (getComputedStyle(card).position === "static") {
				borrowed = { card, position: card.style.position };
				card.style.position = "relative";
			}
			const rig = layer(["z-index:5", "overflow:visible"]);
			const halo = layer([
				`box-shadow:0 0 0 1px color-mix(in srgb, ${PINK} 45%, transparent), 0 10px 38px color-mix(in srgb, ${PINK} 45%, transparent)`,
				"opacity:0",
			]);
			const { ring, beam } = makeRing(rect);
			const { shine, band } = makeShine();
			const particles = makeParticles(rect);
			rig.append(halo, ring, shine, ...particles.map((p) => p.dot));
			card.appendChild(rig);
			nodes.push(rig);

			// 1. 起:球从「更新」钮起飞,弧线飞进卡心;没有起点就从卡片上方落下。
			const to = center(rect);
			const at = motion.from ? center(motion.from) : { x: to.x, y: rect.top - 150 };
			const dx = to.x - at.x;
			const dy = to.y - at.y;
			const ball = makeBall(at);
			document.body.appendChild(ball);
			nodes.push(ball);
			anims.push(
				ball.animate(
					[
						{ transform: "translate(0px,0px) scale(.6)", opacity: 0.9 },
						{ transform: "translate(0px,0px) scale(1.1)", opacity: 1, offset: 0.18 },
						{
							// 起点通常在卡的下沿(按钮就长在卡里),往上抬一段才是一道弧。
							transform: `translate(${dx * 0.5}px,${dy * 0.5 - (motion.from ? 70 : 0)}px) scale(1)`,
							offset: 0.6,
						},
						{ transform: `translate(${dx}px,${dy}px) scale(.45)`, opacity: 0 },
					],
					{ duration: FLY_MS, easing: "cubic-bezier(.66,0,.34,1)", fill: "forwards" },
				),
			);

			// 2–4. 卡片本身:下沉蓄力 → 弹起放大 → 带回弹落回原位。它是这一整段里最长的一条,
			// 以它放完为收摊的时刻。
			const main = card.animate(
				[
					{ transform: "translateY(0px) scale(1)" },
					{ transform: "translateY(2px) scale(.975)", offset: 0.4 },
					{ transform: "translateY(-6px) scale(1.035)", offset: BURST_AT },
					{ transform: "translateY(1px) scale(.994)", offset: 0.74 },
					{ transform: "translateY(0px) scale(1)" },
				],
				{ duration: CARD_MS, delay: CARD_DELAY, easing: "cubic-bezier(.45,0,.25,1)" },
			);
			anims.push(main);

			anims.push(
				halo.animate(
					[
						{ opacity: 0 },
						{ opacity: 0.8, offset: 0.35 },
						{ opacity: 1, offset: 0.5 },
						{ opacity: 0 },
					],
					{ duration: CARD_MS, delay: CARD_DELAY, fill: "forwards" },
				),
				ring.animate(
					[
						{ opacity: 0 },
						{ opacity: 1, offset: 0.12 },
						{ opacity: 1, offset: 0.78 },
						{ opacity: 0 },
					],
					{ duration: BURST - CARD_DELAY + 260, delay: CARD_DELAY, fill: "forwards" },
				),
				// 光走满一圈正好落在「爆」的那一刻。
				beam.animate([{ transform: "rotate(0deg)" }, { transform: "rotate(360deg)" }], {
					duration: BURST - CARD_DELAY,
					delay: CARD_DELAY,
					easing: "cubic-bezier(.5,0,.3,1)",
					fill: "forwards",
				}),
				band.animate([{ transform: "translateX(-130%)" }, { transform: "translateX(340%)" }], {
					duration: 420,
					delay: BURST - 60,
					easing: "cubic-bezier(.4,0,.2,1)",
					fill: "forwards",
				}),
				...particles.map(({ dot, dx: px, dy: py }, i) =>
					dot.animate(
						[
							{ transform: "translate(0px,0px) scale(.2)", opacity: 0 },
							{
								transform: `translate(${px * 0.35}px,${py * 0.35}px) scale(1)`,
								opacity: 1,
								offset: 0.25,
							},
							{ transform: `translate(${px}px,${py}px) scale(.35)`, opacity: 0 },
						],
						// 最晚那颗也得在卡片落地之前放完:收摊跟着卡片走,晚到的光点会被半路拔掉。
						{
							duration: 460,
							delay: BURST - 20 + i * 4,
							easing: "cubic-bezier(.2,.7,.3,1)",
							fill: "forwards",
						},
					),
				),
			);

			main.onfinish = finish;
			main.oncancel = finish;
		};

		raf = requestAnimationFrame(hunt);
		return () => {
			cancelled = true;
			cancelAnimationFrame(raf);
			for (const anim of anims) anim.cancel?.();
			anims.length = 0;
			// 顺利那条路走的是 finish();这一条是「演到一半被拆」,借来的样式也得还回去。
			restore();
		};
	}, [motion]);

	return null;
}
