import type {
	ExtensionDTO,
	ExtensionItemView,
	ExtensionListField,
	ExtensionScalarField,
	ExtensionTone,
} from "@bilibili-notify/contract";
import { LIST_ITEM_ID_KEY } from "@bilibili-notify/internal/constants";
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
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../../../services/api";
import { newId } from "../../../types/domain";
import type { GlobalConfig } from "../../../types/globals";
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
	extensionSettingsOf,
	isPaused,
	isRecord,
	itemLabelOf,
	itemsOf,
	type ListItem,
	markOf,
	plainValueOf,
	rowFieldsOf,
	titleOf,
	toggleDefaultOf,
	writeFailureOf,
} from "./list-items";
import { NewItemDialog } from "./list-new-item";
import {
	CopyControl,
	MissingSecretNote,
	RegenerateButton,
	SecretChip,
	TriStateLegend,
} from "./parts";
import { RichText } from "./rich-text";
import { newHexSecret } from "./secret";
import { extensionStatusKey, isNotFound, isRunning, useExtensionView } from "./view-query";

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

/** 一张卡要回头找这一节做的事 —— 每一件都是一发整份写回。 */
interface CardActions {
	toggle(item: ListItem): void;
	set(item: ListItem, set: Readonly<Record<string, string | number | boolean>>): void;
	regenerate(item: ListItem, sub: ExtensionScalarField): void;
	remove(item: ListItem): void;
	/**
	 * 上一发写回还在路上。
	 *
	 * 🔴 名单是**整份写回**的,基线是渲染那一刻算出来的 —— 前一发没回来时点第二下,第二发带的
	 * 名单里第一下的改动还是旧值,两发都成功而第一下被静默抹掉。所以这一节的钮串行:写回期间
	 * 一律点不动,确认框也不接第二下。
	 */
	busy: boolean;
}

/**
 * 一格 `list` 设置项那一节(ADR-0019 决策 21 / 26 / 29 / 32):标题行 + 每项一张卡 + 新建弹窗 +
 * 删除 / 重新生成的确认。
 *
 * 版式照今天手写的桥页(决策 24「版式、交互、状态都照今天」):桥迁过来之后,这一节画出来的
 * 就该是今天那一页。卡上每一块归三处之一 —— **清单**声明的(标题、方块、字段行、停用 / 启用)、
 * **视图**交来的(状态、药丸、副标题、按钮、积木)、**BN** 自己画的(删除、图例、三句盖章)。
 */
export function ListSection({ ext, field }: { ext: ExtensionDTO; field: ExtensionListField }) {
	const qc = useQueryClient();
	const [adding, setAdding] = useState(false);
	/** 两件要确认的事共用底下那**一个**确认框 —— 谁在等,由它说了算。 */
	const [confirming, setConfirming] = useState<Confirming | null>(null);

	// 列表住拓展自己的设置里(`globals.extensions.<id>.settings.<key>`)。与状态分开取:拓展
	// 没跑起来时它照样在,「配了但没连上」正是要看见的。
	const globals = useQuery({
		queryKey: ["globals"],
		queryFn: () => api.get<GlobalConfig>("/api/globals"),
	});
	const running = isRunning(ext);
	const view = useExtensionView(ext.id, running);

	/**
	 * 整份写回 —— 列表是设置里的一个数组,补丁里的数组是整个换掉的。要写的那份走 variables:
	 * 失败时那句话要按**这一发**发出去的名单点名(第几条、叫什么)。服务端**现读**,重新生成
	 * 的钥匙下一次连接就按新的判。
	 */
	const save = useMutation({
		mutationFn: (next: readonly ListItem[]) =>
			api.patch("/api/globals", {
				extensions: { [ext.id]: { settings: { [field.key]: next } } },
			}),
		onSuccess: () => {
			setAdding(false);
			setConfirming(null);
			void qc.invalidateQueries({ queryKey: ["globals"] });
			void qc.invalidateQueries({ queryKey: extensionStatusKey(ext.id) });
		},
	});

	const items = itemsOf(extensionSettingsOf(globals.data, ext.id), field.key);
	const itemLabel = itemLabelOf(field);

	const viewState: ViewState = !ext.enabled
		? "off"
		: !running || (view.isError && !isNotFound(view.error))
			? "unknown"
			: "live";
	// 出错之后 react-query 还攥着上一份 —— 旧的那份不作数,一样都不画。
	const rawViews =
		viewState === "live" && !view.isError ? view.data?.items?.[field.key] : undefined;
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
	 * 🔴 这一节的每一次写(停用 / 换钥匙 / 改设置 / 新建 / 删除)都落在这一发上,而失败时界面
	 * **自己会退回原样** —— 按钮弹回去、确认框留在原地、弹窗不关。三种症状看上去都是「点了
	 * 没用」,而真正的原因(只读盘 / 401 / 照清单校验不过)就在那条响应里。
	 */
	const saveError = save.isError ? writeFailureOf(save.error, ext.id, field, save.variables) : null;
	const busy = save.isPending;
	const update = (id: string, patch: Readonly<Record<string, unknown>>) =>
		save.mutate(items.map((item) => (item.id === id ? { ...item, ...patch } : item)));
	/** 开一个框之前把上一发的错收掉 —— 那句说的是上一发,摆进新框里会被当成这一下的。 */
	const open = (next: () => void) => {
		save.reset();
		next();
	};

	const actions: CardActions = {
		toggle: (item) => {
			if (field.toggle !== undefined) update(item.id, { [field.toggle]: isPaused(field, item) });
		},
		set: (item, set) => {
			const patch = declaredPatchOf(field, set);
			if (Object.keys(patch).length > 0) update(item.id, patch);
		},
		/*
		 * 换钥匙撤不回,所以**有钥匙可换的时候先问一句**:服务端现读,正用着它的那一头当场断开,
		 * 要它连回来得有人把新的填一遍。空着的**不问**:没有旧钥匙可作废(脱敏备份恢复回来的常态
		 * 就是空的),它恰恰是最该顺手按下去的那一颗。
		 */
		regenerate: (item, sub) => {
			const current = item[sub.key];
			if (typeof current === "string" && current !== "") {
				open(() => setConfirming({ kind: "regenerate", item, sub }));
				return;
			}
			update(item.id, { [sub.key]: newHexSecret() });
		},
		remove: (item) => open(() => setConfirming({ kind: "remove", item })),
		busy,
	};

	// 还在读:什么都不画 —— 先画空态再换成卡,等于闪一下「还没有」。
	if (globals.isPending) return null;
	/*
	 * 🔴 **「读不到」不许画成「没有」**:名单读不出来(401 / 服务端炸了 / 断网)时 `itemsOf`
	 * 交出的也是空数组,而空态那一屏请人建一条 —— 全是假话,主人照着建完才发现原来那几条
	 * 又回来了(或者这一发根本存不进去,因为那份没读到的名单才是真的)。
	 */
	if (globals.isError) {
		return (
			<ErrorNote size="sm">
				读不到{field.label}:{reasonOf(globals.error)}
			</ErrorNote>
		);
	}

	const confirmation = confirming ? confirmationOf(confirming, field) : null;

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
						onClick={() => open(() => setAdding(true))}
					>
						新建{itemLabel}
					</Btn>
				</div>
			) : null}

			{saveError ? <ErrorNote size="sm">这次没写进去:{saveError}</ErrorNote> : null}

			{items.length === 0 ? (
				<ListEmpty field={field} busy={busy} onAdd={() => open(() => setAdding(true))} />
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

			{adding ? (
				<NewItemDialog
					extensionId={ext.id}
					field={field}
					error={saveError}
					saving={busy}
					onCancel={() => setAdding(false)}
					// 生成的那一格由弹窗带过来 —— **屏幕上显示的就是存下去的那一把**。id 在这一刻
					// 由 BN 生成(决策 29);停用那一格弹窗里没有,补清单的默认值。
					onCreate={(values) =>
						save.mutate([
							...items,
							{
								[LIST_ITEM_ID_KEY]: newId(),
								...values,
								...(field.toggle !== undefined ? { [field.toggle]: toggleDefaultOf(field) } : {}),
							},
						])
					}
				/>
			) : null}

			{confirming && confirmation ? (
				<ConfirmDialog
					title={confirmation.title}
					message={
						<>
							{confirmation.body}
							{/* 事情没成时框留在原地 —— 不说原因就是让人对着黑盒按第二下。 */}
							{saveError ? (
								<ErrorNote size="sm" className="mt-2.5">
									{confirmation.errorLead}:{saveError}
								</ErrorNote>
							) : null}
						</>
					}
					confirmLabel={busy ? confirmation.busyLabel : confirmation.label}
					danger
					onConfirm={() => {
						if (busy) return;
						if (confirming.kind === "remove") {
							save.mutate(items.filter((item) => item.id !== confirming.item.id));
						} else {
							// 新钥匙在按下「重新生成」这一刻才生成 —— 框开着时它还不存在,也就不会有
							// 「框里一把、存下去另一把」。
							update(confirming.item.id, { [confirming.sub.key]: newHexSecret() });
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
 * 原因摆在正文尾巴上(框留在原地)、写回期间都不接第二下。
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
 * 卡正文里一格一行(标题 / 方块 / 停用那几格不在这儿)。只读 —— 列表项在卡上不就地改,要改的
 * 那几件(换钥匙、停用、视图给的「改成 ×」)各有自己的钮。
 */
function FieldRow({
	sub,
	item,
	title,
	itemLabel,
	busy,
	onRegenerate,
}: {
	sub: ExtensionScalarField;
	item: ListItem;
	title: string;
	itemLabel: string;
	busy: boolean;
	onRegenerate: () => void;
}) {
	if (sub.type === "string" && (sub.secret || sub.generate)) {
		const raw = item[sub.key];
		const value = typeof raw === "string" ? raw : "";
		const which = `${title} 的 ${sub.label}`;
		if (!value && sub.generate) {
			return (
				<div data-field-row={sub.key} className="flex flex-wrap items-center gap-2.5">
					<MissingSecretNote label={which} disabled={busy} onRegenerate={onRegenerate}>
						这条{itemLabel}还没有 {sub.label} —— 脱敏备份恢复回来的就是这样,生成一个新的。
					</MissingSecretNote>
				</div>
			);
		}
		if (!value) return <PlainRow sub={sub} text="—" />;
		/*
		 * 密钥只露头尾 —— 要用时按「复制」。明文摆着的后果是它被随手截进求助帖里。「重新生成」
		 * 跟在同一行:它讲的就是这一格;摆去卡头的话,那一栏里「停用 / 换钥匙 / 删除」三颗轻重
		 * 完全不同的钮挨在一起,手一抖就换掉了对面正用着的钥匙。
		 */
		return (
			<div data-field-row={sub.key} className="flex flex-wrap items-center gap-2.5">
				<RowLabel>{sub.label}</RowLabel>
				<SecretChip value={value} />
				<CopyControl label={`复制 ${which}`} text={value} />
				{sub.generate ? (
					<RegenerateButton label={which} disabled={busy} onClick={onRegenerate} />
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
