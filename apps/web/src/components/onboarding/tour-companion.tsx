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
 * 聚光灯挖洞层:跟随目标控件矩形(滚动/缩放/布局变化都要追,轮询 + 事件双保险),
 * 巨型 box-shadow 把洞外压暗。`fixed` 由 utility 出 —— styles.css 的层守卫
 * 不许无层类写 position。
 */
function Spotlight({ anchor }: { anchor: TourAnchor }) {
	const [rect, setRect] = useState<DOMRect | null>(null);
	const scrolledRef = useRef(false);

	useEffect(() => {
		scrolledRef.current = false;
		const update = () => {
			const el = document.querySelector(`[data-tour="${anchor}"]`);
			if (!el) {
				setRect((prev) => (prev === null ? prev : null));
				return;
			}
			if (!scrolledRef.current) {
				scrolledRef.current = true;
				el.scrollIntoView({ block: "center", behavior: "smooth" });
			}
			const next = el.getBoundingClientRect();
			setRect((prev) => (rectsDiffer(prev, next) ? next : prev));
		};
		update();
		const timer = setInterval(update, 400);
		window.addEventListener("scroll", update, true);
		window.addEventListener("resize", update);
		return () => {
			clearInterval(timer);
			window.removeEventListener("scroll", update, true);
			window.removeEventListener("resize", update);
		};
	}, [anchor]);

	if (!rect) return null;
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

export function TourCompanion() {
	const location = useLocation();
	const navigate = useNavigate();
	const [manualPos, setManualPos] = useState<TourPos | null>(null);
	// 折叠成左缘小标签(类似女仆 AI 胶囊):导览继续进行、进度照常刷新,只是
	// 不占屏幕。这是唯一的收纳形态 —— 没有「彻底关闭」。
	const [collapsed, setCollapsed] = useState(readCollapsed);
	const toggleCollapsed = (v: boolean) => {
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

	if (!visible || !pos || !view) return null;

	const stepIndex = pos.stepKey === "done" ? STEP_ORDER.length : STEP_ORDER.indexOf(pos.stepKey);
	const subCount = pos.stepKey === "done" ? 0 : TOUR_SCRIPT[pos.stepKey].length;
	const pendingTails = view.tails.filter((t) => !t.done);

	// 折叠态:只剩左缘小标签(图标+竖排「指引」+活进度),聚光灯一并收起。
	if (collapsed) {
		return createPortal(
			<button
				type="button"
				data-bn="btn"
				aria-label="展开新手导览"
				onClick={() => toggleCollapsed(false)}
				className="bn-glass-strong shadow-bn-elev fixed left-0 top-3/4 z-bn-island flex flex-col items-center gap-1 rounded-r-bn-card px-1.5 py-2.5 text-bn-text-secondary transition-colors hover:text-bn-pink"
			>
				<Icon.sparkle size={15} />
				<span className="text-bn-2xs font-medium leading-tight">指</span>
				<span className="-mt-1 text-bn-2xs font-medium leading-tight">引</span>
				<span className="text-bn-2xs text-bn-text-tertiary">
					{view.doneCount}/{view.steps.length}
				</span>
			</button>,
			document.body,
		);
	}

	return createPortal(
		<>
			{sub?.anchor && onRoute ? <Spotlight anchor={sub.anchor} /> : null}
			<aside
				aria-label="新手导览"
				className="bn-glass-strong shadow-bn-elev fixed bottom-4 left-4 z-bn-island w-[300px] rounded-bn-card p-3.5 max-sm:right-4 max-sm:w-auto"
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
