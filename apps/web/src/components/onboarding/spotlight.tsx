import { MODAL_SELECTOR } from "@bilibili-notify/ui";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/**
 * 新手导览的聚光灯 —— 挖洞暗幕(视觉)+ 引导锁(拦截)。
 *
 * 挂点是控件自己身上的 `data-tour="…"`(库件 Btn / AddButton / AddCard 都透传
 * 原生属性)—— 曾经另有一个 TourSpot 包裹件专给 Btn 用,于是同一件事有三种写法,
 * 而且量到的是那层 span 的矩形、不是按钮的。
 *
 * 视觉走一整张 SVG:全屏暗幕 rect 配 mask 挖洞,每洞再描一圈粉框 ——
 * 单洞时代的「巨型 box-shadow」摊不开多洞(暗幕会叠加、互相盖洞),而**同名
 * 挂点的每个实例都是等价入口,必须一起亮**(真机踩过:空态 CTA 亮着,左栏
 * 「+ 新建」暗着锁着,像是被禁用)。SVG rect 的几何是 CSS 可过渡属性,洞口
 * 跟随目标的平滑不丢。
 *
 * 引导锁的拦截块不可见、无动画需求,用矩形补集分割(视口减去洞集)铺
 * `pointer-events: auto` 的块 —— 视觉与拦截各走各的最合适形态。
 */

export interface SpotRect {
	top: number;
	left: number;
	width: number;
	height: number;
}

/**
 * 视口减去洞集的矩形补集 —— 引导锁的拦截块几何。y 扫描分带:洞的上下缘把
 * 视口切成横带,每带内对相交洞的 x 区间取补。洞可以重叠、可以出界(截进
 * bounds 再算)。
 */
export function subtractRects(bounds: SpotRect, holes: readonly SpotRect[]): SpotRect[] {
	const x0 = bounds.left;
	const x1 = bounds.left + bounds.width;
	const y0 = bounds.top;
	const y1 = bounds.top + bounds.height;
	const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
	const ys = new Set<number>([y0, y1]);
	for (const h of holes) {
		ys.add(clamp(h.top, y0, y1));
		ys.add(clamp(h.top + h.height, y0, y1));
	}
	const bands = [...ys].sort((a, b) => a - b);
	const out: SpotRect[] = [];
	for (let i = 0; i < bands.length - 1; i++) {
		const top = bands[i];
		const bottom = bands[i + 1];
		if (bottom <= top) continue;
		// 该带内相交洞的 x 区间,合并后取补
		const spans = holes
			.filter((h) => h.top < bottom && h.top + h.height > top)
			.map((h) => [clamp(h.left, x0, x1), clamp(h.left + h.width, x0, x1)] as const)
			.filter(([l, r]) => r > l)
			.sort((a, b) => a[0] - b[0]);
		let cursor = x0;
		for (const [l, r] of spans) {
			if (l > cursor) out.push({ top, left: cursor, width: l - cursor, height: bottom - top });
			cursor = Math.max(cursor, r);
		}
		if (cursor < x1) out.push({ top, left: cursor, width: x1 - cursor, height: bottom - top });
	}
	return out;
}

/**
 * 相交的洞合并成外接矩形。同亮组里紧挨着的两颗按钮(失败链的「配置」+「测试」),
 * 各开一个带 SPOT_PAD 的洞会叠出「8」字形双描边(真机踩过);合并后整组一颗
 * 胶囊。相离的洞(多行等价入口)保持独立。合并可能引发连锁(A∩B 的并集碰到 C),
 * 所以每合一次从头重扫 —— 洞数是个位数,平方扫描绰绰有余。
 */
export function mergeIntersecting(rects: readonly SpotRect[]): SpotRect[] {
	const out = [...rects];
	for (let i = 0; i < out.length; i++) {
		for (let j = i + 1; j < out.length; j++) {
			const a = out[i];
			const b = out[j];
			const intersects =
				a.left <= b.left + b.width &&
				b.left <= a.left + a.width &&
				a.top <= b.top + b.height &&
				b.top <= a.top + a.height;
			if (!intersects) continue;
			const left = Math.min(a.left, b.left);
			const top = Math.min(a.top, b.top);
			out[i] = {
				left,
				top,
				width: Math.max(a.left + a.width, b.left + b.width) - left,
				height: Math.max(a.top + a.height, b.top + b.height) - top,
			};
			out.splice(j, 1);
			i = -1; // 从头重扫(外层 i++ 后回到 0)
			break;
		}
	}
	return out;
}

function rectsDiffer(a: readonly DOMRect[], b: readonly DOMRect[]): boolean {
	if (a.length !== b.length) return true;
	return a.some(
		(r, i) =>
			r.top !== b[i].top ||
			r.left !== b[i].left ||
			r.width !== b[i].width ||
			r.height !== b[i].height,
	);
}

const SPOT_PAD = 6;

/** 连着这么多帧测下来纹丝不动,就认为这一段静止了,可以降频。 */
const STABLE_FRAMES_TO_IDLE = 30;
/** 静止期的巡查间隔(ms)。仍要巡 —— 有些位移不发任何事件(比如脚本改样式)。 */
const IDLE_MEASURE_MS = 100;

/**
 * 聚光灯挖洞层:rAF 每帧跟随目标矩形。洞外铺拦截块吃掉指针操作(**引导锁**:
 * 亮灯期间只有洞内目标可点,小卡/弹窗 z 在暗幕之上不受拦)。亮灯即锁 ——
 * 不想锁的场景(/about 教程阅读区)由调用方整个不渲染这一层,不是这里开口子。
 * 目标用 CSS selector 描述 —— 页内控件
 * (`[data-tour=…]`)与顶栏导航页签(`[data-tour-nav=…]`)共用同一套机制。
 * `fixed` 由 utility 出 —— styles.css 的层守卫不许无层类写 position。
 *
 * - **每帧追而不是低频轮询**:目标页面带 bn-anim-page-in 入场位移动画,跨页
 *   后的头几百 ms 里矩形一直在动,每帧追踪让洞口全程贴着走(稳态下 rect 不变
 *   即不 setState,零渲染开销)。
 * - **selector 优先级链**:靠前优先,每帧取链上第一个**有实例**的 selector;
 *   该 selector 的全部页面级实例一起开洞(同名挂点=等价入口)。实例全在
 *   modal 内时聚光灯整个让位(modal 自带遮罩就是聚焦,真机否掉过套框方案);
 *   弹窗关掉的那一帧回落页面级锚点,灯自动回来。
 * - **按下即退散,过弹窗即复原**:在页面级目标上按下,灯先熄(别盖住无弹窗
 *   操作的后续,如点「测试」后自由点「配置」);但随后若有弹窗出现(让位),
 *   退散一并清除 —— 用户取消弹窗回来,灯要重新指路(真机踩过:取消后灯
 *   永远不回来)。子步推进换链时整体重置。
 */
export function Spotlight({ selectors }: { selectors: readonly string[] }) {
	const [view, setView] = useState<{
		selector: string;
		rects: DOMRect[];
		/** 目标全在弹窗里 —— 聚光灯整个让位 */
		inModal: boolean;
		/**
		 * 拦截块的补集要按视口算,所以视口尺寸得**跟着测**、进比较、进 state。
		 * 只在渲染时读 `window.innerWidth/innerHeight` 的话:重渲染由锚点 rect
		 * 的变化驱动,而锚在顶栏页签(矩形与窗口尺寸无关)时把窗口拖大,rect 纹丝
		 * 不动 → 不重渲染 → 挡板还是旧尺寸。新露出来那条边被暗幕(width=100%)
		 * 涂黑了却点得动:看着锁着,其实是开的(2026-08-31 审查)。
		 */
		viewport: { width: number; height: number };
	} | null>(null);
	const [dismissedSelector, setDismissedSelector] = useState<string | null>(null);
	const lastScrolledRef = useRef<string | null>(null);
	// 调用方每次 render 造新数组,effect 以内容键为准、链在 effect 内重建
	// (selector 里不会出现 `|`:挂点词表与站内路由都没有它)
	const selectorsKey = selectors.join("|");

	useEffect(() => {
		const chain = selectorsKey.split("|");
		setDismissedSelector(null);
		lastScrolledRef.current = null;
		let raf = 0;
		let idle: ReturnType<typeof setTimeout> | undefined;
		const resolve = (): { selector: string; els: Element[] } | null => {
			for (const selector of chain) {
				// display:none 的实例没有盒,得滤掉 —— 响应式双形态组件(如 SectionNav
				// 竖栏/横条)会把同名挂点渲染两份,被藏起那份的 rect 全 0,给它开洞会把
				// 一枚 12×12 的粉框画到视口原点(真机踩过:左上角一小段粉弧)。
				const els = [...document.querySelectorAll(selector)].filter(
					(el) => el.getClientRects().length > 0,
				);
				if (els.length > 0) return { selector, els };
			}
			return null;
		};
		// 一次完整测量。返回「这次和上次不一样吗」—— 用来决定还要不要逐帧盯着。
		let last: NonNullable<typeof view> | null = null;
		const measure = (): boolean => {
			const found = resolve();
			if (!found) {
				const changed = last !== null;
				last = null;
				if (changed) setView(null);
				return changed;
			}
			const pageEls = found.els.filter((el) => el.closest(MODAL_SELECTOR) === null);
			const inModal = pageEls.length === 0;
			if (inModal) {
				// 让位期间清掉退散:点目标 → 弹窗 → 取消回来,灯要重新指路
				setDismissedSelector((prev) => (prev === null ? prev : null));
			} else if (lastScrolledRef.current !== found.selector) {
				lastScrolledRef.current = found.selector;
				pageEls[0].scrollIntoView({ block: "center", behavior: "smooth" });
			}
			const rects = pageEls.map((el) => el.getBoundingClientRect());
			const viewport = { width: window.innerWidth, height: window.innerHeight };
			const changed =
				last === null ||
				last.selector !== found.selector ||
				last.inModal !== inModal ||
				last.viewport.width !== viewport.width ||
				last.viewport.height !== viewport.height ||
				rectsDiffer(last.rects, rects);
			if (changed) {
				last = { selector: found.selector, rects, inModal, viewport };
				setView(last);
			}
			return changed;
		};

		// 测量要查全文档 + 逐元素 getBoundingClientRect(强制同步重排)。动的时候
		// 必须逐帧跟(洞要贴着做 morph/滚动的目标),但导览常常整段时间就那么停着 ——
		// 停着还每帧重排,图表页、日志长列表都白白陪跑。所以静下来就降到低频巡查,
		// 任何可能让目标位移的信号立刻打回逐帧。
		//
		// 静下来是**真的把 rAF 停掉**、改挂一个 setTimeout,不是继续每帧醒来空转:
		// 一个长期挂着的 rAF 会一直把浏览器的帧循环顶着跑(整段导览、每个页面),
		// 而低频巡查根本不需要跟显示器同步。
		let stableFrames = 0;
		const sweep = () => {
			// 巡查只为抓「没有任何事件的脚本改样式」;一动就打回逐帧
			if (measure()) track();
			else idle = setTimeout(sweep, IDLE_MEASURE_MS);
		};
		const frame = () => {
			stableFrames = measure() ? 0 : stableFrames + 1;
			if (stableFrames >= STABLE_FRAMES_TO_IDLE) {
				raf = 0;
				idle = setTimeout(sweep, IDLE_MEASURE_MS);
				return;
			}
			raf = requestAnimationFrame(frame);
		};
		function track() {
			stableFrames = 0;
			if (idle !== undefined) {
				clearTimeout(idle);
				idle = undefined;
			}
			if (raf === 0) raf = requestAnimationFrame(frame);
		}
		const wake = track;
		track();
		// 捕获阶段:目标可能坐在某个内部滚动容器里,scroll 不冒泡。
		window.addEventListener("scroll", wake, true);
		window.addEventListener("resize", wake);
		document.addEventListener("transitionend", wake, true);
		document.addEventListener("animationend", wake, true);
		const onPointerDown = (e: Event) => {
			wake();
			if (!(e.target instanceof Element)) return;
			// 弹窗内的交互不退散:填表要点很多下 —— 第一下就把灯熄了,
			// 后面全程反而没了指引。
			if (e.target.closest(MODAL_SELECTOR)) return;
			for (const selector of chain) {
				const els = document.querySelectorAll(selector);
				for (const el of els) {
					if (el.contains(e.target)) {
						setDismissedSelector(selector);
						return;
					}
				}
			}
		};
		document.addEventListener("pointerdown", onPointerDown, true);
		return () => {
			cancelAnimationFrame(raf);
			clearTimeout(idle);
			document.removeEventListener("pointerdown", onPointerDown, true);
			window.removeEventListener("scroll", wake, true);
			window.removeEventListener("resize", wake);
			document.removeEventListener("transitionend", wake, true);
			document.removeEventListener("animationend", wake, true);
		};
	}, [selectorsKey]);

	if (!view || view.inModal || view.selector === dismissedSelector) return null;
	const holes: SpotRect[] = mergeIntersecting(
		view.rects.map((r) => ({
			top: r.top - SPOT_PAD,
			left: r.left - SPOT_PAD,
			width: r.width + SPOT_PAD * 2,
			height: r.height + SPOT_PAD * 2,
		})),
	);
	const bounds: SpotRect = {
		top: 0,
		left: 0,
		width: view.viewport.width,
		height: view.viewport.height,
	};
	// **视口里一个洞都看不见 → 灯与锁一起不铺**。滚动是刻意不拦的,而首次滚入
	// 视口按 selector 只做一次 —— 用户自己往下翻页时洞会跟着目标滑出视口,被
	// subtractRects 夹没,整个视口就成了一整块拦截层,而没有任何东西会把目标滚
	// 回来:除了小卡「收起」,页面上每一次点击都被吃掉(2026-08-31 审查)。
	// 不跟用户抢滚动条 —— 他滚回去时 rAF 照样在测,灯自己就回来了。
	const onScreen = holes.some(
		(h) =>
			h.left < bounds.width &&
			h.left + h.width > 0 &&
			h.top < bounds.height &&
			h.top + h.height > 0,
	);
	if (!onScreen) return null;
	const blocks = subtractRects(bounds, holes);
	return createPortal(
		<>
			{/* 引导锁:暗幕即禁区 —— 洞外的补集矩形铺拦截块吃掉指针操作,只留洞内
			    目标可点。小卡/标签(z-bn-tour-panel)与弹窗(z-bn-modal)都在暗幕之上
			    不受拦,逃生口 = 小卡「收起」;滚动不拦,rAF 每帧追着目标一起跟。 */}
			{blocks.length > 0 ? (
				<div
					data-testid="tour-blocker"
					aria-hidden
					className="pointer-events-none fixed inset-0 z-bn-scrim"
				>
					{blocks.map((b, i) => (
						<div
							// biome-ignore lint/suspicious/noArrayIndexKey: subtractRects 按 y 扫描带定序,下标就是稳定身份;用几何做 key 会让目标一动就整批拆了重建
							key={i}
							className="pointer-events-auto absolute"
							style={{ top: b.top, left: b.left, width: b.width, height: b.height }}
						/>
					))}
				</div>
			) : null}
			<svg
				data-testid="tour-spotlight"
				data-target={view.selector}
				aria-hidden
				className="bn-tour-spotlight pointer-events-none fixed inset-0 z-bn-scrim h-full w-full"
			>
				<mask id="bn-tour-spot-mask" maskUnits="userSpaceOnUse">
					<rect x="0" y="0" width="100%" height="100%" fill="white" />
					{holes.map((h, i) => (
						<rect
							// biome-ignore lint/suspicious/noArrayIndexKey: 洞按同名实例的文档序排,无更稳的身份
							key={i}
							className="bn-tour-hole"
							x={h.left}
							y={h.top}
							width={h.width}
							height={h.height}
							fill="black"
						/>
					))}
				</mask>
				<rect
					x="0"
					y="0"
					width="100%"
					height="100%"
					className="bn-tour-shade"
					mask="url(#bn-tour-spot-mask)"
				/>
				{holes.map((h, i) => (
					<rect
						// biome-ignore lint/suspicious/noArrayIndexKey: 同上,与 mask 内洞一一对应
						key={i}
						data-testid="tour-spot-frame"
						className="bn-tour-frame"
						x={h.left}
						y={h.top}
						width={h.width}
						height={h.height}
						fill="none"
					/>
				))}
			</svg>
		</>,
		document.body,
	);
}
