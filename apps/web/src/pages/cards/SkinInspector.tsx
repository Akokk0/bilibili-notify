import { i18n, useT } from "../../i18n";
/**
 * 编辑器的检查器(ADR-0014 决策 20 / 21)—— 画布上选中什么,这里就编什么。
 *
 * 选中一个块时:位置(行 / 起始列 / 跨列 / 跨行)、显示条件、这个块的 CSS,末尾是删除;
 * 选中卡片外框时:卡宽、行列间距、12 列的列定义、外框的 CSS。还欠的是**样式旋钮**
 * (把常用属性做成控件,与下面那个 CSS 框共用同一份状态)与自定义块的 HTML。
 *
 * 数字框**不拒越界只夹回边界**(见 `skin-draft-ops.ts` 的 `clampInt`):这几个框是边敲
 * 边过的,拒了的话想敲两位数就永远敲不出第一位。
 */

import type { CardKind, CardSkinKnob, CardSkinManifest } from "@bilibili-notify/contract";
import type { CardSkinColumn } from "@bilibili-notify/internal";
import {
	CARD_SKIN_BUILTIN_BLOCKS,
	CARD_SKIN_FIELDS,
	CARD_SKIN_FRAME_HOOKS,
	CARD_SKIN_KNOB_LIMITS,
	CARD_SKIN_KNOB_UNITS,
	CARD_SKIN_LIMITS,
	CARD_SKIN_RANKED_KINDS,
	CARD_SKIN_SELF_HOOK,
	cardSkinBytes,
	cardSkinRankGuide,
} from "@bilibili-notify/internal/card-skin";
import {
	AddFileButton,
	Btn,
	ConfirmDialog,
	EmptyNote,
	ErrorNote,
	HintNote,
	Icon,
	IconButton,
	Pill,
	Section,
	Toggle,
	ToneChip,
} from "@bilibili-notify/ui";
import { useState } from "react";
import { Picker, TArea, TColor, TInput, TNum, TSelect } from "../../components/forms";
import type { CardSkinAiDone, CardSkinAiHandlers } from "../../services/cardSkinAi";
import { type CssAiBinding, CssAiSlot } from "./CssAiSlot";
import { CssEditor } from "./CssEditor";
import type { CardSkinAiReadiness } from "./card-skin-ai";
import { INSERT_CHIP } from "./css-value-shapes";
import type { SkinSelection } from "./SkinCanvas";
import {
	blockOf,
	cardOf,
	columnsOf,
	fontsError,
	gridLimits,
	knobsError,
	overlappingBlocks,
	type SkinMetaPatch,
	skinMetaError,
} from "./skin-draft-ops";

type Card = NonNullable<CardSkinManifest["cards"][CardKind]>;
type Grid = Card["blocks"][number]["grid"];
/** 外框那几个数。`gap` 在清单里是个对象,控件上是两个独立的框,所以拍平成两项。 */
export type FramePatch = {
	width?: number;
	gapRow?: number;
	gapColumn?: number;
	/** 出血 px(每边)。写 0 = 整份删掉。 */
	bleedSize?: number;
	/** 出血那圈的底色。这张卡还没有出血时单给它不生效。 */
	bleedColor?: string;
};

/**
 * 「请女仆帮忙写」那一口(ADR-0015 决策 3–10)。`target` 由检查器按选中的框填:
 * 给了 `blockId` 是那一块,没给是外框。
 */
export interface InspectorAi {
	readiness: CardSkinAiReadiness;
	run: (
		target: { blockId?: string },
		instruction: string,
		handlers: CardSkinAiHandlers,
		signal: AbortSignal,
	) => Promise<CardSkinAiDone>;
}

/** 把「写哪个框」绑进去,CSS 那一节只管发话。 */
function bindAi(
	ai: InspectorAi | undefined,
	target: { blockId?: string },
): CssAiBinding | undefined {
	if (!ai) return undefined;
	return {
		readiness: ai.readiness,
		run: (instruction, handlers, signal) => ai.run(target, instruction, handlers, signal),
	};
}

export function SkinInspector({
	manifest,
	kind,
	selection,
	onGrid,
	onCss,
	onHtml,
	onShowIf,
	onFrame,
	onFrameCss,
	onColumns,
	onRemove,
	onDropCard,
	onMeta,
	onKnobs,
	onAssets,
	assets,
	ai,
}: {
	manifest: CardSkinManifest | null;
	kind: CardKind;
	selection: SkinSelection;
	onGrid: (blockId: string, patch: Partial<Grid>) => void;
	onCss: (blockId: string, css: string) => void;
	/** 改自定义块的 HTML。内置块没有内容可改,这个口对它不生效。 */
	onHtml: (blockId: string, html: string) => void;
	/** 改显示条件;`undefined` = 总是显示。 */
	onShowIf: (blockId: string, path: string | undefined) => void;
	onFrame: (patch: FramePatch) => void;
	onFrameCss: (css: string) => void;
	/** 改 12 列的宽度;`undefined` = 回到 12 等分(把 `columns` 整份删掉)。 */
	onColumns: (columns: CardSkinColumn[] | undefined) => void;
	/** 删掉这个块。**不给 = 这套皮肤只读**,连删除钮都不该出现。 */
	onRemove?: (blockId: string) => void;
	/** 交还整张卡(删掉这种卡的定义,出图跟着出厂默认)。与 `onRemove` 同进同出。 */
	onDropCard?: () => void;
	/** 改皮肤级的元信息(名字 / 作者 / 说明)。**不给 = 这套皮肤只读**,三个框都退成只读。 */
	onMeta?: (patch: SkinMetaPatch) => void;
	/** 旋钮声明的增删改。与 `onMeta` 同进同出(同一套「只读」判据)。 */
	onKnobs?: KnobHandlers;
	/** 资产与自带字体。同上。 */
	onAssets?: AssetHandlers;
	/** 这套皮肤盘上有哪些资产 —— 字体那张表照它画候选。 */
	assets?: { names: string[]; pending: boolean; uploadError?: string | null };
	/** CSS 框旁的「请女仆帮忙写」。不给就不摆那颗钮。 */
	ai?: InspectorAi;
}) {
	const tx = useT();

	// 「这块带着内容,真删?」那个弹窗开没开。
	const [confirming, setConfirming] = useState(false);
	const card = cardOf(manifest, kind);

	if (selection === null) {
		return <EmptyNote size="sm">{tx("skinUi.SkinInspector.1")}</EmptyNote>;
	}
	if (selection.kind === "skin") {
		return (
			<SkinMetaInspector
				manifest={manifest}
				onMeta={onMeta}
				onKnobs={onKnobs}
				onAssets={onAssets}
				assets={assets}
			/>
		);
	}
	if (selection.kind === "frame") {
		if (!card) return <EmptyNote size="sm">{tx("skinUi.SkinInspector.2")}</EmptyNote>;
		return (
			<FrameInspector
				kind={kind}
				card={card}
				onFrame={onFrame}
				onColumns={onColumns}
				onFrameCss={onFrameCss}
				onDropCard={onDropCard}
				ai={ai}
			/>
		);
	}

	const block = blockOf(card, selection.id);
	if (!block) {
		// 换了卡种但选中还留着上一张卡的块 id —— 这里如实说,别画一个空壳让人以为坏了。
		return <EmptyNote size="sm">{tx("skinUi.SkinInspector.3")}</EmptyNote>;
	}

	const lim = gridLimits(block.grid);
	const overlapWith = overlappingBlocks(card, block.id);
	/** 这块的「跨行」是真高度还是只给画布看的一句声明(2026-09-18 主人拍板)。 */
	const sizedByRows =
		block.kind === "builtin" &&
		CARD_SKIN_BUILTIN_BLOCKS[kind]?.[block.builtin]?.heightFromRows === true;
	// 自己带内容的块删了就找不回来:自定义块的 HTML、块 CSS、资产变量都不在目录里,
	// 而内置块从「添加块」里原样再摆一个就是了 —— 所以只对前者拦一道。
	const carriesWork =
		block.kind === "custom" ||
		(block.css ?? "") !== "" ||
		Object.keys(block.assets ?? {}).length > 0;

	return (
		<div className="flex flex-col gap-3.5">
			<div className="flex items-center gap-1.5">
				<Pill subtle color="var(--color-bn-pink)">
					{block.kind === "custom" ? tx("skinUi.SkinInspector.4") : tx("skinUi.SkinInspector.5")}
				</Pill>
				<span className="font-mono text-bn-2xs text-bn-text-tertiary">id {block.id}</span>
			</div>

			<Section label={tx("skinUi.SkinInspector.6")}>
				<div className="grid grid-cols-2 gap-x-2.5 gap-y-1.5 p-2.5">
					<GridNum
						label={tx("skinUi.SkinInspector.7")}
						value={block.grid.row}
						lim={lim.row}
						onChange={(row) => onGrid(block.id, { row })}
					/>
					<GridNum
						label={tx("skinUi.SkinInspector.8")}
						value={block.grid.column}
						lim={lim.column}
						onChange={(column) => onGrid(block.id, { column })}
					/>
					<GridNum
						label={tx("skinUi.SkinInspector.9")}
						value={block.grid.span}
						lim={lim.span}
						onChange={(span) => onGrid(block.id, { span })}
					/>
					<GridNum
						label={tx("skinUi.SkinInspector.10")}
						value={block.grid.rowSpan ?? 1}
						lim={lim.rowSpan}
						onChange={(rowSpan) => onGrid(block.id, { rowSpan })}
					/>
					<GridNum
						label={tx("skinUi.SkinInspector.11")}
						value={block.grid.z ?? 0}
						lim={lim.z}
						onChange={(z) => onGrid(block.id, { z })}
					/>
				</div>
				{/* **「跨行」对不同的块不是一件事**(2026-09-18 主人拍板),所以逐块说清楚:
				    封面这种单张图,跨几行就是多高,拖得动也画得准;别的块的高度由内容撑
				    (标题一行还是三行由真实数据说了算),跨行只是一句给画布看的声明。
				    不说的话,主人会拖了没反应还以为是自己改坏了什么。 */}
				<HintNote className="mx-2.5 mb-2.5" tone={sizedByRows ? "success" : "neutral"}>
					{sizedByRows
						? tx("skinUi.SkinInspector.12", { value0: CARD_SKIN_LIMITS.rowHeight })
						: tx("skinUi.SkinInspector.13")}
				</HintNote>
				{/* 只在真叠上了才说这句:平时它是一句与你无关的话,叠上了它才是你要找的那句。 */}
				{overlapWith.length > 0 ? (
					<HintNote className="m-2.5 mt-0">
						{tx("skinUi.SkinInspector.overlap", {
							blocks: overlapWith.map((b) => `「${b}」`).join("、"),
						})}
					</HintNote>
				) : null}
			</Section>

			{block.kind === "custom" ? (
				<HtmlSection kind={kind} value={block.html} onChange={(html) => onHtml(block.id, html)} />
			) : null}

			<Section label={tx("skinUi.SkinInspector.16")}>
				<div className="flex flex-col gap-1.5 p-2.5">
					<TSelect
						value={block.showIf ?? ""}
						onChange={(path) => onShowIf(block.id, path === "" ? undefined : path)}
						options={showIfOptions(kind)}
						ariaLabel={tx("skinUi.SkinInspector.17")}
						full
					/>
					<span className="text-bn-2xs text-bn-text-tertiary">{tx("skinUi.SkinInspector.18")}</span>
				</div>
			</Section>

			{/* 按块 id 换实例:AI 写到一半换了选中的块,原来那一趟得跟着旧块一起卸掉 ——
			    同一个实例留着的话,剩下的规则会写进新选中的那块。 */}
			<CssSection
				key={block.id}
				label={tx("skinUi.SkinInspector.19")}
				hooksLabel={tx("skinUi.SkinInspector.20")}
				hooks={blockHooks(kind, block)}
				value={block.css ?? ""}
				onChange={(css) => onCss(block.id, css)}
				ai={bindAi(ai, { blockId: block.id })}
				note={rankNote(kind)}
			/>

			{onRemove ? (
				<div className="flex justify-end">
					<Btn
						size="sm"
						variant="danger-outline"
						icon={<Icon.trash size={12} />}
						onClick={() => (carriesWork ? setConfirming(true) : onRemove(block.id))}
					>
						{tx("skinUi.SkinInspector.21")}
					</Btn>
				</div>
			) : null}

			{confirming && onRemove ? (
				<ConfirmDialog
					title={tx("skinUi.SkinInspector.22")}
					message={tx("skinUi.SkinInspector.23")}
					confirmLabel={tx("skinUi.SkinInspector.24")}
					danger
					onConfirm={() => {
						setConfirming(false);
						onRemove(block.id);
					}}
					onCancel={() => setConfirming(false)}
				/>
			) : null}
		</div>
	);
}

/**
 * 卡片外框那一节:宽度、行 / 列间距、12 列的列定义。**外框 CSS 不在这儿** —— 它与块的
 * CSS 是同一件东西(同一个编辑器、同一套清洗规矩),跟着「高级 CSS」那一片一起做。
 */
function FrameInspector({
	kind,
	card,
	onFrame,
	onColumns,
	onFrameCss,
	onDropCard,
	ai,
}: {
	kind: CardKind;
	card: Card;
	onFrame: (patch: FramePatch) => void;
	onColumns: (columns: CardSkinColumn[] | undefined) => void;
	onFrameCss: (css: string) => void;
	onDropCard?: () => void;
	ai?: InspectorAi;
}) {
	const tx = useT();

	const [dropping, setDropping] = useState(false);
	const custom = card.columns !== undefined;
	const cols = columnsOf(card);
	// 切到定宽时先填「这一列现在多宽」,而不是一个 1px —— 从当前的样子微调是常态。
	const equalPx = Math.round((card.width / CARD_SKIN_LIMITS.columns) * 100) / 100;

	return (
		<div className="flex flex-col gap-3.5">
			<Section label={tx("skinUi.SkinInspector.25")}>
				<div className="grid grid-cols-2 gap-x-2.5 gap-y-1.5 p-2.5">
					<GridNum
						label={tx("skinUi.SkinInspector.26")}
						value={card.width}
						lim={CARD_SKIN_LIMITS.width}
						onChange={(width) => onFrame({ width })}
					/>
					<GridNum
						label={tx("skinUi.SkinInspector.27")}
						value={card.gap?.row ?? 0}
						lim={CARD_SKIN_LIMITS.gap}
						onChange={(gapRow) => onFrame({ gapRow })}
					/>
					<GridNum
						label={tx("skinUi.SkinInspector.28")}
						value={card.gap?.column ?? 0}
						lim={CARD_SKIN_LIMITS.gap}
						onChange={(gapColumn) => onFrame({ gapColumn })}
					/>
					<GridNum
						label={tx("skinUi.SkinInspector.29")}
						value={card.bleed?.size ?? 0}
						lim={CARD_SKIN_LIMITS.bleed}
						onChange={(bleedSize) => onFrame({ bleedSize })}
					/>
					{/* 色只在真有出血时才给 —— 没有那圈的时候摆一个色块,拧了没反应。 */}
					{card.bleed ? (
						<div className="flex flex-col gap-1">
							<span className="text-bn-2xs text-bn-text-secondary">
								{tx("skinUi.SkinInspector.30")}
							</span>
							<TColor
								value={card.bleed.color}
								onChange={(bleedColor) => onFrame({ bleedColor })}
								ariaLabel={tx("skinUi.SkinInspector.31")}
							/>
						</div>
					) : null}
				</div>
				<HintNote className="mx-2.5 mb-2.5">{tx("skinUi.SkinInspector.32")}</HintNote>
			</Section>

			<Section label={tx("skinUi.SkinInspector.33")}>
				<div className="flex flex-col gap-2 p-2.5">
					<div className="flex items-center justify-between gap-2">
						<span className="text-bn-2xs text-bn-text-secondary">
							{tx("skinUi.SkinInspector.34")}
						</span>
						<Toggle
							size="sm"
							value={custom}
							ariaLabel={tx("skinUi.SkinInspector.35")}
							// 打开时把当前的 12 等分原样落进清单,主人在那个基础上改;关掉就整份删掉。
							onChange={(on) => onColumns(on ? cols : undefined)}
						/>
					</div>
					{custom ? (
						cols.map((c, i) => (
							<ColumnRow
								// biome-ignore lint/suspicious/noArrayIndexKey: 列号就是身份,12 项不增不减
								key={i}
								n={i + 1}
								value={c}
								equalPx={equalPx}
								onChange={(next) => onColumns(cols.map((old, j) => (j === i ? next : old)))}
							/>
						))
					) : (
						<span className="text-bn-2xs text-bn-text-tertiary">
							{tx("skinUi.SkinInspector.36")}
						</span>
					)}
				</div>
			</Section>

			<CssSection
				label={tx("skinUi.SkinInspector.37")}
				hooksLabel={tx("skinUi.SkinInspector.38")}
				hooks={Object.entries(CARD_SKIN_FRAME_HOOKS)}
				value={card.css ?? ""}
				onChange={onFrameCss}
				ai={bindAi(ai, {})}
				note={rankNote(kind)}
			/>

			{onDropCard ? (
				<div className="flex justify-end">
					<Btn
						size="sm"
						variant="danger-outline"
						icon={<Icon.trash size={12} />}
						onClick={() => setDropping(true)}
					>
						{tx("skinUi.SkinInspector.39")}
					</Btn>
				</div>
			) : null}

			{dropping && onDropCard ? (
				<ConfirmDialog
					title={tx("skinUi.SkinInspector.40")}
					message={tx("skinUi.SkinInspector.41")}
					confirmLabel={tx("skinUi.SkinInspector.42")}
					danger
					onConfirm={() => {
						setDropping(false);
						onDropCard();
					}}
					onCancel={() => setDropping(false)}
				/>
			) : null}
		</div>
	);
}

/**
 * 自定义块的内容那一节:能引用的字段 + 一个纯文本框。
 *
 * 字段点一下补进去,`image` 类型补的是一整个 `<img src="{…}">` —— 占位符只有坐在 `src`
 * 上才是图,单写一个 `{creator.avatar}` 出来的是一串 URL 文本(清洗器认的就是这条规矩)。
 */
function HtmlSection({
	kind,
	value,
	onChange,
}: {
	kind: CardKind;
	value: string;
	onChange: (html: string) => void;
}) {
	const tx = useT();

	// 量 **UTF-8 字节**,不是 `value.length` —— 退这份包的清洗器量的就是字节,
	// 两把尺不一样的话面板会一路显示「没超」,存下去才被退回来(汉字占 3 个)。
	const bytes = cardSkinBytes(value);
	const over = bytes > CARD_SKIN_LIMITS.maxHtmlBytes;
	const empty = value.trim() === "";
	return (
		<Section label={tx("skinUi.SkinInspector.43")}>
			<div className="flex flex-col gap-2 p-2.5">
				<fieldset
					aria-label={tx("skinUi.SkinInspector.44")}
					className="flex max-h-28 min-w-0 flex-wrap gap-1 overflow-y-auto"
				>
					{CARD_SKIN_FIELDS[kind].map((f) => (
						<button
							key={f.path}
							type="button"
							data-bn="chip"
							title={`{${f.path}} —— ${f.label}`}
							onClick={() => onChange(appendField(value, f.path, f.type === "image"))}
							className={`flex items-center gap-1 ${INSERT_CHIP}`}
						>
							<span>{f.label}</span>
							<span className="font-mono text-bn-text-tertiary">{f.type}</span>
						</button>
					))}
				</fieldset>

				<TArea
					value={value}
					onChange={onChange}
					rows={6}
					mono
					ariaLabel={tx("skinUi.SkinInspector.45")}
					placeholder="<div>{creator.name}</div>"
				/>

				{empty ? (
					<ErrorNote size="sm">{tx("skinUi.SkinInspector.46")}</ErrorNote>
				) : over ? (
					<ErrorNote size="sm">
						{tx("skinUi.SkinInspector.byteLimit47", {
							count: bytes,
							max: CARD_SKIN_LIMITS.maxHtmlBytes,
						})}
					</ErrorNote>
				) : (
					<span className="text-right font-mono text-bn-2xs text-bn-text-tertiary">
						{bytes} / {CARD_SKIN_LIMITS.maxHtmlBytes}
					</span>
				)}
			</div>
		</Section>
	);
}

/** 在末尾补一个字段占位符。图片字段补整个 `<img>`。 */
function appendField(html: string, path: string, image: boolean): string {
	const piece = image ? `<img src="{${path}}">` : `{${path}}`;
	return html.trim() === "" ? piece : `${html.replace(/\s+$/, "")}${piece}`;
}

/**
 * 显示条件的候选:**这种卡**的字段契约。`bool` 排前面 —— `is*` / `has*` 本来就是为
 * `showIf` 立的;其余字段也收(真值才画,空字符串是假),只是在人话名前标一句「非空时」,
 * 免得作者以为选了「主播名」就是「等于某个名字」。
 */
function showIfOptions(kind: CardKind): Array<{ value: string; label: string }> {
	const fields = CARD_SKIN_FIELDS[kind];
	const order = [...fields].sort((a, b) => Number(b.type === "bool") - Number(a.type === "bool"));
	return [
		{ value: "", label: i18n.t("skinUi.SkinInspector.49") },
		...order.map((f) => ({
			value: f.path,
			label:
				f.type === "bool"
					? `${f.label}(${f.path})`
					: i18n.t("skinUi.SkinInspector.50", { value0: f.label, value1: f.path }),
		})),
	];
}

/**
 * 这个块的 CSS 能挂哪些选择器:`self`(整块)+ 内置块内部那几个部件。自定义块只有
 * `self` —— 里面的 HTML 是作者自己写的,挂点也就该由他自己在 HTML 里定。
 */
function blockHooks(kind: CardKind, block: Card["blocks"][number]): Array<[string, string]> {
	const meta =
		block.kind === "builtin" ? CARD_SKIN_BUILTIN_BLOCKS[kind]?.[block.builtin] : undefined;
	return [
		[CARD_SKIN_SELF_HOOK, i18n.t("skinUi.SkinInspector.51")],
		...Object.entries(meta?.hooks ?? {}),
	];
}

/**
 * 档位卡(醒目留言 / 会员)的 CSS 一节要带上「按档换色」的说明;别的卡没有「档」,不给。
 * 说明与 AI 的规则提示词读同一段常量({@link cardSkinRankGuide})。
 */
function rankNote(kind: CardKind): string | undefined {
	return (CARD_SKIN_RANKED_KINDS as readonly string[]).includes(kind)
		? cardSkinRankGuide()
		: undefined;
}

/**
 * CSS 那一节:结构化编辑器(规则 → 声明,按值给控件)+ 源码切换(ADR-0014 决策 21 的
 * 2026-09-19 🔗),外加女仆钮与字节计数。清洗与「削掉了什么」归 server —— 预览那栏已经把
 * warnings 逐条列出来了,这里只拦一条前端自己就能判的:超上限。
 */
function CssSection({
	label,
	hooksLabel,
	hooks,
	value,
	onChange,
	ai,
	note,
}: {
	label: string;
	hooksLabel: string;
	hooks: Array<[string, string]>;
	value: string;
	onChange: (css: string) => void;
	ai?: CssAiBinding;
	/** 这一节 CSS 旁边给作者的一段说明(档位卡的「按档换色」);没有就不画。 */
	note?: string;
}) {
	const tx = useT();

	// 同上:计数器与那道闸必须是同一把尺(UTF-8 字节)。
	const bytes = cardSkinBytes(value);
	const over = bytes > CARD_SKIN_LIMITS.maxCssBytes;
	return (
		<Section label="CSS">
			<div className="flex flex-col gap-2 p-2.5">
				{ai ? <CssAiSlot ai={ai} value={value} onChange={onChange} /> : null}

				<CssEditor
					css={value}
					hooks={hooks}
					hooksLabel={hooksLabel}
					onChange={onChange}
					ariaLabel={label}
					placeholder={'[data-bn="self"]{padding:12px 16px}'}
				/>

				{note ? <span className="text-bn-2xs text-bn-text-tertiary">{note}</span> : null}

				{over ? (
					<ErrorNote size="sm">
						{tx("skinUi.SkinInspector.byteLimit52", {
							count: bytes,
							max: CARD_SKIN_LIMITS.maxCssBytes,
						})}
					</ErrorNote>
				) : (
					<span className="text-right font-mono text-bn-2xs text-bn-text-tertiary">
						{bytes} / {CARD_SKIN_LIMITS.maxCssBytes}
					</span>
				)}
			</div>
		</Section>
	);
}

/** 一列:列号 + 单位(份 / px)+ 数。 */
function ColumnRow({
	n,
	value,
	equalPx,
	onChange,
}: {
	n: number;
	value: CardSkinColumn;
	equalPx: number;
	onChange: (next: CardSkinColumn) => void;
}) {
	const tx = useT();

	const px = "px" in value;
	return (
		<div className="flex items-center gap-1.5">
			<span className="w-11 shrink-0 font-mono text-bn-2xs text-bn-text-tertiary">
				{tx("skinUi.SkinInspector.columnNumber", { index: n })}
			</span>
			{/* `<fieldset>` 只为给这组钮一个名字 —— 12 组「份 / px」长得一模一样,读屏器
			    (和测试)得知道念的是哪一列。 */}
			<fieldset aria-label={tx("skinUi.SkinInspector.56", { value0: n })} className="min-w-0">
				<Picker
					value={px ? "px" : "fr"}
					onChange={(u) => onChange(u === "px" ? { px: equalPx } : { fr: 1 })}
					options={[
						{ value: "fr", label: tx("skinUi.SkinInspector.57") },
						{ value: "px", label: "px" },
					]}
				/>
			</fieldset>
			<TNum
				value={px ? value.px : value.fr}
				min={1}
				max={px ? CARD_SKIN_LIMITS.width.max : CARD_SKIN_LIMITS.columns}
				step={px ? 0.01 : 1}
				width={72}
				ariaLabel={tx("skinUi.SkinInspector.58", { value0: n })}
				onChange={(v) => onChange(px ? { px: v } : { fr: v })}
			/>
		</div>
	);
}

function GridNum({
	label,
	value,
	lim,
	onChange,
}: {
	label: string;
	value: number;
	lim: { min: number; max: number };
	onChange: (next: number) => void;
}) {
	// 刻意不用 `<label>` 包:控件是 `TNum`(内部才是真 input),包了读屏器与 lint 都对不上
	// 它 —— 名字走 `ariaLabel` 递进去,那是 T 系列既有的口。
	return (
		<div className="flex flex-col gap-1">
			<span className="text-bn-2xs text-bn-text-secondary">{label}</span>
			<TNum
				value={value}
				min={lim.min}
				max={lim.max}
				onChange={onChange}
				ariaLabel={`${label}(${lim.min}–${lim.max})`}
			/>
		</div>
	);
}

/**
 * 皮肤这一档 —— 名字 / 作者 / 说明。
 *
 * 名字是必填的(装包门那头 `name.min = 1`),但空的照样让它敲进去:在这儿弹回旧名的话,
 * 主人看到的是一个「怎么删都删不掉」的框。空了就在下面说清楚,保存钮同时变灰
 * (见 {@link skinMetaError})。作者与说明是可选的,清空即删键。
 */
function SkinMetaInspector({
	manifest,
	onMeta,
	onKnobs,
	onAssets,
	assets,
}: {
	manifest: CardSkinManifest | null;
	onMeta?: (patch: SkinMetaPatch) => void;
	onKnobs?: KnobHandlers;
	onAssets?: AssetHandlers;
	assets?: { names: string[]; pending: boolean; uploadError?: string | null };
}) {
	const tx = useT();

	if (!manifest) return <EmptyNote size="sm">{tx("skinUi.SkinInspector.59")}</EmptyNote>;
	const err = skinMetaError(manifest);
	// 只读皮肤:框仍然画出来(内容本身是主人要看的),走库里的 `disabled` 只读态。
	const ro = onMeta === undefined;
	return (
		<div className="flex flex-col gap-3.5">
			<Section label={tx("skinUi.SkinInspector.60")}>
				<div className="flex flex-col gap-2.5 p-2.5">
					<span className="text-bn-2xs text-bn-text-tertiary">{tx("skinUi.SkinInspector.61")}</span>
					<TInput
						value={manifest.name}
						onChange={(v) => onMeta?.({ name: v })}
						disabled={ro}
						ariaLabel={tx("skinUi.SkinInspector.62")}
						placeholder={tx("skinUi.SkinInspector.63")}
					/>
					{err ? <ErrorNote size="sm">{err}</ErrorNote> : null}

					<TInput
						value={manifest.author ?? ""}
						onChange={(v) => onMeta?.({ author: v })}
						disabled={ro}
						ariaLabel={tx("skinUi.SkinInspector.64")}
						placeholder={tx("skinUi.SkinInspector.65")}
					/>

					<TArea
						value={manifest.description ?? ""}
						onChange={(v) => onMeta?.({ description: v })}
						disabled={ro}
						rows={3}
						ariaLabel={tx("skinUi.SkinInspector.66")}
						placeholder={tx("skinUi.SkinInspector.67")}
					/>
				</div>
			</Section>

			<KnobSection manifest={manifest} onKnobs={onKnobs} />

			<AssetSection
				manifest={manifest}
				assets={assets?.names ?? []}
				assetsPending={assets?.pending ?? false}
				uploadError={assets?.uploadError}
				on={onAssets}
			/>
		</div>
	);
}

/** 旋钮那一节要的四个口。**整份不给 = 这套皮肤只读**(同 `onRemove` 的判据)。 */
export type KnobHandlers = {
	onAdd: () => void;
	onRemove: (key: string) => void;
	onDecl: (key: string, patch: { key?: string; label?: string }) => void;
	onType: (key: string, type: CardSkinKnob["type"]) => void;
	onDefault: (key: string, value: string | number | boolean) => void;
	/** 数值那一档自己的取值域与单位。 */
	onNumber: (
		key: string,
		patch: { min?: number; max?: number; step?: number; unit?: string },
	) => void;
	/** 开关两端注进 CSS 的字面量。 */
	onSwitch: (key: string, patch: { on?: string; off?: string }) => void;
	/** 下拉候选表的增 / 改 / 删。 */
	onOptionAdd: (key: string) => void;
	onOption: (key: string, index: number, patch: { value?: string; label?: string }) => void;
	onOptionRemove: (key: string, index: number) => void;
};

/** 六档在下拉里的人话名。顺序照的是「多数皮肤先要哪一档」。 */
function knobTypeLabels(): Array<[CardSkinKnob["type"], string]> {
	return [
		["color", i18n.t("skinUi.SkinInspector.68")],
		["number", i18n.t("skinUi.SkinInspector.69")],
		["select", i18n.t("skinUi.SkinInspector.70")],
		["switch", i18n.t("skinUi.SkinInspector.71")],
		["font", i18n.t("skinUi.SkinInspector.72")],
		["image", i18n.t("skinUi.SkinInspector.73")],
	];
}

/**
 * 皮肤自己的旋钮声明 —— 卡片页那个旋钮区照它画控件(ADR-0014 决策 16)。
 *
 * 每枚一行:key、人话名、档位,以及**起手位置**。起手位置写的是面板控件停在哪儿,
 * 它**不注入** —— 真正的默认值是皮肤 CSS 里 `var(--bn-knob-<key>, 兜底)` 的那个兜底,
 * 这条得在界面上说出来,否则作者会把它当默认值用,而换皮肤的人什么都看不到变化。
 */
function KnobSection({
	manifest,
	onKnobs,
}: {
	manifest: CardSkinManifest;
	onKnobs?: KnobHandlers;
}) {
	const tx = useT();

	const knobs = manifest.knobs ?? [];
	const err = knobsError(manifest);
	const full = knobs.length >= CARD_SKIN_KNOB_LIMITS.maxKnobs;
	return (
		<Section label={tx("skinUi.SkinInspector.74")}>
			<div className="flex flex-col gap-2.5 p-2.5">
				<span className="text-bn-2xs text-bn-text-tertiary">{tx("skinUi.SkinInspector.75")}</span>

				{knobs.length === 0 ? (
					<EmptyNote size="sm">{tx("skinUi.SkinInspector.81")}</EmptyNote>
				) : (
					knobs.map((knob, i) => (
						<KnobRow key={knob.key || `#${i}`} index={i} knob={knob} onKnobs={onKnobs} />
					))
				)}

				{err ? <ErrorNote size="sm">{err}</ErrorNote> : null}

				{onKnobs === undefined ? null : full ? (
					<span className="text-bn-2xs text-bn-text-tertiary">
						{tx("skinUi.SkinInspector.knobLimit", { count: CARD_SKIN_KNOB_LIMITS.maxKnobs })}
					</span>
				) : (
					<Btn size="sm" variant="outline" onClick={onKnobs.onAdd}>
						<Icon.plus size={12} /> {tx("skinUi.SkinInspector.84")}
					</Btn>
				)}
			</div>
		</Section>
	);
}

/**
 * 一枚旋钮。包一层 `<fieldset>` 是为了让读屏器念得出「第几枚」—— 三个框的名字在每一行
 * 里都一样,不分组的话念出来是一串同名控件。
 */
function KnobRow({
	index,
	knob,
	onKnobs,
}: {
	index: number;
	knob: CardSkinKnob;
	onKnobs?: KnobHandlers;
}) {
	const tx = useT();

	const ro = onKnobs === undefined;
	return (
		<fieldset
			aria-label={tx("skinUi.SkinInspector.85", { value0: index + 1 })}
			className="flex min-w-0 flex-col gap-1.5 rounded-bn-sm border border-bn-border bg-bn-surface-muted p-2"
		>
			{/* key 与名字**各占一行**:检查器那一栏再宽也就 380,两个输入框挤一排时
			    `gradient-start` 这种长度的 key 会被切成 `gradient-st…`,而 key 正是
			    皮肤 CSS 里要照抄的那一串 —— 看不全等于抄不对。 */}
			<div className="flex min-w-0 items-center gap-1.5">
				<TInput
					value={knob.key}
					onChange={(v) => onKnobs?.onDecl(knob.key, { key: v })}
					disabled={ro}
					mono
					ariaLabel={tx("skinUi.SkinInspector.86")}
					placeholder="accent"
				/>
				{ro ? null : (
					<IconButton
						size="sm"
						label={tx("skinUi.SkinInspector.87")}
						icon={<Icon.trash size={12} />}
						onClick={() => onKnobs.onRemove(knob.key)}
					/>
				)}
			</div>
			<TInput
				value={knob.label}
				onChange={(v) => onKnobs?.onDecl(knob.key, { label: v })}
				disabled={ro}
				ariaLabel={tx("skinUi.SkinInspector.88")}
				placeholder={tx("skinUi.SkinInspector.89")}
			/>

			<div className="flex min-w-0 flex-wrap items-center gap-1.5">
				<TSelect
					value={knob.type}
					onChange={(t) => onKnobs?.onType(knob.key, t as CardSkinKnob["type"])}
					options={knobTypeLabels().map(([value, label]) => ({ value, label }))}
					disabled={ro}
					ariaLabel={tx("skinUi.SkinInspector.90")}
					full={false}
				/>
				<KnobDefault knob={knob} onKnobs={onKnobs} />
			</div>

			<KnobExtras knob={knob} onKnobs={onKnobs} />
		</fieldset>
	);
}

/**
 * 三档自己那几项:数值的取值域 / 步长 / 单位、开关两端的字面量、下拉的候选表。
 * 其余三档(颜色 / 字体 / 图)没有附加字段,这里什么都不画。
 */
function KnobExtras({ knob, onKnobs }: { knob: CardSkinKnob; onKnobs?: KnobHandlers }) {
	const tx = useT();

	const ro = onKnobs === undefined;
	if (knob.type === "number") {
		return (
			<div className="flex min-w-0 flex-wrap items-center gap-1.5">
				<span className="text-bn-2xs text-bn-text-tertiary">{tx("skinUi.SkinInspector.91")}</span>
				<TNum
					value={knob.min}
					onChange={(v) => onKnobs?.onNumber(knob.key, { min: v })}
					disabled={ro}
					ariaLabel={tx("skinUi.SkinInspector.92")}
					width={68}
					step={knob.step}
				/>
				<span className="text-bn-2xs text-bn-text-tertiary">~</span>
				<TNum
					value={knob.max}
					onChange={(v) => onKnobs?.onNumber(knob.key, { max: v })}
					disabled={ro}
					ariaLabel={tx("skinUi.SkinInspector.93")}
					width={68}
					step={knob.step}
				/>
				<span className="text-bn-2xs text-bn-text-tertiary">{tx("skinUi.SkinInspector.94")}</span>
				<TNum
					value={knob.step ?? 0}
					onChange={(v) => onKnobs?.onNumber(knob.key, { step: v })}
					disabled={ro}
					ariaLabel={tx("skinUi.SkinInspector.95")}
					width={68}
					step={0.01}
					min={0}
				/>
				<TSelect
					value={knob.unit ?? ""}
					onChange={(u) => onKnobs?.onNumber(knob.key, { unit: u })}
					options={[
						{ value: "", label: tx("skinUi.SkinInspector.96") },
						...CARD_SKIN_KNOB_UNITS.map((u) => ({ value: u, label: u })),
					]}
					disabled={ro}
					ariaLabel={tx("skinUi.SkinInspector.97")}
					full={false}
				/>
			</div>
		);
	}
	if (knob.type === "switch") {
		return (
			<div className="flex min-w-0 flex-wrap items-center gap-1.5">
				<span className="text-bn-2xs text-bn-text-tertiary">{tx("skinUi.SkinInspector.98")}</span>
				<TInput
					value={knob.on}
					onChange={(v) => onKnobs?.onSwitch(knob.key, { on: v })}
					disabled={ro}
					mono
					ariaLabel={tx("skinUi.SkinInspector.99")}
					placeholder="block"
				/>
				<span className="text-bn-2xs text-bn-text-tertiary">{tx("skinUi.SkinInspector.100")}</span>
				<TInput
					value={knob.off}
					onChange={(v) => onKnobs?.onSwitch(knob.key, { off: v })}
					disabled={ro}
					mono
					ariaLabel={tx("skinUi.SkinInspector.101")}
					placeholder="none"
				/>
			</div>
		);
	}
	if (knob.type !== "select") return null;
	return (
		<div className="flex min-w-0 flex-col gap-1.5">
			{knob.options.map((option, i) => (
				// 候选没有稳定 id,值又是边敲边变的 —— 用下标当 key。这一串只增删末尾与中间,
				// 不重排,下标做 key 不会错位。
				// biome-ignore lint/suspicious/noArrayIndexKey: 见上
				<div key={i} className="flex min-w-0 items-center gap-1.5">
					{/* 起手位置就是「选中哪一个候选」—— 走库里那件「一排里选一个」的胶囊,
					    而不是裸 `<input type="radio">`:原生单选圈没有输入面可挂皮肤挂点,
					    装了皮肤的真机上它会是这一行里唯一没跟着变的东西。 */}
					<span className="shrink-0 whitespace-nowrap">
						<ToneChip
							tone="var(--color-bn-pink)"
							active={knob.default === option.value}
							disabled={ro}
							onClick={() => onKnobs?.onDefault(knob.key, option.value)}
						>
							{tx("skinUi.SkinInspector.102")}
						</ToneChip>
					</span>
					<TInput
						value={option.value}
						onChange={(v) => onKnobs?.onOption(knob.key, i, { value: v })}
						disabled={ro}
						mono
						ariaLabel={tx("skinUi.SkinInspector.103")}
						placeholder="12px"
					/>
					<TInput
						value={option.label}
						onChange={(v) => onKnobs?.onOption(knob.key, i, { label: v })}
						disabled={ro}
						ariaLabel={tx("skinUi.SkinInspector.104")}
						placeholder={tx("skinUi.SkinInspector.105")}
					/>
					{ro || knob.options.length <= 1 ? null : (
						<IconButton
							size="sm"
							label={tx("skinUi.SkinInspector.106")}
							icon={<Icon.trash size={12} />}
							onClick={() => onKnobs.onOptionRemove(knob.key, i)}
						/>
					)}
				</div>
			))}
			{ro || knob.options.length >= CARD_SKIN_KNOB_LIMITS.maxOptions ? null : (
				<Btn size="sm" variant="ghost" onClick={() => onKnobs.onOptionAdd(knob.key)}>
					<Icon.plus size={12} /> {tx("skinUi.SkinInspector.107")}
				</Btn>
			)}
		</div>
	);
}

/**
 * 起手位置 —— 按档位换控件。`select` 的起手位置与候选表绑在一起(选的就是候选之一),
 * `image` 压根没有(图是主人自己的东西,皮肤起不出默认值),两档都不在这儿画。
 */
function KnobDefault({ knob, onKnobs }: { knob: CardSkinKnob; onKnobs?: KnobHandlers }) {
	const tx = useT();

	const ro = onKnobs === undefined;
	const set = (v: string | number | boolean) => onKnobs?.onDefault(knob.key, v);
	switch (knob.type) {
		case "color":
			return (
				<TColor
					value={knob.default}
					onChange={set}
					disabled={ro}
					ariaLabel={tx("skinUi.SkinInspector.108")}
				/>
			);
		case "number":
			return (
				<TNum
					value={knob.default}
					onChange={set}
					disabled={ro}
					ariaLabel={tx("skinUi.SkinInspector.109")}
					width={80}
					step={knob.step}
				/>
			);
		case "switch":
			return (
				<Toggle
					value={knob.default}
					onChange={set}
					disabled={ro}
					size="sm"
					ariaLabel={tx("skinUi.SkinInspector.110")}
				/>
			);
		case "font":
			return (
				<TInput
					value={knob.default}
					onChange={set}
					disabled={ro}
					ariaLabel={tx("skinUi.SkinInspector.111")}
					placeholder={tx("skinUi.SkinInspector.112")}
				/>
			);
		default:
			return (
				<span className="text-bn-2xs text-bn-text-tertiary">
					{knob.type === "image" ? tx("skinUi.SkinInspector.113") : tx("skinUi.SkinInspector.114")}
				</span>
			);
	}
}

/** 资产与自带字体那两节要的口。**整份不给 = 只读**(同 `onKnobs` 的判据)。 */
export type AssetHandlers = {
	onUpload: (file: File) => void;
	onDeleteAsset: (name: string) => void;
	onAddFont: () => void;
	onFont: (index: number, patch: { family?: string; asset?: string }) => void;
	onRemoveFont: (index: number) => void;
};

/**
 * 皮肤自己的**资产**与**自带字体**。
 *
 * 两节挨着摆是因为它们是同一件事的两半:清单里的 `asset:assets/<文件>` 只能指**包内**
 * 文件,所以「配一款自带字体」的第一步永远是把文件传进这套皮肤。传到主人自己的字体库里
 * 是不行的 —— 导出的 zip 里没有那份文件,别人装上就是回落字体,而这边一切正常。
 */
function AssetSection({
	manifest,
	assets,
	assetsPending,
	on,
	uploadError,
}: {
	manifest: CardSkinManifest;
	assets: string[];
	assetsPending: boolean;
	on?: AssetHandlers;
	/** 传失败的原因(体积 / 后缀 / 重名),原样摆出来 —— 自编一句「上传失败」等于把线索吞掉。 */
	uploadError?: string | null;
}) {
	const tx = useT();

	const fonts = manifest.fonts ?? [];
	const fontAssets = assets.filter((a) => /\.(woff2|woff|ttf|otf)$/.test(a));
	const err = fontsError(manifest, assets);
	return (
		<>
			<Section label={tx("skinUi.SkinInspector.115")}>
				<div className="flex flex-col gap-2 p-2.5">
					<span className="text-bn-2xs text-bn-text-tertiary">
						{tx("skinUi.SkinInspector.116")}
					</span>

					{assetsPending ? (
						<span className="text-bn-2xs text-bn-text-tertiary">
							{tx("skinUi.SkinInspector.119")}
						</span>
					) : assets.length === 0 ? (
						<EmptyNote size="sm">{tx("skinUi.SkinInspector.120")}</EmptyNote>
					) : (
						assets.map((name) => (
							<div key={name} className="flex min-w-0 items-center gap-1.5">
								<span className="min-w-0 flex-1 truncate font-mono text-bn-2xs text-bn-text-secondary">
									{name}
								</span>
								{on ? (
									<IconButton
										size="sm"
										label={tx("skinUi.SkinInspector.121")}
										icon={<Icon.trash size={12} />}
										onClick={() => on.onDeleteAsset(name)}
									/>
								) : null}
							</div>
						))
					)}

					{on ? (
						<AddFileButton
							accept=".png,.jpg,.jpeg,.webp,.gif,.woff2,.woff,.ttf,.otf"
							onFile={(file) => file && on.onUpload(file)}
							className="flex items-center justify-center gap-1 rounded-lg px-3 py-2 text-bn-2xs"
						>
							<Icon.plus size={12} /> {tx("skinUi.SkinInspector.122")}
						</AddFileButton>
					) : null}

					{uploadError ? <ErrorNote size="sm">{uploadError}</ErrorNote> : null}
				</div>
			</Section>

			<Section label={tx("skinUi.SkinInspector.123")}>
				<div className="flex flex-col gap-2 p-2.5">
					<span className="text-bn-2xs text-bn-text-tertiary">
						{tx("skinUi.SkinInspector.124")}
					</span>

					{fonts.map((font, i) => (
						// 字体行没有稳定 id(family 边敲边变),只增删末尾不重排,下标做 key 不会错位。
						// biome-ignore lint/suspicious/noArrayIndexKey: 见上
						<div key={i} className="flex min-w-0 items-center gap-1.5">
							<TInput
								value={font.family}
								onChange={(v) => on?.onFont(i, { family: v })}
								disabled={on === undefined}
								ariaLabel={tx("skinUi.SkinInspector.127")}
								placeholder="Song"
							/>
							<TSelect
								value={font.asset}
								onChange={(v) => on?.onFont(i, { asset: v })}
								options={[
									{ value: "", label: tx("skinUi.SkinInspector.128") },
									...fontAssets.map((a) => ({ value: `asset:${a}`, label: a })),
								]}
								disabled={on === undefined}
								ariaLabel={tx("skinUi.SkinInspector.129")}
							/>
							{on ? (
								<IconButton
									size="sm"
									label={tx("skinUi.SkinInspector.130")}
									icon={<Icon.trash size={12} />}
									onClick={() => on.onRemoveFont(i)}
								/>
							) : null}
						</div>
					))}

					{fonts.length > 0 && fontAssets.length === 0 ? (
						<HintNote>{tx("skinUi.SkinInspector.131")}</HintNote>
					) : null}
					{err ? <ErrorNote size="sm">{err}</ErrorNote> : null}

					{on === undefined ? null : fonts.length >= CARD_SKIN_LIMITS.maxFonts ? (
						<span className="text-bn-2xs text-bn-text-tertiary">
							{tx("skinUi.SkinInspector.fontLimit", { count: CARD_SKIN_LIMITS.maxFonts })}
						</span>
					) : (
						<Btn size="sm" variant="outline" onClick={on.onAddFont}>
							<Icon.plus size={12} /> {tx("skinUi.SkinInspector.134")}
						</Btn>
					)}
				</div>
			</Section>
		</>
	);
}
