import { Btn, Icon, StatusDot } from "@bilibili-notify/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link, useLocation, useNavigate } from "react-router-dom";
import type { OnboardingStepKey } from "./derive";
import { reconcileTourPos, TOUR_SCRIPT, type TourAnchor, type TourPos } from "./tour-script";
import { useOnboardingState } from "./use-onboarding-view";

/**
 * 新手导览(2026-08-29 四轮定稿:**永久常驻,无关闭态**)。
 *
 * - 两态之间切换:左缘小标签(默认给毕业老用户的形态,活进度徽标)⇄ 展开
 *   小卡;「跳过/彻底关闭」概念整个退役 —— 老用户也常驻标签,server 的
 *   dismissed 字段与 /guide 的「重新开启」一并删除;
 * - 主步切换全自动:判据(activeKey)前进/回退都跟(reconcileTourPos),配合
 *   useOnboardingState 的 3s 轮询兜底(毕业即停),「做完自动进下一步」不依赖
 *   任何单条更新链路恰好有推送;主步内子步(选型说明/分解动作)手动翻页;
 * - **聚光灯**:展开态下有锚点的子步在目标路由上时,Spotlight 按控件矩形
 *   挖洞 —— 四周暗幕聚焦、洞内粉描边,`pointer-events: none` 不锁任何操作;
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

const STEP_ORDER: OnboardingStepKey[] = ["login", "adapter", "target", "test", "subs"];
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
 * 聚光灯挖洞层:rAF 每帧跟随目标控件矩形,巨型 box-shadow 把洞外压暗。
 * `fixed` 由 utility 出 —— styles.css 的层守卫不许无层类写 position。
 *
 * - **每帧追而不是低频轮询**:目标页面带 bn-anim-page-in 入场位移动画,
 *   跨页「带我去」后的头几百 ms 里矩形一直在动 —— 低频轮询会先框错位置
 *   再慢悠悠飘过去;每帧追踪让洞口全程贴着入场动画/smooth 滚动走
 *   (稳态下 rect 不变即不 setState,零渲染开销)。
 * - **锚点优先级链**:anchors 靠前优先,每帧取链上第一个存在于页面的锚点。
 *   交互后弹出的弹窗内容(登录二维码/新建表单)挂更高优先级 —— 但**目标在
 *   modal 内时聚光灯整个让位**(modal 自带遮罩就是聚焦,再套框纯多余,真机
 *   否掉过「框整卡」方案);弹窗关掉的那一帧回落页面级锚点,聚光灯自动回来。
 * - **按下即退散该锚点**:用户在页面级目标上按下,它的指路使命就完成了,不再
 *   聚回来;弹窗内的点击一律不影响退散状态。子步推进换锚点链时整体重置。
 */
function Spotlight({ anchors }: { anchors: readonly TourAnchor[] }) {
	const [view, setView] = useState<{
		anchor: TourAnchor;
		rect: DOMRect;
		/** 目标在弹窗里 —— 聚光灯整个让位:modal 自带遮罩就是聚焦,再套框纯多余 */
		inModal: boolean;
	} | null>(null);
	const [dismissedAnchor, setDismissedAnchor] = useState<TourAnchor | null>(null);
	const lastScrolledRef = useRef<TourAnchor | null>(null);
	// 调用方每次 render 造新数组,effect 以内容键为准、链在 effect 内重建
	const anchorsKey = anchors.join("|");

	useEffect(() => {
		const chain = anchorsKey.split("|") as TourAnchor[];
		setDismissedAnchor(null);
		lastScrolledRef.current = null;
		let raf = 0;
		const resolve = (): { anchor: TourAnchor; el: Element } | null => {
			for (const anchor of chain) {
				const el = document.querySelector(`[data-tour="${anchor}"]`);
				if (el) return { anchor, el };
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
				if (!inModal && lastScrolledRef.current !== found.anchor) {
					lastScrolledRef.current = found.anchor;
					found.el.scrollIntoView({ block: "center", behavior: "smooth" });
				}
				const rect = found.el.getBoundingClientRect();
				setView((prev) =>
					prev &&
					prev.anchor === found.anchor &&
					prev.inModal === inModal &&
					!rectsDiffer(prev.rect, rect)
						? prev
						: { anchor: found.anchor, rect, inModal },
				);
			}
			raf = requestAnimationFrame(tick);
		};
		raf = requestAnimationFrame(tick);
		const onPointerDown = (e: Event) => {
			if (!(e.target instanceof Element)) return;
			// 弹窗内的交互不退散:洞框的是整张 modal 卡,暗幕不挡任何操作,而填表
			// 要点很多下 —— 第一下就把灯熄了,后面全程反而没了指引。
			if (e.target.closest('[data-bn="modal"]')) return;
			for (const anchor of chain) {
				const el = document.querySelector(`[data-tour="${anchor}"]`);
				if (el?.contains(e.target)) {
					setDismissedAnchor(anchor);
					return;
				}
			}
		};
		document.addEventListener("pointerdown", onPointerDown, true);
		return () => {
			cancelAnimationFrame(raf);
			document.removeEventListener("pointerdown", onPointerDown, true);
		};
	}, [anchorsKey]);

	if (!view || view.inModal || view.anchor === dismissedAnchor) return null;
	const { rect } = view;
	const pad = 6;
	return createPortal(
		<div
			data-testid="tour-spotlight"
			aria-hidden
			className="bn-tour-spotlight pointer-events-none fixed z-bn-scrim"
			style={{
				top: rect.top - pad,
				left: rect.left - pad,
				width: rect.width + pad * 2,
				height: rect.height + pad * 2,
			}}
		/>,
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
	// 锚点统一成优先级链(单值包成单元素链),给 Spotlight 消费
	const anchorChain = sub?.anchor ? (Array.isArray(sub.anchor) ? sub.anchor : [sub.anchor]) : null;

	if (!visible || !pos || !view) return null;

	const stepIndex = pos.stepKey === "done" ? STEP_ORDER.length : STEP_ORDER.indexOf(pos.stepKey);
	const subCount = pos.stepKey === "done" ? 0 : TOUR_SCRIPT[pos.stepKey].length;
	const pendingTails = view.tails.filter((t) => !t.done);
	const expanded = !collapsed;

	// 标签与卡**都常驻 DOM**:条件渲染做不出退场帧,两态交接动画(styles.css 的
	// .bn-tour-tab / .bn-tour-card,data-shown 驱动)需要退场那侧活到演完。隐藏侧
	// inert + aria-hidden 摘出可达性树与焦点链,视觉上由 CSS 的 visibility 延迟藏。
	return createPortal(
		<>
			{expanded && anchorChain && onRoute ? <Spotlight anchors={anchorChain} /> : null}
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
					{STEP_ORDER.map((key, i) => {
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
							{onRoute ? null : (
								<Btn size="sm" onClick={() => navigate(sub.route)}>
									带我去
								</Btn>
							)}
							{subCount > 1 && pos.subIndex > 0 ? (
								<Btn
									size="sm"
									variant="ghost"
									onClick={() => setManualPos({ ...pos, subIndex: pos.subIndex - 1 })}
								>
									上一步
								</Btn>
							) : null}
							{subCount > 1 && pos.subIndex < subCount - 1 ? (
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
