/**
 * Cards page — image plugin card style preview. Ports `GlassPreviewTab` from
 * `.bn-design/variation-ac.jsx`.
 *
 * Left column: card-style config (bound to GlobalConfig.defaults.cardStyle via
 * /api/globals PATCH) + preview-content form + 测试推送. Right column: card
 * preview that calls the puppeteer-core-backed `/api/cards/preview` route for
 * ALL four kinds (live /
 * dyn / sc / guard). The server runs the matching production template
 * (LiveCard / DynamicCard / SCCard / GuardCard) through Vue SSR + UnoCSS +
 * puppeteer screenshot and returns a base64 PNG.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Btn, Pill, Toggle } from "../components/atoms";
import { ChromeAutoDetect } from "../components/chrome-autodetect";
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
import { useDirtyDraft } from "../hooks/useDirtyDraft";
import { ApiError, api } from "../services/api";
import type { PushTarget } from "../types/domain";
import type { CardStyle, GlobalConfig, LogLevel } from "../types/globals";

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
}: {
	kind: CardKind;
	style: CardStyle;
	content: PreviewContent;
}) {
	// debounce style + content edits — TColor pickers and TArea fire many onChange
	// callbacks per second; we don't want every keystroke to spawn a puppeteer launch.
	const [debouncedStyle, setDebouncedStyle] = useState(style);
	const [debouncedContent, setDebouncedContent] = useState(content);
	useEffect(() => {
		const t = setTimeout(() => setDebouncedStyle(style), 500);
		return () => clearTimeout(t);
	}, [style]);
	useEffect(() => {
		const t = setTimeout(() => setDebouncedContent(content), 500);
		return () => clearTimeout(t);
	}, [content]);

	const query = useQuery({
		queryKey: ["card-preview", kind, debouncedStyle, debouncedContent[kind]],
		queryFn: async () => {
			const res = await api.post<PreviewResponse>("/api/cards/preview", {
				kind,
				style: debouncedStyle,
				content: debouncedContent[kind],
			});
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
		<div className="relative flex min-h-105 items-center justify-center rounded-bn-card border border-gray-200 p-7">
			{showSkeleton ? (
				<div className="flex w-95 flex-col items-center gap-3 rounded-xl bg-white/70 p-6">
					<div className="bn-anim-spin h-8 w-8 rounded-full border-2 border-bn-pink/30 border-t-bn-pink" />
					<div className="text-[12px] font-bold text-bn-text-secondary">puppeteer 渲染中…</div>
				</div>
			) : query.error ? (
				<div className="w-95 rounded-xl bg-white p-4 text-[12px]">
					<div className="mb-1 font-bold text-red-600">
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
}: {
	kind: CardKind;
	style: CardStyle;
	content: PreviewContent;
}) {
	return <PreviewImage kind={kind} style={style} content={content} />;
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
}: {
	kind: CardKind;
	style: CardStyle;
	content: PreviewContent[CardKind];
}) {
	const targetsQuery = useQuery({
		queryKey: ["targets"],
		queryFn: () => api.get<PushTarget[]>("/api/targets"),
	});
	const targets = useMemo(
		// 仅外部投递目标 —— web-dashboard 是内部通知流,测试推送对它无意义。
		() => (targetsQuery.data ?? []).filter((t) => t.enabled && t.platform !== "web-dashboard"),
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
					className="w-full rounded-md border border-gray-200 bg-white px-2.5 py-2 text-[12.5px] text-bn-text-primary outline-none focus:border-bn-pink disabled:opacity-50"
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
					<div className="mt-2 text-[11px] text-red-600">
						推送失败:{(push.error as ApiError)?.message ?? "未知错误"}
					</div>
				) : push.isSuccess ? (
					<div className="mt-2 text-[11px] text-emerald-600">已送达 · {push.data.latencyMs}ms</div>
				) : null}
			</div>
		</GlassBox>
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

export default function Cards() {
	const qc = useQueryClient();
	const globalsQuery = useQuery({
		queryKey: ["globals"],
		queryFn: () => api.get<GlobalConfig>("/api/globals"),
	});
	const [draft, setDraft] = useState<CardStyle | null>(null);
	const [imageLogLevel, setImageLogLevel] = useState<ImageLogLevel>("");
	const [kind, setKind] = useState<CardKind>("live");
	const [content, setContent] = useState<PreviewContent>(DEFAULT_PREVIEW_CONTENT);

	const setLive = (next: Partial<PreviewContent["live"]>) =>
		setContent((c) => ({ ...c, live: { ...c.live, ...next } }));
	const setDyn = (next: Partial<PreviewContent["dyn"]>) =>
		setContent((c) => ({ ...c, dyn: { ...c.dyn, ...next } }));
	const setSc = (next: Partial<PreviewContent["sc"]>) =>
		setContent((c) => ({ ...c, sc: { ...c.sc, ...next } }));
	const setGuard = (next: Partial<PreviewContent["guard"]>) =>
		setContent((c) => ({ ...c, guard: { ...c.guard, ...next } }));

	useEffect(() => {
		if (globalsQuery.data) {
			setDraft(globalsQuery.data.defaults.cardStyle);
			setImageLogLevel(globalsQuery.data.app.logLevels?.image ?? "");
		}
	}, [globalsQuery.data]);

	const save = useMutation({
		mutationFn: async (payload: { cardStyle: CardStyle; imageLogLevel: ImageLogLevel }) => {
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
				defaults: { cardStyle: payload.cardStyle },
			});
		},
		onSuccess: () => qc.invalidateQueries({ queryKey: ["globals"] }),
	});

	// 灵动岛 draft/baseline:把 cardStyle 顶层字段 + app.logLevels.image 合在
	// 一个对象里,让 walkTreeDiff 输出的 code 跟 FIELD_LABELS 字典 key 对齐
	// (cardColorStart / font / hideDesc / app.logLevels.image)。
	const islandDraft = useMemo(() => {
		if (draft === null) return null;
		return {
			...draft,
			app: { logLevels: { image: imageLogLevel === "" ? null : imageLogLevel } },
		};
	}, [draft, imageLogLevel]);
	const islandBaseline = useMemo(() => {
		if (!globalsQuery.data) return null;
		return {
			...globalsQuery.data.defaults.cardStyle,
			app: { logLevels: { image: globalsQuery.data.app.logLevels?.image ?? null } },
		};
	}, [globalsQuery.data]);

	useDirtyDraft({
		pageKey: "cards",
		pageLabel: "卡片样式",
		draft: islandDraft,
		baseline: islandBaseline,
		onSave: async () => {
			if (draft !== null) await save.mutateAsync({ cardStyle: draft, imageLogLevel });
		},
		onDiscard: () => {
			if (!globalsQuery.data) return;
			setDraft(globalsQuery.data.defaults.cardStyle);
			setImageLogLevel(globalsQuery.data.app.logLevels?.image ?? "");
		},
	});

	if (!draft) {
		return (
			<div className="bn-glass rounded-bn-card p-10 text-center text-sm text-bn-text-secondary shadow-bn-card">
				加载卡片样式中…
			</div>
		);
	}

	const set = <K extends keyof CardStyle>(k: K, v: CardStyle[K]) =>
		setDraft((d) => (d ? { ...d, [k]: v } : d));

	const enabled = draft.enabled;

	const KindIcon = Icon[KIND_LABELS[kind].icon];

	return (
		<div className="bn-anim-fade-in flex flex-col gap-4">
			{/* Hero strip — mirrors AI page (顶层开关 · 日志等级 · 保存控件) */}
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
					<Picker
						value={enabled}
						onChange={(v) => set("enabled", v)}
						options={[
							{ value: true, label: "启用", color: "#a29bfe" },
							{ value: false, label: "停用", color: "#94a3b8" },
						]}
					/>
				</div>
			</div>

			<div className="grid gap-3.5 lg:grid-cols-[380px_1fr]">
				{/* LEFT: image plugin config */}
				<div className="flex flex-col gap-3">
					<GlassBox
						title="卡片渲染样式"
						subtitle="image plugin · 全局默认 · per-UP 覆盖在「高级规则」"
						accent="#a29bfe"
						icon={<Icon.edit size={14} />}
						badge="cardStyle"
					>
						<Field code="cardColorStart">
							<TColor value={draft.cardColorStart} onChange={(v) => set("cardColorStart", v)} />
						</Field>
						<Field code="cardColorEnd">
							<TColor value={draft.cardColorEnd} onChange={(v) => set("cardColorEnd", v)} />
						</Field>
						<Field code="font" full>
							<TInput value={draft.font} onChange={(v) => set("font", v)} />
						</Field>
						<Field code="hideDesc">
							<div className="flex h-7.5 items-center">
								<Toggle value={draft.hideDesc} onChange={(v) => set("hideDesc", v)} />
							</div>
						</Field>
						<Field code="hideFollower">
							<div className="flex h-7.5 items-center">
								<Toggle value={draft.hideFollower} onChange={(v) => set("hideFollower", v)} />
							</div>
						</Field>
						<Field code="app.logLevels.image" full>
							<LogLevelPicker
								value={toPickerValue(imageLogLevel)}
								onChange={(v) => setImageLogLevel(fromPickerValue(v))}
								allowInherit
							/>
						</Field>
						<div className="mt-2 rounded border border-dashed bg-[#a29bfe14] p-2.5 text-[11px] text-bn-text-secondary">
							per-UP 卡片样式覆盖 → 前往「高级规则」→ 选择 UP 主 → 卡片样式覆盖
						</div>
					</GlassBox>

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
												: { background: "rgba(0,0,0,0.04)", color: "#666" }
										}
									>
										{KIND_LABELS[k].label}
									</button>
								);
							})}
						</div>
						{kind === "live" ? (
							<>
								<Field code="roomId">
									<TInput
										value={content.live.roomId}
										onChange={(v) => setLive({ roomId: v })}
										placeholder="留空则使用示例数据"
									/>
								</Field>
								<div className="rounded border border-dashed bg-emerald-50/60 p-2.5 text-[11px] text-emerald-800">
									需要后端账号已登录 B
									站；填入后将真实拉取该直播间数据并渲染。留空则继续使用示例数据。
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
								<div className="rounded border border-dashed bg-emerald-50/60 p-2.5 text-[11px] text-emerald-800">
									需要后端账号已登录 B 站；填入后将拉取该 UP 的 space 动态列表，按 offset
									选取并渲染。
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
								<div className="rounded border border-dashed bg-gray-50 p-2.5 text-[11px] text-bn-text-tertiary">
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
															: { background: "rgba(0,0,0,0.04)", color: "#666" }
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
								<div className="rounded border border-dashed bg-gray-50 p-2.5 text-[11px] text-bn-text-tertiary">
									左侧渐变色对上舰不生效；卡片背景色与徽章图由舰长等级自动决定。
								</div>
							</>
						)}
					</GlassBox>

					<TestPushCard kind={kind} style={draft} content={content[kind]} />
				</div>

				{/* RIGHT: live preview */}
				<div className="space-y-2.5">
					<div className="flex items-center justify-between text-[13px] text-bn-text-primary">
						<span className="font-bold">卡片预览 · 实时反映左侧 image 配置</span>
						<span className="text-[11px] font-normal text-bn-text-secondary">
							puppeteer 真实渲染 · 渲染宽度
							{kind === "sc" ? " 280" : kind === "guard" ? " 430" : " 600"}px
						</span>
					</div>
					<CardPreview kind={kind} style={draft} content={content} />

					{/* Effective style readout */}
					<div className="flex flex-wrap gap-3.5 rounded-md border border-black/5 bg-white/60 px-3 py-2 font-mono text-[10.5px] text-bn-text-tertiary">
						<span>
							cardColorStart: <TInputReadonly value={draft.cardColorStart} />
						</span>
						<span>
							cardColorEnd: <TInputReadonly value={draft.cardColorEnd} />
						</span>
						<span className="italic text-bn-text-secondary">
							per-UP 覆盖 → 高级规则 → cardStyleOverride
						</span>
					</div>
				</div>
			</div>
		</div>
	);
}

function TInputReadonly({ value }: { value: string }) {
	return <b className="text-bn-text-primary">{value}</b>;
}
