import type { SettingsScalarField } from "@bilibili-notify/contract";
import { OptionCard, Picker, TArea, TInput, Toggle } from "@bilibili-notify/ui";
import { safeImage } from "../utils/settings-image";

/**
 * 一格单值控件的通用那几种(字 / 数字 / 开关 / 枚举)。设置表单与列表的新建弹窗**共用这一份** ——
 * 各画各的话,同一个清单在两处长成两种控件。生成的那种两处各有各的特化(表单里遮住 + 复制、弹窗
 * 里明文 + 就地换一把),表单的密钥格存着值时先遮住、按「换一份」才给输入框 —— 那几样留在摆放处,
 * 输入框本身还是这一件。
 */
export function SettingsFieldControl({
	field,
	value,
	onChange,
}: {
	field: SettingsScalarField;
	value: string | boolean;
	onChange: (value: string | boolean) => void;
}) {
	const text = typeof value === "string" ? value : "";
	switch (field.type) {
		case "string":
			// 密钥按密码框画(`secret` 自带等宽);多行的没有密码框这回事,只能等宽。
			return field.multiline ? (
				<TArea
					ariaLabel={field.label}
					value={text}
					onChange={onChange}
					placeholder={field.placeholder}
					mono={field.monospace || field.secret}
				/>
			) : (
				<TInput
					ariaLabel={field.label}
					value={text}
					onChange={onChange}
					placeholder={field.placeholder}
					mono={field.monospace}
					secret={field.secret}
				/>
			);
		case "number":
			return (
				<div className="flex items-center gap-2">
					{/*
					 * 走 TInput 而不是 TNum:TNum 交出来的永远是个数,清空那一格会变成 0 —— 可选的
					 * 数字格清空要发 `null`,打到一半的「-」也得先留在框里。
					 *
					 * 🔴 也不用 `type="number"`:那种框遇到不是数的输入(`abc`、`1e`、打到一半的「-」)
					 * `.value` 按规范给空串 —— 框里明明有字,交出来的却是「清空了」,可选格就发 `null`
					 * 把存着的值删掉。用文本框,算不算数由 `clientErrorOf` 当场说。
					 */}
					<TInput width={120} ariaLabel={field.label} value={text} onChange={onChange} />
					{field.unit ? (
						<span className="text-bn-xs text-bn-text-tertiary">{field.unit}</span>
					) : null}
				</div>
			);
		case "boolean":
			return <Toggle ariaLabel={field.label} value={value === true} onChange={onChange} />;
		case "enum":
			return <EnumControl field={field} value={text} onChange={onChange} />;
	}
}

/** 一格 `enum`(决策 30):选项带图标 → 两张一排的选项卡片(桥的「哪一种桥」),不带 → 分段按钮。 */
function EnumControl({
	field,
	value,
	onChange,
}: {
	field: Extract<SettingsScalarField, { type: "enum" }>;
	value: string;
	onChange: (value: string) => void;
}) {
	if (field.options.some((option) => option.icon)) {
		return (
			// `<fieldset>` 而不是 `<div role="group">`:同一个语义,原生元素不用手写 role。
			<fieldset aria-label={field.label} className="grid min-w-0 grid-cols-2 gap-2.5">
				{field.options.map((option) => (
					<OptionCard
						key={option.value}
						active={value === option.value}
						label={option.label}
						mark={option.value}
						logo={safeImage(option.icon)}
						onSelect={() => onChange(option.value)}
					/>
				))}
			</fieldset>
		);
	}
	return (
		<fieldset aria-label={field.label} className="min-w-0">
			<Picker
				value={value}
				onChange={onChange}
				options={field.options.map((option) => ({ value: option.value, label: option.label }))}
			/>
		</fieldset>
	);
}
