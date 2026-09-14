/**
 * Cards page — image plugin card style preview. Ports `GlassPreviewTab` from
 * `.bn-design/variation-ac.jsx`.
 *
 * A scope switcher (全局默认 / 各 UP) sits on top. Three columns: a left rail
 * (SectionNav) = 全局 + the four card kinds. On the 全局 tab the middle column edits
 * the base style (shared by all cards) + image log level and the right column shows
 * a four-card 全家福 (each kind rendered with its own effective style); to tune one
 * kind you open its tab. On a kind tab the middle column holds that kind's 单独样式
 * override, background gallery and 测试推送 + preview-content form, and the right
 * column is the single live puppeteer preview. In the global scope these bind to
 * GlobalConfig.defaults.{cardStyle,cardStyleByKind}; per-UP they bind to that
 * subscription's overrides, gated by 「覆盖全局」 toggles.
 *
 * 排版归卡片皮肤(ADR-0014):「全局」tab 上的皮肤库是整套外观的入口,per-UP 只挑一套
 * (`overrides.cardSkin`)。旧的一维版式编辑器连同它的配置字段已随决策 15 整个退役 ——
 * 面板里现在搜不到它,那个键只剩服务端一次性迁移时读一遍。
 */

import type { PreviewResponse, TestPushResponse } from "@bilibili-notify/contract";
import { buildPatch } from "@bilibili-notify/internal/patch";
import {
	Btn,
	ConfirmDialog,
	EmptyNote,
	GlassBox,
	HintNote,
	Icon,
	type IconName,
	LoadingBlock,
	Pill,
	SectionNav,
	Toggle,
} from "@bilibili-notify/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { ChromeAutoDetect } from "../components/chrome-autodetect";
import { Field, Picker, TArea, TInput, TSelect } from "../components/forms";
import { HeroStrip } from "../components/hero-strip";
import { InheritNote } from "../components/inherit-note";
import { type Scope, ScopeTabs } from "../components/scope-tabs";
import { GUARD_LEVELS } from "../config/guard-levels";
import { PUSH_TONE } from "../config/push-kinds";
import { SECTION_ACCENT } from "../config/section-accents";
import { useDirtyDraft } from "../hooks/useDirtyDraft";
import { ApiError, api } from "../services/api";
import type { PushTarget, Subscription } from "../types/domain";
import type { CardStyle, GlobalConfig } from "../types/globals";
import { walkTreeDiff } from "../utils/walkTreeDiff";
import { CardSkinKnobsSection } from "./cards/CardSkinKnobs";
import { CardSkinPicker, CardSkinSection } from "./cards/CardSkinSection";
import { removeFontFromByKind, removeFontFromStyle } from "./cards/font-ops";
import { GalleryPicker } from "./cards/GalleryPicker";
import { removeAssetFromByKind, removeAssetFromStyle } from "./cards/gallery-ops";
import type { CardSkinKnobsBySkin } from "./cards/knob-ops";
import type { CardStyleByKind, CardKind as StyleKind } from "./cards/perkind";
import { previewErrorHint, previewErrorTitle } from "./cards/preview-error";
import { enqueuePreview, PREVIEW_TIMEOUT_MS } from "./cards/preview-queue";
import {
	hasCoverOverride,
	hasShowOverride,
	isEmptyObj,
	omitCover,
	omitShow,
	type ShowKey,
	type StylePartial,
} from "./cards/style-partition";
import { displayName } from "./up/helpers";

/** 本页预览 kind("dyn")↔ 样式键("dynamic")的映射。 */
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
	fallback,
	frame = true,
}: {
	kind: CardKind;
	style: CardStyle;
	/** 已按 kind 选好的内容载荷(全局 = 可编辑 mock;per-UP = 该 UP 真实数据 id)。 */
	content: Record<string, unknown>;
	/** 真实拉取失败时是否回退示例数据(per-UP 自动模式 = true)。 */
	fallback: boolean;
	/** 带边框大容器(单卡预览)。false = 裸图缩放填满父格(全家福格子复用)。 */
	frame?: boolean;
}) {
	// **过渡**(ADR-0014 第一步):`/api/cards/preview` 的 spec 仍收一个可选 `layout`,
	// 而服务端出图那头还没切到皮肤。面板这边已经没有版式模型了,索性一个字也不传 ——
	// 那个字段是 optional,服务端照旧用出厂版式渲染。等渲染器换成皮肤驱动之后,这里
	// 改成传当前生效的皮肤 id(全局 / per-UP 各一份),这条注释一起删。
	//
	// 把整份请求(kind/style/content/fallback)合成一个 spec 做**单一**防抖。
	// 关键:kind / fallback 不能直接进 queryKey 而其余走独立防抖 —— 否则切类型时
	// kind 立刻变、content 防抖没追上,会先用「上一个类型残留的内容」白发一次请求
	// (per-UP 下还会真去拉一次接口),一次操作打两条日志、跑两次 puppeteer。整体防抖
	// 后一次变更只触发一次 refetch。TArea / 图廊等控件的高频 onChange 同样收敛。
	const spec = useMemo(
		() => ({ kind, style, content, fallback }),
		[kind, style, content, fallback],
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
		/* `inset` + 自带外壳:这块占的是预览图的位置,底与宽度要跟着预览框走,
		   `card` 变体那层玻璃会和外面的预览区叠成玻璃叠玻璃。 */
		<LoadingBlock
			label="puppeteer 渲染中"
			variant="inset"
			className="w-full max-w-95 rounded-bn-card bg-bn-surface/70"
		/>
	) : query.error ? (
		<div className="w-full max-w-95 rounded-xl bg-bn-surface p-4 text-bn-sm">
			<div className="mb-1 font-bold text-bn-danger-text">{previewErrorTitle(status)}</div>
			<div className="text-bn-text-secondary">{apiErr?.message ?? "未知错误"}</div>
			{previewErrorHint(status) ? (
				<div className="mt-2 text-bn-xs text-bn-text-tertiary">{previewErrorHint(status)}</div>
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

/**
 * 预览内容 + 测试推送(合并卡)—— 上半编辑该类型的预览内容(全局可改 mock,per-UP 用真实
 * 数据),下半把当前预览卡片(草稿样式 + 类型 + 内容)渲染成图片推给所选 PushTarget。
 * 所见即所推:用的是当前预览正在调的草稿,无需先保存。
 */
function TestPushCard({
	kind,
	style,
	pushContent,
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
			// 同 PreviewImage 的过渡注释:版式已归皮肤,这一轮一个字也不传 layout。
			const res = await api.post<TestPushResponse>("/api/cards/test-push", {
				targetId,
				kind,
				style,
				content: pushContent,
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
			accent={SECTION_ACCENT.capability}
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
					<div className="mt-2 text-bn-xs text-bn-danger-text">
						推送失败:{(push.error as ApiError)?.message ?? "未知错误"}
					</div>
				) : push.isSuccess ? (
					<div className="mt-2 text-bn-xs text-bn-success-text">
						已送达 · {push.data.latencyMs}ms
					</div>
				) : null}
			</div>
		</GlassBox>
	);
}

// 背景图选择改用图廊多选组件 GalleryPicker(支持上传 / 删盘 / 轮换序);缩略图 hook
// 抽到 ./cards/useAssetObjectUrl 与之共享。

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
 * `realDataLabel` 缺省时的那句兜底也抄了两份;局部收编后又与 FontPicker /
 * UpDialog 的旁注各配各的圆角 —— 观感统一升进了库的 {@link HintNote},这里
 * 只剩「这条旁注是报喜档」这层领域语义。
 */
function RealDataNote({ children }: { children: React.ReactNode }) {
	return <HintNote tone="success">{children}</HintNote>;
}

/** 「这一档的某些样式不归你管」的中性说明条 —— SC 与上舰各一条。 */
function KindHintNote({ children }: { children: React.ReactNode }) {
	return <HintNote>{children}</HintNote>;
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
					<KindHintNote>左侧渐变色对 SC 不生效；SC 卡片背景色由价格档位自动决定。</KindHintNote>
				</>
			) : (
				<>
					<Field code="level">
						<div className="flex flex-wrap gap-1.5">
							{GUARD_LEVELS.map((g) => {
								const active = content.guard.level === g.level;
								return (
									<button
										type="button"
										key={g.level}
										onClick={() => setGuard({ level: g.level })}
										data-bn={active ? "chip chip-active" : "chip"}
										className="rounded-sm px-3 py-1 text-bn-xs font-semibold transition"
										style={
											active
												? { background: g.color, color: "var(--color-bn-on-solid)" }
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
					<KindHintNote>
						左侧渐变色对上舰不生效；卡片背景色与徽章图由舰长等级自动决定。
					</KindHintNote>
				</>
			)}
		</>
	);
}

/** 预览列的头行:左粗标题 + 右小字说明 —— 全家福与单卡两分支此前各抄一份。 */
function PreviewHead({ title, note }: { title: React.ReactNode; note: React.ReactNode }) {
	return (
		<div className="flex items-center justify-between text-bn-base text-bn-text-primary">
			<span className="font-bold">{title}</span>
			<span className="text-bn-xs font-normal text-bn-text-secondary">{note}</span>
		</div>
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
		(sub.overrides.cardSkin ? 1 : 0)
	);
}
function hasCardCustomization(sub: Subscription): boolean {
	return (
		sub.overrides.cardStyle !== undefined ||
		hasCardStyleByKind(sub) ||
		sub.overrides.cardSkin !== undefined
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
	// 皮肤旋钮的覆盖,按皮肤 id 分层(ADR-0014 决策 16 的 🔗)。全局唯一,不分卡种也不分 UP。
	const [gSkinKnobs, setGSkinKnobs] = useState<CardSkinKnobsBySkin>({});

	// per-UP 覆盖草稿(undefined = 继承全局)
	const [puStyle, setPuStyle] = useState<CardStyle | undefined>(undefined);
	// 按卡片类型的样式覆盖(per-UP)。空 = 各类型跟随该 UP 基准(puStyle ?? 全局)。
	const [puByKind, setPuByKind] = useState<CardStyleByKind>({});
	// 该 UP 单独指定的卡片皮肤;undefined = 跟随全局(保存时把这个键整个清掉)。
	const [puSkin, setPuSkin] = useState<string | undefined>(undefined);

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

	useEffect(() => {
		if (globalsQuery.data) {
			setGStyle(globalsQuery.data.defaults.cardStyle);
			setGByKind(globalsQuery.data.defaults.cardStyleByKind ?? {});
			setGSkinKnobs(globalsQuery.data.defaults.cardSkinKnobs ?? {});
		}
	}, [globalsQuery.data]);

	// 选中 UP 的存储覆盖 → 编辑草稿。cardStyle 合并到全局之上,把历史 partial 覆盖补全
	// 成可直接编辑的完整快照(向后保存即写整份快照)。
	const seededPuStyle = useMemo<CardStyle | undefined>(() => {
		if (!focusedSub?.overrides.cardStyle || !serverGlobalStyle) return undefined;
		return { ...serverGlobalStyle, ...focusedSub.overrides.cardStyle };
	}, [focusedSub?.overrides.cardStyle, serverGlobalStyle]);
	const seededPuSkin = focusedSub?.overrides.cardSkin;
	// per-UP 按类型覆盖的存储值;空对象 = 无覆盖(与 gByKind seed 一致,直接取原始 partial)。
	const seededPuByKind = useMemo<CardStyleByKind>(
		() => focusedSub?.overrides.cardStyleByKind ?? {},
		[focusedSub?.overrides.cardStyleByKind],
	);

	// 切换到不同 UP(或其服务端数据变化)→ 重新 seed 覆盖草稿。
	useEffect(() => {
		setPuStyle(seededPuStyle);
		setPuByKind(seededPuByKind);
		setPuSkin(seededPuSkin);
	}, [seededPuStyle, seededPuByKind, seededPuSkin]);

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
			cardSkinKnobs: CardSkinKnobsBySkin;
		}) => {
			// 只挑本页真正编辑的 scope 做 diff —— 下发全量会让服务端的 enable-check
			// 每次保存都跑一遍 puppeteer 启动 + chat.completions 探针。草稿里消失的键
			// (关掉的 per-kind 样式)由 buildPatch 自动变成显式 null,不必再逐个记着手写。
			const base = globalsQuery.data;
			await api.patch<GlobalConfig>(
				"/api/globals",
				buildPatch(
					{
						defaults: {
							cardStyle: payload.cardStyle,
							cardStyleByKind: payload.cardStyleByKind,
							// 「还原」一枚旋钮是把键删掉,而删除只有走 buildPatch 的 diff 才发得出去
							// (草稿里没了 + 基线里有 → 显式 null)。手写 payload 的话那个键只是
							// 「不出现」= 服务端读作「别动」,于是还原永远不生效。
							cardSkinKnobs: payload.cardSkinKnobs,
						},
					},
					{
						defaults: {
							cardStyle: base?.defaults.cardStyle,
							cardStyleByKind: base?.defaults.cardStyleByKind ?? {},
							cardSkinKnobs: base?.defaults.cardSkinKnobs ?? {},
						},
					},
				),
			);
			// 旋钮变没变要在这儿算:这是**保存前**那份基线,onSuccess 里 globals 已经在重取了。
			return {
				knobsChanged:
					walkTreeDiff(base?.defaults.cardSkinKnobs ?? {}, payload.cardSkinKnobs).length > 0,
			};
		},
		onSuccess: (res) => {
			void qc.invalidateQueries({ queryKey: ["globals"] });
			// 旋钮**不进预览 spec** —— 服务端出图时自己从 globals 里读那一层。于是拧完保存,
			// `["card-preview", spec]` 这个 key 一个字都没变,react-query 端出来的还是保存前
			// 那张图,看着就是「拧了没反应」。别的卡片设置没这个毛病:它们本来就在 spec 里,
			// 编辑当场就重画了。按需作废 —— 无条件作废等于每次保存白跑一遍 puppeteer。
			if (res.knobsChanged) void qc.invalidateQueries({ queryKey: ["card-preview"] });
		},
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
					// 「跟随全局」= 把这个键清掉。undefined 在 JSON 里根本表达不出来(见
					// api.patch 的 nullifyUndefined),必须落成显式 null 才是删除哨兵 ——
					// 否则键消失 = 服务端读作「不改」,选回「跟随全局」永远生效不了。
					cardSkin: puSkin ?? null,
				},
			});
		},
		onSuccess: () => qc.invalidateQueries({ queryKey: ["subscriptions"] }),
	});

	const removeCardCustomization = useMutation({
		mutationFn: async (sub: Subscription) =>
			api.patch<Subscription>(`/api/subs/${sub.id}`, {
				overrides: { cardStyle: null, cardStyleByKind: null, cardSkin: null },
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
	//
	// 全局那份**不含** cardSkin:换全局皮肤是皮肤库里点一下就生效(PUT /active 直改
	// globals),不是草稿 —— 塞进来只会让灵动岛拿一个永远不脏的键去 diff。
	const globalIslandDraft = useMemo(() => {
		if (gStyle === null) return null;
		return {
			...gStyle,
			cardStyleByKind: gByKind,
			cardSkinKnobs: gSkinKnobs,
		};
	}, [gStyle, gByKind, gSkinKnobs]);
	const globalIslandBaseline = useMemo(() => {
		if (!globalsQuery.data) return null;
		return {
			...globalsQuery.data.defaults.cardStyle,
			cardStyleByKind: globalsQuery.data.defaults.cardStyleByKind ?? {},
			cardSkinKnobs: globalsQuery.data.defaults.cardSkinKnobs ?? {},
		};
	}, [globalsQuery.data]);
	const perUpIslandDraft = useMemo(
		() => ({ ...(puStyle ?? {}), cardStyleByKind: puByKind, cardSkin: puSkin ?? null }),
		[puStyle, puByKind, puSkin],
	);
	const perUpIslandBaseline = useMemo(
		() => ({
			...(seededPuStyle ?? {}),
			cardStyleByKind: seededPuByKind,
			cardSkin: seededPuSkin ?? null,
		}),
		[seededPuStyle, seededPuByKind, seededPuSkin],
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
				if (gStyle !== null)
					await saveGlobal.mutateAsync({
						cardStyle: gStyle,
						cardStyleByKind: gByKind,
						cardSkinKnobs: gSkinKnobs,
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
				setGSkinKnobs(globalsQuery.data.defaults.cardSkinKnobs ?? {});
			} else {
				setPuStyle(seededPuStyle);
				setPuByKind(seededPuByKind);
				setPuSkin(seededPuSkin);
			}
		},
	});

	if (!gStyle) {
		return <LoadingBlock label="加载卡片样式中" />;
	}

	// 按 kind 求「生效样式」:全局作用域 = 全局基准 + 该类型覆盖;per-UP = 再叠该 UP 基准 /
	// 类型覆盖(puStyle 覆盖基准时整份替换;否则继承全局该类型生效值)。
	const effStyleFor = (sk: StyleKind): CardStyle => {
		// 全局 per-kind 现在**什么都不贡献**:它从前只贡献外观那一族(字体 / 背景),而那两项
		// 2026-09-14 退役成了皮肤旋钮;show 只认基准 gStyle,封面只认基准 / per-UP kind 层。
		// per-UP per-kind 的 show / 封面仍是该 UP 的独立覆盖,整份 spread 保留。
		const gEff: CardStyle = { ...gStyle };
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
		: { ...gStyle };
	const effStyle: CardStyle = effStyleFor(styleKind);

	return (
		<div className="bn-anim-page-in flex flex-col gap-4">
			{/* Hero strip — 全局插件信息 + (仅全局作用域)总开关 */}
			<HeroStrip
				icon={<Icon.eye size={26} />}
				title={
					<>
						卡片渲染
						<Pill color="var(--color-bn-purple)" subtle size="sm">
							image
						</Pill>
					</>
				}
				subtitle="puppeteer-core 把 Vue/UnoCSS 模板渲染成 PNG;关闭后 push 流程仅发送文本回退。"
				right={
					isGlobalScope ? (
						<Picker
							value={gStyle.enabled}
							onChange={(v) => setGStyle((d) => (d ? { ...d, enabled: v } : d))}
							options={[
								{ value: true, label: "启用", color: "var(--color-bn-purple)" },
								{ value: false, label: "停用", color: "var(--color-bn-inactive)" },
							]}
						/>
					) : (
						<span className="rounded-md border border-bn-border-subtle bg-bn-surface/70 px-2.5 py-1 text-bn-xs text-bn-text-tertiary">
							总开关在全局作用域
						</span>
					)
				}
			/>

			{/* 作用域切换 */}
			<ScopeTabs
				scope={scope}
				onChange={setScope}
				tabSubs={tabSubs}
				availableSubs={availableSubs}
				onAddSub={handleAddSub}
				onRemoveSub={handleRemoveSub}
				overridesCountFor={cardOverrideCount}
				globalHint="此处为全部 UP 的默认卡片样式与皮肤"
				perUpHint={(sub) =>
					sub ? (
						<>
							仅作用于 <b className="text-bn-pink">{sub.uid}</b>,未开启的覆盖继承全局
						</>
					) : null
				}
			/>

			<div className="grid gap-3.5 xl:grid-cols-[220px_380px_minmax(0,1fr)]">
				{/* RAIL: 全局基准 + 各卡片类型 —— 选中决定编辑的样式 + 预览的卡片种类 */}
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
					{/* 字体与背景图 2026-09-14 退役成**皮肤自己的旋钮**(主人拍板):它们在皮肤底下
					    多半不生效 —— 皮肤写一句 `font-family`、自己画一层背景就盖掉了,而面板照样
					    让人调。四个「外观」盒(全局 / per-UP / 两处按卡种)编的都是这两项,一起撤掉;
					    剩下的数据区开关与直播封面不是外观,各有各的盒子。 */}
					{!isGlobalTab && kind !== "live" ? (
						<EmptyNote>
							这种卡的排版与观感现在整个归皮肤管 —— 去下面的皮肤库挑一套,或者「复制一份」再改。
						</EmptyNote>
					) : null}

					{/* 卡片皮肤 —— 仅「全局」tab。皮肤是**整套外观**(七种卡一起换),不分卡种,
					    所以它不该出现在类型 tab 上;旧的「卡片版式」一节正是按卡种各一份,
					    那一节连同它的数据模型一起退役了(ADR-0014 决策 15 / 20)。 */}
					{isGlobalTab &&
						(isGlobalScope ? (
							<>
								<CardSkinSection />
								{/* 旋钮值住全局配置、按皮肤 id 分层(不分卡种也不分 UP),所以只在全局作用域出现
								    —— per-UP 那边挑的是「用哪套皮肤」,不是拧这套皮肤的钮。 */}
								<CardSkinKnobsSection value={gSkinKnobs} onChange={setGSkinKnobs} />
							</>
						) : (
							<GlassBox
								title="卡片皮肤"
								subtitle="这个 UP 的推送卡用哪套皮肤;不选就跟随全局。想单独改排版,先在全局皮肤库「复制一份」再改"
								accent="var(--color-bn-purple)"
								icon={<Icon.palette size={14} />}
								badge={puSkin ? "单独指定" : "跟随全局"}
							>
								<CardSkinPicker value={puSkin} onChange={setPuSkin} />
							</GlassBox>
						))}

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

					{/* 测试推送 + 预览内容编辑 —— 仅「类型」tab(全局只看四卡全家福,不带测试推送)。 */}
					{!isGlobalTab && (
						<TestPushCard
							kind={kind}
							style={effStyle}
							pushContent={previewContent}
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
							<PreviewHead
								title={<>卡片全家福 · 实时反映{isGlobalScope ? "全局" : "该 UP"}配置</>}
								note="四种卡片各自生效样式 · puppeteer 真实渲染"
							/>
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
												<div className="flex items-center gap-1 text-bn-xs font-bold text-bn-text-tertiary">
													<FkIcon size={11} />
													{KIND_LABELS[fk].label}
													{overridden ? (
														<Pill color={KIND_LABELS[fk].tone} subtle size="sm">
															单独
														</Pill>
													) : null}
												</div>
												<div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden">
													<PreviewImage
														kind={fk}
														style={style}
														content={fcontent}
														fallback={previewFallback}
														frame={false}
													/>
												</div>
											</div>
										);
									})}
								</div>
							</div>
							<div className="rounded-md border border-bn-border-subtle bg-bn-surface/60 px-3 py-2 text-bn-xs italic text-bn-text-secondary">
								{isGlobalScope
									? "全局基准应用到四种卡片;要单独调某张卡,点左侧对应类型标签。"
									: focusedSub
										? `${displayName(focusedSub)} 的四种卡片;未覆盖项继承全局,单独调某张卡点左侧类型标签。`
										: ""}
							</div>
						</>
					) : (
						<>
							<PreviewHead
								title={<>卡片预览 · 实时反映{isGlobalScope ? "全局" : "该 UP"}配置</>}
								note={
									<>
										puppeteer 真实渲染 · 渲染宽度
										{kind === "sc" ? " 280" : kind === "guard" ? " 430" : " 600"}px
									</>
								}
							/>
							<PreviewImage
								kind={kind}
								style={effStyle}
								content={previewContent}
								fallback={previewFallback}
							/>

							{/* Effective style readout */}
							<div className="flex flex-wrap gap-3.5 rounded-md border border-bn-border-subtle bg-bn-surface/60 px-3 py-2 font-mono text-bn-2xs text-bn-text-tertiary">
								<span>
									font: <b className="text-bn-text-primary">{effStyle.font}</b>
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
							的卡片样式与皮肤覆盖,该 UP 之后跟随全局卡片设置。此操作不可撤销。
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
