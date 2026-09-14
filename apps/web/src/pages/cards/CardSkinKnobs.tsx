/**
 * 皮肤旋钮区(ADR-0014 决策 16 的 🔗,2026-09-14)—— 卡片页「全局」tab 上,照**当前启用
 * 那套皮肤自己的声明**生成控件的一块。
 *
 * 与隔壁固定变量(字体 / 背景图)那几栏刻意不同的两处,都来自那条决策:
 *
 * - **控件由皮肤说了算**:声明几枚就画几枚、按声明顺序。赛博朋克那类没有玻璃层的皮肤
 *   不该在面板上挂两根拧了没反应的滑杆 —— 但**一枚都没声明时要明说一句**,不能整块消失:
 *   2026-09-14 主人真机上正是栽在这儿,一块凭空不见和「面板还是旧的」长得一模一样。
 * - **存覆盖不存值**:没拧过的键根本不落盘,控件只是拿 `default` 当起始位置摆着;
 *   「还原」删的是键,不是写回 default(理由见 `knob-ops.ts` 文件头)。
 *
 * 值住全局配置(`globals.defaults.cardSkinKnobs`),按皮肤 id 分层、**不分卡种** ——
 * 所以这块只在全局作用域出现;per-UP 那边挑的是「用哪套皮肤」,不是拧这套皮肤的钮。
 */

import type { CardSkinKnob } from "@bilibili-notify/contract";
import { Btn, GlassBox, HintNote, Icon, Toggle } from "@bilibili-notify/ui";
import { FIELD_ROW_CHROME, TColor, TSelect } from "../../components/forms";
import { useCardSkinList } from "./card-skins-query";
import { FontPicker } from "./FontPicker";
import { GalleryPicker } from "./GalleryPicker";
import {
	type CardSkinKnobOverrides,
	type CardSkinKnobsBySkin,
	type CardSkinKnobValue,
	fontChoiceOfKnobValue,
	isKnobTweaked,
	knobSliderStep,
	knobValue,
	knobValueOfFontChoice,
	resetKnobOverride,
	setKnobOverride,
} from "./knob-ops";

export function CardSkinKnobsSection({
	value,
	onChange,
}: {
	/** 全表(所有皮肤的覆盖)。这一块只改当前启用那一层,其余原样带着走。 */
	value: CardSkinKnobsBySkin;
	onChange: (next: CardSkinKnobsBySkin) => void;
}) {
	const listQuery = useCardSkinList();
	const active = listQuery.data?.active ?? "";
	// `skins` 也要问一句 —— 拉取失败 / 回了个不成形的响应时它就是 undefined,而这一块
	// 摆在卡片页整页里,它一炸整页跟着白屏(隔壁皮肤库那节的 `?? []` 是同一个道理)。
	const knobs = listQuery.data?.skins?.find((s) => s.id === active)?.knobs;

	// 列表还没到(或拉挂了)→ 什么都不画。这会儿还不知道该说什么,先闪一句「没有可调项」
	// 比不画更糟。
	if (active === "") return null;

	const overrides: CardSkinKnobOverrides | undefined = value[active];
	const tweaked = overrides === undefined ? 0 : Object.keys(overrides).length;

	return (
		<GlassBox
			title="皮肤旋钮"
			subtitle="这套皮肤自己声明的可调项 —— 拧过的才会存,没拧过的用皮肤自带的兜底"
			accent="var(--color-bn-purple)"
			icon={<Icon.sliders size={14} />}
			badge={
				knobs === undefined || knobs.length === 0
					? "无"
					: tweaked > 0
						? `已调 ${tweaked} 项`
						: "出厂值"
			}
		>
			{knobs === undefined || knobs.length === 0 ? (
				<HintNote>
					这套皮肤没有提供可调项。可调项由皮肤自己声明 ——
					旧版本导出的皮肤包里没有这一段,换一套皮肤(或让作者重新导出)就能在这里看到旋钮。
				</HintNote>
			) : (
				<>
					{knobs.map((knob) => (
						<KnobRow
							key={knob.key}
							knob={knob}
							overrides={overrides}
							onSet={(next) => onChange(setKnobOverride(value, active, knob.key, next))}
							onReset={() => onChange(resetKnobOverride(value, active, knob.key))}
						/>
					))}
					<HintNote className="mt-3">
						旋钮按皮肤分开存,换皮肤再换回来设置还在;「还原」是把这个键删掉,不是写回默认值。
					</HintNote>
				</>
			)}
		</GlassBox>
	);
}

/**
 * 一枚旋钮一行:左边人话名 + 变量名,右边控件。行框借 `FIELD_ROW_CHROME` ——
 * 这一节就摆在 Field 列表旁边,行距一漂两栏当场对不齐。
 *
 * 刻意**不套 `Field`**:Field 的 `code` 是配置字典的键(查 FIELD_LABELS、挂灵动岛
 * 锚点、对默认文案账本),而旋钮 key 是**皮肤作者**取的名字 —— 哪天有人把旋钮叫
 * `font`,字典就会把配置项「字体」的提示语贴到这一行上。
 */
function KnobRow({
	knob,
	overrides,
	onSet,
	onReset,
}: {
	knob: CardSkinKnob;
	overrides: CardSkinKnobOverrides | undefined;
	onSet: (next: CardSkinKnobValue) => void;
	onReset: () => void;
}) {
	const tweaked = isKnobTweaked(overrides, knob.key);
	const current = knobValue(knob, overrides);
	return (
		<div
			// 按 key 找得到这一行(测试、以后的「跳到这枚旋钮」都靠它);同 Field 的 data-code。
			data-knob={knob.key}
			className={`${FIELD_ROW_CHROME} flex flex-row gap-3.5 last:border-b-0`}
		>
			<div className="flex-none basis-40 pt-1">
				<div className="mb-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
					<span className="text-bn-sm font-semibold text-bn-text-primary">{knob.label}</span>
					{/* 拧过的才给还原 —— 没拧过的本来就没有键可删,摆出来是颗点了什么都不会发生的钮。 */}
					{tweaked ? (
						<Btn
							variant="ghost"
							size="sm"
							onClick={onReset}
							title="删掉这个覆盖，回到皮肤自带的兜底"
						>
							还原
						</Btn>
					) : null}
				</div>
				<code className="rounded-sm bg-bn-code-bg px-1.5 py-px font-mono text-bn-2xs text-bn-text-tertiary">
					--bn-knob-{knob.key}
				</code>
			</div>
			{/* 字体与图那两档是整块的选择器(图廊 + 上传 + 失效提示),比一行控件高得多 ——
			    跟着行居中会把标签甩到中间去,所以这两档顶对齐。 */}
			<div
				className={`flex min-w-0 flex-1 gap-3 ${
					knob.type === "font" || knob.type === "image" ? "items-start" : "items-center"
				}`}
			>
				<KnobControl knob={knob} current={current} onSet={onSet} />
			</div>
		</div>
	);
}

function KnobControl({
	knob,
	current,
	onSet,
}: {
	knob: CardSkinKnob;
	current: CardSkinKnobValue;
	onSet: (next: CardSkinKnobValue) => void;
}) {
	switch (knob.type) {
		case "color":
			// 契约还收 `rgb(…)` 与命名色,而颜色选择器只认 hex —— 那两种写法会以「格式不对」
			// 的样子摆在文本框里(点一下色块就换成 hex)。不在这里翻译:一张命名色表要跟着
			// CSS 规范走,而拧一下就再也遇不到这个形状了。
			return <TColor value={String(current)} onChange={onSet} />;
		case "number": {
			const n = typeof current === "number" ? current : knob.default;
			return (
				<>
					<input
						type="range"
						min={knob.min}
						max={knob.max}
						step={knobSliderStep(knob)}
						value={n}
						onChange={(e) => onSet(Number(e.target.value))}
						aria-label={knob.label}
						// `min-w-0`:range 有内在最小宽度,flex 项默认 `min-width:auto` 不肯收到
						// 它以下 —— 380 的栏里滑杆就把右边那个读数挤出容器,「28px」被切成「28p」。
						className="min-w-0 flex-1 accent-bn-pink"
					/>
					<span className="w-14 shrink-0 text-right font-mono text-bn-xs text-bn-text-secondary">
						{n}
						{knob.unit ?? ""}
					</span>
				</>
			);
		}
		case "select":
			return (
				<TSelect
					full
					value={String(current)}
					onChange={onSet}
					ariaLabel={knob.label}
					options={knob.options.map((o) => ({ value: o.value, label: o.label }))}
				/>
			);
		case "switch":
			return (
				<>
					<Toggle value={current === true} onChange={onSet} ariaLabel={knob.label} />
					{/* 开 / 关各自注进 CSS 的字面量。开关本身看不出它到底写了什么进去。 */}
					<code className="font-mono text-bn-xs text-bn-text-tertiary">
						{current === true ? knob.on : knob.off}
					</code>
				</>
			);
		// 字体与图**借现成的那两个选择器**:上传、图廊、「这款已失效」的提示全在里面,
		// 而它们此前伺候的正是 `cardStyle.font` / `backgroundImages` —— 同一件事,换了个家。
		case "font":
			return (
				<div className="min-w-0 flex-1">
					<FontPicker
						value={fontChoiceOfKnobValue(current)}
						onChange={(next) => onSet(knobValueOfFontChoice(next))}
					/>
				</div>
			);
		case "image":
			return (
				<div className="min-w-0 flex-1">
					<GalleryPicker
						value={Array.isArray(current) ? current : []}
						onChange={onSet}
						emptyHint="未选择(这一档由皮肤自己的兜底画)"
					/>
				</div>
			);
	}
}
