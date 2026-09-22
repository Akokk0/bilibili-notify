/**
 * 更新完那一下的「换装」—— 与装完的「传送」(`install-flight.tsx`)同一套语汇、动静更大。
 *
 * 为什么值得做:卡上按「更新」,此前一声不响 —— 按钮灰一下、回来版本号悄悄变了,看起来像
 * 「点了一下什么都没发生」。更新是一件值得看见的事,但它发生在**原地**(卡不挪窝),所以不能
 * 照搬传送的「飞过去」,改成演「新版灌进这张卡」:
 *
 * 1. **起** —— 请求一出门就开演:一颗与传送同款的粉球从按下的「更新」钮起飞,弧线飞进卡片
 *    中心;没有起点(devtools 直接放)就从卡片上方落下来。
 * 2. **蓄** —— 卡片微微下沉,边框上一道光一圈一圈地走,四周晕出粉光 —— **一直蓄到装完**
 *    (`motion.outcome` 落定),下载那几秒因此有了反馈;至少走满一圈,短了没有蓄力感。
 * 3. **收** —— 装成了:那道光一边转一边从边框收到卡心,收成一个圆;卡面蒙上一层薄纱托住它
 *    (新版的卡正好在纱底下刷新,纱退去时印的就是真相)。
 * 4. **画** —— 顺着光头把那个圆画满,接着打一个勾,像付款成功时那一下;勾落下的同时卡从沉底
 *    浮回原位。停一会儿让人看清,圈勾与薄纱一起退去。
 *
 * 没装成就没有 3、4:光环淡出、卡轻轻回原样,错误由页面那句话去说。
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

/** 时间表(毫秒)。「蓄」从球快到的时候开始,两段重叠才像一件事。 */
const FLY_MS = 460;
const CHARGE_AT = 420;
/** 卡片沉下去用多久 —— 沉到底就停在那儿,蓄多久停多久。 */
const SINK_MS = 320;
/** 边框那道光走一圈多久。蓄的时候一圈接一圈。 */
const LOOP_MS = 900;
/** 至少蓄满一圈才收(从开演算起)—— 装得再快,也得看得见蓄过力。 */
const MIN_CHARGE_MS = CHARGE_AT + LOOP_MS;

/*
 * 装成之后那一段(从落定那一刻算)。几段首尾略有重叠 —— 光还没收稳圈就开画、圈还差一点勾就
 * 开打,才像同一道光一路画下来,而不是三段动画排队。
 */
/** 光从边框收到卡心、收成一个圆。 */
const GATHER_MS = 420;
const CIRCLE_AT = GATHER_MS - 40;
/** 圈画满。 */
const CIRCLE_MS = 440;
const CHECK_AT = CIRCLE_AT + CIRCLE_MS - 60;
/** 勾打完。 */
const CHECK_MS = 300;
/** 卡从沉底浮回原位(与勾同时起),回弹落在它的哪儿(比例)。 */
const RISE_MS = 520;
const RISE_PEAK = 0.5;
/** 勾打完停一会儿,让人看清。 */
const HOLD_MS = 520;
const OUT_AT = CHECK_AT + CHECK_MS + HOLD_MS;
/** 圈勾与薄纱退去。 */
const OUT_MS = 320;
const LANDING_MS = OUT_AT + OUT_MS;
/** 没装成:光环淡出、卡回原样那一下。 */
const FADE_MS = 320;

/** 卡心那个圈的直径与线宽 —— 光环收拢成的就是这个圆,粗细一致才像同一道光接着画。 */
const MARK = 64;
const STROKE = 3.5;
const CIRCLE_R = (MARK - STROKE) / 2;
const CIRCLE_LEN = 2 * Math.PI * CIRCLE_R;
/** 勾:短的一笔、长的一笔(`MARK` 见方的画布里)。长度照点算,描线才刚好描满。 */
const TICK_FROM = { x: 20.5, y: 33 };
const TICK_TURN = { x: 28.5, y: 41 };
const TICK_TO = { x: 44, y: 25.5 };
const TICK_PATH = `M${TICK_FROM.x} ${TICK_FROM.y} L${TICK_TURN.x} ${TICK_TURN.y} L${TICK_TO.x} ${TICK_TO.y}`;
const TICK_LEN =
	Math.hypot(TICK_TURN.x - TICK_FROM.x, TICK_TURN.y - TICK_FROM.y) +
	Math.hypot(TICK_TO.x - TICK_TURN.x, TICK_TO.y - TICK_TURN.y);

/** 光头在锥形渐变里的位置(一圈的比例)—— 最亮的那一截,后面拖着渐淡的尾巴。 */
const HEAD = 0.96;

const PINK = "var(--color-bn-pink)";
const RADIUS = "var(--radius-bn-card,14px)";
const SVG_NS = "http://www.w3.org/2000/svg";

function reducedMotion(): boolean {
	return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

function center(rect: DOMRect): { x: number; y: number } {
	return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

/** 一块铺满卡片、不挡点击的层 —— 光环、光晕、薄纱、圈勾都挂在它底下。 */
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
 * 只露出一圈内边距 —— 于是看起来是一道光沿着卡的圆角边跑,而不是整张卡在转。
 *
 * 收的时候把这一层的盒子缩成卡心一个圆、内边距加到圈的线宽:锥形渐变一直居中在转,于是
 * 那道光是**一边转一边收拢**成圆的,不是换了一个东西。
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
		`background:conic-gradient(from 0deg, transparent 0 55%, color-mix(in srgb, ${PINK} 35%, transparent) 72%, ${PINK} 88%, white ${HEAD * 100}%, transparent 100%)`,
		"will-change:transform",
	].join(";");
	ring.appendChild(beam);
	return { ring, beam };
}

/**
 * 光头在 `aheadMs` 之后转到哪(从十二点钟顺时针量的角度)。读不到转了多少(测试替身)就当
 * 还没转过 —— 差的只是圈从哪儿起笔。
 */
function headAngle(spin: Animation, aheadMs: number): number {
	const turned = spin.effect?.getComputedTiming?.().progress ?? 0;
	return ((HEAD + turned + aheadMs / LOOP_MS) % 1) * 360;
}

/** 描一笔的样式:虚线只有一段、长度正好一笔;起始偏移把它整段藏在起点之前。 */
function strokeStyle(len: number): string {
	return [
		"fill:none",
		`stroke:${PINK}`,
		`stroke-width:${STROKE}`,
		"stroke-linecap:round",
		"stroke-linejoin:round",
		// 空档比一笔长出一截:圆头的线帽在偏移刚好等于长度时也会露一个点。
		`stroke-dasharray:${len} ${len + STROKE * 2}`,
		`stroke-dashoffset:${len + STROKE}`,
	].join(";");
}

/**
 * 卡心那个圈 + 勾。圈的起笔转到 `headDeg`(光头收到的地方):SVG 的圆从三点钟起笔、顺时针走,
 * 所以转 `headDeg - 90` 度 —— 画出来是那道光接着往前跑,而不是在别处另起一笔。
 */
function makeMark(headDeg: number): {
	mark: HTMLDivElement;
	circle: SVGCircleElement;
	tick: SVGPathElement;
} {
	const mid = MARK / 2;
	const mark = document.createElement("div");
	mark.style.cssText = [
		"position:absolute",
		"left:50%",
		"top:50%",
		`width:${MARK}px`,
		`height:${MARK}px`,
		`margin-left:${-mid}px`,
		`margin-top:${-mid}px`,
		"will-change:transform,opacity",
	].join(";");
	const svg = document.createElementNS(SVG_NS, "svg");
	svg.setAttribute("viewBox", `0 0 ${MARK} ${MARK}`);
	svg.setAttribute("width", String(MARK));
	svg.setAttribute("height", String(MARK));
	svg.style.cssText = `display:block;overflow:visible;filter:drop-shadow(0 0 6px color-mix(in srgb, ${PINK} 55%, transparent))`;

	const circle = document.createElementNS(SVG_NS, "circle");
	circle.setAttribute("cx", String(mid));
	circle.setAttribute("cy", String(mid));
	circle.setAttribute("r", String(CIRCLE_R));
	circle.setAttribute("transform", `rotate(${headDeg - 90} ${mid} ${mid})`);
	circle.style.cssText = strokeStyle(CIRCLE_LEN);

	const tick = document.createElementNS(SVG_NS, "path");
	tick.setAttribute("d", TICK_PATH);
	tick.style.cssText = strokeStyle(TICK_LEN);

	svg.append(circle, tick);
	mark.appendChild(svg);
	return { mark, circle, tick };
}

/**
 * 换装本体 —— 挂在拓展页上,`motion` 一非空就演一次,演完调 `onDone`。
 */
export function UpdateFlight({
	motion,
	onDone,
	minChargeMs = MIN_CHARGE_MS,
}: {
	motion: UpdateMotion | null;
	onDone: () => void;
	/** 至少蓄多久才落定 —— 只有测试会给(给 0,不必真等一圈)。 */
	minChargeMs?: number;
}) {
	const doneRef = useRef(onDone);
	doneRef.current = onDone;
	const minChargeRef = useRef(minChargeMs);
	minChargeRef.current = minChargeMs;

	useEffect(() => {
		if (!motion) return;
		if (reducedMotion()) {
			doneRef.current();
			return;
		}

		let cancelled = false;
		/** 已经收过摊了 —— 收摊时要停掉所有动画,而停掉卡片那条会再叫一次收摊。 */
		let over = false;
		let raf = 0;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const nodes: HTMLElement[] = [];
		const anims: Animation[] = [];
		/**
		 * 卡上借来的那一格:挂光环要它是定位容器。🔴 **借了必须还** —— 演到一半被拆没还原的话,
		 * 卡片布局就永久多了一格内联样式,而门禁全绿。还原因此写在收摊与清理两条路上。
		 */
		let borrowed: { card: HTMLElement; position: string } | null = null;
		const restore = () => {
			// 🔴 先停动画再摘节点:「下沉」那条停在末帧(`fill: forwards`),不停的话卡永远陷着。
			for (const anim of anims) anim.cancel?.();
			anims.length = 0;
			for (const node of nodes) node.remove();
			nodes.length = 0;
			if (borrowed) {
				borrowed.card.style.position = borrowed.position;
				borrowed = null;
			}
		};
		const finish = () => {
			if (cancelled || over) return;
			over = true;
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
			const playedAt = performance.now();

			if (getComputedStyle(card).position === "static") {
				borrowed = { card, position: card.style.position };
				card.style.position = "relative";
			}
			const rig = layer(["z-index:5", "overflow:visible"]);
			const halo = layer([
				`box-shadow:0 0 0 1px color-mix(in srgb, ${PINK} 45%, transparent), 0 10px 38px color-mix(in srgb, ${PINK} 45%, transparent)`,
				"opacity:0",
			]);
			const veil = layer([
				"background:color-mix(in srgb, var(--color-bn-surface) 72%, transparent)",
				"backdrop-filter:blur(6px)",
				"-webkit-backdrop-filter:blur(6px)",
				"opacity:0",
			]);
			const { ring, beam } = makeRing(rect);
			rig.append(halo, veil, ring);
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

			// 2. 蓄:沉下去就停在那儿;光一圈接一圈地走,光晕亮起来 —— 蓄到装完为止。
			const sunk = "translateY(2px) scale(.975)";
			const sink = card.animate([{ transform: "translateY(0px) scale(1)" }, { transform: sunk }], {
				duration: SINK_MS,
				delay: CHARGE_AT,
				easing: "cubic-bezier(.4,0,.2,1)",
				fill: "forwards",
			});
			const spin = beam.animate([{ transform: "rotate(0deg)" }, { transform: "rotate(360deg)" }], {
				duration: LOOP_MS,
				delay: CHARGE_AT,
				iterations: Number.POSITIVE_INFINITY,
			});
			anims.push(
				sink,
				halo.animate([{ opacity: 0 }, { opacity: 0.8 }], {
					duration: SINK_MS,
					delay: CHARGE_AT,
					fill: "forwards",
				}),
				ring.animate([{ opacity: 0 }, { opacity: 1 }], {
					duration: 220,
					delay: CHARGE_AT,
					fill: "forwards",
				}),
				spin,
			);

			// 装完没有 + 至少蓄满一圈,两样都到了才落定。
			const enough = new Promise<void>((resolve) => {
				timer = setTimeout(
					resolve,
					Math.max(0, minChargeRef.current - (performance.now() - playedAt)),
				);
			});
			void Promise.all([motion.outcome, enough]).then(([landed]) => {
				if (cancelled || over) return;
				if (landed) land(card);
				else fade(card);
				// 新的一段已经从沉底那一帧接过去了,这时再停「下沉」才不会闪一下。
				sink.cancel();
			});

			/**
			 * 3–4. 收 + 画:光收到卡心成一个圆,顺着光头画满、打勾;卡跟着勾浮回原位。整段挂在
			 * **卡片那一条**上(沉着 → 浮起 → 停着),它放完就收摊 —— 别的几条都在它之内放完。
			 */
			function land(target: HTMLElement) {
				const { mark, circle, tick } = makeMark(headAngle(spin, CIRCLE_AT));
				rig.append(mark);
				const share = (ms: number) => ms / LANDING_MS;
				const main = target.animate(
					[
						{ transform: sunk },
						{ transform: sunk, offset: share(CHECK_AT), easing: "cubic-bezier(.3,0,.2,1)" },
						{
							transform: "translateY(-2px) scale(1.012)",
							offset: share(CHECK_AT + RISE_MS * RISE_PEAK),
							easing: "cubic-bezier(.4,0,.2,1)",
						},
						{ transform: "translateY(0px) scale(1)", offset: share(CHECK_AT + RISE_MS) },
						{ transform: "translateY(0px) scale(1)" },
					],
					{ duration: LANDING_MS },
				);
				const pop = CHECK_AT + CHECK_MS + 180 - CIRCLE_AT;
				anims.push(
					main,
					ring.animate(
						[
							{
								inset: "0px",
								borderRadius: getComputedStyle(ring).borderTopLeftRadius || "14px",
								padding: "2px",
							},
							{
								inset: `calc(50% - ${MARK / 2}px)`,
								borderRadius: `${MARK / 2}px`,
								padding: `${STROKE}px`,
							},
						],
						{ duration: GATHER_MS, easing: "cubic-bezier(.55,0,.15,1)", fill: "forwards" },
					),
					// 圈画上来,转着的那道光就退掉 —— 接力,不是两道光叠在一起。
					ring.animate([{ opacity: 1 }, { opacity: 0 }], {
						duration: CIRCLE_MS * 0.7,
						delay: CIRCLE_AT,
						fill: "forwards",
					}),
					halo.animate([{ opacity: 0.8 }, { opacity: 0 }], {
						duration: GATHER_MS,
						fill: "forwards",
					}),
					veil.animate([{ opacity: 0 }, { opacity: 1 }], {
						duration: GATHER_MS,
						easing: "ease-out",
						fill: "forwards",
					}),
					// 起笔的速度接住那道光(一圈 LOOP_MS),再加速把圈合上。
					circle.animate([{ strokeDashoffset: CIRCLE_LEN + STROKE }, { strokeDashoffset: 0 }], {
						duration: CIRCLE_MS,
						delay: CIRCLE_AT,
						easing: "cubic-bezier(.4,.2,.2,1)",
						fill: "both",
					}),
					tick.animate([{ strokeDashoffset: TICK_LEN + STROKE }, { strokeDashoffset: 0 }], {
						duration: CHECK_MS,
						delay: CHECK_AT,
						easing: "cubic-bezier(.4,0,.2,1)",
						fill: "both",
					}),
					// 圈画着慢慢放大到位,勾落下那一下轻轻一顶 —— 是「好了」,不是爆炸。
					mark.animate(
						[
							{ transform: "scale(.9)" },
							{ transform: "scale(1)", offset: (CHECK_AT - CIRCLE_AT) / pop },
							{ transform: "scale(1.04)", offset: (CHECK_AT + CHECK_MS - CIRCLE_AT) / pop },
							{ transform: "scale(1)" },
						],
						{ duration: pop, delay: CIRCLE_AT, easing: "ease-out", fill: "both" },
					),
					mark.animate(
						[
							{ opacity: 1, transform: "scale(1)", filter: "blur(0px)" },
							{ opacity: 0, transform: "scale(.94)", filter: "blur(2px)" },
						],
						{ duration: OUT_MS, delay: OUT_AT, easing: "ease-in", fill: "forwards" },
					),
					veil.animate([{ opacity: 1 }, { opacity: 0 }], {
						duration: OUT_MS,
						delay: OUT_AT,
						easing: "ease-in",
						fill: "forwards",
					}),
				);
				main.onfinish = finish;
				main.oncancel = finish;
			}

			/** 没装成:光环与光晕淡出,卡从沉底轻轻回原样。不画勾 —— 没有值得庆祝的事。 */
			function fade(target: HTMLElement) {
				const main = target.animate(
					[{ transform: sunk }, { transform: "translateY(0px) scale(1)" }],
					{
						duration: FADE_MS,
						easing: "cubic-bezier(.4,0,.2,1)",
					},
				);
				anims.push(
					main,
					halo.animate([{ opacity: 0.8 }, { opacity: 0 }], { duration: FADE_MS, fill: "forwards" }),
					ring.animate([{ opacity: 1 }, { opacity: 0 }], { duration: FADE_MS, fill: "forwards" }),
				);
				main.onfinish = finish;
				main.oncancel = finish;
			}
		};

		raf = requestAnimationFrame(hunt);
		return () => {
			cancelled = true;
			cancelAnimationFrame(raf);
			clearTimeout(timer);
			// 顺利那条路走的是 finish();这一条是「演到一半被拆」,借来的样式也得还回去。
			restore();
		};
	}, [motion]);

	return null;
}
