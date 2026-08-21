import type { CSSProperties, ReactNode } from "react";

/**
 * 一句话瞬时提示 —— 「已复制」「已保存」「保存失败」这类,自己不管计时,由调用方
 * 挂上 / 撤下。
 *
 * 与 apps/web 的推送 toast(`toast-shell`)分工:那个是通知中心的富卡片(图标 +
 * 事件名 + 时间 + 正文,从 store 里成摞渲染),这个是页面自己弹的一行字。
 *
 * ── 三条不许改的取值 ──────────────────────────────────────────────────
 *
 * **字色恒走 `text-bn-text-primary`,不写死白字。** 底色是可以被皮肤重绘的,写死的
 * 字色不能 —— 两者一起就是「皮肤刷了底,字消失了」。收编前 Targets 那个正是
 * `bg-bn-success` + 写死的 `text-white`,于是它整个挂不上挂点(挂上必白底白字),皮肤永远
 * 够不着它。
 *
 * **语义走描边,不走实心底。** 同 `ToneChip` 的道理:底恒定,tone 只换 borderColor。
 * 实心语义底一来逼出白字,二来在换肤后与页面其余部分格格不入。
 *
 * **钉在底部居中,不在右下角。** 右下角是推送 toast 那一摞的位置(`toast-shell` 的
 * `fixed bottom-4 right-4`)。收编前 Targets 那个也钉在 `bottom-4 right-4`,推送
 * 提示正显示时保存一次目标,两者就直接叠上了。
 */

export type ToastTone = "neutral" | "ok" | "err";

const TONE_BORDER: Record<ToastTone, string | undefined> = {
	neutral: undefined,
	ok: "var(--color-bn-success-border)",
	err: "var(--color-bn-danger-border)",
};

export interface ToastProps {
	children: ReactNode;
	/** 语义。只换描边色,底与字色不动。 */
	tone?: ToastTone;
}

export function Toast({ children, tone = "neutral" }: ToastProps) {
	// 层级走 `z-bn-toast-base`(压得住页面内容,让开弹窗与皮肤预览条)。此前它是个
	// `z?: number` prop,一个调用方都没有 —— 那只是给了一个绕过分层表的口子。
	const style: CSSProperties = {};
	const border = TONE_BORDER[tone];
	if (border) style.borderColor = border;
	return (
		<div
			role="status"
			// polite:提示该被念出来,但不该打断读屏器当前在念的东西。
			aria-live="polite"
			data-bn="glass-strong"
			style={style}
			className="fixed bottom-5 left-1/2 z-bn-toast-base -translate-x-1/2 rounded-md border border-bn-border bg-bn-surface-strong px-3 py-1.5 text-[12px] font-medium text-bn-text-primary shadow-bn-elev"
		>
			{children}
		</div>
	);
}
