/**
 * Cards page — image plugin card style preview. Ports `GlassPreviewTab` from
 * `.bn-design/variation-ac.jsx`.
 *
 * A scope switcher (全局默认 / 各 UP) sits on top. Three columns: a left rail
 * (SectionNav) = 全局 + the four card kinds. On the 全局 tab the middle column edits
 * the base style (shared by all cards) + image log level and the right column shows
 * a four-card 全家福 (each kind rendered with its own effective style); to tune one
 * kind you open its tab. On a kind tab the middle column holds that kind's 单独样式
 * override, background gallery, 卡片版式 editor and 测试推送 + preview-content form,
 * and the right column is the single live puppeteer preview. In the global scope
 * these bind to GlobalConfig.defaults.{cardStyle,cardStyleByKind,cardLayout}; per-UP
 * they bind to that subscription's overrides, gated by 「覆盖全局」 toggles.
 */

import type { PreviewResponse, TestPushResponse } from "@bilibili-notify/contract";
import { buildPatch } from "@bilibili-notify/internal/patch";
import {
	Btn,
	ConfirmDialog,
	GlassBox,
	Icon,
	type IconName,
	Pill,
	SectionNav,
	Spinner,
	Toggle,
} from "@bilibili-notify/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { ChromeAutoDetect } from "../components/chrome-autodetect";
import {
	Field,
	LogLevelPicker,
	type LogLevelValue,
	Picker,
	TArea,
	TColor,
	TInput,
	TSelect,
} from "../components/forms";
import { type Scope, ScopeTabs } from "../components/scope-tabs";
import { PUSH_TONE } from "../config/push-kinds";
import { useDirtyDraft } from "../hooks/useDirtyDraft";
import { ApiError, api } from "../services/api";
import type { CardLayoutFull, PushTarget, Subscription } from "../types/domain";
import type { CardStyle, GlobalConfig, LogLevel } from "../types/globals";
import { CardLayoutEditor } from "./cards/CardLayoutEditor";
import { FontPicker } from "./cards/FontPicker";
import { removeFontFromByKind, removeFontFromStyle } from "./cards/font-ops";
import { GalleryPicker } from "./cards/GalleryPicker";
import { removeAssetFromByKind, removeAssetFromStyle } from "./cards/gallery-ops";
import {
	type CardStyleByKind,
	resolveKindStyle,
	type CardKind as StyleKind,
} from "./cards/perkind";
import { previewErrorHint, previewErrorTitle } from "./cards/preview-error";
import { enqueuePreview, PREVIEW_TIMEOUT_MS } from "./cards/preview-queue";
import {
	colorOnly,
	hasColorOverride,
	hasCoverOverride,
	hasShowOverride,
	isEmptyObj,
	omitCover,
	omitShow,
	pickCover,
	pickShow,
	type ShowKey,
	type StylePartial,
} from "./cards/style-partition";
import { displayName } from "./up/helpers";

/** 本页预览 kind("dyn")↔ 样式/版式键("dynamic")的映射。 */
function toStyleKind(kind: CardKind): StyleKind {
	return kind === "dyn" ? "dynamic" : kind;
}

// per-kind partial 的字段族分区(颜色 / 数据区 show / 直播封面,三族互不相交、各有独立
// 开关)—— 拣取与剔除工具在 ./cards/style-partition,含各族语义说明。

type CardKind = "live" | "dyn" | "sc" | "guard";

interface PreviewContent {
	live: { roomId: string };
	dyn: { uid: string; offset: number };
	sc: { text: string; price: number };
	guard: { text: string; level: 1 | 2 | 3 };
}

const DEFAULT_PREVIEW_CONTENT: PreviewContent = {
	live: { roomId: "" },
	dyn: { uid: "", offset: 1 },
	sc: { text: "主播加油！这首要听到！示例 UP 主唱得太好了！", price: 30 },
	// guard.text empty by default so the backend falls back to the logged-in
	// account name (the operator), with "示例新舰长" only kicking in when
	// nobody is logged in.
	guard: { text: "", level: 3 },
};

const GUARD_LEVELS: { v: 1 | 2 | 3; label: string; tone: string }[] = [
	{ v: 1, label: "总督", tone: "#e84393" },
	{ v: 2, label: "提督", tone: "#a29bfe" },
	{ v: 3, label: "舰长", tone: "#74b9ff" },
];

const KIND_LABELS: Record<CardKind, { label: string; tone: string; icon: IconName }> = {
	live: { label: "直播开播", tone: PUSH_TONE.live, icon: "live" },
	dyn: { label: "动态发布", tone: PUSH_TONE.dynamic, icon: "dyn" },
	sc: { label: "SC 提醒", tone: PUSH_TONE.sc, icon: "sc" },
	guard: { label: "上舰提醒", tone: PUSH_TONE.guard, icon: "guard" },
};

/** 左侧类型导航的副标题(对齐 Rules 左栏的「label + desc」观感)。 */
const KIND_DESC: Record<CardKind, string> = {
	live: "开播 / 直播中 / 下播",
	dyn: "动态 / 视频投稿",
	sc: "醒目留言 SC",
	guard: "舰长 / 提督 / 总督",
};

function PreviewImage({
	kind,
	style,
	content,
	layout,
	fallback,
	frame = true,
}: {
	kind: CardKind;
	style: CardStyle;
	/** 已按 kind 选好的内容载荷(全局 = 可编辑 mock;per-UP = 该 UP 真实数据 id)。 */
	content: Record<string, unknown>;
	layout: CardLayoutFull | null;
	/** 真实拉取失败时是否回退示例数据(per-UP 自动模式 = true)。 */
	fallback: boolean;
	/** 带边框大容器(单卡预览)。false = 裸图缩放填满父格(全家福格子复用)。 */
	frame?: boolean;
}) {
	// 把整份请求(kind/style/content/layout/fallback)合成一个 spec 做**单一**防抖。
	// 关键:kind / fallback 不能直接进 queryKey 而其余走独立防抖 —— 否则切类型时
	// kind 立刻变、content 防抖没追上,会先用「上一个类型残留的内容」白发一次请求
	// (per-UP 下还会真去拉一次接口),一次操作打两条日志、跑两次 puppeteer。整体防抖
	// 后一次变更只触发一次 refetch。TColor / TArea / 拖拽编辑器的高频 onChange 同样收敛。
	const spec = useMemo(
		() => ({ kind, style, content, layout: layout ?? undefined, fallback }),
		[kind, style, content, layout, fallback],
	);
	const [debouncedSpec, setDebouncedSpec] = useState(spec);
	useEffect(() => {
		const t = setTimeout(() => setDebouncedSpec(spec), 500);
		return () => clearTimeout(t);
	}, [spec]);

	const query = useQuery({
		queryKey: ["card-preview", debouncedSpec],
		// 经串行队列 —— 全家福一屏四张卡,四个请求一起打出去的话,后三个只是挂在服务端
		// 渲染闸门口空等(服务端本来就串行,见 runtime/serial-gate.ts)。等在浏览器这边
		// 总耗时一样,但每条连接的存活时间只剩自己那张卡的渲染时间,不会被反代的读超时
		// 连坐掐断。详见 cards/preview-queue.ts。
		queryFn: () =>
			enqueuePreview(async () => {
				// 带死线:队伍是串行的,一个永不落地的请求会让后面几张卡连发都发不出去。
				const res = await api.post<PreviewResponse>("/api/cards/preview", debouncedSpec, {
					timeoutMs: PREVIEW_TIMEOUT_MS,
				});
				if (!res.ok || !res.dataUrl) {
					throw new ApiError(500, res, res.err ?? "preview failed");
				}
				return res.dataUrl;
			}),
		retry: false,
	});

	const showSkeleton = query.isPending;
	const apiErr = query.error as ApiError | undefined;
	const status = apiErr?.status;

	const body = showSkeleton ? (
		<div className="flex w-full max-w-95 flex-col items-center gap-3 rounded-xl bg-bn-surface/70 p-6">
			<Spinner />
			<div className="text-[12px] font-bold text-bn-text-secondary">puppeteer 渲染中…</div>
		</div>
	) : query.error ? (
		<div className="w-full max-w-95 rounded-xl bg-bn-surface p-4 text-[12px]">
			<div className="mb-1 font-bold text-bn-danger-text">{previewErrorTitle(status)}</div>
			<div className="text-bn-text-secondary">{apiErr?.message ?? "未知错误"}</div>
			{previewErrorHint(status) ? (
				<div className="mt-2 text-[11px] text-bn-text-tertiary">{previewErrorHint(status)}</div>
			) : null}
			{status === 503 ? <ChromeAutoDetect onEnabled={() => query.refetch()} /> : null}
		</div>
	) : (
		<img
			src={query.data}
			srcSet={`${query.data} 2x`}
			alt="卡片实时预览"
			className={
				frame
					? "bn-anim-fade-in max-w-full rounded-xl shadow-[0_6px_20px_rgba(0,0,0,0.14)]"
					: "bn-anim-fade-in max-h-full max-w-full rounded-lg object-contain shadow-[0_4px_14px_rgba(0,0,0,0.12)]"
			}
		/>
	);

	// 全家福格子复用裸图模式:不套大边框,缩放填满父格(父格定高 + overflow-hidden)。
	if (!frame) {
		return <div className="flex h-full w-full items-center justify-center">{body}</div>;
	}
	return (
		<div className="relative flex min-h-105 items-center justify-center rounded-bn-card border border-bn-border p-7">
			{body}
		</div>
	);
}

function CardPreview({
	kind,
	style,
	content,
	layout,
	fallback,
	frame,
}: {
	kind: CardKind;
	style: CardStyle;
	content: Record<string, unknown>;
	layout: CardLayoutFull | null;
	fallback: boolean;
	frame?: boolean;
}) {
	return (
		<PreviewImage
			kind={kind}
			style={style}
			content={content}
			layout={layout}
			fallback={fallback}
			frame={frame}
		/>
	);
}

/**
 * 预览内容 + 测试推送(合并卡)—— 上半编辑该类型的预览内容(全局可改 mock,per-UP 用真实
 * 数据),下半把当前预览卡片(草稿样式 + 类型 + 内容)渲染成图片推给所选 PushTarget。
 * 所见即所推:用的是当前预览正在调的草稿,无需先保存。
 */
function TestPushCard({
	kind,
	style,
	pushContent,
	layout,
	fallback,
	mockContent,
	setMockContent,
	realData,
	realDataLabel,
}: {
	kind: CardKind;
	style: CardStyle;
	/** 已解析的预览/推送内容载荷(全局 = mock;per-UP = 该 UP 真实数据 id)。 */
	pushContent: Record<string, unknown>;
	layout: CardLayoutFull | null;
	fallback: boolean;
	/** 可编辑的 mock 内容状态(供上半内容编辑)。 */
	mockContent: PreviewContent;
	setMockContent: React.Dispatch<React.SetStateAction<PreviewContent>>;
	realData?: boolean;
	realDataLabel?: string;
}) {
	const targetsQuery = useQuery({
		queryKey: ["targets"],
		queryFn: () => api.get<PushTarget[]>("/api/targets"),
	});
	const targets = useMemo(
		() => (targetsQuery.data ?? []).filter((t) => t.enabled),
		[targetsQuery.data],
	);
	const [targetId, setTargetId] = useState("");
	useEffect(() => {
		// 目标列表到位后默认选第一个;所选目标被删 / 停用则回退到第一个。
		const first = targets[0];
		if (first && !targets.some((t) => t.id === targetId)) setTargetId(first.id);
	}, [targets, targetId]);

	const push = useMutation({
		mutationFn: async () => {
			const res = await api.post<TestPushResponse>("/api/cards/test-push", {
				targetId,
				kind,
				style,
				content: pushContent,
				layout: layout ?? undefined,
				fallback,
			});
			if (!res.ok) throw new ApiError(500, res, res.err ?? "推送失败");
			return res;
		},
	});

	return (
		<GlassBox
			title="预览内容 · 测试推送"
			subtitle="编辑该类型预览内容,并把当前预览卡片(草稿样式)推送到所选目标"
			accent="#00b894"
			icon={<Icon.bell size={14} />}
			badge="test-push"
		>
			<PreviewContentFields
				kind={kind}
				content={mockContent}
				setContent={setMockContent}
				realData={realData}
				realDataLabel={realDataLabel}
			/>
			<div className="my-3 border-t border-bn-border-subtle" />
			<Field code="targetId" full>
				<TSelect
					full
					value={targetId}
					onChange={setTargetId}
					disabled={targets.length === 0}
					options={
						targets.length === 0
							? [{ value: "", label: "无可用推送目标" }]
							: targets.map((t) => ({ value: t.id, label: t.name }))
					}
				/>
			</Field>
			<div className="pt-2.5">
				<Btn
					variant="primary"
					size="sm"
					full
					onClick={() => push.mutate()}
					disabled={push.isPending || !targetId}
				>
					{push.isPending ? "推送中…" : "测试推送"}
				</Btn>
				{push.isError ? (
					<div className="mt-2 text-[11px] text-bn-danger-text">
						推送失败:{(push.error as ApiError)?.message ?? "未知错误"}
					</div>
				) : push.isSuccess ? (
					<div className="mt-2 text-[11px] text-bn-success-text">
						已送达 · {push.data.latencyMs}ms
					</div>
				) : null}
			</div>
		</GlassBox>
	);
}

// 背景图选择改用图廊多选组件 GalleryPicker(支持上传 / 删盘 / 轮换序);缩略图 hook
// 抽到 ./cards/useAssetObjectUrl 与之共享。

// Server-side override is `LogLevel` strings; the LogLevelPicker speaks 1|2|3
// numeric. `null` ↔ "" (no override; fall back to app.logLevel).
type ImageLogLevel = LogLevel | "";
const LOG_LEVEL_TO_NUM: Record<LogLevel, LogLevelValue> = { error: 1, warn: 2, info: 3, debug: 4 };
const NUM_TO_LOG_LEVEL: Record<LogLevelValue, LogLevel> = {
	1: "error",
	2: "warn",
	3: "info",
	4: "debug",
};
const toPickerValue = (v: ImageLogLevel): LogLevelValue | null =>
	v === "" ? null : LOG_LEVEL_TO_NUM[v];
const fromPickerValue = (v: LogLevelValue | null): ImageLogLevel =>
	v === null ? "" : NUM_TO_LOG_LEVEL[v];

/**
 * 卡片样式表单字段(渐变 / 字体 / 隐藏项 / 玻璃片 / 背景图)—— 全局默认与 per-UP
 * 覆盖复用同一组控件。插件总开关 enabled 与 image 日志等级是基础设施级、全局唯一,
 * 不在此组件内。
 */
export function CardStyleFields({
	style,
	onChange,
	onAssetDeleted,
}: {
	style: CardStyle;
	onChange: (next: CardStyle) => void;
	/** 背景图删盘回调,透传给 GalleryPicker(Cards 页借它清扫其他样式草稿)。 */
	onAssetDeleted?: (id: string) => void;
}) {
	const set = <K extends keyof CardStyle>(k: K, v: CardStyle[K]) => onChange({ ...style, [k]: v });
	return (
		<>
			<Field code="cardColorStart">
				<TColor value={style.cardColorStart} onChange={(v) => set("cardColorStart", v)} />
			</Field>
			<Field code="cardColorEnd">
				<TColor value={style.cardColorEnd} onChange={(v) => set("cardColorEnd", v)} />
			</Field>
			<Field code="font" full>
				<FontPicker
					value={{ font: style.font, fontAsset: style.fontAsset }}
					onChange={(next) => onChange({ ...style, font: next.font, fontAsset: next.fontAsset })}
					onAssetDeleted={onAssetDeleted}
				/>
			</Field>
			<Field code="glassOpacity" full>
				<div className="flex flex-col gap-2">
					<div className="flex h-7.5 items-center gap-3">
						<Toggle
							value={style.glassOpacity !== undefined}
							onChange={(on) =>
								onChange({ ...style, glassOpacity: on ? 0.82 : undefined, glassClear: false })
							}
						/>
						{style.glassOpacity !== undefined ? (
							<>
								<input
									type="range"
									min={0}
									max={1}
									step={0.05}
									value={style.glassOpacity}
									onChange={(e) => set("glassOpacity", Number(e.target.value))}
									className="flex-1 accent-bn-pink"
								/>
								<span className="w-9 shrink-0 text-right font-mono text-[11px] text-bn-text-secondary">
									{style.glassOpacity.toFixed(2)}
								</span>
							</>
						) : (
							<span className="text-[11px] text-bn-text-tertiary">
								{style.glassClear ? "已开启完全透明" : "默认（各卡内置基线）"}
							</span>
						)}
					</div>
					{/* 子选项:完全透明(去磨砂模糊),与上方透明度二选一。 */}
					<div className="flex items-center gap-2 text-[11px] text-bn-text-secondary">
						<Toggle
							size="sm"
							value={style.glassClear}
							onChange={(on) => onChange({ ...style, glassClear: on, glassOpacity: undefined })}
						/>
						完全透明（去磨砂模糊）
					</div>
				</div>
			</Field>
			<Field code="backgroundImages" full>
				<GalleryPicker
					value={style.backgroundImages}
					onChange={(next) => set("backgroundImages", next)}
					onAssetDeleted={onAssetDeleted}
				/>
			</Field>
		</>
	);
}

/**
 * 直播卡「数据区」显示开关(人气·点赞 / 分区 / 粉丝数据)—— 仅直播卡用,控制数据区内部
 * 显示哪几项。绑定基准 CardStyle 的 show* 字段(全局作用域;数据区走全局 image config)。
 */
function DataSectionFields({
	style,
	onChange,
}: {
	style: CardStyle;
	onChange: (next: CardStyle) => void;
}) {
	const row = (code: "showPopularity" | "showArea" | "showFans") => (
		<Field code={code} key={code}>
			<div className="flex h-7.5 items-center">
				<Toggle value={style[code]} onChange={(v) => onChange({ ...style, [code]: v })} />
			</div>
		</Field>
	);
	return (
		<>
			{row("showPopularity")}
			{row("showArea")}
			{row("showFans")}
		</>
	);
}

/**
 * per-UP 直播封面:对该 UP 单独选封面图(替换 B 站房间封面/关键帧)。封面字段存进
 * `cardStyleByKind.live` 的 partial —— 与颜色覆盖 / 数据区 show **字段不相交**,三套
 * 开关互不覆盖(pickCover/omitCover)。未覆盖时跟随全局封面(基准层不持有封面)。
 */
export function PerUpCoverSection({
	base,
	value,
	onChange,
	onAssetDeleted,
}: {
	/** 继承值来源:全局基准的封面列表。 */
	base: string[];
	/** `cardStyleByKind.live` 的当前 partial(可能同时含颜色/数据区覆盖)。 */
	value: StylePartial | undefined;
	/** 写回 `cardStyleByKind.live`(undefined = 删除该 kind)。 */
	onChange: (next: StylePartial | undefined) => void;
	/** 封面图删盘回调,透传给 GalleryPicker(Cards 页借它清扫其他样式草稿)。 */
	onAssetDeleted?: (id: string) => void;
}) {
	const active = hasCoverOverride(value);
	const toggleOverride = (on: boolean) => {
		if (on) {
			onChange({ ...(value ?? {}), liveCoverImages: [...base] });
		} else {
			const rest = omitCover(value);
			onChange(isEmptyObj(rest) ? undefined : rest);
		}
	};
	return (
		<GlassBox
			title="直播封面"
			subtitle="开 = 该 UP 单独选封面图(替换 B 站房间封面/关键帧,多张每次推送轮换);关 = 跟随全局"
			accent={KIND_LABELS.live.tone}
			icon={<Icon.live size={14} />}
			badge={active ? "单独设置" : "跟随"}
			right={<Toggle value={active} onChange={toggleOverride} />}
		>
			{active ? (
				<Field code="liveCoverImages" full>
					<GalleryPicker
						value={value?.liveCoverImages ?? []}
						onChange={(next) => onChange({ ...(value ?? {}), liveCoverImages: next })}
						onAssetDeleted={onAssetDeleted}
						emptyHint="未选择(用 B 站直播间原始封面)"
						singleHint="单张固定封面"
					/>
				</Field>
			) : (
				<InheritNote>
					{base.length > 0
						? `跟随全局封面(${base.length} 张)`
						: "跟随全局(未设置,使用 B 站房间封面)"}
				</InheritNote>
			)}
		</GlassBox>
	);
}

/**
 * per-UP 数据区:对该 UP 单独设置直播卡数据区显示项。show 字段存进 `cardStyleByKind.live`
 * 的 partial —— 与该 kind 的颜色覆盖字段**不相交**(颜色卡 omitShow、数据卡 pickShow),
 * 故两套开关互不覆盖。未覆盖时跟随该 UP 基准 / 全局。
 */
function PerUpDataSection({
	base,
	value,
	onChange,
}: {
	/** 该 UP「live」的基准生效样式(继承值来源)。 */
	base: CardStyle;
	/** `cardStyleByKind.live` 的当前 partial(可能同时含颜色覆盖)。 */
	value: StylePartial | undefined;
	/** 写回 `cardStyleByKind.live`(undefined = 删除该 kind)。 */
	onChange: (next: StylePartial | undefined) => void;
}) {
	const active = hasShowOverride(value);
	const eff = (k: ShowKey): boolean => value?.[k] ?? base[k];
	const toggleOverride = (on: boolean) => {
		if (on) {
			onChange({
				...(value ?? {}),
				showPopularity: base.showPopularity,
				showArea: base.showArea,
				showFans: base.showFans,
			});
		} else {
			const rest = omitShow(value);
			onChange(isEmptyObj(rest) ? undefined : rest);
		}
	};
	const setFlag = (k: ShowKey, v: boolean) => onChange({ ...(value ?? {}), [k]: v });
	const row = (k: ShowKey) => (
		<Field code={k} key={k}>
			<div className="flex h-7.5 items-center">
				<Toggle value={eff(k)} onChange={(v) => setFlag(k, v)} />
			</div>
		</Field>
	);
	return (
		<GlassBox
			title="直播数据"
			subtitle="开 = 该 UP 单独设置直播数据显示项(人气·点赞 / 分区 / 粉丝数据);关 = 跟随全局 / 基准"
			accent={KIND_LABELS.live.tone}
			icon={<Icon.live size={14} />}
			badge={active ? "单独设置" : "跟随"}
			right={<Toggle value={active} onChange={toggleOverride} />}
		>
			{active ? (
				<>
					{row("showPopularity")}
					{row("showArea")}
					{row("showFans")}
				</>
			) : (
				<InheritNote>该 UP 数据区跟随全局 / 基准</InheritNote>
			)}
		</GlassBox>
	);
}

/**
 * 「这条预览用的是真实数据」的绿色说明条。四个 kind 分支各自写了一遍,连
 * `realDataLabel` 缺省时的那句兜底也抄了两份 —— 抄的东西一漂,同一个弹窗里
 * 两条说明就会一条圆一条方。
 */
function RealDataNote({ children }: { children: React.ReactNode }) {
	return (
		<div className="rounded-sm border border-dashed bg-bn-success-soft/60 p-2.5 text-[11px] text-bn-success-text">
			{children}
		</div>
	);
}

/** per-UP 作用域没给 `realDataLabel` 时的兜底说明。 */
const REAL_DATA_FALLBACK =
	"使用该 UP 的真实数据渲染预览；未开播 / 无动态 / 网络异常时自动回退示例数据。";

/**
 * 「预览内容」框 —— 卡片类型切换 + 各类型的 mock/真实内容字段。与作用域无关
 * (预览的是哪类卡片、用什么内容,跟改谁的样式独立)。
 */
function PreviewContentFields({
	kind,
	content,
	setContent,
	realData = false,
	realDataLabel,
}: {
	kind: CardKind;
	content: PreviewContent;
	setContent: React.Dispatch<React.SetStateAction<PreviewContent>>;
	/** per-UP 作用域:仅类型选择,不提供 mock 内容编辑(用该 UP 真实数据)。 */
	realData?: boolean;
	realDataLabel?: string;
}) {
	const setLive = (next: Partial<PreviewContent["live"]>) =>
		setContent((c) => ({ ...c, live: { ...c.live, ...next } }));
	const setDyn = (next: Partial<PreviewContent["dyn"]>) =>
		setContent((c) => ({ ...c, dyn: { ...c.dyn, ...next } }));
	const setSc = (next: Partial<PreviewContent["sc"]>) =>
		setContent((c) => ({ ...c, sc: { ...c.sc, ...next } }));
	const setGuard = (next: Partial<PreviewContent["guard"]>) =>
		setContent((c) => ({ ...c, guard: { ...c.guard, ...next } }));

	return (
		<>
			{/* 卡片类型由左侧「卡片类型」导航选择;此处只显示当前类型的内容字段。 */}
			{realData ? (
				kind === "dyn" ? (
					// per-UP 动态:仍用该 UP 真实动态,但可选渲染「第几条」(offset)。
					<>
						<Field code="offset" label="第几条动态">
							<TInput
								value={String(content.dyn.offset)}
								onChange={(v) => {
									const n = Number.parseInt(v, 10);
									setDyn({ offset: Number.isFinite(n) && n > 0 ? n : 1 });
								}}
								placeholder="1"
							/>
						</Field>
						<RealDataNote>{realDataLabel ?? REAL_DATA_FALLBACK}</RealDataNote>
					</>
				) : (
					<RealDataNote>
						{kind === "live"
							? (realDataLabel ?? REAL_DATA_FALLBACK)
							: "SC / 上舰:接收方为该 UP(真实名字 / 头像),发送者 / 新舰长取当前登录账号;解析失败回退示例。"}
					</RealDataNote>
				)
			) : kind === "live" ? (
				<>
					<Field code="roomId">
						<TInput
							value={content.live.roomId}
							onChange={(v) => setLive({ roomId: v })}
							placeholder="留空则使用示例数据"
						/>
					</Field>
					<RealDataNote>
						需要后端账号已登录 B 站；填入后将真实拉取该直播间数据并渲染。留空则继续使用示例数据。
					</RealDataNote>
				</>
			) : kind === "dyn" ? (
				<>
					<Field code="uid">
						<TInput
							value={content.dyn.uid}
							onChange={(v) => setDyn({ uid: v })}
							placeholder="留空则使用示例数据"
						/>
					</Field>
					<Field code="offset">
						<TInput
							value={String(content.dyn.offset)}
							onChange={(v) => {
								const n = Number.parseInt(v, 10);
								setDyn({ offset: Number.isFinite(n) && n > 0 ? n : 1 });
							}}
							placeholder="1"
						/>
					</Field>
					<RealDataNote>
						需要后端账号已登录 B 站；填入后将拉取该 UP 的 space 动态列表，按 offset 选取并渲染。
					</RealDataNote>
				</>
			) : kind === "sc" ? (
				<>
					<Field code="text">
						<TArea value={content.sc.text} onChange={(v) => setSc({ text: v })} rows={3} />
					</Field>
					<Field code="price">
						<TInput
							value={String(content.sc.price)}
							onChange={(v) => {
								const n = Number.parseInt(v, 10);
								setSc({ price: Number.isFinite(n) && n > 0 ? n : 30 });
							}}
							placeholder="30"
						/>
					</Field>
					<div className="rounded-sm border border-dashed bg-bn-surface-muted p-2.5 text-[11px] text-bn-text-tertiary">
						左侧渐变色对 SC 不生效；SC 卡片背景色由价格档位自动决定。
					</div>
				</>
			) : (
				<>
					<Field code="level">
						<div className="flex flex-wrap gap-1.5">
							{GUARD_LEVELS.map((g) => {
								const active = content.guard.level === g.v;
								return (
									<button
										type="button"
										key={g.v}
										onClick={() => setGuard({ level: g.v })}
										data-bn="btn"
										className="rounded-sm px-3 py-1 text-[11.5px] font-semibold transition"
										style={
											active
												? { background: g.tone, color: "white" }
												: {
														background: "var(--color-bn-hover-muted)",
														color: "var(--color-bn-text-tertiary)",
													}
										}
									>
										{g.label}
									</button>
								);
							})}
						</div>
					</Field>
					<Field
						label="新舰长称呼"
						code="text"
						hint="留空时使用当前登录账号的名字（未登录则显示示例新舰长）"
					>
						<TArea
							value={content.guard.text}
							onChange={(v) => setGuard({ text: v })}
							placeholder="留空使用登录账号名"
							rows={2}
						/>
					</Field>
					<div className="rounded-sm border border-dashed bg-bn-surface-muted p-2.5 text-[11px] text-bn-text-tertiary">
						左侧渐变色对上舰不生效；卡片背景色与徽章图由舰长等级自动决定。
					</div>
				</>
			)}
		</>
	);
}

/** 关闭态下方一行说明文字。 */
function InheritNote({ children }: { children: React.ReactNode }) {
	return (
		<div className="py-6 text-center text-[12px] text-bn-text-tertiary">未启用 · {children}</div>
	);
}

/** 该 UP 是否设了「按类型」样式覆盖(非空才算)。 */
function hasCardStyleByKind(sub: Subscription): boolean {
	const bk = sub.overrides.cardStyleByKind;
	return bk !== undefined && Object.keys(bk).length > 0;
}
/** 该 sub 已覆盖的卡片切片数(0..3),供 ScopeTabs 计数徽章。 */
function cardOverrideCount(sub: Subscription): number {
	return (
		(sub.overrides.cardStyle ? 1 : 0) +
		(hasCardStyleByKind(sub) ? 1 : 0) +
		(sub.overrides.cardLayout ? 1 : 0)
	);
}
function hasCardCustomization(sub: Subscription): boolean {
	return (
		sub.overrides.cardStyle !== undefined ||
		hasCardStyleByKind(sub) ||
		sub.overrides.cardLayout !== undefined
	);
}

export default function Cards() {
	const qc = useQueryClient();
	const globalsQuery = useQuery({
		queryKey: ["globals"],
		queryFn: () => api.get<GlobalConfig>("/api/globals"),
	});
	const subsQuery = useQuery({
		queryKey: ["subscriptions"],
		queryFn: () => api.get<Subscription[]>("/api/subs"),
	});

	const [scope, setScope] = useState<Scope>("__global");
	// 客户端临时添加(还没设覆盖)的 sub.id;刷新即清空。
	const [addedSubIds, setAddedSubIds] = useState<Set<string>>(new Set());
	const [pendingRemoval, setPendingRemoval] = useState<Subscription | null>(null);

	// 全局草稿
	const [gStyle, setGStyle] = useState<CardStyle | null>(null);
	// 按卡片类型的样式覆盖(全局)。空 = 各类型跟随 gStyle 基准。
	const [gByKind, setGByKind] = useState<CardStyleByKind>({});
	const [gLayout, setGLayout] = useState<CardLayoutFull | null>(null);
	const [imageLogLevel, setImageLogLevel] = useState<ImageLogLevel>("");

	// per-UP 覆盖草稿(undefined = 继承全局)
	const [puStyle, setPuStyle] = useState<CardStyle | undefined>(undefined);
	// 按卡片类型的样式覆盖(per-UP)。空 = 各类型跟随该 UP 基准(puStyle ?? 全局)。
	const [puByKind, setPuByKind] = useState<CardStyleByKind>({});
	const [puLayout, setPuLayout] = useState<CardLayoutFull | undefined>(undefined);

	// 删盘后清扫页面上所有仍引用该 id 的样式草稿(全局基准 / 全局 per-kind / per-UP
	// 基准 / per-UP per-kind 的背景图 + 直播封面 + 字体)。picker 自身的 onChange 只清它
	// 绑定的那一个字段;其余草稿若攥着这个 id 不放,下次保存就落盘成悬空引用(背景图是
	// 幽灵占轮换位,字体是出图静静回落兜底)。服务端 409 只拦「已保存配置」里的引用,
	// 未保存草稿只能靠这里。
	//
	// 图与字体两套清扫都跑:两类资产 id 各自随机 32 位 hex,撞不到一起,所以对另一类
	// 是纯 no-op —— 比让两个 picker 各带一个回调简单,也不会漏。
	const sweep = <
		T extends { backgroundImages?: string[]; liveCoverImages?: string[]; fontAsset?: string },
	>(
		s: T,
		id: string,
	): T => removeFontFromStyle(removeAssetFromStyle(s, id), id);
	const sweepDeletedAsset = (id: string) => {
		setGStyle((s) => (s ? sweep(s, id) : s));
		setGByKind((bk) => removeFontFromByKind(removeAssetFromByKind(bk, id), id));
		setPuStyle((s) => (s ? sweep(s, id) : s));
		setPuByKind((bk) => removeFontFromByKind(removeAssetFromByKind(bk, id), id));
	};

	// 左侧导航:「全局」(基准通用样式)或某卡片类型。与作用域无关。
	const [activeTab, setActiveTab] = useState<"__global" | StyleKind>("__global");
	const [content, setContent] = useState<PreviewContent>(DEFAULT_PREVIEW_CONTENT);

	const isGlobalTab = activeTab === "__global";
	// 类型 tab 锁定为该类型;全局 tab 右侧铺四张卡(无单一类型),styleKind/kind 仅占位。
	const styleKind: StyleKind = isGlobalTab ? "live" : activeTab;
	const kind: CardKind = styleKind === "dynamic" ? "dyn" : styleKind;

	const allSubs = useMemo(() => subsQuery.data ?? [], [subsQuery.data]);
	const isGlobalScope = scope === "__global";
	const focusedSub = isGlobalScope ? undefined : allSubs.find((s) => s.id === scope);
	const serverGlobalStyle = globalsQuery.data?.defaults.cardStyle;
	const serverGlobalLayout = globalsQuery.data?.defaults.cardLayout;

	useEffect(() => {
		if (globalsQuery.data) {
			setGStyle(globalsQuery.data.defaults.cardStyle);
			setGByKind(globalsQuery.data.defaults.cardStyleByKind ?? {});
			setGLayout(globalsQuery.data.defaults.cardLayout);
			setImageLogLevel(globalsQuery.data.app.logLevels?.image ?? "");
		}
	}, [globalsQuery.data]);

	// 选中 UP 的存储覆盖 → 编辑草稿。cardStyle 合并到全局之上,把历史 partial 覆盖补全
	// 成可直接编辑的完整快照(向后保存即写整份快照)。
	const seededPuStyle = useMemo<CardStyle | undefined>(() => {
		if (!focusedSub?.overrides.cardStyle || !serverGlobalStyle) return undefined;
		return { ...serverGlobalStyle, ...focusedSub.overrides.cardStyle };
	}, [focusedSub?.overrides.cardStyle, serverGlobalStyle]);
	const seededPuLayout = focusedSub?.overrides.cardLayout;
	// per-UP 按类型覆盖的存储值;空对象 = 无覆盖(与 gByKind seed 一致,直接取原始 partial)。
	const seededPuByKind = useMemo<CardStyleByKind>(
		() => focusedSub?.overrides.cardStyleByKind ?? {},
		[focusedSub?.overrides.cardStyleByKind],
	);

	// 切换到不同 UP(或其服务端数据变化)→ 重新 seed 覆盖草稿。
	useEffect(() => {
		setPuStyle(seededPuStyle);
		setPuByKind(seededPuByKind);
		setPuLayout(seededPuLayout);
	}, [seededPuStyle, seededPuByKind, seededPuLayout]);

	// 选中的 UP 从订阅列表消失 → 回退全局。
	useEffect(() => {
		if (!isGlobalScope && subsQuery.data && !allSubs.some((s) => s.id === scope)) {
			setScope("__global");
		}
	}, [isGlobalScope, scope, subsQuery.data, allSubs]);

	const saveGlobal = useMutation({
		mutationFn: async (payload: {
			cardStyle: CardStyle;
			cardStyleByKind: CardStyleByKind;
			cardLayout: CardLayoutFull;
			imageLogLevel: ImageLogLevel;
		}) => {
			// 只挑本页真正编辑的 scope 做 diff —— 下发全量会让服务端的 enable-check
			// 每次保存都跑一遍 puppeteer 启动 + chat.completions 探针。草稿里消失的键
			// (关掉的 per-kind 样式、退回跟随全局的日志等级)由 buildPatch 自动变成
			// 显式 null,不必再逐个记着手写。
			const base = globalsQuery.data;
			await api.patch<GlobalConfig>(
				"/api/globals",
				buildPatch(
					{
						app: { logLevels: { image: payload.imageLogLevel || undefined } },
						defaults: {
							cardStyle: payload.cardStyle,
							cardStyleByKind: payload.cardStyleByKind,
							cardLayout: payload.cardLayout,
						},
					},
					{
						app: { logLevels: { image: base?.app.logLevels?.image } },
						defaults: {
							cardStyle: base?.defaults.cardStyle,
							cardStyleByKind: base?.defaults.cardStyleByKind ?? {},
							cardLayout: base?.defaults.cardLayout,
						},
					},
				),
			);
		},
		onSuccess: () => qc.invalidateQueries({ queryKey: ["globals"] }),
	});

	// per-UP 保存:只下发卡片两片(缺席键 = 不改其它 slice;null = 清除)。
	const savePerUp = useMutation({
		mutationFn: async (sub: Subscription) => {
			await api.patch<Subscription>(`/api/subs/${sub.id}`, {
				overrides: {
					// 基准覆盖剥掉封面键再落盘:基准是「打开时的 gStyle 快照」,若携带封面会把
					// 全局封面冻结/清空(封面的 per-UP 归宿只有 cardStyleByKind.live)。
					cardStyle: puStyle ? omitCover(puStyle) : null,
					// 空对象 = 无按类型覆盖 → 下发 null 清除整片(不存空对象)。还有覆盖时
					// 与该 UP 服务端当前值做 diff:关掉的类型由 buildPatch 变成显式 null,
					// 否则「开了两类只关一类」那一类关不掉(键消失 = 不改)。
					cardStyleByKind:
						Object.keys(puByKind).length > 0
							? buildPatch(puByKind, sub.overrides.cardStyleByKind ?? {})
							: null,
					cardLayout: puLayout ?? null,
				},
			});
		},
		onSuccess: () => qc.invalidateQueries({ queryKey: ["subscriptions"] }),
	});

	const removeCardCustomization = useMutation({
		mutationFn: async (sub: Subscription) =>
			api.patch<Subscription>(`/api/subs/${sub.id}`, {
				overrides: { cardStyle: null, cardStyleByKind: null, cardLayout: null },
			}),
		onSuccess: () => qc.invalidateQueries({ queryKey: ["subscriptions"] }),
	});

	// Tab 栏:已有卡片覆盖 / 本轮客户端添加的 sub。
	const tabSubs = useMemo(
		() => allSubs.filter((s) => hasCardCustomization(s) || addedSubIds.has(s.id)),
		[allSubs, addedSubIds],
	);
	const availableSubs = useMemo(() => {
		const taken = new Set(tabSubs.map((s) => s.id));
		return allSubs.filter((s) => !taken.has(s.id));
	}, [allSubs, tabSubs]);

	function handleAddSub(id: string): void {
		setAddedSubIds((set) => {
			const next = new Set(set);
			next.add(id);
			return next;
		});
		setScope(id);
	}
	function detachSub(id: string): void {
		setAddedSubIds((set) => {
			const next = new Set(set);
			next.delete(id);
			return next;
		});
		if (scope === id) setScope("__global");
	}
	function handleRemoveSub(id: string): void {
		const sub = allSubs.find((s) => s.id === id);
		if (sub && hasCardCustomization(sub)) {
			setPendingRemoval(sub);
			return;
		}
		detachSub(id);
	}
	function confirmRemoveSub(): void {
		if (!pendingRemoval) return;
		removeCardCustomization.mutate(pendingRemoval);
		detachSub(pendingRemoval.id);
		setPendingRemoval(null);
	}

	// 灵动岛:单一 hook 按作用域切换,杜绝双挂载抢单槽竞态。
	const globalIslandDraft = useMemo(() => {
		if (gStyle === null) return null;
		return {
			...gStyle,
			cardStyleByKind: gByKind,
			cardLayout: gLayout,
			app: { logLevels: { image: imageLogLevel === "" ? null : imageLogLevel } },
		};
	}, [gStyle, gByKind, gLayout, imageLogLevel]);
	const globalIslandBaseline = useMemo(() => {
		if (!globalsQuery.data) return null;
		return {
			...globalsQuery.data.defaults.cardStyle,
			cardStyleByKind: globalsQuery.data.defaults.cardStyleByKind ?? {},
			cardLayout: globalsQuery.data.defaults.cardLayout,
			app: { logLevels: { image: globalsQuery.data.app.logLevels?.image ?? null } },
		};
	}, [globalsQuery.data]);
	const perUpIslandDraft = useMemo(
		() => ({ ...(puStyle ?? {}), cardStyleByKind: puByKind, cardLayout: puLayout ?? null }),
		[puStyle, puByKind, puLayout],
	);
	const perUpIslandBaseline = useMemo(
		() => ({
			...(seededPuStyle ?? {}),
			cardStyleByKind: seededPuByKind,
			cardLayout: seededPuLayout ?? null,
		}),
		[seededPuStyle, seededPuByKind, seededPuLayout],
	);

	// 预览内容:全局 = 可编辑 mock;per-UP = 该 UP 真实数据(live/dyn 按 uid,后端解析房间号
	// / 拉动态),失败由 fallback 自动回退示例;sc/guard 无该 UP 真实数据,沿用固定 mock。
	// useMemo 稳定引用 —— 否则每次 render 新建对象会不断重置 PreviewImage 的防抖定时器。
	const previewFallback = !isGlobalScope;
	const previewContent = useMemo<Record<string, unknown>>(() => {
		if (isGlobalScope || !focusedSub) return content[kind];
		if (kind === "live") return { uid: focusedSub.uid };
		// 动态:用「第几条」选择器的 offset(默认 1),后端按 offset 从该 UP 动态列表取一条。
		if (kind === "dyn") return { uid: focusedSub.uid, offset: content.dyn.offset };
		// sc / guard:发送者 / 新舰长由后端取当前登录账号(与全局一致);带上该 UP 的 uid,
		// 后端据此把卡片**接收方**渲染成真实的该 UP(失败回退示例)。内容沿用固定示例。
		return { ...content[kind], uid: focusedSub.uid };
	}, [isGlobalScope, focusedSub, kind, content]);

	useDirtyDraft({
		pageKey: isGlobalScope ? "cards" : "cards-perup",
		pageLabel: isGlobalScope
			? "卡片样式"
			: `${focusedSub ? displayName(focusedSub) : ""} · 卡片覆盖`,
		draft: isGlobalScope ? globalIslandDraft : perUpIslandDraft,
		baseline: isGlobalScope ? globalIslandBaseline : perUpIslandBaseline,
		onSave: async () => {
			if (isGlobalScope) {
				if (gStyle !== null && gLayout !== null)
					await saveGlobal.mutateAsync({
						cardStyle: gStyle,
						cardStyleByKind: gByKind,
						cardLayout: gLayout,
						imageLogLevel,
					});
			} else if (focusedSub) {
				await savePerUp.mutateAsync(focusedSub);
			}
		},
		onDiscard: () => {
			if (isGlobalScope) {
				if (!globalsQuery.data) return;
				setGStyle(globalsQuery.data.defaults.cardStyle);
				setGByKind(globalsQuery.data.defaults.cardStyleByKind ?? {});
				setGLayout(globalsQuery.data.defaults.cardLayout);
				setImageLogLevel(globalsQuery.data.app.logLevels?.image ?? "");
			} else {
				setPuStyle(seededPuStyle);
				setPuByKind(seededPuByKind);
				setPuLayout(seededPuLayout);
			}
		},
	});

	if (!gStyle) {
		return (
			<div className="bn-glass rounded-bn-card p-10 text-center text-sm text-bn-text-secondary shadow-bn-card">
				加载卡片样式中…
			</div>
		);
	}

	// 按 kind 求「生效样式」:全局作用域 = 全局基准 + 该类型覆盖;per-UP = 再叠该 UP 基准 /
	// 类型覆盖(puStyle 覆盖基准时整份替换;否则继承全局该类型生效值)。
	const effStyleFor = (sk: StyleKind): CardStyle => {
		// 全局 per-kind 只贡献颜色族(show 只认基准 gStyle;封面只认基准/per-UP kind 层);
		// per-UP per-kind 的 show / 封面是该 UP 的独立覆盖,整份 spread 保留。
		const gEff: CardStyle = { ...gStyle, ...colorOnly(gByKind[sk]) };
		if (isGlobalScope) return gEff;
		// 基准层不持有封面(savePerUp 剥离,不落盘):封面继承链 = per-UP kind 层 > 全局基准。
		const base = puStyle ? { ...puStyle, liveCoverImages: gStyle.liveCoverImages } : gEff;
		return puByKind[sk] !== undefined ? { ...base, ...puByKind[sk] } : base;
	};
	// 按 kind 求预览内容:全局 = 可编辑 mock;per-UP = 该 UP 真实数据(live/dyn 按 uid,
	// dyn 带「第几条」offset;sc/guard 带 uid 渲染真实接收方)。
	const contentFor = (k: CardKind): Record<string, unknown> => {
		if (isGlobalScope || !focusedSub) return content[k];
		if (k === "live") return { uid: focusedSub.uid };
		if (k === "dyn") return { uid: focusedSub.uid, offset: content.dyn.offset };
		return { ...content[k], uid: focusedSub.uid };
	};
	// 全局 tab:右侧四张卡「全家福」,逐类型用各自生效样式 + 内容渲染。
	const familyPreviews = (["live", "dyn", "sc", "guard"] as const).map((fk) => ({
		fk,
		style: effStyleFor(toStyleKind(fk)),
		content: contentFor(fk),
	}));

	// 类型 tab 单卡生效值。per-UP 编辑「单独样式」/「数据区」用的基准 = puStyle ?? 全局该类型生效值
	// (全局 per-kind 的 show 字段同样剥掉,数据区继承值取自基准)。
	const puBaseStyle: CardStyle = puStyle
		? { ...puStyle, liveCoverImages: gStyle.liveCoverImages }
		: { ...gStyle, ...colorOnly(gByKind[styleKind]) };
	const effStyle: CardStyle = effStyleFor(styleKind);
	const effLayout: CardLayoutFull | null = isGlobalScope ? gLayout : (puLayout ?? gLayout);

	const KindIcon = Icon[KIND_LABELS[kind].icon];

	return (
		<div className="bn-anim-page-in flex flex-col gap-4">
			{/* Hero strip — 全局插件信息 + (仅全局作用域)总开关 */}
			<div className="bn-glass bn-hero-tint relative rounded-bn-card p-5 shadow-bn-card">
				<div className="flex items-center gap-3.5">
					<div className="bn-hero-badge grid h-13 w-13 shrink-0 place-items-center rounded-2xl text-white">
						<Icon.eye size={26} />
					</div>
					<div className="flex-1">
						<div className="flex items-center gap-2 text-[15.5px] font-bold text-bn-text-primary">
							卡片渲染
							<Pill color="#a29bfe" subtle size="sm">
								image
							</Pill>
						</div>
						<div className="mt-1 text-xs text-bn-text-tertiary">
							puppeteer-core 把 Vue/UnoCSS 模板渲染成 PNG;关闭后 push 流程仅发送文本回退。
						</div>
					</div>
					{isGlobalScope ? (
						<Picker
							value={gStyle.enabled}
							onChange={(v) => setGStyle((d) => (d ? { ...d, enabled: v } : d))}
							options={[
								{ value: true, label: "启用", color: "#a29bfe" },
								{ value: false, label: "停用", color: "#94a3b8" },
							]}
						/>
					) : (
						<span className="rounded-md border border-bn-border-subtle bg-bn-surface/70 px-2.5 py-1 text-[11px] text-bn-text-tertiary">
							总开关在全局作用域
						</span>
					)}
				</div>
			</div>

			{/* 作用域切换 */}
			<ScopeTabs
				scope={scope}
				onChange={setScope}
				tabSubs={tabSubs}
				availableSubs={availableSubs}
				onAddSub={handleAddSub}
				onRemoveSub={handleRemoveSub}
				overridesCountFor={cardOverrideCount}
				globalHint="此处为全部 UP 的默认卡片样式与版式"
				perUpHint={(sub) =>
					sub ? (
						<>
							仅作用于 <b className="text-bn-pink">{sub.uid}</b>,未开启的覆盖继承全局
						</>
					) : null
				}
			/>

			<div className="grid gap-3.5 xl:grid-cols-[220px_380px_minmax(0,1fr)]">
				{/* RAIL: 全局基准 + 各卡片类型 —— 选中决定编辑的样式 / 版式 + 预览的卡片种类 */}
				<SectionNav
					heading="卡片样式"
					items={[
						{
							id: "__global",
							label: "全局",
							desc: "所有卡片通用样式",
							icon: <Icon.edit size={15} />,
						},
						...(["live", "dyn", "sc", "guard"] as const).map((k) => {
							const Ic = Icon[KIND_LABELS[k].icon];
							return {
								id: toStyleKind(k),
								label: KIND_LABELS[k].label,
								desc: KIND_DESC[k],
								icon: <Ic size={15} />,
							};
						}),
					]}
					activeId={activeTab}
					onPick={(id) => setActiveTab(id === "__global" ? "__global" : (id as StyleKind))}
				/>

				{/* LEFT: style config */}
				<div className="flex flex-col gap-3">
					{isGlobalTab ? (
						isGlobalScope ? (
							// 「全局」tab:基准通用样式(所有卡片默认共用)+ 日志等级。
							<GlassBox
								title="卡片渲染样式 · 全局通用"
								subtitle="image plugin · 所有卡片的基准渐变 / 字体 / 玻璃片 / 背景;各类型可在对应标签单独覆盖"
								accent="#a29bfe"
								icon={<Icon.edit size={14} />}
								badge="cardStyle"
							>
								<CardStyleFields
									style={gStyle}
									onChange={(n) => setGStyle(n)}
									onAssetDeleted={sweepDeletedAsset}
								/>
								<Field code="app.logLevels.image" full>
									<LogLevelPicker
										value={toPickerValue(imageLogLevel)}
										onChange={(v) => setImageLogLevel(fromPickerValue(v))}
										allowInherit
									/>
								</Field>
							</GlassBox>
						) : (
							// 「全局」tab · per-UP:该 UP 的样式覆盖(一套管该 UP 全部卡片)。
							<GlassBox
								title="卡片样式覆盖"
								subtitle="开 = 该 UP 用自定义渐变 / 字体 / 玻璃片 / 背景;关 = 继承全局样式"
								accent="#a29bfe"
								icon={<Icon.edit size={14} />}
								badge={puStyle ? "覆盖中" : "继承"}
								right={
									<Toggle
										value={puStyle !== undefined}
										onChange={(on) => setPuStyle(on ? { ...gStyle } : undefined)}
									/>
								}
							>
								{puStyle ? (
									<CardStyleFields
										style={puStyle}
										onChange={(n) => setPuStyle(n)}
										onAssetDeleted={sweepDeletedAsset}
									/>
								) : (
									<InheritNote>该 UP 继承全局卡片样式</InheritNote>
								)}
							</GlassBox>
						)
					) : isGlobalScope ? (
						// 类型 tab · 全局作用域:该卡片单独样式开关,打开才展开覆盖。
						<GlassBox
							title={`${KIND_LABELS[kind].label} · 单独样式`}
							subtitle="开 = 该卡片用自己的渐变 / 字体 / 玻璃片 / 背景;关 = 跟随「全局」"
							accent={KIND_LABELS[kind].tone}
							icon={<KindIcon size={14} />}
							badge={gByKind[styleKind] ? "单独设置" : "跟随全局"}
							right={
								<Toggle
									value={gByKind[styleKind] !== undefined}
									onChange={(on) =>
										setGByKind((bk) => {
											const next = { ...bk };
											// 颜色覆盖只含颜色族(show 归 gStyle 基准、封面归独立区块),colorOnly 防携带。
											if (on) next[styleKind] = colorOnly(resolveKindStyle(gStyle, bk, styleKind));
											else delete next[styleKind];
											return next;
										})
									}
								/>
							}
						>
							{gByKind[styleKind] ? (
								<CardStyleFields
									style={resolveKindStyle(gStyle, gByKind, styleKind)}
									onChange={(n) => setGByKind((bk) => ({ ...bk, [styleKind]: colorOnly(n) }))}
									onAssetDeleted={sweepDeletedAsset}
								/>
							) : (
								<InheritNote>该卡片跟随「全局」通用样式</InheritNote>
							)}
						</GlassBox>
					) : (
						// 类型 tab · per-UP:该 UP 此卡片单独样式开关,打开才展开覆盖(叠在该 UP 基准之上)。
						<GlassBox
							title={`${KIND_LABELS[kind].label} · 单独样式`}
							subtitle="开 = 该 UP 的此卡片用自己的渐变 / 字体 / 玻璃片 / 背景;关 = 跟随该 UP 基准（基准未覆盖则继承全局）"
							accent={KIND_LABELS[kind].tone}
							icon={<KindIcon size={14} />}
							badge={hasColorOverride(puByKind[styleKind]) ? "单独设置" : "跟随基准"}
							right={
								<Toggle
									value={hasColorOverride(puByKind[styleKind])}
									onChange={(on) =>
										setPuByKind((bk) => {
											const next = { ...bk };
											// 颜色/数据区(show)/封面三族同住该 kind 的 partial 但字段不相交:
											// 打开取颜色快照(colorOnly)并保留已有 show 与封面覆盖;关闭只去颜色、留两族。
											if (on) {
												next[styleKind] = {
													...colorOnly(puBaseStyle),
													...pickShow(bk[styleKind]),
													...pickCover(bk[styleKind]),
												};
											} else {
												const keep = { ...pickShow(bk[styleKind]), ...pickCover(bk[styleKind]) };
												if (isEmptyObj(keep)) delete next[styleKind];
												else next[styleKind] = keep;
											}
											return next;
										})
									}
								/>
							}
						>
							{hasColorOverride(puByKind[styleKind]) ? (
								<CardStyleFields
									style={{ ...puBaseStyle, ...puByKind[styleKind] }}
									onChange={(n) =>
										setPuByKind((bk) => ({
											...bk,
											[styleKind]: {
												...colorOnly(n),
												...pickShow(bk[styleKind]),
												...pickCover(bk[styleKind]),
											},
										}))
									}
									onAssetDeleted={sweepDeletedAsset}
								/>
							) : (
								<InheritNote>该卡片跟随该 UP 的基准样式</InheritNote>
							)}
						</GlassBox>
					)}

					{/* 数据区显示项 —— 仅「直播开播」tab(数据区是直播卡专属:人气/分区/粉丝)。
					    全局作用域改 gStyle(走全局 image config);per-UP 可单独覆盖(经 colorOptions 透传)。 */}
					{!isGlobalTab &&
						kind === "live" &&
						(isGlobalScope ? (
							<GlassBox
								title="直播数据"
								subtitle="直播卡数据显示项 —— 人气·点赞 / 分区 / 粉丝数据;关掉某项即从卡片隐藏"
								accent={KIND_LABELS.live.tone}
								icon={<Icon.live size={14} />}
								badge="cardData"
							>
								<DataSectionFields style={gStyle} onChange={(n) => setGStyle(n)} />
							</GlassBox>
						) : (
							<PerUpDataSection
								base={puBaseStyle}
								value={puByKind.live}
								onChange={(next) =>
									setPuByKind((bk) => {
										const nb = { ...bk };
										if (next) nb.live = next;
										else delete nb.live;
										return nb;
									})
								}
							/>
						))}

					{/* 直播封面 —— 仅「直播开播」tab。全局作用域改 gStyle 基准(engines 的全局默认
					    封面即读它);per-UP 单独覆盖走 cardStyleByKind.live 的 liveCoverImages 单字段,
					    与「单独样式」(颜色)/「直播数据」(show)互不牵动。 */}
					{!isGlobalTab &&
						kind === "live" &&
						(isGlobalScope ? (
							<GlassBox
								title="直播封面"
								subtitle="选图替换推送卡的直播间封面(B 站封面/关键帧);多张每次推送轮换;清空恢复 B 站封面"
								accent={KIND_LABELS.live.tone}
								icon={<Icon.live size={14} />}
								badge="liveCover"
							>
								<Field code="liveCoverImages" full>
									<GalleryPicker
										value={gStyle.liveCoverImages}
										onChange={(next) => setGStyle({ ...gStyle, liveCoverImages: next })}
										onAssetDeleted={sweepDeletedAsset}
										emptyHint="未选择(用 B 站直播间原始封面)"
										singleHint="单张固定封面"
									/>
								</Field>
							</GlassBox>
						) : (
							<PerUpCoverSection
								base={gStyle.liveCoverImages}
								value={puByKind.live}
								onChange={(next) =>
									setPuByKind((bk) => {
										const nb = { ...bk };
										if (next) nb.live = next;
										else delete nb.live;
										return nb;
									})
								}
								onAssetDeleted={sweepDeletedAsset}
							/>
						))}

					{/* 卡片版式 —— 仅「类型」tab(全局 tab 只调全局样式,不碰具体卡片版式)。 */}
					{!isGlobalTab &&
						(isGlobalScope ? (
							gLayout ? (
								<GlassBox
									title="卡片版式"
									subtitle="拖拽排序 · 开关显隐 · 改动实时反映到预览"
									accent={KIND_LABELS[kind].tone}
									icon={<KindIcon size={14} />}
									badge="cardLayout"
								>
									<CardLayoutEditor kind={kind} layout={gLayout} onChange={setGLayout} />
								</GlassBox>
							) : null
						) : (
							<GlassBox
								title="卡片版式覆盖"
								subtitle="开 = 该 UP 用自定义版式(整份复制全局后编辑);关 = 继承全局版式"
								accent={KIND_LABELS[kind].tone}
								icon={<KindIcon size={14} />}
								badge={puLayout ? "覆盖中" : "继承"}
								right={
									<Toggle
										value={puLayout !== undefined}
										onChange={(on) =>
											setPuLayout(on ? structuredClone(gLayout ?? serverGlobalLayout) : undefined)
										}
									/>
								}
							>
								{puLayout ? (
									<CardLayoutEditor kind={kind} layout={puLayout} onChange={setPuLayout} />
								) : (
									<InheritNote>该 UP 继承全局卡片版式</InheritNote>
								)}
							</GlassBox>
						))}

					{/* 测试推送 + 预览内容编辑 —— 仅「类型」tab(全局只看四卡全家福,不带测试推送)。 */}
					{!isGlobalTab && (
						<TestPushCard
							kind={kind}
							style={effStyle}
							pushContent={previewContent}
							layout={effLayout}
							fallback={previewFallback}
							mockContent={content}
							setMockContent={setContent}
							realData={!isGlobalScope}
							realDataLabel={
								focusedSub
									? `使用 ${displayName(focusedSub)} 的真实数据渲染预览；未开播 / 无动态 / 网络异常时自动回退示例数据。`
									: undefined
							}
						/>
					)}
				</div>

				{/* PREVIEW: 全局 tab = 四卡全家福;类型 tab = 单卡 */}
				<div className="flex flex-col gap-2.5">
					{isGlobalTab ? (
						<>
							<div className="flex items-center justify-between text-[13px] text-bn-text-primary">
								<span className="font-bold">
									卡片全家福 · 实时反映{isGlobalScope ? "全局" : "该 UP"}配置
								</span>
								<span className="text-[11px] font-normal text-bn-text-secondary">
									四种卡片各自生效样式 · puppeteer 真实渲染
								</span>
							</div>
							{/* 一个框装四张卡:2×2 四宫格。固定高度(参考选项卡片满展开时的观感取值,不跟随它),
							    四格 grid-rows-2 等分该高度,卡片 object-contain 缩放填格。 */}
							<div className="flex h-180 flex-col rounded-bn-card border border-bn-border p-4">
								<div className="grid min-h-0 flex-1 grid-cols-2 grid-rows-2 gap-3">
									{familyPreviews.map(({ fk, style, content: fcontent }) => {
										const FkIcon = Icon[KIND_LABELS[fk].icon];
										// 该类型是否有「单独样式」覆盖(全局看 gByKind,per-UP 看 puByKind)→ 角标提示。
										const overridden =
											(isGlobalScope ? gByKind : puByKind)[toStyleKind(fk)] !== undefined;
										return (
											<div key={fk} className="flex min-h-0 flex-col gap-1">
												<div className="flex items-center gap-1 text-[11px] font-bold text-bn-text-tertiary">
													<FkIcon size={11} />
													{KIND_LABELS[fk].label}
													{overridden ? (
														<Pill color={KIND_LABELS[fk].tone} subtle size="sm">
															单独
														</Pill>
													) : null}
												</div>
												<div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden">
													<CardPreview
														kind={fk}
														style={style}
														content={fcontent}
														layout={effLayout}
														fallback={previewFallback}
														frame={false}
													/>
												</div>
											</div>
										);
									})}
								</div>
							</div>
							<div className="rounded-md border border-bn-border-subtle bg-bn-surface/60 px-3 py-2 text-[11px] italic text-bn-text-secondary">
								{isGlobalScope
									? "全局基准应用到四种卡片;要单独调某张卡,点左侧对应类型标签。"
									: focusedSub
										? `${displayName(focusedSub)} 的四种卡片;未覆盖项继承全局,单独调某张卡点左侧类型标签。`
										: ""}
							</div>
						</>
					) : (
						<>
							<div className="flex items-center justify-between text-[13px] text-bn-text-primary">
								<span className="font-bold">
									卡片预览 · 实时反映{isGlobalScope ? "全局" : "该 UP"}配置
								</span>
								<span className="text-[11px] font-normal text-bn-text-secondary">
									puppeteer 真实渲染 · 渲染宽度
									{kind === "sc" ? " 280" : kind === "guard" ? " 430" : " 600"}px
								</span>
							</div>
							<CardPreview
								kind={kind}
								style={effStyle}
								content={previewContent}
								layout={effLayout}
								fallback={previewFallback}
							/>

							{/* Effective style readout */}
							<div className="flex flex-wrap gap-3.5 rounded-md border border-bn-border-subtle bg-bn-surface/60 px-3 py-2 font-mono text-[10.5px] text-bn-text-tertiary">
								<span>
									cardColorStart: <b className="text-bn-text-primary">{effStyle.cardColorStart}</b>
								</span>
								<span>
									cardColorEnd: <b className="text-bn-text-primary">{effStyle.cardColorEnd}</b>
								</span>
								<span className="italic text-bn-text-secondary">
									{isGlobalScope
										? "全局默认 · 上方切 UP 可单独覆盖"
										: focusedSub
											? `仅 ${displayName(focusedSub)} · 未覆盖项继承全局`
											: ""}
								</span>
							</div>
						</>
					)}
				</div>
			</div>

			{pendingRemoval ? (
				<ConfirmDialog
					title="移除该 UP 的卡片定制?"
					message={
						<>
							将清空 <b className="text-bn-text-primary">{displayName(pendingRemoval)}</b>{" "}
							的卡片样式与版式覆盖,该 UP 之后跟随全局卡片设置。此操作不可撤销。
						</>
					}
					confirmLabel="移除"
					cancelLabel="取消"
					danger
					onConfirm={confirmRemoveSub}
					onCancel={() => setPendingRemoval(null)}
				/>
			) : null}
		</div>
	);
}
