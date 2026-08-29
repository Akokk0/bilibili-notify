import { Btn, StatusDot } from "@bilibili-notify/ui";
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useLocation, useNavigate } from "react-router-dom";
import { useTourStore } from "../../store/tour";
import type { OnboardingStepKey } from "./derive";
import { reconcileTourPos, TOUR_SCRIPT, type TourPos } from "./tour-script";
import { useOnboardingState } from "./use-onboarding-view";

/**
 * 「带我做」左下角伴随悬浮窗(2026-08-29 二轮定案:控件级 + 判据驱动)。
 *
 * - 主步切换全自动:useOnboardingState 的 activeKey 变了,reconcileTourPos
 *   跟着跳 —— 扫码成功 / 测试通过等无需用户点任何东西;
 * - 主步内子步(选型说明 / 分解动作)手动「上一步 / 下一步」;
 * - 不做全屏遮罩:表单保持完全可操作(主人拍板「表单也不用丢」),指路靠
 *   目标控件上的 `data-tour` 挂点高亮描边 + 滚入视口;
 * - 位置:fixed 左下角 —— 右下是推送 toast、右上是组件告警、底部居中是
 *   灵动岛与 Toast,左下是唯一空位。z 走 island 档(低于 toast/modal)。
 */

const STEP_ORDER: OnboardingStepKey[] = ["login", "subs", "adapter", "target", "graduate"];
const STEP_SHORT: Record<OnboardingStepKey, string> = {
	login: "登录",
	subs: "订阅",
	adapter: "适配器",
	target: "目标",
	graduate: "测试",
};

const HIGHLIGHT_CLASS = "bn-tour-highlight";

export function TourCompanion() {
	const active = useTourStore((s) => s.active);
	const stop = useTourStore((s) => s.stop);
	const { view, ready } = useOnboardingState();
	const location = useLocation();
	const navigate = useNavigate();
	const [manualPos, setManualPos] = useState<TourPos | null>(null);

	const pos = useMemo(
		() => (ready && view ? reconcileTourPos(manualPos, view.activeKey) : null),
		[ready, view, manualPos],
	);

	const sub = pos && pos.stepKey !== "done" ? TOUR_SCRIPT[pos.stepKey][pos.subIndex] : null;
	const onRoute = sub ? location.pathname === sub.route : false;

	// 控件高亮:目标元素可能等数据才渲染,轮询几轮再放弃;离开该子步时摘除。
	useEffect(() => {
		if (!active || !sub?.anchor || !onRoute) return;
		const anchor = sub.anchor;
		let el: Element | null = null;
		let tries = 0;
		const timer = setInterval(() => {
			el = document.querySelector(`[data-tour="${anchor}"]`);
			tries += 1;
			if (el) {
				el.classList.add(HIGHLIGHT_CLASS);
				el.scrollIntoView({ block: "center", behavior: "smooth" });
				clearInterval(timer);
			} else if (tries > 10) {
				clearInterval(timer);
			}
		}, 300);
		return () => {
			clearInterval(timer);
			el?.classList.remove(HIGHLIGHT_CLASS);
		};
	}, [active, sub?.anchor, onRoute]);

	if (!active || !pos || !view) return null;

	const stepIndex = pos.stepKey === "done" ? STEP_ORDER.length : STEP_ORDER.indexOf(pos.stepKey);
	const subCount = pos.stepKey === "done" ? 0 : TOUR_SCRIPT[pos.stepKey].length;

	return createPortal(
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
					<p className="mt-1 mb-2.5 text-bn-xs leading-relaxed text-bn-text-secondary">
						五步链路已打通,订阅 UP 的动态与开播会自动推送。导览到此结束啦。
					</p>
					<Btn size="sm" onClick={stop}>
						完成
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
							onClick={stop}
							className="text-bn-2xs text-bn-text-tertiary transition-colors hover:text-bn-text-primary"
						>
							跳过指引
						</button>
					</div>
				</>
			) : null}
		</aside>,
		document.body,
	);
}
