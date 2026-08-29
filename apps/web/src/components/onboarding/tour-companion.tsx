import { Btn, Icon, StatusDot } from "@bilibili-notify/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link, useLocation, useNavigate } from "react-router-dom";
import type { OnboardingStepKey } from "./derive";
import { reconcileTourPos, TOUR_SCRIPT, TOUR_STEP_ORDER, type TourPos } from "./tour-script";
import { useOnboardingState } from "./use-onboarding-view";

/**
 * 新手导览(2026-08-29 四轮定稿:**永久常驻,无关闭态**)。
 *
 * - 两态之间切换:左缘小标签(默认给毕业老用户的形态,活进度徽标)⇄ 展开
 *   小卡;「跳过/彻底关闭」概念整个退役 —— 老用户也常驻标签,server 的
 *   dismissed 字段与 /guide 的「重新开启」一并删除;
 * - 主步切换全自动、**只进不退**(reconcileTourPos):判据前进就跟,被破坏
 *   不回跳;配合 useOnboardingState 的 3s 轮询兜底(毕业即停),「做完自动进
 *   下一步」不依赖任何单条更新链路恰好有推送;主步内子步(选型说明/分解动作)
 *   靠「下一步」或抵达目标路由(advanceOnRoute)流转,同样没有回头路;
 * - **聚光灯即引导锁**:展开态下 Spotlight 按目标矩形挖洞 —— 在目标路由上聚
 *   子步的控件挂点;不在时聚顶栏对应导航页签(「带我去」按钮退役,用户跟着灯
 *   自己点页签过去)。四周暗幕聚焦、洞内粉描边,洞外的点击被拦截层吃掉(处于
 *   引导就只做被指的操作);/about 教程阅读区亮灯不锁;逃生口 = 小卡「收起」
 *   (z 在暗幕之上,永远可点);
 * - 位置:fixed 左缘/左下角 —— 右下推送 toast、右上告警、底部居中灵动岛,
 *   左边是唯一空位。小卡 z 走 island 档,暗幕走 scrim 档(在小卡之下)。
 * - **两态 morph 动画**(styles.css 的 .bn-tour-tab/.bn-tour-card):iOS zoom 式
 *   「标签展开成卡、卡缩回标签」—— 标签与卡常驻 DOM,切换瞬间把对方的布局
 *   矩形 pose 写进 CSS 变量,两元素沿同一条几何轨迹互变+中段交叉淡切,读作
 *   同一块玻璃在变形;CSS transition 天生可打断(中途再点从当前姿态直接反向)。
 */

/** 折叠成左缘小标签的状态 —— per-browser 轻量偏好,localStorage 读写都要兜隐私模式。 */
const COLLAPSED_LS_KEY = "bn-tour-collapsed";

function readCollapsed(): boolean {
	try {
		return localStorage.getItem(COLLAPSED_LS_KEY) === "1";
	} catch {
		return false;
	}
}

function persistCollapsed(v: boolean) {
	try {
		localStorage.setItem(COLLAPSED_LS_KEY, v ? "1" : "0");
	} catch {
		// 存不住就只活在本次会话
	}
}

const STEP_SHORT: Record<OnboardingStepKey, string> = {
	login: "登录",
	adapter: "适配器",
	target: "目标",
	test: "测试",
	subs: "订阅",
};

function rectsDiffer(a: DOMRect | null, b: DOMRect | null): boolean {
	if (!a || !b) return a !== b;
	return a.top !== b.top || a.left !== b.left || a.width !== b.width || a.height !== b.height;
}

/**
 * 聚光灯挖洞层:rAF 每帧跟随目标矩形,巨型 box-shadow 把洞外压暗;lock 时
 * 洞外同时铺四块拦截层吃掉指针操作(**引导锁**:亮灯期间只有洞内目标可点,
 * 小卡/弹窗 z 在暗幕之上不受拦;/about 教程阅读区亮灯不锁,不然读不了)。
 * 目标用 CSS selector 描述 —— 页内控件(`[data-tour=…]`)与顶栏导航页签
 * (`[data-tour-nav=…]`,「带我去」按钮退役后 off-route 的指路方式)共用同一套
 * 解析/退散/让位机制。`fixed` 由 utility 出 —— styles.css 的层守卫不许
 * 无层类写 position。
 *
 * - **每帧追而不是低频轮询**:目标页面带 bn-anim-page-in 入场位移动画,
 *   跨页「带我去」后的头几百 ms 里矩形一直在动 —— 低频轮询会先框错位置
 *   再慢悠悠飘过去;每帧追踪让洞口全程贴着入场动画/smooth 滚动走
 *   (稳态下 rect 不变即不 setState,零渲染开销)。
 * - **selector 优先级链**:靠前优先,每帧取链上第一个存在于页面的目标。
 *   交互后弹出的弹窗内容(登录二维码/新建表单)挂更高优先级 —— 但**目标在
 *   modal 内时聚光灯整个让位**(modal 自带遮罩就是聚焦,再套框纯多余,真机
 *   否掉过「框整卡」方案);弹窗关掉的那一帧回落页面级锚点,聚光灯自动回来。
 * - **按下即退散该目标**:用户在页面级目标上按下,它的指路使命就完成了,不再
 *   聚回来;弹窗内的点击一律不影响退散状态。子步推进换链时整体重置。
 */
function Spotlight({ selectors, lock }: { selectors: readonly string[]; lock: boolean }) {
	const [view, setView] = useState<{
		selector: string;
		rect: DOMRect;
		/** 目标在弹窗里 —— 聚光灯整个让位:modal 自带遮罩就是聚焦,再套框纯多余 */
		inModal: boolean;
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
		const resolve = (): { selector: string; el: Element } | null => {
			for (const selector of chain) {
				const el = document.querySelector(selector);
				if (el) return { selector, el };
			}
			return null;
		};
		const tick = () => {
			const found = resolve();
			if (!found) {
				setView((prev) => (prev === null ? prev : null));
			} else {
				// 目标在弹窗里 → 不渲染(让位),但仍持续解析:弹窗关掉的那一帧回落到
				// 页面级锚点,聚光灯自动回来。
				const inModal = found.el.closest('[data-bn="modal"]') !== null;
				if (!inModal && lastScrolledRef.current !== found.selector) {
					lastScrolledRef.current = found.selector;
					found.el.scrollIntoView({ block: "center", behavior: "smooth" });
				}
				const rect = found.el.getBoundingClientRect();
				setView((prev) =>
					prev &&
					prev.selector === found.selector &&
					prev.inModal === inModal &&
					!rectsDiffer(prev.rect, rect)
						? prev
						: { selector: found.selector, rect, inModal },
				);
			}
			raf = requestAnimationFrame(tick);
		};
		raf = requestAnimationFrame(tick);
		const onPointerDown = (e: Event) => {
			if (!(e.target instanceof Element)) return;
			// 弹窗内的交互不退散:填表要点很多下 —— 第一下就把灯熄了,
			// 后面全程反而没了指引。
			if (e.target.closest('[data-bn="modal"]')) return;
			for (const selector of chain) {
				const el = document.querySelector(selector);
				if (el?.contains(e.target)) {
					setDismissedSelector(selector);
					return;
				}
			}
		};
		document.addEventListener("pointerdown", onPointerDown, true);
		return () => {
			cancelAnimationFrame(raf);
			document.removeEventListener("pointerdown", onPointerDown, true);
		};
	}, [selectorsKey]);

	if (!view || view.inModal || view.selector === dismissedSelector) return null;
	const { rect } = view;
	const pad = 6;
	const hole = {
		top: rect.top - pad,
		left: rect.left - pad,
		width: rect.width + pad * 2,
		height: rect.height + pad * 2,
	};
	return createPortal(
		<>
			{/* 引导锁:暗幕即禁区 —— 洞外四块拦截层吃掉指针操作,只留洞内目标可点
			    (处于引导就只做被指的那一步)。小卡/标签(z-bn-tour-panel)与弹窗
			    (z-bn-modal)都在暗幕之上不受拦,逃生口 = 小卡「收起」;滚动不拦,
			    rAF 每帧追着目标,洞口与拦截块一起跟。lock=false(教程阅读区)时
			    只亮灯指路、不锁。 */}
			{lock ? (
				<div
					data-testid="tour-blocker"
					aria-hidden
					className="pointer-events-none fixed inset-0 z-bn-scrim"
				>
					<div
						className="pointer-events-auto absolute inset-x-0 top-0"
						style={{ height: Math.max(0, hole.top) }}
					/>
					<div
						className="pointer-events-auto absolute inset-x-0 bottom-0"
						style={{ top: Math.max(0, hole.top + hole.height) }}
					/>
					<div
						className="pointer-events-auto absolute left-0"
						style={{ top: hole.top, height: hole.height, width: Math.max(0, hole.left) }}
					/>
					<div
						className="pointer-events-auto absolute right-0"
						style={{
							top: hole.top,
							height: hole.height,
							left: Math.max(0, hole.left + hole.width),
						}}
					/>
				</div>
			) : null}
			<div
				data-testid="tour-spotlight"
				data-target={view.selector}
				aria-hidden
				className="bn-tour-spotlight pointer-events-none fixed z-bn-scrim"
				style={{
					top: hole.top,
					left: hole.left,
					width: hole.width,
					height: hole.height,
				}}
			/>
		</>,
		document.body,
	);
}

/** 元素的**布局**矩形(不含 transform)。隐藏侧正停在 morph pose 上,
 *  getBoundingClientRect 会测到形变后的假矩形;而「临时清 transform 再测」
 *  更糟 —— rect 调用强制同步重排,把隐藏侧的当前渲染值硬拉到清零后的位置
 *  (正好是动画终点),随后的 transition 零距离,整个 morph 瞬移(真机踩过)。
 *  offset 系是纯布局量,天生不含 transform、零副作用;两元素同挂 body 下
 *  offsetParent 一致,即便 body 被皮肤 transform 化,差值与比值也不受影响。 */
function measureLayoutRect(el: HTMLElement): {
	left: number;
	top: number;
	width: number;
	height: number;
} {
	return { left: el.offsetLeft, top: el.offsetTop, width: el.offsetWidth, height: el.offsetHeight };
}

export function TourCompanion() {
	const location = useLocation();
	const navigate = useNavigate();
	const [manualPos, setManualPos] = useState<TourPos | null>(null);
	const tabRef = useRef<HTMLButtonElement>(null);
	const cardRef = useRef<HTMLElement>(null);
	// 折叠成左缘小标签(类似女仆 AI 胶囊):导览继续进行、进度照常刷新,只是
	// 不占屏幕。这是唯一的收纳形态 —— 没有「彻底关闭」。
	const [collapsed, setCollapsed] = useState(readCollapsed);
	const toggleCollapsed = (v: boolean) => {
		// iOS zoom 式 morph:翻转状态**之前**把「对方的矩形 pose」写进 CSS 变量,
		// 标签与卡沿同一条几何轨迹互变(styles.css 按 data-shown 消费这两个变量)。
		// 每次点击现测现写 —— resize/内容高度变化都不会留下过时轨迹;切换永远由
		// 这里触发,所以变量总在动画开始前就位,不需要 fallback。
		const tab = tabRef.current;
		const card = cardRef.current;
		if (tab && card) {
			const t = measureLayoutRect(tab);
			const c = measureLayoutRect(card);
			// jsdom 的 rect 全 0,除零守护顺便兜住极端布局
			const sx = (a: number, b: number) => (b > 0 ? a / b : 1);
			card.style.setProperty(
				"--bn-tour-to-tab",
				`translate(${t.left - c.left}px, ${t.top - c.top}px) scale(${sx(t.width, c.width)}, ${sx(t.height, c.height)})`,
			);
			tab.style.setProperty(
				"--bn-tour-to-card",
				`translate(${c.left - t.left}px, ${c.top - t.top}px) scale(${sx(c.width, t.width)}, ${sx(c.height, t.height)})`,
			);
		}
		persistCollapsed(v);
		setCollapsed(v);
	};
	// poll 的启停条件(未毕业)在 hook 内部判,这里只声明意图。
	const { view, ready } = useOnboardingState({ poll: true });
	const visible = ready && view !== null;

	const pos = useMemo(
		() => (view ? reconcileTourPos(manualPos, view.activeKey) : null),
		[view, manualPos],
	);

	const sub = pos && pos.stepKey !== "done" ? TOUR_SCRIPT[pos.stepKey][pos.subIndex] : null;
	const onRoute = sub ? location.pathname === sub.route : false;
	// 提出来给闭包用 —— JSX 条件里的 narrowing 进不了 onClick 闭包
	const subLink = sub?.link ?? null;
	// 聚光目标统一成 selector 优先级链:在目标路由上取子步的控件挂点;不在时改聚
	// 顶栏对应导航页签(「带我去」按钮退役 —— 用户跟着灯自己点页签过去)。
	const anchorChain = sub?.anchor ? (Array.isArray(sub.anchor) ? sub.anchor : [sub.anchor]) : null;
	const spotlightSelectors = sub
		? onRoute
			? (anchorChain?.map((a) => `[data-tour="${a}"]`) ?? null)
			: [`[data-tour-nav="${sub.route}"]`]
		: null;
	// 教程阅读区亮灯不锁:点「选型指引」进来是要读内容的,锁住连章节都切不了;
	// 灯仍指着导航页签,读完跟着走。
	const inReadingZone = location.pathname.startsWith("/about");

	// 抵达即流转:说明步(advanceOnRoute)在用户到达目标路由的那一刻使命完成 ——
	// 不论走「带我去」还是自己切导航,都直接进入动手子步,聚光灯与文案永远同步
	// (真机踩过:灯已指到「+ 新建」,小卡还在讲选型)。
	const arrivedOnInfoStep = sub?.advanceOnRoute === true && onRoute;
	useEffect(() => {
		if (!arrivedOnInfoStep || !pos || pos.stepKey === "done") return;
		if (pos.subIndex < TOUR_SCRIPT[pos.stepKey].length - 1) {
			setManualPos({ stepKey: pos.stepKey, subIndex: pos.subIndex + 1 });
		}
	}, [arrivedOnInfoStep, pos]);

	if (!visible || !pos || !view) return null;

	const stepIndex =
		pos.stepKey === "done" ? TOUR_STEP_ORDER.length : TOUR_STEP_ORDER.indexOf(pos.stepKey);
	const subCount = pos.stepKey === "done" ? 0 : TOUR_SCRIPT[pos.stepKey].length;
	const pendingTails = view.tails.filter((t) => !t.done);
	const expanded = !collapsed;

	// 标签与卡**都常驻 DOM**:条件渲染做不出退场帧,两态交接动画(styles.css 的
	// .bn-tour-tab / .bn-tour-card,data-shown 驱动)需要退场那侧活到演完。隐藏侧
	// inert + aria-hidden 摘出可达性树与焦点链,视觉上由 CSS 的 visibility 延迟藏。
	return createPortal(
		<>
			{expanded && spotlightSelectors ? (
				<Spotlight selectors={spotlightSelectors} lock={!inReadingZone} />
			) : null}
			<button
				ref={tabRef}
				type="button"
				data-bn="btn"
				aria-label="展开新手导览"
				aria-hidden={expanded}
				inert={expanded}
				data-shown={collapsed ? "true" : "false"}
				onClick={() => toggleCollapsed(false)}
				className="bn-tour-tab bn-glass-strong shadow-bn-elev fixed left-0 top-3/4 z-bn-tour-panel flex flex-col items-center gap-1 rounded-r-bn-card px-1.5 py-2.5 text-bn-text-secondary hover:text-bn-pink"
			>
				<Icon.sparkle size={15} />
				<span className="text-bn-2xs font-medium leading-tight">指</span>
				<span className="-mt-1 text-bn-2xs font-medium leading-tight">引</span>
				<span className="text-bn-2xs text-bn-text-tertiary">
					{view.doneCount}/{view.steps.length}
				</span>
			</button>
			<aside
				ref={cardRef}
				aria-label="新手导览"
				aria-hidden={collapsed}
				inert={collapsed}
				data-shown={expanded ? "true" : "false"}
				className="bn-tour-card bn-glass-strong shadow-bn-elev fixed bottom-4 left-4 z-bn-tour-panel w-[300px] rounded-bn-card p-3.5 max-sm:right-4 max-sm:w-auto"
			>
				<div className="mb-2 flex items-center gap-1.5">
					{TOUR_STEP_ORDER.map((key, i) => {
						const done = view.steps.find((s) => s.key === key)?.done === true;
						return (
							<span key={key} className="flex items-center gap-1">
								<StatusDot kind={done ? "ok" : i === stepIndex ? "live" : "pending"} size="sm" />
								<span
									className={
										i === stepIndex
											? "text-bn-2xs font-medium text-bn-text-primary"
											: "text-bn-2xs text-bn-text-tertiary"
									}
								>
									{STEP_SHORT[key]}
								</span>
							</span>
						);
					})}
				</div>
				{pos.stepKey === "done" ? (
					<>
						<div className="text-bn-base font-semibold text-bn-text-primary">🎉 全部配置完成!</div>
						<p className="mt-1 mb-2 text-bn-xs leading-relaxed text-bn-text-secondary">
							五步链路已打通,订阅 UP 的动态与开播会自动推送。
						</p>
						{pendingTails.length > 0 ? (
							<p className="mb-2 text-bn-2xs leading-relaxed text-bn-text-tertiary">
								锦上添花:
								{pendingTails.map((t) => (
									<Link
										key={t.key}
										to={t.key === "image" ? "/about/guide/render" : "/about/guide/ai"}
										className="ml-1 text-bn-pink hover:underline"
									>
										{t.key === "image" ? "图片渲染(强烈推荐)" : "AI 能力"}
									</Link>
								))}
							</p>
						) : null}
						<Btn size="sm" onClick={() => toggleCollapsed(true)}>
							收起
						</Btn>
					</>
				) : sub ? (
					<>
						<div className="text-bn-base font-semibold text-bn-text-primary">{sub.title}</div>
						<p className="mt-1 mb-2.5 text-bn-xs leading-relaxed text-bn-text-secondary">
							{sub.body}
						</p>
						<div className="flex items-center gap-2">
							{/* 「带我去」退役:不在目标路由时聚光灯指着顶栏页签,用户自己点过去 */}
							{onRoute ? null : (
								<span className="text-bn-2xs text-bn-text-tertiary">点亮起的页签前往 →</span>
							)}
							{/* 没有「上一步」—— 流转单向(定案:做完一步不回头,只顺序前进);
							    说明步(advanceOnRoute)也没有「下一步」,它的流转方式就是抵达 */}
							{subCount > 1 && pos.subIndex < subCount - 1 && !sub.advanceOnRoute ? (
								<Btn
									size="sm"
									variant="outline"
									onClick={() => setManualPos({ ...pos, subIndex: pos.subIndex + 1 })}
								>
									下一步
								</Btn>
							) : null}
							{subLink ? (
								<Btn size="sm" variant="ghost" onClick={() => navigate(subLink.to)}>
									{subLink.label}
								</Btn>
							) : null}
							<span className="flex-1" />
							<button
								type="button"
								data-bn="btn"
								onClick={() => toggleCollapsed(true)}
								className="text-bn-2xs text-bn-text-tertiary transition-colors hover:text-bn-text-primary"
							>
								收起
							</button>
						</div>
					</>
				) : null}
			</aside>
		</>,
		document.body,
	);
}
