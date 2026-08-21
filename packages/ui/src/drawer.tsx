/**
 * DrawerShell — 右侧滑出的**非模态**抽屉:portal 到 body、贴视口右缘全高、
 * 内部滚动、ESC 关闭。与 ModalShell 的分工:弹窗带遮罩、打断页面;抽屉不带
 * 遮罩,页面保持可见可交互 —— 「边调参数边看整页变化」这类实时工作台用它。
 *
 * 入场动画是纯位移(bn-anim-drawer-in):抽屉底是玻璃面,opacity/filter 动画
 * 会让它成为 backdrop root、磨砂瞬时熄灭(教训见 theme.css 的 bn-fade-in 注释)。
 */

import { type ReactNode, useEffect } from "react";
import { createPortal } from "react-dom";

export interface DrawerShellProps {
	children: ReactNode;
	onClose: () => void;
	/** 面板宽度 px;窄视口自动收到 100vw 以内。 */
	width: number;
	/** 读屏器的抽屉名。 */
	ariaLabel: string;
}

export function DrawerShell({ children, onClose, width, ariaLabel }: DrawerShellProps) {
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);
	if (typeof document === "undefined") return null;
	return createPortal(
		<div
			role="dialog"
			aria-label={ariaLabel}
			className="bn-anim-drawer-in bn-glass-strong fixed inset-y-0 right-0 z-bn-modal flex max-w-full flex-col overflow-y-auto rounded-l-2xl border-y-0 border-r-0 text-bn-text-primary shadow-bn-elev"
			style={{ width }}
		>
			{children}
		</div>,
		document.body,
	);
}
