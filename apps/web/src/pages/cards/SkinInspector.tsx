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

import type { CardSkinKind, CardSkinManifest } from "@bilibili-notify/contract";
import type { CardSkinColumn } from "@bilibili-notify/internal";
import {
	CARD_SKIN_BUILTIN_BLOCKS,
	CARD_SKIN_FIELDS,
	CARD_SKIN_FRAME_HOOKS,
	CARD_SKIN_LIMITS,
	CARD_SKIN_SELF_HOOK,
} from "@bilibili-notify/internal/constants";
import {
	Btn,
	ConfirmDialog,
	EmptyNote,
	ErrorNote,
	Icon,
	Pill,
	Section,
	Toggle,
} from "@bilibili-notify/ui";
import { useState } from "react";
import { Picker, TArea, TNum, TSelect } from "../../components/forms";
import type { SkinSelection } from "./SkinCanvas";
import { blockOf, cardOf, columnsOf, gridLimits } from "./skin-draft-ops";

type Card = NonNullable<CardSkinManifest["cards"][CardSkinKind]>;
type Grid = Card["blocks"][number]["grid"];
/** 外框那几个数。`gap` 在清单里是个对象,控件上是两个独立的框,所以拍平成两项。 */
export type FramePatch = { width?: number; gapRow?: number; gapColumn?: number };

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
}: {
	manifest: CardSkinManifest | null;
	kind: CardSkinKind;
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
}) {
	// 「这块带着内容,真删?」那个弹窗开没开。
	const [confirming, setConfirming] = useState(false);
	const card = cardOf(manifest, kind);

	if (selection === null) {
		return <EmptyNote size="sm">在左边画布上点一个块,或者点最底下那条「卡片外框」。</EmptyNote>;
	}
	if (selection.kind === "frame") {
		if (!card) return <EmptyNote size="sm">这套皮肤没有定义这种卡。</EmptyNote>;
		return (
			<FrameInspector
				card={card}
				onFrame={onFrame}
				onColumns={onColumns}
				onFrameCss={onFrameCss}
				onDropCard={onDropCard}
			/>
		);
	}

	const block = blockOf(card, selection.id);
	if (!block) {
		// 换了卡种但选中还留着上一张卡的块 id —— 这里如实说,别画一个空壳让人以为坏了。
		return <EmptyNote size="sm">这一张卡里没有这个块。</EmptyNote>;
	}

	const lim = gridLimits(block.grid);
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
					{block.kind === "custom" ? "自定义块" : "内置块"}
				</Pill>
				<span className="font-mono text-bn-2xs text-bn-text-tertiary">id {block.id}</span>
			</div>

			<Section label="位置">
				<div className="grid grid-cols-2 gap-x-2.5 gap-y-1.5 p-2.5">
					<GridNum
						label="行"
						value={block.grid.row}
						lim={lim.row}
						onChange={(row) => onGrid(block.id, { row })}
					/>
					<GridNum
						label="起始列"
						value={block.grid.column}
						lim={lim.column}
						onChange={(column) => onGrid(block.id, { column })}
					/>
					<GridNum
						label="跨列"
						value={block.grid.span}
						lim={lim.span}
						onChange={(span) => onGrid(block.id, { span })}
					/>
					<GridNum
						label="跨行"
						value={block.grid.rowSpan ?? 1}
						lim={lim.rowSpan}
						onChange={(rowSpan) => onGrid(block.id, { rowSpan })}
					/>
				</div>
			</Section>

			{block.kind === "custom" ? (
				<HtmlSection kind={kind} value={block.html} onChange={(html) => onHtml(block.id, html)} />
			) : null}

			<Section label="显示条件">
				<div className="flex flex-col gap-1.5 p-2.5">
					<TSelect
						value={block.showIf ?? ""}
						onChange={(path) => onShowIf(block.id, path === "" ? undefined : path)}
						options={showIfOptions(kind)}
						ariaLabel="显示条件"
						full
					/>
					<span className="text-bn-2xs text-bn-text-tertiary">
						字段为真才画这一块。候选只列这种卡承诺的字段 —— 别的卡的字段写进去,装包门那头直接拒。
					</span>
				</div>
			</Section>

			<CssSection
				label="这个块的 CSS"
				hooksLabel="这个块的挂点"
				hooks={blockHooks(kind, block)}
				value={block.css ?? ""}
				onChange={(css) => onCss(block.id, css)}
			/>

			{onRemove ? (
				<div className="flex justify-end">
					<Btn
						size="sm"
						variant="danger-outline"
						icon={<Icon.trash size={12} />}
						onClick={() => (carriesWork ? setConfirming(true) : onRemove(block.id))}
					>
						删除这个块
					</Btn>
				</div>
			) : null}

			{confirming && onRemove ? (
				<ConfirmDialog
					title="删掉这个块?"
					message="它自己带着内容(自定义 HTML / 块 CSS / 资产变量),删了找不回来 —— 内置块能从「添加块」里原样再摆一个,这些不能。"
					confirmLabel="删掉"
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
	card,
	onFrame,
	onColumns,
	onFrameCss,
	onDropCard,
}: {
	card: Card;
	onFrame: (patch: FramePatch) => void;
	onColumns: (columns: CardSkinColumn[] | undefined) => void;
	onFrameCss: (css: string) => void;
	onDropCard?: () => void;
}) {
	const [dropping, setDropping] = useState(false);
	const custom = card.columns !== undefined;
	const cols = columnsOf(card);
	// 切到定宽时先填「这一列现在多宽」,而不是一个 1px —— 从当前的样子微调是常态。
	const equalPx = Math.round((card.width / CARD_SKIN_LIMITS.columns) * 100) / 100;

	return (
		<div className="flex flex-col gap-3.5">
			<Section label="卡片外框">
				<div className="grid grid-cols-2 gap-x-2.5 gap-y-1.5 p-2.5">
					<GridNum
						label="卡宽"
						value={card.width}
						lim={CARD_SKIN_LIMITS.width}
						onChange={(width) => onFrame({ width })}
					/>
					<GridNum
						label="行间距"
						value={card.gap?.row ?? 0}
						lim={CARD_SKIN_LIMITS.gap}
						onChange={(gapRow) => onFrame({ gapRow })}
					/>
					<GridNum
						label="列间距"
						value={card.gap?.column ?? 0}
						lim={CARD_SKIN_LIMITS.gap}
						onChange={(gapColumn) => onFrame({ gapColumn })}
					/>
				</div>
			</Section>

			<Section label="列定义">
				<div className="flex flex-col gap-2 p-2.5">
					<div className="flex items-center justify-between gap-2">
						<span className="text-bn-2xs text-bn-text-secondary">自定义列宽</span>
						<Toggle
							size="sm"
							value={custom}
							ariaLabel="自定义列宽"
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
							12 等分。定宽列是给定尺寸的图留的 —— 上舰卡那枚 175px 的方徽章在 12 等分里落不到
							整数列,只有定宽列能复刻到像素。
						</span>
					)}
				</div>
			</Section>

			<CssSection
				label="外框的 CSS"
				hooksLabel="外框的挂点"
				hooks={Object.entries(CARD_SKIN_FRAME_HOOKS)}
				value={card.css ?? ""}
				onChange={onFrameCss}
			/>

			{onDropCard ? (
				<div className="flex justify-end">
					<Btn
						size="sm"
						variant="danger-outline"
						icon={<Icon.trash size={12} />}
						onClick={() => setDropping(true)}
					>
						交还给默认皮肤
					</Btn>
				</div>
			) : null}

			{dropping && onDropCard ? (
				<ConfirmDialog
					title="把这种卡交还给出厂默认?"
					message="这张卡的块、位置与 CSS 会整份从这套皮肤里去掉,出图时它跟着出厂默认走。想再改回来得重新接管一次。"
					confirmLabel="交还"
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
 * 上才是图,单写一个 `{up.face}` 出来的是一串 URL 文本(清洗器认的就是这条规矩)。
 */
function HtmlSection({
	kind,
	value,
	onChange,
}: {
	kind: CardSkinKind;
	value: string;
	onChange: (html: string) => void;
}) {
	const over = value.length > CARD_SKIN_LIMITS.maxHtmlBytes;
	const empty = value.trim() === "";
	return (
		<Section label="内容">
			<div className="flex flex-col gap-2 p-2.5">
				<fieldset
					aria-label="这种卡能引用的字段"
					className="flex max-h-28 min-w-0 flex-wrap gap-1 overflow-y-auto"
				>
					{CARD_SKIN_FIELDS[kind].map((f) => (
						<button
							key={f.path}
							type="button"
							data-bn="chip"
							title={`{${f.path}} —— ${f.label}`}
							onClick={() => onChange(appendField(value, f.path, f.type === "image"))}
							className="flex items-center gap-1 rounded-bn-pill border border-bn-border px-2 py-0.5 text-bn-2xs text-bn-text-secondary transition hover:border-bn-pink hover:text-bn-pink"
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
					ariaLabel="这个块的 HTML"
					placeholder="<div>{up.name}</div>"
				/>

				{empty ? (
					<ErrorNote size="sm">
						空的自定义块存不下去 —— 装包门判的是「清洗后什么都不剩」。
					</ErrorNote>
				) : over ? (
					<ErrorNote size="sm">
						{value.length} 字,超过上限 {CARD_SKIN_LIMITS.maxHtmlBytes} —— 这样存不下去。
					</ErrorNote>
				) : (
					<span className="text-right font-mono text-bn-2xs text-bn-text-tertiary">
						{value.length} / {CARD_SKIN_LIMITS.maxHtmlBytes}
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
function showIfOptions(kind: CardSkinKind): Array<{ value: string; label: string }> {
	const fields = CARD_SKIN_FIELDS[kind];
	const order = [...fields].sort((a, b) => Number(b.type === "bool") - Number(a.type === "bool"));
	return [
		{ value: "", label: "总是显示" },
		...order.map((f) => ({
			value: f.path,
			label: f.type === "bool" ? `${f.label}(${f.path})` : `非空时:${f.label}(${f.path})`,
		})),
	];
}

/**
 * 这个块的 CSS 能挂哪些选择器:`self`(整块)+ 内置块内部那几个部件。自定义块只有
 * `self` —— 里面的 HTML 是作者自己写的,挂点也就该由他自己在 HTML 里定。
 */
function blockHooks(kind: CardSkinKind, block: Card["blocks"][number]): Array<[string, string]> {
	const meta =
		block.kind === "builtin" ? CARD_SKIN_BUILTIN_BLOCKS[kind]?.[block.builtin] : undefined;
	return [[CARD_SKIN_SELF_HOOK, "整块"], ...Object.entries(meta?.hooks ?? {})];
}

/**
 * CSS 那一节:挂点清单 + 一个纯文本框。
 *
 * **先有文本框,再谈旋钮**(「编辑器 = 能力全集」):白名单里七十来条属性,能变成控件的
 * 只是其中一小把,少了这个框,作者就有一半的能力够不着。清洗与「削掉了什么」归 server
 * ——预览那栏已经把 warnings 逐条列出来了,这里只拦一条前端自己就能判的:超上限。
 *
 * 挂点列出来还能点一下补进去:挂点名是**对外 API**,而记不住名字是写卡片皮肤的第一道坎。
 */
function CssSection({
	label,
	hooksLabel,
	hooks,
	value,
	onChange,
}: {
	label: string;
	hooksLabel: string;
	hooks: Array<[string, string]>;
	value: string;
	onChange: (css: string) => void;
}) {
	const over = value.length > CARD_SKIN_LIMITS.maxCssBytes;
	return (
		<Section label="CSS">
			<div className="flex flex-col gap-2 p-2.5">
				{/* `<fieldset>` 只为给这排钮一个名字(同列定义那处)。 */}
				<fieldset aria-label={hooksLabel} className="flex min-w-0 flex-wrap gap-1">
					{hooks.map(([name, human]) => (
						<button
							key={name}
							type="button"
							data-bn="chip"
							title={`[data-bn="${name}"] —— ${human}`}
							onClick={() => onChange(appendRule(value, name))}
							className="flex items-center gap-1 rounded-bn-pill border border-bn-border px-2 py-0.5 text-bn-2xs text-bn-text-secondary transition hover:border-bn-pink hover:text-bn-pink"
						>
							<span>{shortLabel(human)}</span>
							<span className="font-mono text-bn-text-tertiary">{name}</span>
						</button>
					))}
				</fieldset>

				<TArea
					value={value}
					onChange={onChange}
					rows={8}
					mono
					ariaLabel={label}
					placeholder={'[data-bn="self"]{padding:12px 16px}'}
				/>

				{over ? (
					<ErrorNote size="sm">
						{value.length} 字,超过上限 {CARD_SKIN_LIMITS.maxCssBytes} —— 这样存不下去。
					</ErrorNote>
				) : (
					<span className="text-right font-mono text-bn-2xs text-bn-text-tertiary">
						{value.length} / {CARD_SKIN_LIMITS.maxCssBytes}
					</span>
				)}
			</div>
		</Section>
	);
}

/** 在末尾补一条空规则。已有内容时另起一行,不打断作者手里那一条。 */
function appendRule(css: string, hook: string): string {
	const rule = `[data-bn="${hook}"]{}`;
	return css.trim() === "" ? rule : `${css.replace(/\s+$/, "")}\n${rule}`;
}

/** 挂点的人话名摆在胶囊上时只取括号前那截 —— 「外框(渐变 / 背景图那一层)」太长。 */
function shortLabel(human: string): string {
	return human.split("(")[0]?.trim() || human;
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
	const px = "px" in value;
	return (
		<div className="flex items-center gap-1.5">
			<span className="w-11 shrink-0 font-mono text-bn-2xs text-bn-text-tertiary">第 {n} 列</span>
			{/* `<fieldset>` 只为给这组钮一个名字 —— 12 组「份 / px」长得一模一样,读屏器
			    (和测试)得知道念的是哪一列。 */}
			<fieldset aria-label={`第 ${n} 列的单位`} className="min-w-0">
				<Picker
					value={px ? "px" : "fr"}
					onChange={(u) => onChange(u === "px" ? { px: equalPx } : { fr: 1 })}
					options={[
						{ value: "fr", label: "份" },
						{ value: "px", label: "px" },
					]}
				/>
			</fieldset>
			<TNum
				value={px ? value.px : value.fr}
				min={px ? 1 : 1}
				max={px ? CARD_SKIN_LIMITS.width.max : CARD_SKIN_LIMITS.columns}
				step={px ? 0.01 : 1}
				width={72}
				ariaLabel={`第 ${n} 列的宽度`}
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
