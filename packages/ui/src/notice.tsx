/**
 * 通知栈与富通知卡 —— 推送 toast(右下)与组件告警(右上)那种「图标片 + 标题/时间 +
 * 正文 + 关闭」的浮层卡。收编前两个 shell 各抄一份:卡骨架、图标片壳、标题行、
 * 关闭钮逐字符相同,连 portal + fixed 角落 + `pointer-events-none` 的栈壳都重复。
 *
 * 与 {@link Toast} 的分工不变(Toast 的注释里写着):Toast 是一句话瞬时提示,
 * 这里是带图标/时间的富卡片。**颜色语义全留调用方** —— 推送卡逐 kind 染色、
 * 告警卡红边红标题,那是内容语义,库件不该猜。
 */

import type { CSSProperties, ReactNode } from "react";
import { createPortal } from "react-dom";
import { IconButton } from "./atoms";
import { Icon } from "./icons";

// ── NoticeStack ─────────────────────────────────────────────────────────────

const STACK_CORNER = {
	"top-right": "right-4 top-4",
	"bottom-right": "bottom-4 right-4",
} as const;

export interface NoticeStackProps {
	corner: keyof typeof STACK_CORNER;
	/**
	 * `polite`(会打断的少)给自动消失的推送 toast,`assertive` 给要主人确认的告警。
	 */
	ariaLive: "polite" | "assertive";
	/** 栈宽(`w-80` / `w-96`)这类不冲突的追加项。 */
	className?: string;
	children: ReactNode;
}

/**
 * 角落通知栈:portal 到 body(fixed 摆位不能被 transform 过的祖先劫走 ——
 * ModalShell 踩过的同一个坑),栈壳 `pointer-events-none`、卡片各自恢复指针。
 */
export function NoticeStack({ corner, ariaLive, className, children }: NoticeStackProps) {
	if (typeof document === "undefined") return null;
	return createPortal(
		<div
			aria-live={ariaLive}
			className={`pointer-events-none fixed z-bn-notify flex flex-col gap-2 ${STACK_CORNER[corner]} ${className ?? ""}`}
		>
			{children}
		</div>,
		document.body,
	);
}

// ── NoticeCard ──────────────────────────────────────────────────────────────

export interface NoticeCardProps {
	/** 左侧图标片的内容(尺寸由调用方给,片壳 8×8 圆角由组件出)。 */
	icon: ReactNode;
	/** 图标片的静态配色 class(`bg-bn-danger-soft text-bn-danger-text` 那类)。 */
	tileClassName?: string;
	/** 图标片的逐项动态染色(推送 kind 的 tone 现调 12% 底)—— 动态色才走 style。 */
	tileStyle?: CSSProperties;
	/** 标题行左侧。字号字重由壳子出,字色默认正文色 —— 告警卡从 titleClassName 换红。 */
	title: ReactNode;
	titleClassName?: string;
	/** 右上角等宽小字时间。**预格式化**:toast 到分、告警到秒,精度是语义,组件不猜。 */
	time?: string;
	/** 正文区(标题行下方),各自带 mt-*。 */
	children?: ReactNode;
	onClose: () => void;
	closeLabel?: string;
	/** 边框覆盖(失败红边 / 告警红边+左竖条)。只收边框这类语义覆盖,别拿来改布局。 */
	style?: CSSProperties;
}

export function NoticeCard({
	icon,
	tileClassName,
	tileStyle,
	title,
	titleClassName,
	time,
	children,
	onClose,
	closeLabel = "关闭",
	style,
}: NoticeCardProps) {
	return (
		<div
			data-bn="glass-strong"
			className="bn-anim-fade-in pointer-events-auto flex gap-2.5 rounded-bn-card border border-bn-border bg-bn-surface p-3 shadow-bn-elev"
			style={style}
		>
			<div
				className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${tileClassName ?? ""}`}
				style={tileStyle}
				aria-hidden="true"
			>
				{icon}
			</div>
			<div className="min-w-0 flex-1">
				<div className="flex items-center justify-between gap-2">
					<span className={`text-bn-sm font-bold ${titleClassName ?? "text-bn-text-primary"}`}>
						{title}
					</span>
					{time ? (
						<span className="font-mono text-bn-2xs text-bn-text-tertiary">{time}</span>
					) : null}
				</div>
				{children}
			</div>
			<IconButton icon={<Icon.close size={11} />} label={closeLabel} onClick={onClose} />
		</div>
	);
}
