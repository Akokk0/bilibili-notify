import type {
	ExtensionBlock,
	ExtensionButton,
	ExtensionRichText,
	ExtensionTableColumn,
	ExtensionTone,
} from "@bilibili-notify/contract";
import {
	Btn,
	ErrorNote,
	HintNote,
	Icon,
	KindMark,
	MonoChip,
	Pill,
	StatusDot,
	type StatusDotKind,
	type TriState,
	TriStateChip,
	WarnNote,
} from "@bilibili-notify/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Fragment, type ReactNode } from "react";
import { api } from "../../../services/api";
import { reasonOf } from "../shared";
import { extensionAddress } from "./address";
import { safeImage } from "./image";
import { CopyControl, TriStateLegend } from "./parts";
import { RichText } from "./rich-text";
import { extensionStatusKey } from "./view-query";

/**
 * 拓展交来的积木怎么画(ADR-0019 决策 20 / 27)—— 一组**封闭的**积木,拓展只说「画什么」。
 *
 * 版式照今天的桥页(决策 24「版式、交互、状态都照今天」):键值是抖音稿上那排小格、表格是
 * 桥的 bot 行、提示条是那三种提示盒、`copy` 是头卡上的地址行。每一块都画成**兄弟节点**、
 * 不自带外层间距,间距归摆放处(头卡正文是 `gap-2.5`,列表项卡里是 `gap-3`)。
 */

/** 「改设置」那种按钮要改的那一格(决策 22)。只挂在列表项上,由列表那一层接。 */
export type SetHandler = (set: Readonly<Record<string, string | number | boolean>>) => void;

export function Blocks({
	blocks,
	extensionId,
	legend = false,
	onSet,
	disabled = false,
	ruleBeforeTables = false,
}: {
	blocks: readonly ExtensionBlock[];
	extensionId: string;
	/**
	 * 有三态列的表要不要自己挂图例。页级积木要(没有别处可挂);列表项卡里的不要 ——
	 * 那一页的图例挂在列表头上,只挂一次(决策 27)。
	 */
	legend?: boolean;
	/** 接「改设置」的按钮。不给就不画那种按钮 —— 页级积木里本来就不许有。 */
	onSet?: SetHandler;
	/**
	 * 摆放处有一发写回还在路上:积木里的按钮一律按不动。列表那一节是**整份写回**的 ——
	 * 「改设置」的按钮在前一发没回来时再按,带的是旧名单,前一发的改动会被静默抹掉。
	 */
	disabled?: boolean;
	/**
	 * 每张表上面划一道发丝线 —— 列表项卡里,表是字段行底下另起的一段(今天桥卡上 token 行与
	 * 「它驮着的 bot」之间就是这一道)。页级积木不要:头卡正文里各块本来就是并列的。
	 */
	ruleBeforeTables?: boolean;
}) {
	return (
		<>
			{blocks.map((block, i) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: 积木是拓展整份交来的一列,没有别的身份;整份换掉时下标跟着换,不会串
				<Fragment key={i}>
					{ruleBeforeTables && block.type === "table" ? (
						<div data-table-rule className="h-px bg-bn-border-subtle" />
					) : null}
					<Block
						block={block}
						extensionId={extensionId}
						legend={legend}
						onSet={onSet}
						disabled={disabled}
					/>
				</Fragment>
			))}
		</>
	);
}

/**
 * 这几块积木里有没有带三态列的表 —— 有的话,列表那一节要在标题行挂一次图例(决策 27)。
 * 它与表格自己挂图例用的是同一个判据,两处各写一份的话迟早对不上。
 */
export function hasTriStateTable(blocks: readonly ExtensionBlock[] | undefined): boolean {
	return (blocks ?? []).some(
		(block) => block.type === "table" && block.columns.some((column) => column.kind === "tristate"),
	);
}

/** 某一种积木 —— 每种积木的组件收的就是它,字段不再一格格拆成 prop(拆了就得再抄一遍类型)。 */
type BlockOf<T extends ExtensionBlock["type"]> = Extract<ExtensionBlock, { type: T }>;

function Block({
	block,
	extensionId,
	legend,
	onSet,
	disabled,
}: {
	block: ExtensionBlock;
	extensionId: string;
	legend: boolean;
	onSet?: SetHandler;
	disabled: boolean;
}) {
	switch (block.type) {
		case "keyValue":
			return <KeyValueBlock block={block} extensionId={extensionId} />;
		case "table":
			return <TableBlock block={block} extensionId={extensionId} legend={legend} />;
		case "notice":
			return (
				<NoticeBlock block={block} extensionId={extensionId} onSet={onSet} disabled={disabled} />
			);
		case "copy":
			return (
				<CopyBlock
					label={block.label}
					value={typeof block.value === "string" ? block.value : extensionAddress(extensionId)}
					note={block.note}
					extensionId={extensionId}
				/>
			);
		case "qr":
			return <QrBlock block={block} extensionId={extensionId} />;
		case "button":
			return (
				<ButtonBlock button={block} extensionId={extensionId} onSet={onSet} disabled={disabled} />
			);
		default:
			// 面板比服务端旧(应用内升级那几秒)时可能碰上没见过的积木 —— 不画,别整页白屏。
			return null;
	}
}

// ── 语气 ─────────────────────────────────────────────────────────────────────

/** 语气 → 那颗点。`off` 走浅灰:「关着的」与「等着的」靠深浅分(StatusDot 那条)。 */
export const TONE_DOT: Record<ExtensionTone, StatusDotKind> = {
	ok: "ok",
	warn: "warn",
	error: "err",
	off: "off",
};

/** 语气 → 字色。与桥卡上那句状态同一套(已连接 / 对不上 / 没连上)。 */
export const TONE_TEXT: Record<ExtensionTone, string> = {
	ok: "text-bn-success-text",
	warn: "text-bn-warning-text",
	error: "text-bn-danger-text",
	off: "text-bn-text-tertiary",
};

// ── keyValue ────────────────────────────────────────────────────────────────

/** 几格就排几列,最多四列一行;窄屏两列。列数是版式,不是数据,不交给拓展。 */
function kvColumns(count: number): string {
	if (count <= 1) return "grid-cols-1";
	if (count === 2) return "grid-cols-2";
	if (count === 3) return "grid-cols-2 md:grid-cols-3";
	return "grid-cols-2 md:grid-cols-4";
}

function KeyValueBlock({
	block: { items },
	extensionId,
}: {
	block: BlockOf<"keyValue">;
	extensionId: string;
}) {
	return (
		<dl className={`grid gap-2.5 ${kvColumns(items.length)}`}>
			{items.map((item, i) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: 标签不保证不重名;整份交来的一排,按位置就是身份
				<div key={i} className="min-w-0 rounded-lg bg-bn-surface-muted px-2.5 py-2">
					<dt className="text-bn-2xs text-bn-text-tertiary">{item.label}</dt>
					<dd
						className={`mt-0.5 flex min-w-0 items-center gap-[5px] text-bn-sm font-bold ${
							item.tone ? TONE_TEXT[item.tone] : "text-bn-text-primary"
						}`}
					>
						{item.tone ? <StatusDot kind={TONE_DOT[item.tone]} /> : null}
						<span className="min-w-0 truncate">
							<RichText text={item.value} extensionId={extensionId} />
						</span>
					</dd>
				</div>
			))}
		</dl>
	);
}

// ── table ───────────────────────────────────────────────────────────────────

/** 视图里的三态词 → 面板的三态。认不出的按「还不知道」算 —— 缺席不是「不支持」。 */
const TRISTATE_OF: Readonly<Record<string, TriState>> = {
	yes: "supported",
	no: "unsupported",
	unknown: "unknown",
};

/**
 * 一行里的几段:连着的三态列并成一段(它们在一个自己的 flex 里横排、间距比别的格宽 ——
 * 今天 bot 行上那排能力就是这么排的),其余每列一段。
 */
type RowSegment =
	| { kind: "cell"; column: ExtensionTableColumn; index: number }
	| { kind: "tristates"; columns: { label: string; index: number }[] };

function segmentsOf(columns: readonly ExtensionTableColumn[]): RowSegment[] {
	const segments: RowSegment[] = [];
	columns.forEach((column, index) => {
		const last = segments[segments.length - 1];
		if (column.kind === "tristate") {
			if (last?.kind === "tristates") last.columns.push({ label: column.label, index });
			else segments.push({ kind: "tristates", columns: [{ label: column.label, index }] });
			return;
		}
		segments.push({ kind: "cell", column, index });
	});
	return segments;
}

function TableBlock({
	block: { title, count, empty, columns, rows },
	extensionId,
	legend,
}: {
	block: BlockOf<"table">;
	extensionId: string;
	legend: boolean;
}) {
	const withLegend = legend && columns.some((column) => column.kind === "tristate");
	const segments = segmentsOf(columns);
	return (
		<div className="flex flex-col gap-3">
			{title || count || withLegend ? (
				<div className="flex flex-wrap items-center gap-2">
					{title ? (
						<span className="text-bn-xs font-bold text-bn-text-tertiary">{title}</span>
					) : null}
					{count ? (
						<Pill subtle size="sm">
							{rows.length}
						</Pill>
					) : null}
					{withLegend ? (
						<span className="ml-auto">
							<TriStateLegend />
						</span>
					) : null}
				</div>
			) : null}
			{rows.length === 0 ? (
				empty ? (
					<span className="text-bn-xs text-bn-text-tertiary">
						<RichText text={empty} extensionId={extensionId} />
					</span>
				) : null
			) : (
				<div className="flex flex-col divide-y divide-bn-border-subtle">
					{rows.map((row, r) => (
						<div
							// biome-ignore lint/suspicious/noArrayIndexKey: 行是拓展整份交来的,没有自带身份
							key={r}
							className="flex flex-wrap items-center gap-x-3 gap-y-1.5 py-[9px]"
						>
							{segments.map((segment) =>
								segment.kind === "tristates" ? (
									<div
										key={`t${segment.columns[0]?.index}`}
										className="flex flex-wrap items-center gap-x-4 gap-y-1.5"
									>
										{segment.columns.map(({ label, index }) => (
											<TriStateChip
												key={index}
												label={label}
												state={TRISTATE_OF[String(row[index])] ?? "unknown"}
											/>
										))}
									</div>
								) : (
									<TableCell
										key={segment.index}
										column={segment.column}
										cell={row[segment.index]}
									/>
								),
							)}
						</div>
					))}
				</div>
			)}
		</div>
	);
}

function TableCell({ column, cell }: { column: ExtensionTableColumn; cell: unknown }) {
	switch (column.kind) {
		case "icon": {
			const icon = (typeof cell === "object" && cell !== null ? cell : {}) as {
				image?: unknown;
				fallback?: unknown;
			};
			return (
				<span className="flex shrink-0">
					<KindMark
						text={typeof icon.fallback === "string" ? icon.fallback : ""}
						size={26}
						logo={safeImage(icon.image)}
					/>
				</span>
			);
		}
		case "text": {
			const bag = (typeof cell === "object" && cell !== null ? cell : {}) as {
				text?: unknown;
				sub?: unknown;
			};
			// 宿主校验过形状;这里只防「不是字」的东西被当成 React 子节点画 —— 那会把整页带走。
			const text = typeof cell === "string" ? cell : typeof bag.text === "string" ? bag.text : "";
			const sub = typeof cell === "string" || typeof bag.sub !== "string" ? undefined : bag.sub;
			return (
				// 定宽是版式的承重件:多行排下来,后面的三态记号得在同一条竖线上起排。宽度是几何量,
				// 留在行内。
				<div className="min-w-0" style={column.width ? { width: column.width } : undefined}>
					<div className="truncate text-bn-sm font-bold text-bn-text-primary">{text}</div>
					{sub ? (
						<div className="mt-px truncate font-mono text-bn-2xs text-bn-text-tertiary">{sub}</div>
					) : null}
				</div>
			);
		}
		case "mono":
			return (
				<span className="min-w-0 truncate font-mono text-bn-xs text-bn-text-secondary">
					{typeof cell === "string" ? cell : ""}
				</span>
			);
		default:
			return null;
	}
}

// ── notice ──────────────────────────────────────────────────────────────────

function NoticeBlock({
	block: { tone, text, button },
	extensionId,
	onSet,
	disabled,
}: {
	block: BlockOf<"notice">;
	extensionId: string;
	onSet?: SetHandler;
	disabled: boolean;
}) {
	const control = useButtonControl(button, extensionId, onSet, disabled);
	const trailing = control.node ? (
		<span className="shrink-0 self-center">{control.node}</span>
	) : null;
	/** 带按钮时正文占满、按钮贴右;不带就只有正文。 */
	const withTrailing = (body: ReactNode) =>
		trailing ? (
			<>
				<div className="min-w-0 flex-1">{body}</div>
				{trailing}
			</>
		) : (
			body
		);
	const note =
		tone === "info" ? (
			<HintNote
				className={trailing ? "flex items-center gap-[9px] leading-[1.65]" : "leading-[1.65]"}
			>
				{withTrailing(
					<RichText text={text} extensionId={extensionId} monoClassName="text-bn-text-secondary" />,
				)}
			</HintNote>
		) : tone === "warn" ? (
			<WarnNote size="sm" icon={<Icon.warning size={15} />} className="leading-[1.7]">
				{trailing ? (
					<div className="flex gap-[9px]">
						{withTrailing(<RichText text={text} extensionId={extensionId} />)}
					</div>
				) : (
					<RichText text={text} extensionId={extensionId} />
				)}
			</WarnNote>
		) : (
			<ErrorNote size="sm" className={trailing ? "flex items-center gap-[9px]" : undefined}>
				{withTrailing(<RichText text={text} extensionId={extensionId} />)}
			</ErrorNote>
		);
	// 按钮没成的原因摆在提示条**底下**,不塞进提示条肚子里 —— 黄盒里再套一个红盒读不成话。
	return (
		<>
			{note}
			{control.error}
		</>
	);
}

// ── copy ────────────────────────────────────────────────────────────────────

/** 今天头卡上那一行:名字 + 值 + 复制 | 一句说明。 */
function CopyBlock({
	label,
	value,
	note,
	extensionId,
}: {
	label: string;
	value: string;
	note?: ExtensionRichText;
	extensionId: string;
}) {
	return (
		<div className="flex flex-wrap items-center gap-x-5 gap-y-2 py-0.5">
			<div className="flex items-center gap-[7px] text-bn-xs text-bn-text-secondary">
				<span className="text-bn-text-tertiary">{label}</span>
				<MonoChip>{value}</MonoChip>
				<CopyControl iconOnly label={`复制 ${label}`} text={value} />
			</div>
			{note ? (
				<>
					<span className="h-4 w-px bg-bn-border-subtle" />
					<span className="text-bn-xs text-bn-text-tertiary">
						<RichText
							text={note}
							extensionId={extensionId}
							boldClassName="text-bn-text-secondary"
						/>
					</span>
				</>
			) : null}
		</div>
	);
}

// ── qr ──────────────────────────────────────────────────────────────────────

/** 与系统页 B 站登录那张二维码卡同一副样子 —— 任何拓展的扫码都该与 BN 自己的长一样。 */
function QrBlock({
	block: { image, caption },
	extensionId,
}: {
	block: BlockOf<"qr">;
	extensionId: string;
}) {
	const src = safeImage(image);
	return (
		<div className="flex flex-col items-center gap-3 rounded-lg border border-bn-border bg-bn-surface/55 p-6">
			{src ? (
				<img
					alt="二维码"
					className="h-56 w-56 rounded-sm bg-bn-surface p-2 shadow-bn-card"
					src={src}
				/>
			) : null}
			{caption ? (
				<div className="text-bn-sm text-bn-text-secondary">
					<RichText text={caption} extensionId={extensionId} />
				</div>
			) : null}
		</div>
	);
}

// ── 按钮 ─────────────────────────────────────────────────────────────────────

function ButtonBlock({
	button,
	extensionId,
	onSet,
	disabled,
}: {
	button: ExtensionButton;
	extensionId: string;
	onSet?: SetHandler;
	disabled: boolean;
}) {
	const control = useButtonControl(button, extensionId, onSet, disabled);
	if (!control.node) return null;
	return (
		<div className="flex flex-col items-start gap-1.5">
			{control.node}
			{control.error}
		</div>
	);
}

/** 调拓展的那种按钮(决策 22)。 */
type ActionButton = Extract<ExtensionButton, { action: string }>;

/**
 * 调拓展的那一发:`POST /api/ext/:id/actions/:name`,只走 `/api/…`、吃面板会话鉴权(决策 23 那条
 * 红线在服务端守着)。成了就重读状态 —— 拓展多半会在动作里改自己的状态,等它喊
 * `statusChanged` 也行,但主人按完那一下就该看见结果。
 *
 * 积木里的按钮与列表项卡头上的按钮**共用这一份**:两处各写一份的话,「回了 200 却说没成」
 * 那条迟早只被记起一半。
 */
export function useExtensionAction(extensionId: string) {
	const qc = useQueryClient();
	return useMutation({
		// 按的是哪一颗走 variables,不从闭包里拿 —— 失败那句要说出**这一发**的名字。
		mutationFn: async (button: ActionButton) => {
			const name = button.action;
			const answer = await api.post<{ ok?: boolean; err?: string } | undefined>(
				`/api/ext/${extensionId}/actions/${encodeURIComponent(name)}`,
			);
			// 服务端的失败都带非 2xx(404 / 501 / 504 / 500),这一条防的是哪天回了 200 却说没成。
			if (answer?.ok === false) throw new Error(answer.err ?? `动作 ${name} 没成`);
			return answer;
		},
		onSuccess: () => qc.invalidateQueries({ queryKey: extensionStatusKey(extensionId) }),
	});
}

/**
 * 那一发没成时那句话。
 *
 * 🔴 失败的原因不许吞:服务端那句原话(没声明 / 代码没接 / 超时 / 拓展自己抛的)是主人唯一能
 * 照着做的线索,换成一句「操作失败」等于让人对着黑盒再按一下。
 */
export function ActionFailure({ label, error }: { label: string; error: unknown }) {
	return (
		<ErrorNote size="sm">
			「{label}」没成:{reasonOf(error)}
		</ErrorNote>
	);
}

/**
 * 一颗按钮连同它「没成」时那句话。两种按钮(决策 22):
 * - **调拓展**:见 {@link useExtensionAction}。
 * - **改设置**:交给列表那一层(它知道是哪一项);没人接就不画。
 */
function useButtonControl(
	button: ExtensionButton | undefined,
	extensionId: string,
	onSet: SetHandler | undefined,
	disabled: boolean,
): { node: ReactNode; error: ReactNode } {
	const run = useExtensionAction(extensionId);

	if (!button) return { node: null, error: null };
	if ("action" in button) {
		return {
			node: (
				<Btn
					variant="outline"
					size="sm"
					disabled={disabled || run.isPending}
					onClick={() => run.mutate(button)}
				>
					{button.label}
				</Btn>
			),
			error: run.isError ? <ActionFailure label={button.label} error={run.error} /> : null,
		};
	}
	if (!onSet) return { node: null, error: null };
	return {
		node: (
			<Btn variant="outline" size="sm" disabled={disabled} onClick={() => onSet(button.set)}>
				{button.label}
			</Btn>
		),
		error: null,
	};
}
