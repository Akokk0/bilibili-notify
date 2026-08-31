import { Btn, ErrorNote, Icon, ModalShell, StatusDot } from "@bilibili-notify/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { api } from "../../services/api";
import { useNavStore } from "../../store/nav";
import { useOnboardingReopen } from "../../store/onboarding";
import type { GlobalConfig } from "../../types/globals";
import { Fireworks, StepDoneBadge } from "./celebration";
import type { OnboardingStepKey, OnboardingTailKey, OnboardingView } from "./derive";
import { Spotlight } from "./spotlight";
import { reconcileTourPos, STEP_DONE_MESSAGES, TOUR_SCRIPT, type TourPos } from "./tour-script";
import { useOnboardingState } from "./use-onboarding-view";

/**
 * 新手导览(2026-08-30 主人定案:三态 `onboarding.skipped`)。
 *
 * - **缺失 = 还没问过**:打开面板先在屏幕中间弹询问框 —— 「我是新用户,开始
 *   指引」/「我是老用户,跳过」。存量实例升级上来与全新安装都落在这档:判据认
 *   「按过测试」才算配好适配器,老用户升级后一律被判成没配完,不问一句就开导览
 *   等于拿引导锁糊人一脸(上一版正是这么被打回的);
 * - `false` = 要指引:左缘小标签(活进度徽标)⇄ 展开小卡,判据驱动照旧;
 * - `true` = 不要:**整个导览不渲染**(标签也没有)。写入的三条路 —— 询问框选
 *   「老用户」、小卡上的「跳过指引」、走完五步毕业(🎉 卡演完点收起才谢幕);
 *   系统页的「重新开启」写回 false 并经 useOnboardingReopen 信号把卡展开。
 *   它落在**配置**而非 localStorage:换浏览器/换机器不该被重新问一遍;
 * - 主步切换全自动(reconcileTourPos):判据**前进与回退都跟**(回退=前置被
 *   破坏,如退出登录,导览带用户回去补);配合 useOnboardingState 的 3s 轮询
 *   兜底(毕业即停),「做完自动进下一步」不依赖任何单条更新链路恰好有推送;
 *   「不回头」只在交互层:子步靠「下一步」/抵达/达成流转,没有「上一步」;
 * - **聚光灯即引导锁**:展开态下 Spotlight 按目标矩形挖洞 —— 在目标路由上聚
 *   子步的控件挂点;不在时聚顶栏对应导航页签(「带我去」按钮退役,用户跟着灯
 *   自己点页签过去)。四周暗幕聚焦、洞内粉描边,洞外的点击被拦截层吃掉(处于
 *   引导就只做被指的操作);/about 教程阅读区聚光灯整个不渲染(读内容不受压,
 *   回去的路 = 小卡「回去继续」按钮);逃生口 = 小卡「收起」
 *   (z 在暗幕之上,永远可点);
 *   唯一的例外是**目标页签被主人藏掉**(nav 偏好只钉死「系统」):此时没有页签
 *   可指,灯与锁都不铺,「带我去」作为降级出口回到小卡上 —— 否则导览死在这儿;
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
 * `null` = 这台浏览器还没人动过两态开关 → 按展开算。
 *
 * 这里**不回落到实例那笔 `onboarding.skipped`**:三态改版之后「不要指引」已经由
 * `skipped=true` 整个不渲染接管了,轮不到收纳态代劳。collapsed 只回答一件更小的
 * 事 ——「此刻在这台机器上,卡是摊开的还是收成标签」,所以它天生是 per-browser 的。
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

/** 毕业卡上的「锦上添花」链接。两条分支(去哪 / 叫什么)曾各写一个三元,
 *  加第三个尾巴会同时落进两处的 else 里 —— 一张表就没有漏的余地。 */
const TAIL_LINKS: Record<OnboardingTailKey, { to: string; label: string }> = {
	image: { to: "/about/guide/render", label: "图片渲染(强烈推荐)" },
	ai: { to: "/about/guide/ai", label: "AI 能力" },
};

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

/** 小卡右下角那排三级小字钮(「跳过指引」/「收起」)—— 比库件 Btn.sm 还轻一档,
 *  刻意不用 Btn:那是 26px 高的控件,塞进这行会把整行挤到折行(真机踩过)。 */
function TextBtn({ label, onClick }: { label: string; onClick: () => void }) {
	return (
		<button
			type="button"
			data-bn="btn"
			onClick={onClick}
			className="whitespace-nowrap text-bn-2xs text-bn-text-tertiary transition-colors hover:text-bn-text-primary"
		>
			{label}
		</button>
	);
}

export function TourCompanion() {
	const location = useLocation();
	const navigate = useNavigate();
	const [manualPos, setManualPos] = useState<TourPos | null>(null);
	const tabRef = useRef<HTMLButtonElement>(null);
	const cardRef = useRef<HTMLElement>(null);
	// 折叠成左缘小标签(类似女仆 AI 胶囊):导览继续进行、进度照常刷新,只是
	// 不占屏幕。**纯 per-browser**,没存过就按展开算(见 readCollapsed)——
	// 「要不要指引」是实例级的三态标记管的事,这里只管「此刻这台机器上摊开没有」。
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
	// 「这台实例已经不用再被自动展开了」的持久标记。落配置不落 localStorage:
	// 换浏览器/换机器开面板不该再被引导一遍(判据本身也是实例级的)。
	const globalsQ = useQuery({
		queryKey: ["globals"],
		queryFn: () => api.get<GlobalConfig>("/api/globals"),
	});
	// 三态:undefined = 还没问过(弹询问框);false = 要指引;true = 整个导览不渲染
	const choice = globalsQ.data?.onboarding?.skipped;
	// 三态是**配置**读出来的,不是「data 有没有值」读出来的:请求失败时 data 同样
	// 是 undefined,而 undefined 在三态里就是「还没问过」—— 一次 502 / 代理抖动
	// 就能把已经选过「我是老用户,跳过」的人重新问一遍,而且他按哪个键都会当场
	// 覆写自己的配置(2026-08-31 审查)。**拿不到答案 ≠ 还没问过**,那就一个字都别问。
	const choiceKnown = globalsQ.data !== undefined;
	const collapsed = collapsedPref ?? false;
	// 询问框的两页与本会话关闭态(Esc/点外面 = 这次不回答,刷新后再问)
	const [askPhase, setAskPhase] = useState<"ask" | "noted">("ask");
	const [askDismissed, setAskDismissed] = useState(false);
	// 毕业活口:标记自动写下后,🎉 卡还得站到用户点「收起」为止,别被 invalidate
	// 回流的 choice=true 当场掐没
	const [justGraduated, setJustGraduated] = useState(false);
	// 「本会话已经替这台实例写过毕业标记」的重入闸(见下方毕业 effect)。声明提到
	// 这儿是因为**重新开启要把它抬起来** —— 详见 reopen effect 里那段。
	const markedRef = useRef(false);
	// 只有导览真开着(要指引 + 卡摊开)才轮询判据 —— 这是全站唯一的长期定时请求。
	// active 是更外面那道闸:答案还没到手、或者答案是「不要」时,这棵树整个 render
	// null,判据一条都不必问(否则每开一个页面都白发四条,/logs、/cards 上连订阅
	// 全表都拉一遍)。
	const { view } = useOnboardingState({
		poll: choice === false && !collapsed,
		active: choiceKnown && choice !== true,
	});

	// 标记没到手之前**什么都不渲染**:先画出来再收回去会闪一下,而这一闪正好落在
	// 「老用户被问」那个最敏感的场景上。请求失败(isPending 落地为 error)也放行 ——
	// 那时 globals 整个面板都废了,不该顺带把导览也吞掉;失败态下 choice 读不出来,
	// 由 choiceKnown 挡住询问框,底下的 `choice !== false` 再把导览本体收干净。
	const visible = view !== null && !globalsQ.isPending;

	const qc = useQueryClient();
	const { mutate: markChoice } = useMutation({
		mutationFn: (skipped: boolean) => api.patch("/api/globals", { onboarding: { skipped } }),
		onSuccess: () => qc.invalidateQueries({ queryKey: ["globals"] }),
	});

	// 系统页「重新开启」:配置那半走 PATCH+invalidate 既有通道,这里接的是「把这台
	// 浏览器上收着的卡展开」那半拍 —— 不展开的话按钮点了毫无动静。
	const reopenSeq = useOnboardingReopen((st) => st.seq);
	const prevReopenRef = useRef(reopenSeq);
	// biome-ignore lint/correctness/useExhaustiveDependencies: 只在 seq 变化时执行一次
	useEffect(() => {
		if (reopenSeq === prevReopenRef.current) return;
		prevReopenRef.current = reopenSeq;
		setAskDismissed(false);
		setAskPhase("ask");
		// 毕业闸抬起来:本会话毕业过的人再点「重新开启」时,判据仍然全绿 → 又渲染
		// 🎉 卡,而闸挡着不会重走自动写标记那一拍。于是卡上唯一那颗「收起」只剩
		// setJustGraduated(false) —— choice===false 时这个值根本不参与渲染判断,
		// 按钮成了摆设,贺卡关不掉(2026-08-31 审查)。抬闸即可回到正常那条路。
		markedRef.current = false;
		toggleCollapsed(false);
	}, [reopenSeq]);

	const pos = useMemo(
		() => (view ? reconcileTourPos(manualPos, view.activeKey) : null),
		[view, manualPos],
	);

	const sub = pos && pos.stepKey !== "done" ? TOUR_SCRIPT[pos.stepKey][pos.subIndex] : null;
	const onRoute = sub ? location.pathname === sub.route : false;
	// 提出来给闭包用 —— JSX 条件里的 narrowing 进不了 onClick 闭包
	const subLink = sub?.link ?? null;

	// 测试失败兜底(2026-08-30 真机反馈):失败不换链、不开弹窗,聚光灯「按下即
	// 退散」永远不复原。at(lastCheckedAt)每次尝试必变 —— 变一次就给 Spotlight
	// 换一次 key,整层重挂 = 退散清零 + 重新滚到目标。引导锁**不放开**(放开过
	// 一版,主人打回):该做的动作(配置/重测)由失败链的同亮组全放进洞内。
	// 只认当前步自己的失败(pos 换步动画期间不拿别步的旧账换链)。
	const failNote = view?.failNote != null && pos?.stepKey === view.activeKey ? view.failNote : null;
	const [failSeq, setFailSeq] = useState(0);
	const prevFailAtRef = useRef<string | undefined>(undefined);
	const failAt = failNote?.at;
	useEffect(() => {
		if (failAt !== undefined && failAt !== prevFailAtRef.current) {
			prevFailAtRef.current = failAt;
			setFailSeq((s) => s + 1);
		}
	}, [failAt]);

	// 聚光目标统一成 selector 优先级链:在目标路由上取子步的控件挂点;不在时改聚
	// 顶栏对应导航页签(「带我去」按钮退役 —— 用户跟着灯自己点页签过去)。
	// 失败悬着时换失败链 —— 灯移到「配置」(与「测试」同亮),不改配置重测永远失败。
	const anchorChain =
		failNote && sub?.anchorOnFail
			? sub.anchorOnFail
			: sub?.anchor
				? Array.isArray(sub.anchor)
					? sub.anchor
					: [sub.anchor]
				: null;
	// 页签是可以被主人藏起来的(config/nav.ts 只钉死「系统」)。藏掉之后跨页那一步
	// 没有页签可指:灯不亮、锁也不铺,小卡却还在说「点亮起的页签前往」—— 指着一个
	// 不存在的东西,而「带我去」已退役,导览就此死在这儿。降级出口把按钮放回来。
	const hiddenNav = useNavStore((s) => s.hidden);
	const navTabHidden = sub != null && !onRoute && hiddenNav.includes(sub.route);
	// 教程阅读区(/about)聚光灯**整个不渲染**(三易其稿的主人定案):点「选型指引」
	// 进来是要读内容的 —— 暗幕压得没法读,只留描边呼吸框也还是打扰;回去的路
	// 改走小卡上的「回去继续」按钮。
	const inReadingZone = location.pathname.startsWith("/about");
	// navTabHidden 自带 `!onRoute`,「没有目标可指」与「阅读区」并成一道前置守卫
	const spotlightSelectors =
		!sub || navTabHidden || inReadingZone
			? null
			: onRoute
				? // 数组元素 = 同亮组:组内锚点拼成一个逗号 selector,一起开洞
					(anchorChain?.map((entry) =>
						Array.isArray(entry)
							? entry.map((a) => `[data-tour="${a}"]`).join(",")
							: `[data-tour="${entry}"]`,
					) ?? null)
				: [`[data-tour-nav="${sub.route}"]`];

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

	// 子步层的判据回退(2026-08-30 真机反馈):主步 activeKey 的前进回退早有
	// (reconcileTourPos),但子步曾只进不退 —— 删掉适配器后 activeKey 仍是
	// adapter,手动位停在「测试连通」;聚光灯靠链回落指对了「+ 新建」,小卡文案
	// 却还在讲测试。只盯**从真变假的转变沿**:当前位之前有带 doneWhen 的子步判据
	// 被破坏 → 退回那一子步。「为假就退」不行 —— 会把手动「下一步」的提前翻页
	// (单向流转定案里允许的预读)当场按回去。纯说明步无 doneWhen,不做回退目标。
	const prevSubViewRef = useRef<OnboardingView | null>(null);
	useEffect(() => {
		const prev = prevSubViewRef.current;
		prevSubViewRef.current = view;
		if (!pos || pos.stepKey === "done" || view == null || prev == null) return;
		const subs = TOUR_SCRIPT[pos.stepKey];
		const firstBroken = subs.findIndex(
			(s, i) => i < pos.subIndex && s.doneWhen != null && !s.doneWhen(view) && s.doneWhen(prev),
		);
		if (firstBroken !== -1) setManualPos({ stepKey: pos.stepKey, subIndex: firstBroken });
	}, [view, pos]);

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
		// 两份 steps 都出自 deriveOnboarding,同序等长 —— 按下标对位即可
		const justDone = view.steps.findLast((s, i) => s.done && prev.steps[i]?.done === false);
		if (justDone) setCelebration({ seq: Date.now(), text: STEP_DONE_MESSAGES[justDone.key] });
		if (view.allDone && !prev.allDone) setFireworks(true);
	}, [view, collapsed]);

	// 毕业即记标记(= 关掉导览):否则走完五步的人下次开面板还会见到 🎉 卡 ——
	// 它已经没有信息量了。只在 choice===false(明确在引导中)时写:还没回答询问框
	// 的人毕不毕业都轮不到我们替他选。ref 挡重入(重新开启时抬闸,见上方),
	// justGraduated 给 🎉 卡留活口。
	useEffect(() => {
		if (choice !== false || !view?.allDone || markedRef.current) return;
		markedRef.current = true;
		setJustGraduated(true);
		markChoice(true);
	}, [view?.allDone, choice, markChoice]);

	if (!visible || !pos || !view) return null;

	// ── 三态分闸(数据都齐了才走到这) ─────────────────────────────────────────
	// 询问框:没问过(undefined)必弹;选「老用户」后的教育页(noted)在 choice
	// 已回流成 true 时也要站住,直到点「知道了」。Esc/点外面 = 这次不回答,本会话
	// 不再骚扰,刷新后再问。
	const askOpen =
		choiceKnown &&
		!askDismissed &&
		(choice === undefined ? askPhase === "ask" : choice === true && askPhase === "noted");
	if (askOpen) {
		return createPortal(
			<ModalShell
				width={400}
				onCancel={() => setAskDismissed(true)}
				title="需要新手指引吗?"
				description="五步带你配好 B 站登录与推送通道"
			>
				{askPhase === "ask" ? (
					<div className="flex flex-col gap-2">
						<Btn
							full
							onClick={() => {
								markChoice(false);
								toggleCollapsed(false);
							}}
						>
							我是新用户,开始指引
						</Btn>
						<Btn
							full
							variant="outline"
							onClick={() => {
								setAskPhase("noted");
								markChoice(true);
							}}
						>
							我是老用户,跳过
						</Btn>
					</div>
				) : (
					<div className="flex flex-col gap-3">
						<p className="text-bn-sm leading-relaxed text-bn-text-secondary">
							好的,不再打扰。以后需要指引时,到「系统」页的「新手指引」一节点「重新开启」即可。
						</p>
						<Btn full variant="outline" onClick={() => setAskDismissed(true)}>
							知道了
						</Btn>
					</div>
				)}
			</ModalShell>,
			document.body,
		);
	}
	// 不要(true)或这次没回答 → 整个导览不渲染;唯一例外是本会话刚毕业,
	// 🎉 卡演完点「收起」再谢幕
	if (choice !== false && !justGraduated) return null;

	// 步序只有一份 —— derive.ts 排好的 view.steps。曾另立 TOUR_STEP_ORDER,
	// 改一处漏一处不会红,步点条会静静地少一颗或谁都不高亮。
	const stepIndex =
		pos.stepKey === "done" ? view.steps.length : view.steps.findIndex((s) => s.key === pos.stepKey);
	const subCount = pos.stepKey === "done" ? 0 : TOUR_SCRIPT[pos.stepKey].length;
	const pendingTails = view.tails.filter((t) => !t.done);
	const expanded = !collapsed;

	// 标签与卡**都常驻 DOM**:条件渲染做不出退场帧,两态交接动画(styles.css 的
	// .bn-tour-tab / .bn-tour-card,data-shown 驱动)需要退场那侧活到演完。隐藏侧
	// inert + aria-hidden 摘出可达性树与焦点链,视觉上由 CSS 的 visibility 延迟藏。
	return createPortal(
		<>
			{expanded && spotlightSelectors ? (
				<Spotlight key={failSeq} selectors={spotlightSelectors} />
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
					{view.steps.map((s, i) => (
						<span key={s.key} className="flex items-center gap-1">
							<StatusDot kind={s.done ? "ok" : i === stepIndex ? "live" : "pending"} size="sm" />
							<span
								className={
									i === stepIndex
										? "text-bn-2xs font-medium text-bn-text-primary"
										: "text-bn-2xs text-bn-text-tertiary"
								}
							>
								{STEP_SHORT[s.key]}
							</span>
						</span>
					))}
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
										to={TAIL_LINKS[t.key].to}
										className="ml-1 text-bn-pink hover:underline"
									>
										{TAIL_LINKS[t.key].label}
									</Link>
								))}
							</p>
						) : null}
						<Btn size="sm" onClick={() => setJustGraduated(false)}>
							收起
						</Btn>
					</div>
				) : sub ? (
					<div key={`${pos.stepKey}:${pos.subIndex}`} className="bn-tour-step-in">
						<div className="text-bn-base font-semibold text-bn-text-primary">{sub.title}</div>
						<p className="mt-1 mb-2.5 text-bn-xs leading-relaxed text-bn-text-secondary">
							{sub.body}
						</p>
						{/* failNote 已只认当前步自己的失败(见上方守卫) */}
						{failNote ? (
							<ErrorNote size="sm" className="-mt-1 mb-2">
								测试没通过:{failNote.text} —— 照原因排查,改完配置再点一次「测试」。
							</ErrorNote>
						) : null}
						{/* 「带我去」退役:不在目标路由时聚光灯指着顶栏页签,用户自己点过去。
						    提示独立成行 —— 塞进按钮行会把整行挤爆(真机踩过:收起折成竖排) */}
						{onRoute || navTabHidden || inReadingZone ? null : (
							<p className="-mt-1.5 mb-2 text-bn-2xs text-bn-text-tertiary">点亮起的页签前往 →</p>
						)}
						<div className="flex flex-wrap items-center gap-2">
							{/* 降级出口:目标页签被藏起来了,没有灯可跟 —— 只有这时才把退役的
							    「带我去」放回来,正常情况下仍旧是「跟着灯自己点页签过去」 */}
							{navTabHidden && !inReadingZone ? (
								<Btn size="sm" onClick={() => navigate(sub.route)}>
									带我去
								</Btn>
							) : null}
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
							{/* 阅读区里没有灯,回去的路就是这颗按钮;「选型指引」此刻让位 ——
							    人已经在教程里,再指过来没意义 */}
							{inReadingZone ? (
								<Btn size="sm" onClick={() => navigate(sub.route)}>
									回去继续
								</Btn>
							) : subLink ? (
								<Btn size="sm" variant="ghost" onClick={() => navigate(subLink.to)}>
									{subLink.label}
								</Btn>
							) : null}
							<span className="flex-1" />
							{/* 「跳过指引」= 写回 true,整个导览就此消失(三态语义);
							    系统页「新手指引」一节可随时重开 */}
							<TextBtn label="跳过指引" onClick={() => markChoice(true)} />
							<TextBtn label="收起" onClick={() => toggleCollapsed(true)} />
						</div>
					</div>
				) : null}
			</aside>
		</>,
		document.body,
	);
}
