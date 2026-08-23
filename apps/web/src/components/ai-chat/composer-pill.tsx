import type { ReactNode } from "react";

/**
 * 聊天输入框工具栏的胶囊按钮外壳 —— 「深度思考」与「联网搜索」同一副面孔:
 * 图标 + 文字的药丸,点亮态、禁用态、悬浮态全在这一份 className 里。
 *
 * 只管**长相与开关手感**;能不能开(策略)由各控件自己判,把结论经
 * `disabled`/`title` 递进来。曾经两颗胶囊各抄一份 200 字的 className ——
 * 下一次样式或 aria 调整只落在一颗上,工具栏就会出现两颗微妙不同的药丸。
 */
export function ComposerPill({
	label,
	icon,
	on,
	disabled,
	title,
	onToggle,
}: {
	label: string;
	icon: ReactNode;
	/** 调用方传「意愿」;真正点亮还要 `!disabled`,灰着的胶囊不该发光。 */
	on: boolean;
	disabled: boolean;
	title: string;
	onToggle: (v: boolean) => void;
}) {
	const lit = !disabled && on;
	return (
		<button
			type="button"
			aria-label={label}
			aria-pressed={lit}
			disabled={disabled}
			title={title}
			onClick={() => onToggle(!on)}
			// 开关胶囊改的是值(联网/思考开没开),不是动作 —— chip 家族。
			data-bn={lit ? "chip chip-active" : "chip"}
			className={`flex h-9 shrink-0 cursor-pointer items-center gap-1.5 rounded-bn-pill border px-3 text-bn-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
				lit
					? "bn-chat-accent bn-chat-accent-soft border-transparent"
					: "border-bn-border text-bn-text-secondary hover:bg-bn-hover-muted"
			}`}
		>
			{icon}
			{label}
		</button>
	);
}
