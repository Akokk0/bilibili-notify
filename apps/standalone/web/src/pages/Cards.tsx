/**
 * Cards page — image plugin card style preview. Ports `GlassPreviewTab` from
 * `.bn-design/variation-ac.jsx`.
 *
 * Left column: ImageRenderingSidebar bound to GlobalConfig.defaults.cardStyle
 * via /api/globals PATCH. Right column: card preview that calls the
 * puppeteer-core-backed `/api/cards/preview` route for ALL four kinds (live /
 * dyn / sc / guard). The server runs the matching production template
 * (LiveCard / DynamicCard / SCCard / GuardCard) through Vue SSR + UnoCSS +
 * puppeteer screenshot and returns a base64 PNG.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Btn } from "../components/atoms";
import { Field, TColor } from "../components/forms";
import { GlassBox } from "../components/glass-box";
import { Icon } from "../components/icons";
import { ApiError, api } from "../services/api";
import type { CardStyle, GlobalConfig } from "../types/globals";

type CardKind = "live" | "dyn" | "sc" | "guard";

const KIND_LABELS: Record<CardKind, { label: string; tone: string }> = {
	live: { label: "直播开播", tone: "#FF6699" },
	dyn: { label: "动态发布", tone: "#00AEEC" },
	sc: { label: "SC 提醒", tone: "#fdcb6e" },
	guard: { label: "上舰提醒", tone: "#f2a053" },
};

interface PreviewResponse {
	ok: boolean;
	dataUrl?: string;
	err?: string;
}

function PreviewImage({ kind, style }: { kind: CardKind; style: CardStyle }) {
	// debounce style edits — TColor pickers fire many onChange callbacks per second
	const [debouncedStyle, setDebouncedStyle] = useState(style);
	useEffect(() => {
		const t = setTimeout(() => setDebouncedStyle(style), 500);
		return () => clearTimeout(t);
	}, [style]);

	const query = useQuery({
		queryKey: ["card-preview", kind, debouncedStyle],
		queryFn: async () => {
			const res = await api.post<PreviewResponse>("/api/cards/preview", {
				kind,
				style: debouncedStyle,
			});
			if (!res.ok || !res.dataUrl) {
				throw new ApiError(500, res, res.err ?? "preview failed");
			}
			return res.dataUrl;
		},
		retry: false,
	});

	const previewBg = `linear-gradient(135deg, ${style.cardColorStart}, ${style.cardColorEnd})`;
	const showSkeleton = query.isPending;
	const apiErr = query.error as ApiError | undefined;
	const status = apiErr?.status;

	return (
		<div
			className="relative flex min-h-105 items-center justify-center rounded-bn-card border border-gray-200 p-7"
			style={{ background: previewBg }}
		>
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
					{status === 503 ? (
						<div className="mt-2 rounded bg-amber-50 p-2 text-[11px] text-amber-800">
							设置 <code className="font-mono">BN_CHROME_PATH</code> 环境变量指向 chrome / chromium
							二进制后重启服务。
						</div>
					) : null}
				</div>
			) : (
				<img
					src={query.data}
					alt="卡片实时预览"
					className="bn-anim-fade-in max-w-full rounded-xl shadow-[0_6px_20px_rgba(0,0,0,0.14)]"
				/>
			)}
		</div>
	);
}

function CardPreview({ kind, style }: { kind: CardKind; style: CardStyle }) {
	return <PreviewImage kind={kind} style={style} />;
}

export default function Cards() {
	const qc = useQueryClient();
	const globalsQuery = useQuery({
		queryKey: ["globals"],
		queryFn: () => api.get<GlobalConfig>("/api/globals"),
	});
	const [draft, setDraft] = useState<CardStyle | null>(null);
	const [kind, setKind] = useState<CardKind>("live");
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (globalsQuery.data) setDraft(globalsQuery.data.defaults.cardStyle);
	}, [globalsQuery.data]);

	const dirty = useMemo(() => {
		if (!draft || !globalsQuery.data) return false;
		return JSON.stringify(draft) !== JSON.stringify(globalsQuery.data.defaults.cardStyle);
	}, [draft, globalsQuery.data]);

	const save = useMutation({
		mutationFn: async (next: CardStyle) => {
			setError(null);
			try {
				await api.patch<GlobalConfig>("/api/globals", { defaults: { cardStyle: next } });
			} catch (err) {
				if (err instanceof ApiError) setError(err.message);
				else setError(String(err));
				throw err;
			}
		},
		onSuccess: () => qc.invalidateQueries({ queryKey: ["globals"] }),
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

	return (
		<div className="bn-anim-fade-in grid gap-3.5 lg:grid-cols-[380px_1fr]">
			{/* LEFT: image plugin config */}
			<div className="flex flex-col gap-3">
				<GlassBox
					title="卡片渲染样式"
					subtitle="image plugin · 全局默认 · per-UP 覆盖在「高级规则」"
					accent="#a29bfe"
					icon={<Icon.sparkle size={14} />}
					badge="cardStyle"
					right={
						dirty ? (
							<div className="flex items-center gap-2">
								<span className="text-[11.5px] font-semibold text-bn-pink">未保存</span>
								<Btn
									size="sm"
									variant="outline"
									onClick={() =>
										globalsQuery.data && setDraft(globalsQuery.data.defaults.cardStyle)
									}
									disabled={save.isPending}
								>
									丢弃
								</Btn>
								<Btn
									size="sm"
									variant="primary"
									onClick={() => save.mutate(draft)}
									disabled={save.isPending}
								>
									{save.isPending ? "保存中…" : "保存"}
								</Btn>
							</div>
						) : (
							<span className="text-[11.5px] text-bn-text-secondary">已同步</span>
						)
					}
				>
					<Field label="渐变起始" code="cardColorStart">
						<TColor value={draft.cardColorStart} onChange={(v) => set("cardColorStart", v)} />
					</Field>
					<Field label="渐变结束" code="cardColorEnd">
						<TColor value={draft.cardColorEnd} onChange={(v) => set("cardColorEnd", v)} />
					</Field>
					<Field label="底板颜色" code="cardBasePlateColor">
						<TColor
							value={draft.cardBasePlateColor}
							onChange={(v) => set("cardBasePlateColor", v)}
						/>
					</Field>
					<Field label="底板边框" code="cardBasePlateBorder">
						<TColor
							value={draft.cardBasePlateBorder}
							onChange={(v) => set("cardBasePlateBorder", v)}
						/>
					</Field>
					<div className="mt-2 rounded border border-dashed bg-[#a29bfe14] p-2.5 text-[11px] text-bn-text-secondary">
						per-UP 卡片样式覆盖 → 前往「高级规则」→ 选择 UP 主 → 卡片样式覆盖
					</div>
				</GlassBox>

				<GlassBox
					title="测试推送"
					subtitle="切换卡片类型预览"
					accent="#FB7299"
					icon={<Icon.bell size={14} />}
				>
					<div className="flex flex-wrap gap-1.5">
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
									{k === "live"
										? "直播开播"
										: k === "dyn"
											? "动态发布"
											: k === "sc"
												? "SC 提醒"
												: "上舰提醒"}
								</button>
							);
						})}
					</div>
					<div className="mt-3">
						<Btn variant="primary" full icon={<Icon.bell size={13} />}>
							发送测试推送
						</Btn>
					</div>
				</GlassBox>
			</div>

			{/* RIGHT: live preview */}
			<div className="space-y-2.5">
				<div className="flex items-center justify-between text-[13px] text-bn-text-primary">
					<span className="font-bold">卡片预览 · 实时反映左侧 image 配置</span>
					<span className="text-[11px] font-normal text-bn-text-secondary">
						puppeteer 真实渲染 · 渲染宽度{kind === "sc" || kind === "guard" ? " 430" : " 600"}px
					</span>
				</div>
				<CardPreview kind={kind} style={draft} />

				{error ? (
					<div className="rounded border border-red-200 bg-red-50 p-2 text-xs text-red-700">
						{error}
					</div>
				) : null}

				{/* Effective style readout */}
				<div className="flex flex-wrap gap-3.5 rounded-md border border-black/5 bg-white/60 px-3 py-2 font-mono text-[10.5px] text-bn-text-tertiary">
					<span>
						cardColorStart: <TInputReadonly value={draft.cardColorStart} />
					</span>
					<span>
						cardColorEnd: <TInputReadonly value={draft.cardColorEnd} />
					</span>
					<span>
						cardBasePlateColor: <TInputReadonly value={draft.cardBasePlateColor} />
					</span>
					<span>
						cardBasePlateBorder: <TInputReadonly value={draft.cardBasePlateBorder} />
					</span>
					<span className="italic text-bn-text-secondary">
						per-UP 覆盖 → 高级规则 → cardStyleOverride
					</span>
				</div>
			</div>
		</div>
	);
}

function TInputReadonly({ value }: { value: string }) {
	return <b className="text-bn-text-primary">{value}</b>;
}
