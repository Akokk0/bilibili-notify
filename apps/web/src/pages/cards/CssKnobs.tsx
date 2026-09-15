/**
 * 常用旋钮那一排(ADR-0014 决策 21)。
 *
 * **它没有自己的 state。** 决策原话是「旋钮 + 高级 CSS 文本框,两者同写一段 CSS」并明确
 * 否掉「旋钮值和 CSS 文本两份状态互相盖」—— 所以每次渲染都从那段文本里现读,拧一下就把
 * 改过的**整段文本**交回去。文本框里手改一个数,这排跟着动;拧这排,文本框里跟着变。
 *
 * 两条不肯让步的:
 *
 * 1. **表示不了的值不许被悄悄改写。** `padding:12px 16px`、`background` 是渐变 —— 这些
 *    旋钮画不出来,那就把原文照显、连输入框都不给,要改得按一下「改用旋钮」。
 * 2. **不预先灌默认值。** 没写过的那条就是没写;拧了才写进去。一上来把七条默认值铺满,
 *    等于替作者按死了一堆他本来想继承的东西。
 */

import { Btn, HintNote, Icon, IconButton, Picker, TColor, TNum } from "@bilibili-notify/ui";
import { KNOB_SPECS, type KnobSpec, type KnobValue } from "./css-knob-specs";
import { readKnobs, setKnobDecl } from "./css-knobs";

/** 旋钮画不出来的值被「接管」时的起手位置。 */
const NEUTRAL: Record<KnobSpec["kind"], KnobValue> = {
	len: { px: 0 },
	color: { hex: "#000000" },
	keyword: { keyword: "left" },
	border: { px: 1, style: "solid", hex: "#000000" },
};

/**
 * 按下「改用旋钮」之后从哪个值起步。
 *
 * 从原值里**捡第一个认得出的 token**(`12px 16px` → `12px`)。这与「不许悄悄折」不冲突:
 * 那条说的是**不问自取**,这里是作者自己按的按钮,给他一个贴近原样的起点比一律归零好。
 */
function takeover(spec: KnobSpec, raw: string): KnobValue {
	for (const token of raw.trim().split(/\s+/)) {
		const got = spec.parse(token);
		if (got) return got;
	}
	return NEUTRAL[spec.kind];
}

function KnobControl({
	spec,
	value,
	onSet,
}: {
	spec: KnobSpec;
	value: KnobValue;
	onSet: (next: KnobValue) => void;
}) {
	if (spec.kind === "len") {
		return (
			<TNum
				value={(value as { px: number }).px}
				min={0}
				max={999}
				onChange={(px) => onSet({ px })}
				ariaLabel={spec.label}
				width={72}
			/>
		);
	}
	if (spec.kind === "color") {
		return (
			<TColor
				value={(value as { hex: string }).hex}
				onChange={(hex) => onSet({ hex })}
				ariaLabel={spec.label}
			/>
		);
	}
	if (spec.kind === "keyword") {
		return (
			<Picker
				value={(value as { keyword: string }).keyword}
				onChange={(keyword) => onSet({ keyword })}
				options={[...(spec.options ?? [])]}
			/>
		);
	}
	const b = value as { px: number; style: string; hex: string };
	return (
		<div className="flex flex-wrap items-center gap-1.5">
			<TNum
				value={b.px}
				min={0}
				max={40}
				onChange={(px) => onSet({ ...b, px })}
				ariaLabel={`${spec.label}宽度`}
				width={64}
			/>
			<Picker
				value={b.style}
				onChange={(style) => onSet({ ...b, style: String(style) })}
				options={[
					{ value: "solid", label: "实线" },
					{ value: "dashed", label: "虚线" },
					{ value: "none", label: "无" },
				]}
			/>
			<TColor
				value={b.hex}
				onChange={(hex) => onSet({ ...b, hex })}
				ariaLabel={`${spec.label}颜色`}
			/>
		</div>
	);
}

function KnobRow({
	spec,
	raw,
	onWrite,
}: {
	spec: KnobSpec;
	/** 这条声明在 CSS 里的原文;`undefined` = 没写过。 */
	raw: string | undefined;
	onWrite: (value: string | null) => void;
}) {
	const parsed = raw === undefined ? null : spec.parse(raw);

	// 写了、但旋钮画不出来:原文照显,**不给输入框** —— 给了就等于邀请他一按就覆盖。
	if (raw !== undefined && parsed === null) {
		return (
			<div className="flex flex-col gap-1">
				<span className="text-bn-2xs text-bn-text-secondary">{spec.label}</span>
				<div className="flex min-w-0 items-center gap-1.5">
					<span
						className="min-w-0 truncate font-mono text-bn-2xs text-bn-text-tertiary"
						title={raw}
					>
						{raw}
					</span>
					<Btn
						size="sm"
						variant="ghost"
						onClick={() => onWrite(spec.format(takeover(spec, raw)))}
						aria-label={`改用旋钮(${spec.label})`}
					>
						改用旋钮
					</Btn>
				</div>
			</div>
		);
	}

	const shown = parsed ?? NEUTRAL[spec.kind];
	return (
		<div className="flex flex-col gap-1">
			<div className="flex items-center gap-1">
				<span className="text-bn-2xs text-bn-text-secondary">{spec.label}</span>
				{raw === undefined ? (
					<span className="text-bn-2xs text-bn-text-disabled">未设置</span>
				) : (
					<IconButton
						size="xs"
						label={`清掉${spec.label}`}
						icon={<Icon.close size={10} />}
						onClick={() => onWrite(null)}
					/>
				)}
			</div>
			<KnobControl spec={spec} value={shown} onSet={(next) => onWrite(spec.format(next))} />
		</div>
	);
}

export function CssKnobs({
	css,
	hook,
	onChange,
}: {
	css: string;
	/** 这排旋钮改哪一层:块是 `self`,外框是 `frame`。 */
	hook: string;
	onChange: (css: string) => void;
}) {
	const readout = readKnobs(css, hook);

	// 解析不了就整排退场。硬撑着显示等于拿半份 AST 上算出来的偏移去切作者的文本 ——
	// 那比「这会儿用不了」糟得多。
	if (readout === null) {
		return (
			<HintNote className="w-full">
				这段 CSS 现在解析不了(多半是括号没配上),常用旋钮先退场 —— 下面的文本框照旧能改,
				改好了它们自己回来。
			</HintNote>
		);
	}

	return (
		<div className="grid grid-cols-2 gap-x-2.5 gap-y-2">
			{KNOB_SPECS.map((spec) => (
				<KnobRow
					key={spec.prop}
					spec={spec}
					raw={readout[spec.prop]}
					onWrite={(value) => onChange(setKnobDecl(css, hook, spec.prop, value))}
				/>
			))}
		</div>
	);
}
