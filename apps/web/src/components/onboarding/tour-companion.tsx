import { Btn, Icon, StatusDot } from "@bilibili-notify/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { api } from "../../services/api";
import type { GlobalConfig } from "../../types/globals";
import { Fireworks, StepDoneBadge } from "./celebration";
import type { OnboardingStepKey, OnboardingView } from "./derive";
import { Spotlight } from "./spotlight";
import {
	reconcileTourPos,
	STEP_DONE_MESSAGES,
	TOUR_SCRIPT,
	TOUR_STEP_ORDER,
	type TourPos,
} from "./tour-script";
import { useOnboardingState } from "./use-onboarding-view";

/**
 * 新手导览(2026-08-29 四轮定稿:**永久常驻,无关闭态**)。
 *
 * - 两态之间切换:左缘小标签(活进度徽标)⇄ 展开小卡。**没有关闭态** —— 标签
 *   永久常驻(旧的 dismissed 字段与 /guide 的「重新开启」已一并删除);
 * - 展不展开由 `onboarding.skipped` 决定(2026-08-30 补):没这笔标记就自动展开
 *   (新装的用户一开面板即被接住),有标记就收成标签。写标记的两条路 —— 小卡上
 *   的「跳过指引」与走完五步毕业。它落在**配置**而非 localStorage:换浏览器/换
 *   机器不该被重新引导一遍。存量用户全靠这个按钮脱身:判据认「按过测试」才算配
 *   好适配器,没点过的老用户升级后一律被判成没配完,会连人带面板被引导锁锁住;
 * - 主步切换全自动(reconcileTourPos):判据**前进与回退都跟**(回退=前置被
 *   破坏,如退出登录,导览带用户回去补);配合 useOnboardingState 的 3s 轮询
 *   兜底(毕业即停),「做完自动进下一步」不依赖任何单条更新链路恰好有推送;
 *   「不回头」只在交互层:子步靠「下一步」/抵达/达成流转,没有「上一步」;
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

/**
 * `null` = 这台浏览器还没人动过两态开关 —— 交给实例那笔 `onboarding.skipped` 决定。
 * 存过就以存的为准:「我在这台机器上想不想看见它」比实例标记更贴身。
 */
function readCollapsed(): boolean | null {
	try {
		const v = localStorage.getItem(COLLAPSED_LS_KEY);
		return v === null ? null : v === "1";
	} catch {
		return null;
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
	//
	// 两个来源合成:本机存过的偏好优先,没存过则跟随实例那笔 `onboarding.skipped`
	// (见下方 skipped)。所以「跳过」在别的浏览器打开也照样生效,而「我在这台机器
	// 上把它展开了」不会被实例标记按回去。
	const [collapsedPref, setCollapsedPref] = useState<boolean | null>(readCollapsed);
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
		setCollapsedPref(v);
	};
	// poll 的启停条件(未毕业)在 hook 内部判,这里只声明意图。
	const { view, ready } = useOnboardingState({ poll: true });

	// 「这台实例已经不用再被自动展开了」的持久标记。落配置不落 localStorage:
	// 换浏览器/换机器开面板不该再被引导一遍(判据本身也是实例级的)。
	const globalsQ = useQuery({
		queryKey: ["globals"],
		queryFn: () => api.get<GlobalConfig>("/api/globals"),
	});
	const skipped = globalsQ.data?.onboarding?.skipped === true;
	const collapsed = collapsedPref ?? skipped;
	// 标记没到手之前**什么都不渲染**:先画展开态再收回去会闪一下,而这一闪正好
	// 落在「老用户被锁」那个最敏感的场景上。请求失败(isPending 落地为 error)也
	// 放行 —— 那时 globals 整个面板都废了,不该顺带把导览也吞掉。
	const visible = ready && view !== null && !globalsQ.isPending;

	const qc = useQueryClient();
	const { mutate: markSkipped } = useMutation({
		mutationFn: () => api.patch("/api/globals", { onboarding: { skipped: true } }),
		onSuccess: () => qc.invalidateQueries({ queryKey: ["globals"] }),
	});

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

	// 子步自动流转(单向),两个信号:
	// - 抵达(advanceOnRoute):说明步在用户到达目标路由的那一刻使命完成,直接进入
	//   动手子步,聚光灯与文案永远同步(真机踩过:灯已指「+ 新建」,小卡还讲选型);
	// - 达成(doneWhen):探测数据证明子步目标已完成(如适配器已落库),立刻翻页把灯
	//   移到下一个动作上(真机踩过:保存适配器后灯断档,要自己想起来去点测试)。
	const subAdvanceReady =
		(sub?.advanceOnRoute === true && onRoute) ||
		(sub?.doneWhen != null && view != null && sub.doneWhen(view));
	useEffect(() => {
		if (!subAdvanceReady || !pos || pos.stepKey === "done") return;
		if (pos.subIndex < TOUR_SCRIPT[pos.stepKey].length - 1) {
			setManualPos({ stepKey: pos.stepKey, subIndex: pos.subIndex + 1 });
		}
	}, [subAdvanceReady, pos]);

	// 完成庆祝:主步判据 false→true 的那一拍,屏幕中央弹完成徽章(主人定案:
	// 挂操作位置太不起眼)—— 小卡文案无声切到下一步太突兀(真机反馈);五步
	// 全绿的毕业时刻加放一场全屏烟花。
	// 首拍(prev 为空)只记录不庆祝:刷新页面时已完成的步不算「刚完成」。
	const prevViewRef = useRef<OnboardingView | null>(null);
	const [celebration, setCelebration] = useState<{ seq: number; text: string } | null>(null);
	const [fireworks, setFireworks] = useState(false);
	useEffect(() => {
		const prev = prevViewRef.current;
		prevViewRef.current = view;
		if (!view || !prev || collapsed) return;
		const newlyDone = view.steps.filter(
			(s) => s.done && prev.steps.find((p) => p.key === s.key)?.done === false,
		);
		if (newlyDone.length > 0) {
			const key = newlyDone[newlyDone.length - 1].key;
			setCelebration({ seq: Date.now(), text: STEP_DONE_MESSAGES[key] });
		}
		if (view.allDone && !prev.allDone) setFireworks(true);
	}, [view, collapsed]);

	// 毕业即记标记:否则走完五步的人此后每次开面板都被那张 🎉 卡糊一脸 —— 它已经
	// 没有信息量了。ref 挡住重入:mutate 到 invalidate 落回来之间 skipped 还是 false,
	// 不挡就会连发。
	const markedRef = useRef(false);
	useEffect(() => {
		if (!view?.allDone || skipped || markedRef.current) return;
		markedRef.current = true;
		markSkipped();
	}, [view?.allDone, skipped, markSkipped]);

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
			{celebration ? (
				<StepDoneBadge
					key={celebration.seq}
					text={celebration.text}
					onDone={() => setCelebration(null)}
				/>
			) : null}
			{fireworks ? <Fireworks onDone={() => setFireworks(false)} /> : null}
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
				className="bn-tour-card bn-glass-strong shadow-bn-elev fixed bottom-4 left-4 z-bn-tour-panel w-80 rounded-bn-card p-3.5 max-sm:right-4 max-sm:w-auto"
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
				{/* 内容区按步位 key 重挂,换步时浅浮入(bn-tour-step-in)—— 判据自动流转的
				    文案硬切太突兀(真机反馈);完成徽章在操作位负责「上一步成了」的那半 */}
				{pos.stepKey === "done" ? (
					<div key="done" className="bn-tour-step-in">
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
					</div>
				) : sub ? (
					<div key={`${pos.stepKey}:${pos.subIndex}`} className="bn-tour-step-in">
						<div className="text-bn-base font-semibold text-bn-text-primary">{sub.title}</div>
						<p className="mt-1 mb-2.5 text-bn-xs leading-relaxed text-bn-text-secondary">
							{sub.body}
						</p>
						{/* 「带我去」退役:不在目标路由时聚光灯指着顶栏页签,用户自己点过去。
						    提示独立成行 —— 塞进按钮行会把整行挤爆(真机踩过:收起折成竖排) */}
						{onRoute ? null : (
							<p className="-mt-1.5 mb-2 text-bn-2xs text-bn-text-tertiary">点亮起的页签前往 →</p>
						)}
						<div className="flex flex-wrap items-center gap-2">
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
							{/* 「跳过指引」= 记下实例标记 + 收起,不是关闭(标签照常常驻)。存量
							    用户唯一的出口:判据认「按过测试」才算配好适配器,没点过那个按钮
							    的老用户升级后一律被判成没配完,引导锁会把面板锁到只剩聚光灯 */}
							<button
								type="button"
								data-bn="btn"
								onClick={() => {
									markSkipped();
									toggleCollapsed(true);
								}}
								className="whitespace-nowrap text-bn-2xs text-bn-text-tertiary transition-colors hover:text-bn-text-primary"
							>
								跳过指引
							</button>
							<button
								type="button"
								data-bn="btn"
								onClick={() => toggleCollapsed(true)}
								className="whitespace-nowrap text-bn-2xs text-bn-text-tertiary transition-colors hover:text-bn-text-primary"
							>
								收起
							</button>
						</div>
					</div>
				) : null}
			</aside>
		</>,
		document.body,
	);
}
