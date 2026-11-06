import { i18n, useT } from "../../i18n";
/** 卡片页只保留选用、旋钮与回落告警；资源库复用原有皮肤包管理与编辑器。 */

import type { CardSkinDuplicateResponse, CardSkinSummary } from "@bilibili-notify/contract";
import { CARD_KIND_SHORT_NAMES } from "@bilibili-notify/internal/card-skin";
import {
	Btn,
	ConfirmDialog,
	EmptyNote,
	ErrorNote,
	GlassBox,
	HintNote,
	Icon,
	LoadingBlock,
	Pill,
	WarnNote,
} from "@bilibili-notify/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type ChangeEvent, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Field, TSelect } from "../../components/forms";
import { ManageResourcesButton } from "../../components/library/manage-resources-button";
import { SETTINGS_KEY } from "../../hooks/useSettings";
import { api } from "../../services/api";
import { errorTextOf } from "../../services/error-text";
import { CARD_SKINS_KEY, useActivateCardSkin, useCardSkinList } from "./card-skins-query";

/** 七种卡在回落告警里怎么称呼:短名(名字只住在 internal 的 card-skin.ts,见 `CARD_KIND_SHORT_NAMES`)。 */
const KIND_LABEL = CARD_KIND_SHORT_NAMES;

/**
 * 回落告警里那套皮肤的名字。**账本记的是 id**(渲染器那头拿不到名字,也不该为了一句
 * 告警去查库),所以这里回头对一遍;对不上就把 id 原样摆出来 —— 皮肤可能已经被删了,
 * 而「哪一套」正是主人唯一能照着去查的线索。
 */
function skinName(skins: readonly CardSkinSummary[], id: string): string {
	return skins.find((s) => s.id === id)?.name ?? i18n.t("skinUi.CardSkinSection.1", { value0: id });
}

/** 回落时刻:同一天只报时分,跨天带上月日 —— 「上周那条」和「刚刚那条」要一眼分得开。 */
function formatAt(at: number): string {
	const d = new Date(at);
	const now = new Date();
	const sameDay = d.toDateString() === now.toDateString();
	const hh = String(d.getHours()).padStart(2, "0");
	const mm = String(d.getMinutes()).padStart(2, "0");
	return sameDay ? `${hh}:${mm}` : `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`;
}

/** 装包响应(POST /api/cards/skins)。 */
interface UploadResult {
	id: string;
	warnings: string[];
}

/**
 * 内置那份排首位,其余保持服务端给的顺序。
 *
 * 内置是「出厂默认 + 复制一份的母本」,排在中间的话主人得在一列自制皮肤里找它。
 */
function sortSkins(skins: readonly CardSkinSummary[]): CardSkinSummary[] {
	return [...skins].sort((a, b) => Number(b.builtin) - Number(a.builtin));
}

/** 「by 作者 · 描述」那一行(两样都没有就整行不出)。 */
function skinDesc(skin: CardSkinSummary): string {
	return [skin.author ? `by ${skin.author}` : null, skin.description ?? null]
		.filter(Boolean)
		.join(" · ");
}

/** 导出:直接开导出端点,浏览器按 content-disposition 落文件(会话 cookie 同源自带)。 */
function downloadSkin(skin: CardSkinSummary): void {
	const a = document.createElement("a");
	a.href = `/api/cards/skins/${skin.id}/export`;
	a.download = `${skin.name}.zip`;
	a.click();
}

export function CardSkinSection({ mode = "select" }: { mode?: "select" | "manage" } = {}) {
	return mode === "select" ? <CardSkinSelection /> : <CardSkinManagement />;
}

function CardSkinManagement() {
	const tx = useT();

	const qc = useQueryClient();
	const navigate = useNavigate();
	const [error, setError] = useState<string | null>(null);
	const [warnings, setWarnings] = useState<string[]>([]);
	const [confirmRemove, setConfirmRemove] = useState<CardSkinSummary | null>(null);
	const uploadInputRef = useRef<HTMLInputElement | null>(null);

	const listQuery = useCardSkinList();
	const skins = useMemo(() => sortSkins(listQuery.data?.skins ?? []), [listQuery.data?.skins]);
	const active = listQuery.data?.active ?? "";

	/** 装包 / 复制 / 删除后让管理列表和设置读者同步重取。 */
	function refresh(): void {
		void qc.invalidateQueries({ queryKey: CARD_SKINS_KEY });
		// 启用指针住在 `globals.defaults.cardSkin`,不在店里 —— 删掉正在用的那套,服务端
		// 会顺手改这个指针,页面上读 globals 的那些地方(预览、灵动岛基线)得跟着重取。
		void qc.invalidateQueries({ queryKey: SETTINGS_KEY });
	}

	/**
	 * 复制一份。`andThen` 是「复制完拿新 id 干什么」(**别叫 `then`** —— 带 `then` 的对象
	 * 是 thenable,被 await 到就会当 promise 解开)。内置那档的按钮写的是「复制并编辑」
	 * (决策 5:内置改不了,要改先派生一份),点了就该直接落进编辑器,让主人少走一步
	 * 「回列表里找那份刚出现的副本」。
	 */
	const duplicate = useMutation({
		mutationFn: async (v: { id: string; andThen?: (newId: string) => void }) => {
			const r = await api.post<CardSkinDuplicateResponse>(`/api/cards/skins/${v.id}/duplicate`, {});
			return { r, andThen: v.andThen };
		},
		onSuccess: ({ r, andThen }) => {
			setError(null);
			refresh();
			andThen?.(r.id);
		},
		onError: (e) => setError(String((e as Error).message)),
	});

	const remove = useMutation({
		mutationFn: (id: string) => api.delete<{ ok: boolean }>(`/api/cards/skins/${id}`),
		onSuccess: () => {
			setError(null);
			refresh();
		},
		// `conflict`(409)的 `message` 已经点名了用家(全局默认 / 哪几个 UP)。原样显示 ——
		// 换成自编的「删除失败」就把唯一能照着去改的线索吞了。
		onError: (e) => setError(String((e as Error).message)),
	});

	const upload = useMutation({
		mutationFn: (file: File) => {
			const form = new FormData();
			form.set("file", file);
			return api.upload<UploadResult>("/api/cards/skins", form);
		},
		onSuccess: (data) => {
			setError(null);
			setWarnings(data.warnings);
			refresh();
		},
		// 装包门没过时 `message` 只是一句概括,逐条意见在 `issues` —— 一起给主人,他要照着去改那个包。
		onError: (e) => setError(errorTextOf(e)),
	});

	function onUploadPick(e: ChangeEvent<HTMLInputElement>): void {
		const file = e.target.files?.[0];
		e.target.value = "";
		if (file) upload.mutate(file);
	}

	const busy = duplicate.isPending || remove.isPending;

	return (
		<GlassBox
			title={tx("skinUi.CardSkinSection.2")}
			subtitle={tx("skinUi.CardSkinSection.3")}
			accent="var(--color-bn-purple)"
			icon={<Icon.palette size={14} />}
			badge={
				active && active !== "default"
					? tx("skinUi.CardSkinSection.4")
					: tx("skinUi.CardSkinSection.5")
			}
			right={
				<div className="flex items-center gap-2">
					<Btn
						size="sm"
						onClick={() => uploadInputRef.current?.click()}
						disabled={upload.isPending}
					>
						{upload.isPending ? tx("skinUi.CardSkinSection.6") : tx("skinUi.CardSkinSection.7")}
					</Btn>
					<input
						ref={uploadInputRef}
						type="file"
						accept=".zip,application/zip"
						className="hidden"
						onChange={onUploadPick}
						aria-label={tx("skinUi.CardSkinSection.8")}
					/>
				</div>
			}
		>
			{error ? (
				<ErrorNote className="mb-3">
					{tx("skinUi.CardSkinSection.9")}
					{error}
				</ErrorNote>
			) : null}

			{warnings.length > 0 ? (
				<WarnNote className="mb-3 leading-5">
					{warnings.map((w) => (
						<div key={w}>{w}</div>
					))}
				</WarnNote>
			) : null}

			{listQuery.isError ? (
				<ErrorNote>
					{tx("library.skinsReadFailed")}{" "}
					<Btn size="sm" onClick={() => void listQuery.refetch()}>
						{tx("library.retry")}
					</Btn>
				</ErrorNote>
			) : listQuery.isPending ? (
				<LoadingBlock label={tx("skinUi.CardSkinSection.15")} variant="inset" />
			) : skins.length === 0 ? (
				<EmptyNote>{tx("skinUi.CardSkinSection.16")}</EmptyNote>
			) : (
				<div className="space-y-2">
					{skins.map((skin) => (
						<CardSkinRow
							key={skin.id}
							skin={skin}
							inUse={skin.id === active}
							busy={busy}
							onDuplicate={() => duplicate.mutate({ id: skin.id })}
							onEdit={() =>
								skin.builtin
									? duplicate.mutate({
											id: skin.id,
											andThen: (newId: string) => navigate(`/cards/skins/${newId}`),
										})
									: navigate(`/cards/skins/${skin.id}`)
							}
							onExport={() => downloadSkin(skin)}
							onRemove={() => setConfirmRemove(skin)}
						/>
					))}
				</div>
			)}

			<HintNote className="mt-3">{tx("library.cardManageHint")}</HintNote>

			{confirmRemove ? (
				<ConfirmDialog
					title={tx("skinUi.CardSkinSection.18")}
					message={tx("skinUi.CardSkinSection.19", { value0: confirmRemove.name })}
					danger
					confirmLabel={tx("skinUi.CardSkinSection.20")}
					onConfirm={() => {
						remove.mutate(confirmRemove.id);
						setConfirmRemove(null);
					}}
					onCancel={() => setConfirmRemove(null)}
				/>
			) : null}
		</GlassBox>
	);
}

function CardSkinRow(props: {
	skin: CardSkinSummary;
	inUse: boolean;
	busy: boolean;
	onDuplicate: () => void;
	onEdit: () => void;
	onExport: () => void;
	onRemove: () => void;
}) {
	const tx = useT();

	const { skin } = props;
	const desc = skinDesc(skin);
	return (
		// 名字与那排钮**上下两行**:这一节住在卡片页 380 宽的左栏里,五颗钮挤在同一排时会
		// 把名字区压到零宽,「赛博朋克」四个字当场竖着排下来(2026-09-14 主人报的)。
		<div
			// 行内的钮都按这个属性找(测试如此,以后的「跳到这套皮肤」也如此)—— 靠 class
			// 串定位的话,一次排版调整就能把找行的代码找断。
			data-skin={skin.id}
			className="flex flex-col gap-2 rounded-bn-sm border border-bn-border-subtle bg-bn-surface-muted/60 px-3 py-2.5"
		>
			<div className="min-w-0">
				<div className="flex flex-wrap items-center gap-1.5">
					<span className="min-w-0 truncate text-bn-base font-semibold text-bn-text-primary">
						{skin.name}
					</span>
					{skin.builtin ? (
						<Pill subtle color="var(--color-bn-blue)">
							{tx("skinUi.CardSkinSection.21")}
						</Pill>
					) : null}
					{props.inUse ? (
						<Pill color="var(--color-bn-pink)">{tx("skinUi.CardSkinSection.22")}</Pill>
					) : null}
				</div>
				{desc ? (
					<div className="mt-0.5 truncate text-bn-xs text-bn-text-secondary">{desc}</div>
				) : null}
			</div>
			<div className="flex flex-wrap items-center gap-1.5">
				{/* 内置那份改不了(决策 5),所以它这颗写的是「复制并编辑」:点了先派生再进编辑器。 */}
				<Btn size="sm" variant="ghost" onClick={props.onEdit} disabled={props.busy}>
					{skin.builtin ? tx("skinUi.CardSkinSection.25") : tx("skinUi.CardSkinSection.26")}
				</Btn>
				<Btn size="sm" variant="ghost" onClick={props.onDuplicate} disabled={props.busy}>
					{tx("skinUi.CardSkinSection.27")}
				</Btn>
				<Btn size="sm" variant="ghost" onClick={props.onExport}>
					{tx("skinUi.CardSkinSection.28")}
				</Btn>
				{/* 内置那份删不掉(服务端也拦)—— 摆一颗点了必失败的钮只是在骗人。 */}
				{skin.builtin ? null : (
					<Btn size="sm" variant="danger" onClick={props.onRemove} disabled={props.busy}>
						{tx("skinUi.CardSkinSection.29")}
					</Btn>
				)}
			</div>
		</div>
	);
}

function CardSkinSelection() {
	const tx = useT(),
		qc = useQueryClient();
	const [error, setError] = useState<string | null>(null);
	const listQuery = useCardSkinList();
	const skins = listQuery.data?.skins ?? [];
	const activate = useActivateCardSkin({ onSuccess: () => setError(null), onError: setError });
	function refresh() {
		void qc.invalidateQueries({ queryKey: CARD_SKINS_KEY });
	}
	/**
	 * 出图回落的账本(ADR-0014 决策 19「回落必须可见」)。
	 *
	 * **刻意不做 toast**:回落发生在推送的那一刻,主人多半不在面板前;等他下次打开卡片页
	 * 才看得见,所以这块要一直留在页面上,直到他自己说「知道了」。
	 */
	const fallbacks = listQuery.data?.fallbacks ?? [];
	const dismissFallbacks = useMutation({
		mutationFn: () => api.delete<{ ok: boolean }>("/api/cards/skins/fallbacks"),
		onSuccess: refresh,
		onError: (e) => setError(String((e as Error).message)),
	});

	return (
		<GlassBox
			title={tx("skinUi.CardSkinSection.2")}
			subtitle={tx("library.cardSelectHint")}
			accent="var(--color-bn-purple)"
			icon={<Icon.palette size={14} />}
		>
			{error ? <ErrorNote>{error}</ErrorNote> : null}
			{fallbacks.length > 0 ? (
				<WarnNote className="mb-3 leading-5">
					<div className="flex items-start gap-3">
						<div className="min-w-0 flex-1 space-y-0.5">
							<div className="font-semibold">{tx("skinUi.CardSkinSection.10")}</div>
							{fallbacks.map((f) => (
								<div key={`${f.skinId} ${f.kind} ${f.reason}`}>
									{tx("skinUi.CardSkinSection.fallback", {
										skin: skinName(skins, f.skinId),
										kind: KIND_LABEL[f.kind],
										reason: f.reason,
									})}
									{f.count > 1 ? tx("skinUi.CardSkinSection.13", { count: f.count }) : ""} ·{" "}
									{formatAt(f.at)}
								</div>
							))}
						</div>
						<Btn
							size="sm"
							variant="ghost"
							onClick={() => dismissFallbacks.mutate()}
							disabled={dismissFallbacks.isPending}
						>
							{tx("skinUi.CardSkinSection.14")}
						</Btn>
					</div>
				</WarnNote>
			) : null}
			{listQuery.isPending ? (
				<LoadingBlock label={tx("skinUi.CardSkinSection.15")} variant="inset" />
			) : listQuery.isError ? (
				<ErrorNote>
					{tx("library.skinsReadFailed")}{" "}
					<Btn size="sm" onClick={() => void listQuery.refetch()}>
						{tx("library.retry")}
					</Btn>
				</ErrorNote>
			) : (
				<fieldset disabled={activate.isPending}>
					<CardSkinPicker
						value={listQuery.data?.active}
						inherit={false}
						onChange={(id) => {
							if (id && id !== listQuery.data?.active) activate.mutate(id);
						}}
					/>
				</fieldset>
			)}
		</GlassBox>
	);
}

/**
 * per-UP 的「这个 UP 用哪套皮肤」下拉(ADR-0014 决策 17)。
 *
 * `undefined` = 跟随全局(保存时把 `overrides.cardSkin` 这个键清掉,不是存一个空串)。
 * 选项列全库 —— per-UP 想单独改排版的路子是「复制一份再改」,不是再叠一层版式补丁。
 */
export function CardSkinPicker({
	value,
	onChange,
	inherit = true,
}: {
	inherit?: boolean;
	value: string | undefined;
	onChange: (next: string | undefined) => void;
}) {
	const tx = useT();

	const listQuery = useCardSkinList();
	const skins = useMemo(() => sortSkins(listQuery.data?.skins ?? []), [listQuery.data?.skins]);
	const active = listQuery.data?.active ?? "";
	const activeName = skins.find((s) => s.id === active)?.name ?? active;

	return (
		<div className="space-y-3">
			<Field code="cardSkin" full>
				<TSelect
					full
					value={value ?? ""}
					onChange={(next) => onChange(next === "" ? undefined : next)}
					options={[
						...(inherit
							? [
									{
										value: "",
										label: activeName
											? tx("skinUi.CardSkinSection.30", { value0: activeName })
											: tx("skinUi.CardSkinSection.31"),
									},
								]
							: []),
						...skins.map((s) => ({
							value: s.id,
							label: s.builtin ? tx("skinUi.CardSkinSection.32", { value0: s.name }) : s.name,
						})),
					]}
				/>
			</Field>
			<div className="flex justify-end">
				<ManageResourcesButton category="card-skins" />
			</div>
		</div>
	);
}
