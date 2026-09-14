/**
 * 卡片皮肤库(ADR-0014 决策 2 / 5 / 20 的第①段)+ per-UP 的「选哪套」下拉(决策 17)。
 *
 * 形态与文案口径照抄 dashboard 皮肤库(`pages/skins/SkinSection.tsx`)—— 两个库讲的是
 * 同一件事(上传 zip / 启用 / 复制一份 / 导出 / 删除),长成两副样子只会让人以为它们
 * 规矩不同。与那边刻意的三处不同,都来自 ADR:
 *
 * - **启用的是一套不是两套**:卡片没有深浅之分,`PUT /active` 只收一个 id;
 * - **内置那份列得出但改不了删不了**(决策 5),要改先「复制一份」;
 * - **删之前服务端先问「谁在用」**:409 的那句话里已经点名了用家(全局默认 / 哪几个
 *   UP),原样显示给主人 —— 自己再编一句「删除失败」等于把唯一可操作的线索吞掉。
 *
 * 「编辑」按钮这轮只占位(编辑器是 ADR-0014 节奏里的第二步),摆出来但禁用,免得第二步
 * 落地时整行按钮重排。
 */

import type { CardSkinDuplicateResponse, CardSkinSummary } from "@bilibili-notify/contract";
import type { CardSkinKind } from "@bilibili-notify/internal";
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
import { Field, TSelect } from "../../components/forms";
import { api } from "../../services/api";
import { CARD_SKINS_KEY, useCardSkinList } from "./card-skins-query";

/** 七种卡在回落告警里怎么称呼。 */
const KIND_LABEL: Record<CardSkinKind, string> = {
	live: "直播",
	dynamic: "动态",
	sc: "SC",
	guard: "上舰",
	roastBoard: "锐评榜单",
	roastSolo: "单人锐评",
	wordcloud: "词云",
};

/**
 * 回落告警里那套皮肤的名字。**账本记的是 id**(渲染器那头拿不到名字,也不该为了一句
 * 告警去查库),所以这里回头对一遍;对不上就把 id 原样摆出来 —— 皮肤可能已经被删了,
 * 而「哪一套」正是主人唯一能照着去查的线索。
 */
function skinName(skins: readonly CardSkinSummary[], id: string): string {
	return skins.find((s) => s.id === id)?.name ?? `皮肤 ${id}`;
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

/** 装包响应(POST /api/card-skins)。 */
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
	a.href = `/api/card-skins/${skin.id}/export`;
	a.download = `${skin.name}.zip`;
	a.click();
}

export function CardSkinSection() {
	const qc = useQueryClient();
	const [error, setError] = useState<string | null>(null);
	const [warnings, setWarnings] = useState<string[]>([]);
	const [confirmRemove, setConfirmRemove] = useState<CardSkinSummary | null>(null);
	const uploadInputRef = useRef<HTMLInputElement | null>(null);

	const listQuery = useCardSkinList();
	const skins = useMemo(() => sortSkins(listQuery.data?.skins ?? []), [listQuery.data?.skins]);
	const active = listQuery.data?.active ?? "";

	function refresh(): void {
		void qc.invalidateQueries({ queryKey: CARD_SKINS_KEY });
		// 启用指针住在 `globals.defaults.cardSkin`,不在店里 —— 换一套皮肤同时也改了
		// 全局配置,页面上读 globals 的那些地方(预览、灵动岛基线)得跟着重取。
		void qc.invalidateQueries({ queryKey: ["globals"] });
	}

	const activate = useMutation({
		mutationFn: (id: string) => api.put<{ ok: boolean }>("/api/card-skins/active", { id }),
		onSuccess: () => {
			setError(null);
			refresh();
		},
		onError: (e) => setError(String((e as Error).message)),
	});

	const duplicate = useMutation({
		mutationFn: (id: string) =>
			api.post<CardSkinDuplicateResponse>(`/api/card-skins/${id}/duplicate`, {}),
		onSuccess: () => {
			setError(null);
			refresh();
		},
		onError: (e) => setError(String((e as Error).message)),
	});

	const remove = useMutation({
		mutationFn: (id: string) => api.delete<{ ok: boolean }>(`/api/card-skins/${id}`),
		onSuccess: () => {
			setError(null);
			refresh();
		},
		// 409 的响应体里那句 `err` 已经点名了用家(全局默认 / 哪几个 UP),`api` 那层会把它
		// 抬成 message。原样显示 —— 换成自编的「删除失败」就把唯一能照着去改的线索吞了。
		onError: (e) => setError(String((e as Error).message)),
	});

	const upload = useMutation({
		mutationFn: (file: File) => {
			const form = new FormData();
			form.set("file", file);
			return api.upload<UploadResult>("/api/card-skins", form);
		},
		onSuccess: (data) => {
			setError(null);
			setWarnings(data.warnings);
			refresh();
		},
		onError: (e) => setError(String((e as Error).message)),
	});

	function onUploadPick(e: ChangeEvent<HTMLInputElement>): void {
		const file = e.target.files?.[0];
		e.target.value = "";
		if (file) upload.mutate(file);
	}

	/**
	 * 出图回落的账本(ADR-0014 决策 19「回落必须可见」)。
	 *
	 * **刻意不做 toast**:回落发生在推送的那一刻,主人多半不在面板前;等他下次打开卡片页
	 * 才看得见,所以这块要一直留在页面上,直到他自己说「知道了」。
	 */
	const fallbacks = listQuery.data?.fallbacks ?? [];
	const dismissFallbacks = useMutation({
		mutationFn: () => api.delete<{ ok: boolean }>("/api/card-skins/fallbacks"),
		onSuccess: refresh,
		onError: (e) => setError(String((e as Error).message)),
	});

	const busy = activate.isPending || duplicate.isPending || remove.isPending;

	return (
		<GlassBox
			title="卡片皮肤 · card-skin"
			subtitle="推送卡片的整套外观 —— 上传皮肤包换装;内置那套只读,想改先「复制一份」"
			accent="var(--color-bn-purple)"
			icon={<Icon.palette size={14} />}
			badge={active && active !== "default" ? "已换装" : "内置皮肤"}
			right={
				<div className="flex items-center gap-2">
					<Btn
						size="sm"
						onClick={() => uploadInputRef.current?.click()}
						disabled={upload.isPending}
					>
						{upload.isPending ? "上传中…" : "上传皮肤包"}
					</Btn>
					<input
						ref={uploadInputRef}
						type="file"
						accept=".zip,application/zip"
						className="hidden"
						onChange={onUploadPick}
						aria-label="选择卡片皮肤包 zip 文件"
					/>
				</div>
			}
		>
			{error ? <ErrorNote className="mb-3">操作失败：{error}</ErrorNote> : null}
			{fallbacks.length > 0 ? (
				<WarnNote className="mb-3 leading-5">
					<div className="flex items-start gap-3">
						<div className="min-w-0 flex-1 space-y-0.5">
							<div className="font-semibold">有卡片没能按皮肤画出来,已回落内置默认皮肤</div>
							{fallbacks.map((f) => (
								<div key={`${f.skinId} ${f.kind} ${f.reason}`}>
									{skinName(skins, f.skinId)} 的{KIND_LABEL[f.kind]}卡{f.reason}
									{f.count > 1 ? `(${f.count} 次)` : ""} · {formatAt(f.at)}
								</div>
							))}
						</div>
						<Btn
							size="sm"
							variant="ghost"
							onClick={() => dismissFallbacks.mutate()}
							disabled={dismissFallbacks.isPending}
						>
							知道了
						</Btn>
					</div>
				</WarnNote>
			) : null}
			{warnings.length > 0 ? (
				<WarnNote className="mb-3 leading-5">
					{warnings.map((w) => (
						<div key={w}>{w}</div>
					))}
				</WarnNote>
			) : null}

			{listQuery.isPending ? (
				<LoadingBlock label="读取皮肤库中" variant="inset" />
			) : skins.length === 0 ? (
				<EmptyNote>皮肤库是空的 —— 上传一个皮肤包试试。</EmptyNote>
			) : (
				<div className="space-y-2">
					{skins.map((skin) => (
						<CardSkinRow
							key={skin.id}
							skin={skin}
							inUse={skin.id === active}
							busy={busy}
							onActivate={() => activate.mutate(skin.id)}
							onDuplicate={() => duplicate.mutate(skin.id)}
							onExport={() => downloadSkin(skin)}
							onRemove={() => setConfirmRemove(skin)}
						/>
					))}
				</div>
			)}

			<HintNote className="mt-3">
				per-UP 想单独换一套:上方切到那个 UP,在「卡片皮肤」里挑;想给它改排版就先「复制一份」再改。
			</HintNote>

			{confirmRemove ? (
				<ConfirmDialog
					title="删除卡片皮肤"
					message={`确定删除「${confirmRemove.name}」吗?删除后不可恢复。`}
					danger
					confirmLabel="删除"
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
	onActivate: () => void;
	onDuplicate: () => void;
	onExport: () => void;
	onRemove: () => void;
}) {
	const { skin } = props;
	const desc = skinDesc(skin);
	return (
		<div className="flex items-center gap-3 rounded-bn-sm border border-bn-border-subtle bg-bn-surface-muted/60 px-3 py-2.5">
			<div className="min-w-0 flex-1">
				<div className="flex flex-wrap items-center gap-1.5">
					<span className="text-bn-base font-semibold text-bn-text-primary">{skin.name}</span>
					{skin.builtin ? (
						<Pill subtle color="var(--color-bn-blue)">
							内置
						</Pill>
					) : null}
					{props.inUse ? <Pill color="var(--color-bn-pink)">使用中</Pill> : null}
				</div>
				{desc ? (
					<div className="mt-0.5 truncate text-bn-xs text-bn-text-secondary">{desc}</div>
				) : null}
			</div>
			<div className="flex shrink-0 items-center gap-1.5">
				<Btn
					size="sm"
					variant="ghost"
					onClick={props.onActivate}
					disabled={props.busy || props.inUse}
				>
					{props.inUse ? "已启用" : "启用"}
				</Btn>
				{/* 编辑器是 ADR-0014 节奏的第二步 —— 位置先占着,免得那时整行按钮重排。 */}
				<Btn size="sm" variant="ghost" disabled title="全屏编辑器还没做,下一步才有">
					编辑
				</Btn>
				<Btn size="sm" variant="ghost" onClick={props.onDuplicate} disabled={props.busy}>
					复制一份
				</Btn>
				<Btn size="sm" variant="ghost" onClick={props.onExport}>
					导出
				</Btn>
				{/* 内置那份删不掉(服务端也拦)—— 摆一颗点了必失败的钮只是在骗人。 */}
				{skin.builtin ? null : (
					<Btn size="sm" variant="danger" onClick={props.onRemove} disabled={props.busy}>
						删除
					</Btn>
				)}
			</div>
		</div>
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
}: {
	value: string | undefined;
	onChange: (next: string | undefined) => void;
}) {
	const listQuery = useCardSkinList();
	const skins = useMemo(() => sortSkins(listQuery.data?.skins ?? []), [listQuery.data?.skins]);
	const active = listQuery.data?.active ?? "";
	const activeName = skins.find((s) => s.id === active)?.name ?? active;

	return (
		<Field code="cardSkin" full>
			<TSelect
				full
				value={value ?? ""}
				onChange={(next) => onChange(next === "" ? undefined : next)}
				options={[
					{ value: "", label: activeName ? `跟随全局（${activeName}）` : "跟随全局" },
					...skins.map((s) => ({ value: s.id, label: s.builtin ? `${s.name}（内置）` : s.name })),
				]}
			/>
		</Field>
	);
}
