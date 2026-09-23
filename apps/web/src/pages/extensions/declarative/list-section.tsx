import type {
	ExtensionDTO,
	ExtensionItemView,
	ExtensionListField,
	ExtensionScalarField,
	ExtensionSettingsOp,
	ExtensionTone,
} from "@bilibili-notify/contract";
import {
	Btn,
	ConfirmDialog,
	EmptyNote,
	ErrorNote,
	GlassBox,
	Icon,
	KindMark,
	Pill,
	StatusDot,
} from "@bilibili-notify/ui";
import { useState } from "react";
import { reasonOf, SectionCaption } from "../shared";
import {
	ActionFailure,
	Blocks,
	hasTriStateTable,
	type SetHandler,
	TONE_DOT,
	TONE_TEXT,
	useExtensionAction,
} from "./blocks";
import {
	declaredPatchOf,
	dialogFieldsOf,
	dialogIssuesOf,
	isPaused,
	isRecord,
	isSecretSub,
	itemLabelOf,
	itemsOf,
	type ListItem,
	markOf,
	plainValueOf,
	rowFieldsOf,
	settingsValuesOf,
	titleOf,
	toggleDefaultOf,
	writeFailureOf,
	writeReasonOf,
} from "./list-items";
import { ItemDialog } from "./list-new-item";
import {
	CopyControl,
	MissingSecretNote,
	RegenerateButton,
	SecretChip,
	TriStateLegend,
} from "./parts";
import { RichText } from "./rich-text";
import { maskedOf, newHexSecret } from "./secret";
import { type SettingsWrite, useExtensionSettings, useSettingsWrite } from "./settings-query";
import { isNotFound, isRunning, liveViewOf, useExtensionView } from "./view-query";

/**
 * 视图此刻作不作数。
 * - `off`:拓展关着 —— 没有视图可问(问了也是 404)。
 * - `unknown`:开着却没跑起来,或者状态那一口出错(不是 404)—— 该有的东西拿不到。
 * - `live`:跑着。视图可能还没到,也可能从来没交过(404):那是「没有」,不是出错。
 */
type ViewState = "off" | "unknown" | "live";

/** 卡上那句状态。 */
interface CardStatus {
	tone: ExtensionTone;
	text: string;
}

/**
 * 那句状态从哪来,**先中先得**:
 * 1. 停用的项由 BN 盖成「已停用」,拓展报什么都不算(决策 26)—— 那是主人自己拨的,最具体;
 * 2. 拓展关着 → 「拓展关着」(决策 32);
 * 3. 开着却没跑起来 / 状态那一口出错 → 「状态未知」—— 面板不替拓展猜(决策 24 的五处之一);
 * 4. 视图里这一项报了什么就是什么;没报就不说 —— 一句编出来的状态比没有更糟。
 */
function cardStatusOf(
	paused: boolean,
	viewState: ViewState,
	itemView: ExtensionItemView | undefined,
): CardStatus | undefined {
	if (paused) return { tone: "off", text: "已停用" };
	if (viewState === "off") return { tone: "off", text: "拓展关着" };
	if (viewState === "unknown") return { tone: "off", text: "状态未知" };
	return itemView?.status;
}

/** 语气 → 卡角那抹光。没有状态的走中性灰,与「关着的」同一档。 */
const TONE_ACCENT: Record<ExtensionTone, string> = {
	ok: "var(--color-bn-success)",
	warn: "var(--color-bn-warning)",
	error: "var(--color-bn-danger)",
	off: "var(--color-bn-inactive)",
};

/** 要先问一句的那两件事:删掉这一项 / 换一把钥匙。 */
type Confirming =
	| { kind: "remove"; item: ListItem }
	| { kind: "regenerate"; item: ListItem; sub: ExtensionScalarField };

/** 开着的那个弹窗:新建一项,或编辑某一项(决策 37)。 */
type Dialog = { kind: "new" } | { kind: "edit"; item: ListItem };

/** 刚生成、已经存下的那一把:它现在的遮挡(对得上才亮)与明文。 */
interface Revealed {
	masked: string;
	text: string;
}

/**
 * 这一节的一发写:照读到的版本号、做哪几步;重新生成的那一发再带上新钥匙的明文 —— 写成之后卡上
 * 亮一次(决策 38:那一刻明文在面板手里)。
 */
interface ListWrite extends SettingsWrite {
	reveal?: { id: string; key: string; text: string };
}

/** 一张卡要回头找这一节做的事 —— 每一件都是一发写。 */
interface CardActions {
	edit(item: ListItem): void;
	toggle(item: ListItem): void;
	set(item: ListItem, set: Readonly<Record<string, string | number | boolean>>): void;
	regenerate(item: ListItem, sub: ExtensionScalarField): void;
	remove(item: ListItem): void;
	/** 刚生成、还亮着的明文 —— 没有(或已经不是存着的那一把)就是 `undefined`。 */
	revealed(item: ListItem, sub: ExtensionScalarField): string | undefined;
	/**
	 * 上一发写还在路上。
	 *
	 * 🔴 每一发都带着读到的版本号 —— 前一发没回来时点第二下,第二发拿的还是写之前的版本号,
	 * 服务端回 409,第二下白按。所以这一节的钮串行:写的期间一律点不动,确认框也不接第二下。
	 * 另一半在 `useSettingsWrite`:写后的那份在这一发结束**之前**就进了缓存 —— 钮松开的那一刻,
	 * 版本号已经是写后的。
	 */
	busy: boolean;
}

/** 明文那张表的键:哪一项的哪一格。id 是存着的数据,不拿它当普通对象的键。 */
const revealKey = (id: string, key: string) => JSON.stringify([id, key]);

/**
 * 一格 `list` 设置项那一节(ADR-0019 决策 21 / 26 / 29 / 32):标题行 + 每项一张卡 + 新建弹窗 +
 * 删除 / 重新生成的确认。
 *
 * 版式照今天手写的桥页(决策 24「版式、交互、状态都照今天」):桥迁过来之后,这一节画出来的
 * 就该是今天那一页。卡上每一块归三处之一 —— **清单**声明的(标题、方块、字段行、停用 / 启用)、
 * **视图**交来的(状态、药丸、副标题、按钮、积木)、**BN** 自己画的(删除、图例、三句盖章)。
 */
export function ListSection({ ext, field }: { ext: ExtensionDTO; field: ExtensionListField }) {
	const [dialog, setDialog] = useState<Dialog | null>(null);
	/** 两件要确认的事共用底下那**一个**确认框 —— 谁在等,由它说了算。 */
	const [confirming, setConfirming] = useState<Confirming | null>(null);
	/** 刚生成、已经存下的明文(决策 38)。只活在这一页上,离开就没了。 */
	const [revealed, setRevealed] = useState<ReadonlyMap<string, Revealed>>(() => new Map());

	// 列表住拓展自己的设置里(`/api/ext/:id/settings`)。与状态分开取:拓展没跑起来时它照样在,
	// 「配了但没连上」正是要看见的。
	const settings = useExtensionSettings(ext.id);
	const running = isRunning(ext);
	const view = useExtensionView(ext.id, running);

	/**
	 * 写。只说这一下改了什么(`add` / `update` / `remove`),带着读到的版本号 —— 服务端**现读**,
	 * 重新生成的钥匙下一次连接就按新的判。写成之后回应已经进了缓存(`useSettingsWrite`),这里只收
	 * 弹窗、确认框,再把重新生成的那一把亮出来。
	 */
	const write = useSettingsWrite<ListWrite>(ext.id, (written, vars) => {
		setDialog(null);
		setConfirming(null);
		const { reveal } = vars;
		if (!reveal) return;
		const saved = itemsOf(settingsValuesOf(written), field.key).find(
			(item) => item.id === reveal.id,
		);
		const masked = saved ? maskedOf(saved[reveal.key]) : undefined;
		if (masked === undefined) return;
		setRevealed((prev) =>
			new Map(prev).set(revealKey(reveal.id, reveal.key), { masked, text: reveal.text }),
		);
	});

	const items = itemsOf(settingsValuesOf(settings.data), field.key);
	const itemLabel = itemLabelOf(field);

	const viewState: ViewState = !ext.enabled
		? "off"
		: !running || (view.isError && !isNotFound(view.error))
			? "unknown"
			: "live";
	// 出错之后 react-query 还攥着上一份 —— 旧的那份不作数,一样都不画(`liveViewOf`)。
	const rawViews = liveViewOf(running, view)?.items?.[field.key];
	const views = isRecord(rawViews)
		? (rawViews as Readonly<Record<string, ExtensionItemView>>)
		: undefined;
	const viewOf = (item: ListItem) => views?.[item.id];
	const legend = items.some((item) => {
		const itemView = viewOf(item);
		return hasTriStateTable(itemView?.lead) || hasTriStateTable(itemView?.blocks);
	});

	/**
	 * 没写进去的原因。
	 *
	 * 🔴 这一节的每一次写(停用 / 换钥匙 / 改设置 / 新建 / 编辑 / 删除)都落在这一发上,而失败时界面
	 * **自己会退回原样** —— 按钮弹回去、确认框留在原地、弹窗不关。三种症状看上去都是「点了
	 * 没用」,而真正的原因(只读盘 / 401 / 版本号对不上 / 校验不过)就在那条响应里。
	 */
	const writeError = write.isError ? writeFailureOf(write.error, field, items) : null;
	const busy = write.isPending;
	/** 照读到的那份写。还没读到(按钮还没画出来)时什么都不发。 */
	const send = (ops: ExtensionSettingsOp[], reveal?: ListWrite["reveal"]) => {
		const revision = settings.data?.revision;
		if (revision === undefined) return;
		write.mutate({ revision, ops, ...(reveal ? { reveal } : {}) });
	};
	const update = (id: string, values: Record<string, unknown>) =>
		send([{ op: "update", list: field.key, id, values }]);
	/** 开一个框之前把上一发的错收掉 —— 那句说的是上一发,摆进新框里会被当成这一下的。 */
	const open = (next: () => void) => {
		write.reset();
		next();
	};
	/**
	 * 换一把钥匙:新的在这一刻生成,写成之后卡上亮一次(存下之后浏览器只有头尾,不亮的话主人
	 * 拿不到它)。
	 */
	const regenerateNow = (item: ListItem, sub: ExtensionScalarField) => {
		const text = newHexSecret();
		send([{ op: "update", list: field.key, id: item.id, values: { [sub.key]: text } }], {
			id: item.id,
			key: sub.key,
			text,
		});
	};

	const actions: CardActions = {
		edit: (item) => open(() => setDialog({ kind: "edit", item })),
		toggle: (item) => {
			if (field.toggle !== undefined) update(item.id, { [field.toggle]: isPaused(field, item) });
		},
		set: (item, set) => {
			const values = declaredPatchOf(field, set);
			if (Object.keys(values).length > 0) update(item.id, values);
		},
		/*
		 * 换钥匙撤不回,所以**有钥匙可换的时候先问一句**:服务端现读,正用着它的那一头当场断开,
		 * 要它连回来得有人把新的填一遍。空着的**不问**:没有旧钥匙可作废(脱敏备份恢复回来的常态
		 * 就是空的),它恰恰是最该顺手按下去的那一颗。
		 */
		regenerate: (item, sub) => {
			if (maskedOf(item[sub.key]) !== undefined) {
				open(() => setConfirming({ kind: "regenerate", item, sub }));
				return;
			}
			regenerateNow(item, sub);
		},
		remove: (item) => open(() => setConfirming({ kind: "remove", item })),
		/*
		 * 🔴 亮着的那一把得**还是存着的那一把**:别处(另一个标签页)又换了一次,这里还亮着旧的明文
		 * 的话,主人粘过去的是作废的那一把。现在下发的遮挡与存下那一刻的对不上,就收起来。
		 */
		revealed: (item, sub) => {
			const shown = revealed.get(revealKey(item.id, sub.key));
			return shown && shown.masked === maskedOf(item[sub.key]) ? shown.text : undefined;
		},
		busy,
	};

	// 还在读:什么都不画 —— 先画空态再换成卡,等于闪一下「还没有」。
	if (settings.isPending) return null;
	/*
	 * 🔴 **「读不到」不许画成「没有」**:名单读不出来(401 / 服务端炸了 / 断网)时 `itemsOf`
	 * 交出的也是空数组,而空态那一屏请人建一条 —— 全是假话,主人照着建完才发现原来那几条
	 * 又回来了。
	 */
	if (settings.isError) {
		return (
			<ErrorNote size="sm">
				读不到{field.label}:{reasonOf(settings.error)}
			</ErrorNote>
		);
	}

	const confirmation = confirming ? confirmationOf(confirming, field) : null;
	const dialogKeys = new Set(
		dialogFieldsOf(field, dialog?.kind === "edit" ? "edit" : "new").map((sub) => sub.key),
	);
	// 弹窗里:落得到某一格的放那一格底下,落不到的(与 409、别的失败)整条说在弹窗里。
	const dialogIssues = write.isError ? dialogIssuesOf(write.error, field, dialogKeys, items) : null;
	const dialogError = write.isError
		? dialogIssues
			? dialogIssues.rest.join(";") || null
			: writeReasonOf(write.error)
		: null;

	return (
		<>
			{/*
			 * 标题行 —— 小标题 · 发丝线 · 图例 · 新建。只在有卡可看时才有:一条都没有那一屏自己
			 * 带着开工的钮。**拓展关着也在**(决策 32):设置只是存着的数据,「装好 → 填 → 启用」。
			 */}
			{items.length > 0 ? (
				<div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-2">
					<SectionCaption>{field.label}</SectionCaption>
					<span className="h-px min-w-4 flex-1 bg-bn-border-subtle" />
					{legend ? <TriStateLegend /> : null}
					<Btn
						size="sm"
						disabled={busy}
						icon={<Icon.plus size={13} />}
						onClick={() => open(() => setDialog({ kind: "new" }))}
					>
						新建{itemLabel}
					</Btn>
				</div>
			) : null}

			{writeError ? <ErrorNote size="sm">这次没写进去:{writeError}</ErrorNote> : null}

			{items.length === 0 ? (
				<ListEmpty field={field} busy={busy} onAdd={() => open(() => setDialog({ kind: "new" }))} />
			) : null}

			{items.map((item) => (
				<ListCard
					key={item.id}
					extensionId={ext.id}
					field={field}
					item={item}
					itemView={viewOf(item)}
					status={cardStatusOf(isPaused(field, item), viewState, viewOf(item))}
					actions={actions}
				/>
			))}

			{dialog ? (
				<ItemDialog
					// 换一个弹窗就是一份新草稿 —— 编辑完这一项接着编辑那一项,不许带着上一份的字。
					key={dialog.kind === "edit" ? `edit:${dialog.item.id}` : "new"}
					extensionId={ext.id}
					field={field}
					item={dialog.kind === "edit" ? dialog.item : undefined}
					error={dialogError}
					fieldErrors={dialogIssues?.byField}
					saving={busy}
					onCancel={() => setDialog(null)}
					onEdit={() => {
						if (write.isError) write.reset();
					}}
					onSubmit={(values) => {
						if (dialog.kind === "edit") {
							update(dialog.item.id, values);
							return;
						}
						// 生成的那一格由弹窗带过来 —— **屏幕上显示的就是存下去的那一把**。id 由服务端
						// 生成(决策 29),不在这里;停用那一格弹窗里没有,补清单的默认值。
						send([
							{
								op: "add",
								list: field.key,
								item: {
									...values,
									...(field.toggle !== undefined ? { [field.toggle]: toggleDefaultOf(field) } : {}),
								},
							},
						]);
					}}
				/>
			) : null}

			{confirming && confirmation ? (
				<ConfirmDialog
					title={confirmation.title}
					message={
						<>
							{confirmation.body}
							{/* 事情没成时框留在原地 —— 不说原因就是让人对着黑盒按第二下。 */}
							{writeError ? (
								<ErrorNote size="sm" className="mt-2.5">
									{confirmation.errorLead}:{writeError}
								</ErrorNote>
							) : null}
						</>
					}
					confirmLabel={busy ? confirmation.busyLabel : confirmation.label}
					danger
					onConfirm={() => {
						if (busy) return;
						if (confirming.kind === "remove") {
							send([{ op: "remove", list: field.key, id: confirming.item.id }]);
						} else {
							// 新钥匙在按下「重新生成」这一刻才生成 —— 框开着时它还不存在,也就不会有
							// 「框里一把、存下去另一把」。
							regenerateNow(confirming.item, confirming.sub);
						}
					}}
					onCancel={() => setConfirming(null)}
				/>
			) : null}
		</>
	);
}

/**
 * 那两个确认框的**全部差别**:几句话。除此之外它们逐行同形 —— 都是 `danger`、写不进去时都把
 * 原因摆在正文尾巴上(框留在原地)、写的期间都不接第二下。
 *
 * 「重新生成」那句是**通用说法**(决策 24 的五处之一):BN 不知道那把钥匙对面是插件还是别的
 * 什么,只知道「正用着它的那一头」。删除那句「删了会怎样」由清单的 `removeWarning` 交 ——
 * 那是安全提示,通用说法说不出来(决策 29)。
 */
function confirmationOf(confirming: Confirming, field: ExtensionListField) {
	const title = titleOf(field, confirming.item);
	if (confirming.kind === "remove") {
		return {
			title: `删掉这条${itemLabelOf(field)}?`,
			body: field.removeWarning
				? `「${title}」删掉之后,${field.removeWarning}`
				: `「${title}」连同它的设置一起删掉。`,
			errorLead: "删不掉",
			label: "删除",
			busyLabel: "删除中…",
		};
	}
	const label = confirming.sub.label;
	return {
		title: `重新生成${label}?`,
		body: `「${title}」的旧 ${label} 立刻作废 —— 正用着它的那一头会当场断开,得把新的复制过去重新填。`,
		// 写不进去时那句得贴着这一下说 —— 通用的「保存失败」等于让人对着黑盒按第二下。
		errorLead: "换不了",
		label: "重新生成",
		busyLabel: "重新生成中…",
	};
}

// ── 空态 ─────────────────────────────────────────────────────────────────────

/**
 * 一条都没有 —— 讲的是接下来干什么,不是「这里是空的」。「干什么」那句由清单的 `description`
 * 交(决策 29):BN 说不出「把 token 填进插件」这种话,那是拓展自己的事。
 */
function ListEmpty({
	field,
	busy,
	onAdd,
}: {
	field: ExtensionListField;
	busy: boolean;
	onAdd: () => void;
}) {
	return (
		<EmptyNote>
			<div data-list-empty className="flex flex-col items-center">
				<span className="text-bn-sm text-bn-text-secondary">还没有{field.label}。</span>
				{field.description ? (
					<span className="mt-[5px] text-bn-xs leading-[1.7] text-bn-text-tertiary">
						{field.description}
					</span>
				) : null}
				<div className="mt-3.5">
					<Btn
						variant="primary"
						size="md"
						disabled={busy}
						icon={<Icon.plus size={13} />}
						onClick={onAdd}
					>
						新建第一条{itemLabelOf(field)}
					</Btn>
				</div>
			</div>
		</EmptyNote>
	);
}

// ── 一张卡 ───────────────────────────────────────────────────────────────────

/**
 * 一项一张卡。拓展关着 / 没跑起来时没有视图:卡上只剩 BN 自己画的那几块(标题、方块、字段行、
 * 停用 / 启用、删除)—— 照常能改(决策 32)。
 *
 * 🔴 方块印的是**设置里那一格**,不是拓展报上来的什么:两者对不上正是视图要说的事(桥的
 * 「连上了,但对不上」),方块替它抹平就看不见了。
 */
function ListCard({
	extensionId,
	field,
	item,
	itemView,
	status,
	actions,
}: {
	extensionId: string;
	field: ExtensionListField;
	item: ListItem;
	itemView: ExtensionItemView | undefined;
	status: CardStatus | undefined;
	actions: CardActions;
}) {
	// 卡头上「调拓展」的按钮共用一发:同一时刻只按得动一颗,失败那句点的是按下去的那一颗。
	const run = useExtensionAction(extensionId);
	const title = titleOf(field, item);
	const mark = markOf(field, item);
	const paused = isPaused(field, item);
	const { busy } = actions;
	const onSet: SetHandler = (set) => actions.set(item, set);
	// 弹窗里一格都填不了(全是密钥 / 生成的、停用那一格)的列表没有这颗钮 —— 开出来是个空框。
	const editable = dialogFieldsOf(field, "edit").length > 0;

	return (
		<div data-list-card={item.id}>
			<GlassBox
				accent={TONE_ACCENT[status?.tone ?? "off"]}
				mark={
					mark ? (
						<KindMark
							text={mark.value}
							size={32}
							label={`${mark.value} ${itemLabelOf(field)}`}
							logo={mark.image}
						/>
					) : undefined
				}
				title={title}
				aside={
					<>
						{itemView?.pill ? (
							<Pill subtle size="sm" color="var(--color-bn-inactive)">
								{itemView.pill}
							</Pill>
						) : null}
						{status ? <StatusLine status={status} /> : null}
					</>
				}
				subtitle={
					itemView?.subtitle ? (
						<span className="text-bn-text-tertiary">
							<RichText text={itemView.subtitle} extensionId={extensionId} />
						</span>
					) : undefined
				}
				right={
					<div className="flex shrink-0 items-center gap-2">
						{(itemView?.buttons ?? []).map((button, i) => (
							<Btn
								// biome-ignore lint/suspicious/noArrayIndexKey: 按钮是视图整份交来的一排,没有别的身份
								key={i}
								variant="outline"
								size="sm"
								disabled={busy || run.isPending}
								onClick={() => ("action" in button ? run.mutate(button) : onSet(button.set))}
							>
								{button.label}
							</Btn>
						))}
						{editable ? (
							<Btn
								variant="outline"
								size="sm"
								disabled={busy}
								aria-label={`编辑 ${title}`}
								onClick={() => actions.edit(item)}
							>
								编辑
							</Btn>
						) : null}
						{field.toggle !== undefined ? (
							<Btn
								variant="outline"
								size="sm"
								disabled={busy}
								aria-label={`${paused ? "启用" : "停用"} ${title}`}
								onClick={() => actions.toggle(item)}
							>
								{paused ? "启用" : "停用"}
							</Btn>
						) : null}
						<Btn
							variant="danger-outline"
							size="sm"
							disabled={busy}
							aria-label={`删除 ${title}`}
							onClick={() => actions.remove(item)}
						>
							删除
						</Btn>
					</div>
				}
			>
				<div className="flex flex-col gap-3">
					{run.isError && run.variables ? (
						<ActionFailure label={run.variables.label} error={run.error} />
					) : null}
					{itemView?.lead ? (
						<Blocks
							blocks={itemView.lead}
							extensionId={extensionId}
							onSet={onSet}
							disabled={busy}
						/>
					) : null}
					{rowFieldsOf(field).map((sub) => (
						<FieldRow
							key={sub.key}
							sub={sub}
							item={item}
							title={title}
							itemLabel={itemLabelOf(field)}
							busy={busy}
							revealed={actions.revealed(item, sub)}
							onRegenerate={() => actions.regenerate(item, sub)}
						/>
					))}
					{itemView?.blocks ? (
						<Blocks
							blocks={itemView.blocks}
							extensionId={extensionId}
							onSet={onSet}
							disabled={busy}
							ruleBeforeTables
						/>
					) : null}
				</div>
			</GlassBox>
		</div>
	);
}

/** 卡上那句状态:点 + 字,颜色跟语气走 —— 与今天桥卡上的「已连接 / 没连上」同一副样子。 */
function StatusLine({ status }: { status: CardStatus }) {
	return (
		<span
			data-list-status
			className={`inline-flex items-center gap-[5px] text-bn-xs font-bold ${TONE_TEXT[status.tone]}`}
		>
			<StatusDot kind={TONE_DOT[status.tone]} />
			{status.text}
		</span>
	);
}

// ── 字段行 ───────────────────────────────────────────────────────────────────

/**
 * 卡正文里一格一行(标题 / 方块 / 停用那几格不在这儿)。只读 —— 要改的那几件各有自己的钮(编辑、
 * 换钥匙、停用、视图给的「改成 ×」)。
 */
function FieldRow({
	sub,
	item,
	title,
	itemLabel,
	busy,
	revealed,
	onRegenerate,
}: {
	sub: ExtensionScalarField;
	item: ListItem;
	title: string;
	itemLabel: string;
	busy: boolean;
	/** 刚生成、已经存下的那一把的明文 —— 只有它能复制。 */
	revealed: string | undefined;
	onRegenerate: () => void;
}) {
	if (isSecretSub(sub)) {
		const masked = maskedOf(item[sub.key]);
		const which = `${title} 的 ${sub.label}`;
		const generated = sub.type === "string" && sub.generate === true;
		if (masked === undefined && generated) {
			return (
				<div data-field-row={sub.key} className="flex flex-wrap items-center gap-2.5">
					<MissingSecretNote label={which} disabled={busy} onRegenerate={onRegenerate}>
						这条{itemLabel}还没有 {sub.label} —— 脱敏备份恢复回来的就是这样,生成一个新的。
					</MissingSecretNote>
				</div>
			);
		}
		if (masked === undefined) return <PlainRow sub={sub} text="—" />;
		/*
		 * 🔴 存下之后只画服务端给的遮挡、**不给复制**(决策 38):浏览器只拿得到头尾,要全文就重新
		 * 生成。刚生成的那一把明文在面板手里,亮一次、能复制 —— 不亮的话换完了主人拿不到新的。
		 * 「重新生成」跟在同一行:它讲的就是这一格;摆去卡头的话,那一栏里「编辑 / 停用 / 换钥匙 /
		 * 删除」几颗轻重完全不同的钮挨在一起,手一抖就换掉了对面正用着的钥匙。
		 */
		return (
			<div data-field-row={sub.key} className="flex flex-col gap-1.5">
				<div className="flex flex-wrap items-center gap-2.5">
					<RowLabel>{sub.label}</RowLabel>
					<SecretChip text={revealed ?? masked} />
					{revealed ? <CopyControl label={`复制 ${which}`} text={revealed} /> : null}
					{generated ? (
						<RegenerateButton label={which} disabled={busy} onClick={onRegenerate} />
					) : null}
				</div>
				{revealed ? (
					<p className="text-bn-2xs leading-[1.7] text-bn-text-tertiary">
						新生成的,只在这一刻看得到全文 —— 离开这一页就只剩头尾,要用就趁现在复制。
					</p>
				) : null}
			</div>
		);
	}
	return <PlainRow sub={sub} text={plainValueOf(sub, item[sub.key])} />;
}

/** 字段行左边那格的名字 —— 窄窄一列,几行的值才对得齐。 */
function RowLabel({ children }: { children: string }) {
	return <span className="w-9 shrink-0 text-bn-xs text-bn-text-tertiary">{children}</span>;
}

/** 别的格:名字 + 值,只读。 */
function PlainRow({ sub, text }: { sub: ExtensionScalarField; text: string }) {
	const mono = sub.type === "string" && sub.monospace === true;
	return (
		<div data-field-row={sub.key} className="flex flex-wrap items-center gap-2.5">
			<RowLabel>{sub.label}</RowLabel>
			<span
				className={`min-w-0 flex-1 truncate text-bn-xs text-bn-text-secondary ${mono ? "font-mono" : ""}`}
			>
				{text}
			</span>
		</div>
	);
}
