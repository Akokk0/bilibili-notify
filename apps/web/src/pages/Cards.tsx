/**
 * Cards page — image plugin card style preview. Ports `GlassPreviewTab` from
 * `.bn-design/variation-ac.jsx`.
 *
 * A scope switcher (全局默认 / 各 UP) sits on top. In the global scope the three
 * columns bind to GlobalConfig.defaults.{cardStyle,cardLayout}; in a per-UP scope
 * they bind to that subscription's overrides.{cardStyle,cardLayout}, each gated by
 * a 「覆盖全局」 toggle (off = inherit). Left: card-style config + preview-content
 * form. Middle: live puppeteer preview of the EFFECTIVE style+layout for ALL four
 * kinds. Right: the 卡片版式 layout editor + 测试推送.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Btn, Pill, Toggle } from "../components/atoms";
import { ChromeAutoDetect } from "../components/chrome-autodetect";
import { ConfirmDialog } from "../components/dialog";
import {
	Field,
	LogLevelPicker,
	type LogLevelValue,
	Picker,
	TArea,
	TColor,
	TInput,
} from "../components/forms";
import { GlassBox } from "../components/glass-box";
import { Icon, type IconName } from "../components/icons";
import { type Scope, ScopeTabs } from "../components/scope-tabs";
import { useDirtyDraft } from "../hooks/useDirtyDraft";
import { ApiError, api } from "../services/api";
import type { CardLayoutFull, PushTarget, Subscription } from "../types/domain";
import type { CardStyle, GlobalConfig, LogLevel } from "../types/globals";
import { CardLayoutEditor } from "./cards/CardLayoutEditor";
import { displayName } from "./up/helpers";

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
	live: { label: "直播开播", tone: "#FF6699", icon: "live" },
	dyn: { label: "动态发布", tone: "#00AEEC", icon: "dyn" },
	sc: { label: "SC 提醒", tone: "#fdcb6e", icon: "sc" },
	guard: { label: "上舰提醒", tone: "#f2a053", icon: "guard" },
};

interface PreviewResponse {
	ok: boolean;
	dataUrl?: string;
	err?: string;
}

function PreviewImage({
	kind,
	style,
	content,
	layout,
	fallback,
}: {
	kind: CardKind;
	style: CardStyle;
	/** 已按 kind 选好的内容载荷(全局 = 可编辑 mock;per-UP = 该 UP 真实数据 id)。 */
	content: Record<string, unknown>;
	layout: CardLayoutFull | null;
	/** 真实拉取失败时是否回退示例数据(per-UP 自动模式 = true)。 */
	fallback: boolean;
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
		queryFn: async () => {
			const res = await api.post<PreviewResponse>("/api/cards/preview", debouncedSpec);
			if (!res.ok || !res.dataUrl) {
				throw new ApiError(500, res, res.err ?? "preview failed");
			}
			return res.dataUrl;
		},
		retry: false,
	});

	const showSkeleton = query.isPending;
	const apiErr = query.error as ApiError | undefined;
	const status = apiErr?.status;

	return (
		<div className="relative flex min-h-105 items-center justify-center rounded-bn-card border border-bn-border p-7">
			{showSkeleton ? (
				<div className="flex w-95 flex-col items-center gap-3 rounded-xl bg-bn-surface/70 p-6">
					<div className="bn-anim-spin h-8 w-8 rounded-full border-2 border-bn-pink/30 border-t-bn-pink" />
					<div className="text-[12px] font-bold text-bn-text-secondary">puppeteer 渲染中…</div>
				</div>
			) : query.error ? (
				<div className="w-95 rounded-xl bg-bn-surface p-4 text-[12px]">
					<div className="mb-1 font-bold text-bn-danger-text">
						{status === 503 ? "puppeteer 未配置" : status === 501 ? "kind 暂未支持" : "渲染失败"}
					</div>
					<div className="text-bn-text-secondary">{apiErr?.message ?? "未知错误"}</div>
					{status === 503 ? <ChromeAutoDetect onEnabled={() => query.refetch()} /> : null}
				</div>
			) : (
				<img
					src={query.data}
					srcSet={`${query.data} 2x`}
					alt="卡片实时预览"
					className="bn-anim-fade-in max-w-full rounded-xl shadow-[0_6px_20px_rgba(0,0,0,0.14)]"
				/>
			)}
		</div>
	);
}

function CardPreview({
	kind,
	style,
	content,
	layout,
	fallback,
}: {
	kind: CardKind;
	style: CardStyle;
	content: Record<string, unknown>;
	layout: CardLayoutFull | null;
	fallback: boolean;
}) {
	return (
		<PreviewImage kind={kind} style={style} content={content} layout={layout} fallback={fallback} />
	);
}

interface TestPushResponse {
	ok: boolean;
	latencyMs: number;
	err?: string;
}

/**
 * 测试推送 —— 把当前预览卡片(草稿样式 + 类型 + 内容)渲染成图片,推给所选
 * PushTarget。所见即所推:用的是当前预览正在调的草稿,无需先保存。
 */
function TestPushCard({
	kind,
	style,
	content,
	layout,
	fallback,
}: {
	kind: CardKind;
	style: CardStyle;
	content: Record<string, unknown>;
	layout: CardLayoutFull | null;
	fallback: boolean;
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
				content,
				layout: layout ?? undefined,
				fallback,
			});
			if (!res.ok) throw new ApiError(500, res, res.err ?? "推送失败");
			return res;
		},
	});

	return (
		<GlassBox
			title="测试推送"
			subtitle="把当前预览卡片(草稿样式)作为图片推送到所选目标"
			accent="#00b894"
			icon={<Icon.bell size={14} />}
			badge="test-push"
		>
			<Field code="targetId" full>
				<select
					value={targetId}
					onChange={(e) => setTargetId(e.target.value)}
					disabled={targets.length === 0}
					className="w-full rounded-md border border-bn-border bg-bn-surface px-2.5 py-2 text-[12.5px] text-bn-text-primary outline-none focus:border-bn-pink disabled:opacity-50"
				>
					{targets.length === 0 ? (
						<option value="">无可用推送目标</option>
					) : (
						targets.map((t) => (
							<option key={t.id} value={t.id}>
								{t.name}
							</option>
						))
					)}
				</select>
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
					<div className="mt-2 text-[11px] text-emerald-600">已送达 · {push.data.latencyMs}ms</div>
				) : null}
			</div>
		</GlassBox>
	);
}

/**
 * 拉资产二进制并转 object URL 给缩略图用。`<img src="/api/cards/asset/:id">` 直连在
 * 桌面壳(token-header 鉴权)下会 401 —— img 标签不带自定义 header。改由 `api.blob`
 * 带鉴权头 fetch、createObjectURL 喂 img;assetId 变化 / 卸载时 revoke 旧 URL 防泄漏。
 * 空 id 返回 null(显示占位)。
 */
function useAssetObjectUrl(assetId: string): string | null {
	const [url, setUrl] = useState<string | null>(null);
	useEffect(() => {
		if (!assetId) {
			setUrl(null);
			return;
		}
		let cancelled = false;
		let objectUrl: string | null = null;
		api
			.blob(`/api/cards/asset/${assetId}`)
			.then((blob) => {
				if (cancelled) return;
				objectUrl = URL.createObjectURL(blob);
				setUrl(objectUrl);
			})
			.catch(() => {
				if (!cancelled) setUrl(null);
			});
		return () => {
			cancelled = true;
			if (objectUrl) URL.revokeObjectURL(objectUrl);
		};
	}, [assetId]);
	return url;
}

/**
 * 背景图选择器 —— 上传 PNG/JPEG/WebP 到 `/api/cards/asset`,把返回的资产 id 存进
 * cardStyle.backgroundImage。空 = 走渐变。缩略图经 `api.blob` 带鉴权头拉取(桌面壳
 * 也能显示,见 {@link useAssetObjectUrl});移除即清空字段。
 */
function BackgroundImagePicker({
	value,
	onChange,
}: {
	value: string;
	onChange: (id: string) => void;
}) {
	const [uploading, setUploading] = useState(false);
	const [err, setErr] = useState<string | null>(null);
	const thumbUrl = useAssetObjectUrl(value);

	const onFile = async (file: File | undefined) => {
		if (!file) return;
		setErr(null);
		setUploading(true);
		try {
			const form = new FormData();
			form.append("file", file);
			const res = await api.upload<{ ok: boolean; id?: string; err?: string }>(
				"/api/cards/asset",
				form,
			);
			if (!res.ok || !res.id) throw new Error(res.err ?? "上传失败");
			onChange(res.id);
		} catch (e) {
			setErr((e as Error).message);
		} finally {
			setUploading(false);
		}
	};

	return (
		<div className="flex items-center gap-2">
			{value ? (
				thumbUrl ? (
					<img
						src={thumbUrl}
						alt="背景图"
						className="h-9 w-14 shrink-0 rounded border border-bn-border-subtle object-cover"
					/>
				) : (
					<span className="grid h-9 w-14 shrink-0 place-items-center rounded border border-bn-border-subtle bg-bn-surface-muted text-[10px] text-bn-text-tertiary">
						…
					</span>
				)
			) : (
				<span className="text-[11px] text-bn-text-tertiary">未设置（用渐变）</span>
			)}
			<label className="cursor-pointer rounded-md border border-bn-border bg-bn-surface px-2.5 py-1 text-[11.5px] font-medium text-bn-text-primary transition hover:border-bn-pink">
				{uploading ? "上传中…" : value ? "更换" : "上传图片"}
				<input
					type="file"
					accept="image/png,image/jpeg,image/webp"
					className="hidden"
					disabled={uploading}
					onChange={(e) => onFile(e.target.files?.[0])}
				/>
			</label>
			{value ? (
				<button
					type="button"
					onClick={() => onChange("")}
					className="text-[11px] text-bn-text-tertiary transition hover:text-bn-danger-text"
				>
					移除
				</button>
			) : null}
			{err ? <span className="text-[11px] text-bn-danger-text">{err}</span> : null}
		</div>
	);
}

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
function CardStyleFields({
	style,
	onChange,
}: {
	style: CardStyle;
	onChange: (next: CardStyle) => void;
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
				<TInput value={style.font} onChange={(v) => set("font", v)} />
			</Field>
			<Field code="hideDesc">
				<div className="flex h-7.5 items-center">
					<Toggle value={style.hideDesc} onChange={(v) => set("hideDesc", v)} />
				</div>
			</Field>
			<Field code="hideFollower">
				<div className="flex h-7.5 items-center">
					<Toggle value={style.hideFollower} onChange={(v) => set("hideFollower", v)} />
				</div>
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
			<Field code="backgroundImage" full>
				<BackgroundImagePicker
					value={style.backgroundImage}
					onChange={(id) => set("backgroundImage", id)}
				/>
			</Field>
		</>
	);
}

/**
 * 「预览内容」框 —— 卡片类型切换 + 各类型的 mock/真实内容字段。与作用域无关
 * (预览的是哪类卡片、用什么内容,跟改谁的样式独立)。
 */
function PreviewContentBox({
	kind,
	setKind,
	content,
	setContent,
	realData = false,
	realDataLabel,
}: {
	kind: CardKind;
	setKind: (k: CardKind) => void;
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

	const KindIcon = Icon[KIND_LABELS[kind].icon];

	return (
		<GlassBox
			title="预览内容"
			subtitle={
				kind === "live"
					? "拉取目标直播间的真实数据"
					: kind === "dyn"
						? "拉取指定 UP 的某条动态"
						: "自定义文案 · mock 头像/数值"
			}
			accent={KIND_LABELS[kind].tone}
			icon={<KindIcon size={14} />}
			badge={kind}
		>
			{/* 卡片类型切换 —— 决定下方表单字段 + 右侧渲染的卡片种类。 */}
			<div className="mb-3 flex flex-wrap gap-1.5">
				{(["live", "dyn", "sc", "guard"] as const).map((k) => {
					const active = kind === k;
					const tone = KIND_LABELS[k].tone;
					return (
						<button
							type="button"
							key={k}
							onClick={() => setKind(k)}
							className="rounded px-3 py-1 text-[11.5px] font-semibold transition"
							style={
								active
									? { background: tone, color: "white" }
									: {
											background: "var(--color-bn-hover-muted)",
											color: "var(--color-bn-text-tertiary)",
										}
							}
						>
							{KIND_LABELS[k].label}
						</button>
					);
				})}
			</div>
			{realData ? (
				<div className="rounded border border-dashed bg-bn-success-soft/60 p-2.5 text-[11px] text-emerald-800">
					{kind === "live" || kind === "dyn"
						? (realDataLabel ??
							"使用该 UP 的真实数据渲染预览；未开播 / 无动态 / 网络异常时自动回退示例数据。")
						: "SC / 上舰:接收方为该 UP(真实名字 / 头像),发送者 / 新舰长取当前登录账号;解析失败回退示例。"}
				</div>
			) : kind === "live" ? (
				<>
					<Field code="roomId">
						<TInput
							value={content.live.roomId}
							onChange={(v) => setLive({ roomId: v })}
							placeholder="留空则使用示例数据"
						/>
					</Field>
					<div className="rounded border border-dashed bg-bn-success-soft/60 p-2.5 text-[11px] text-emerald-800">
						需要后端账号已登录 B 站；填入后将真实拉取该直播间数据并渲染。留空则继续使用示例数据。
					</div>
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
					<div className="rounded border border-dashed bg-bn-success-soft/60 p-2.5 text-[11px] text-emerald-800">
						需要后端账号已登录 B 站；填入后将拉取该 UP 的 space 动态列表，按 offset 选取并渲染。
					</div>
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
					<div className="rounded border border-dashed bg-bn-surface-muted p-2.5 text-[11px] text-bn-text-tertiary">
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
										className="rounded px-3 py-1 text-[11.5px] font-semibold transition"
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
					<div className="rounded border border-dashed bg-bn-surface-muted p-2.5 text-[11px] text-bn-text-tertiary">
						左侧渐变色对上舰不生效；卡片背景色与徽章图由舰长等级自动决定。
					</div>
				</>
			)}
		</GlassBox>
	);
}

/** 关闭态下方一行说明文字。 */
function InheritNote({ children }: { children: React.ReactNode }) {
	return (
		<div className="py-6 text-center text-[12px] text-bn-text-tertiary">未启用 · {children}</div>
	);
}

/** 该 sub 已覆盖的卡片切片数(0..2),供 ScopeTabs 计数徽章。 */
function cardOverrideCount(sub: Subscription): number {
	return (sub.overrides.cardStyle ? 1 : 0) + (sub.overrides.cardLayout ? 1 : 0);
}
function hasCardCustomization(sub: Subscription): boolean {
	return sub.overrides.cardStyle !== undefined || sub.overrides.cardLayout !== undefined;
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
	const [gLayout, setGLayout] = useState<CardLayoutFull | null>(null);
	const [imageLogLevel, setImageLogLevel] = useState<ImageLogLevel>("");

	// per-UP 覆盖草稿(undefined = 继承全局)
	const [puStyle, setPuStyle] = useState<CardStyle | undefined>(undefined);
	const [puLayout, setPuLayout] = useState<CardLayoutFull | undefined>(undefined);

	// 共享:预览类型 + 内容(与作用域无关)
	const [kind, setKind] = useState<CardKind>("live");
	const [content, setContent] = useState<PreviewContent>(DEFAULT_PREVIEW_CONTENT);

	const allSubs = useMemo(() => subsQuery.data ?? [], [subsQuery.data]);
	const isGlobalScope = scope === "__global";
	const focusedSub = isGlobalScope ? undefined : allSubs.find((s) => s.id === scope);
	const serverGlobalStyle = globalsQuery.data?.defaults.cardStyle;
	const serverGlobalLayout = globalsQuery.data?.defaults.cardLayout;

	useEffect(() => {
		if (globalsQuery.data) {
			setGStyle(globalsQuery.data.defaults.cardStyle);
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

	// 切换到不同 UP(或其服务端数据变化)→ 重新 seed 覆盖草稿。
	useEffect(() => {
		setPuStyle(seededPuStyle);
		setPuLayout(seededPuLayout);
	}, [seededPuStyle, seededPuLayout]);

	// 选中的 UP 从订阅列表消失 → 回退全局。
	useEffect(() => {
		if (!isGlobalScope && subsQuery.data && !allSubs.some((s) => s.id === scope)) {
			setScope("__global");
		}
	}, [isGlobalScope, scope, subsQuery.data, allSubs]);

	const saveGlobal = useMutation({
		mutationFn: async (payload: {
			cardStyle: CardStyle;
			cardLayout: CardLayoutFull;
			imageLogLevel: ImageLogLevel;
		}) => {
			const existing = globalsQuery.data?.app.logLevels ?? {};
			// "" → drop the override (fall back to global). Setting to a level
			// → patch only that key, so other module overrides stay untouched.
			const nextLogLevels =
				payload.imageLogLevel === ""
					? Object.fromEntries(Object.entries(existing).filter(([k]) => k !== "image"))
					: { ...existing, image: payload.imageLogLevel };
			await api.patch<GlobalConfig>("/api/globals", {
				app: {
					logLevels: Object.keys(nextLogLevels).length === 0 ? undefined : nextLogLevels,
				},
				defaults: { cardStyle: payload.cardStyle, cardLayout: payload.cardLayout },
			});
		},
		onSuccess: () => qc.invalidateQueries({ queryKey: ["globals"] }),
	});

	// per-UP 保存:只下发卡片两片(缺席键 = 不改其它 slice;null = 清除)。
	const savePerUp = useMutation({
		mutationFn: async (sub: Subscription) => {
			await api.patch<Subscription>(`/api/subs/${sub.id}`, {
				overrides: { cardStyle: puStyle ?? null, cardLayout: puLayout ?? null },
			});
		},
		onSuccess: () => qc.invalidateQueries({ queryKey: ["subscriptions"] }),
	});

	const removeCardCustomization = useMutation({
		mutationFn: async (sub: Subscription) =>
			api.patch<Subscription>(`/api/subs/${sub.id}`, {
				overrides: { cardStyle: null, cardLayout: null },
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
			cardLayout: gLayout,
			app: { logLevels: { image: imageLogLevel === "" ? null : imageLogLevel } },
		};
	}, [gStyle, gLayout, imageLogLevel]);
	const globalIslandBaseline = useMemo(() => {
		if (!globalsQuery.data) return null;
		return {
			...globalsQuery.data.defaults.cardStyle,
			cardLayout: globalsQuery.data.defaults.cardLayout,
			app: { logLevels: { image: globalsQuery.data.app.logLevels?.image ?? null } },
		};
	}, [globalsQuery.data]);
	const perUpIslandDraft = useMemo(
		() => ({ ...(puStyle ?? {}), cardLayout: puLayout ?? null }),
		[puStyle, puLayout],
	);
	const perUpIslandBaseline = useMemo(
		() => ({ ...(seededPuStyle ?? {}), cardLayout: seededPuLayout ?? null }),
		[seededPuStyle, seededPuLayout],
	);

	// 预览内容:全局 = 可编辑 mock;per-UP = 该 UP 真实数据(live/dyn 按 uid,后端解析房间号
	// / 拉动态),失败由 fallback 自动回退示例;sc/guard 无该 UP 真实数据,沿用固定 mock。
	// useMemo 稳定引用 —— 否则每次 render 新建对象会不断重置 PreviewImage 的防抖定时器。
	const previewFallback = !isGlobalScope;
	const previewContent = useMemo<Record<string, unknown>>(() => {
		if (isGlobalScope || !focusedSub) return content[kind];
		if (kind === "live") return { uid: focusedSub.uid };
		if (kind === "dyn") return { uid: focusedSub.uid, offset: 1 };
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
					await saveGlobal.mutateAsync({ cardStyle: gStyle, cardLayout: gLayout, imageLogLevel });
			} else if (focusedSub) {
				await savePerUp.mutateAsync(focusedSub);
			}
		},
		onDiscard: () => {
			if (isGlobalScope) {
				if (!globalsQuery.data) return;
				setGStyle(globalsQuery.data.defaults.cardStyle);
				setGLayout(globalsQuery.data.defaults.cardLayout);
				setImageLogLevel(globalsQuery.data.app.logLevels?.image ?? "");
			} else {
				setPuStyle(seededPuStyle);
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

	// 预览 / 测试推送始终用「生效值」:per-UP 未覆盖则回落全局草稿。
	const effStyle: CardStyle = isGlobalScope ? gStyle : (puStyle ?? gStyle);
	const effLayout: CardLayoutFull | null = isGlobalScope ? gLayout : (puLayout ?? gLayout);

	const KindIcon = Icon[KIND_LABELS[kind].icon];

	return (
		<div className="bn-anim-fade-in flex flex-col gap-4">
			{/* Hero strip — 全局插件信息 + (仅全局作用域)总开关 */}
			<div
				className="relative rounded-bn-card border p-5"
				style={{
					background: "linear-gradient(135deg, rgba(162,155,254,0.18), rgba(0,174,236,0.08))",
					borderColor: "rgba(162,155,254,0.25)",
				}}
			>
				<div className="flex items-center gap-3.5">
					<div
						className="grid shrink-0 place-items-center rounded-2xl text-white"
						style={{
							background: "linear-gradient(135deg, #a29bfe, #00AEEC)",
							boxShadow: "0 6px 18px rgba(108,92,231,0.35)",
							width: 52,
							height: 52,
						}}
					>
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

			<div className="grid gap-3.5 lg:grid-cols-[380px_1fr_360px]">
				{/* LEFT: style config */}
				<div className="flex flex-col gap-3">
					{isGlobalScope ? (
						<GlassBox
							title="卡片渲染样式"
							subtitle="image plugin · 全局默认 · 上方切 UP 可单独覆盖"
							accent="#a29bfe"
							icon={<Icon.edit size={14} />}
							badge="cardStyle"
						>
							<CardStyleFields style={gStyle} onChange={(n) => setGStyle(n)} />
							<Field code="app.logLevels.image" full>
								<LogLevelPicker
									value={toPickerValue(imageLogLevel)}
									onChange={(v) => setImageLogLevel(fromPickerValue(v))}
									allowInherit
								/>
							</Field>
						</GlassBox>
					) : (
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
								<CardStyleFields style={puStyle} onChange={(n) => setPuStyle(n)} />
							) : (
								<InheritNote>该 UP 继承全局卡片样式</InheritNote>
							)}
						</GlassBox>
					)}

					<PreviewContentBox
						kind={kind}
						setKind={setKind}
						content={content}
						setContent={setContent}
						realData={!isGlobalScope}
						realDataLabel={
							focusedSub
								? `使用 ${displayName(focusedSub)} 的真实数据渲染预览；未开播 / 无动态 / 网络异常时自动回退示例数据。`
								: undefined
						}
					/>
				</div>

				{/* MIDDLE: live preview */}
				<div className="space-y-2.5">
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
				</div>

				{/* RIGHT: layout editor + test push */}
				<div className="flex flex-col gap-3">
					{isGlobalScope ? (
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
					)}

					<TestPushCard
						kind={kind}
						style={effStyle}
						content={previewContent}
						layout={effLayout}
						fallback={previewFallback}
					/>
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
