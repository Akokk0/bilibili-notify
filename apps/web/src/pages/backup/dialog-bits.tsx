/**
 * 导出 / 导入两个备份对话框共用的小件。曾各自手搓一份(KindCard / ModeCard
 * 逐字符相同、PIN 输入框两份),合并到这里;只有 backup 在用,先不上升为全站原子。
 */

/** 二选一的方式卡(完整/脱敏、覆盖/合并):标题 + 小字说明,选中态粉框。 */
export function ChoiceCard(props: {
	active: boolean;
	title: string;
	sub: string;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			onClick={props.onClick}
			data-bn="btn"
			className={`rounded-lg border px-3 py-2.5 text-left transition ${
				props.active
					? "border-bn-pink/60 bg-bn-pink/10"
					: "border-bn-border bg-bn-surface hover:border-bn-pink/40"
			}`}
		>
			<div className="text-bn-base font-bold text-bn-text-primary">{props.title}</div>
			<div className="text-bn-xs text-bn-text-tertiary">{props.sub}</div>
		</button>
	);
}

/** 「备份 PIN（6 位数字）」标签 + 只收数字、上限 6 位的密码输入。 */
export function PinField({
	value,
	onChange,
	placeholder,
	className,
}: {
	value: string;
	onChange: (next: string) => void;
	placeholder: string;
	className?: string;
}) {
	return (
		<label className={`block ${className ?? ""}`}>
			<span className="mb-1 block text-bn-sm font-semibold text-bn-text-secondary">
				备份 PIN（6 位数字）
			</span>
			<input
				type="password"
				inputMode="numeric"
				maxLength={6}
				value={value}
				onChange={(e) => onChange(e.target.value.replace(/\D/g, "").slice(0, 6))}
				placeholder={placeholder}
				data-bn="input"
				className="w-full rounded-md border border-bn-border bg-bn-field px-3 py-2 text-bn-base tracking-[0.4em] text-bn-text-primary outline-none focus:border-bn-pink"
			/>
		</label>
	);
}
