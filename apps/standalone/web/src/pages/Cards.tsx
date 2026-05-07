/**
 * Cards page — image plugin card style preview. Ports `GlassPreviewTab` from
 * `.bn-design/variation-ac.jsx`.
 *
 * Left column: ImageRenderingSidebar bound to GlobalConfig.defaults.cardStyle
 * via /api/globals PATCH. Right column: live card mock that re-renders on
 * every keystroke. The puppeteer-backed `/api/cards/preview` endpoint isn't
 * wired yet (plan §3 — to land alongside the image-engine integration), so
 * the right pane uses an in-DOM facsimile that mirrors the production card's
 * gradient + base-plate + content layout.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Avatar, Btn, Pill } from "../components/atoms";
import { Field, TColor } from "../components/forms";
import { GlassBox } from "../components/glass-box";
import { Icon } from "../components/icons";
import { ApiError, api } from "../services/api";
import type { CardStyle, GlobalConfig } from "../types/globals";

type CardKind = "live" | "dyn" | "sc" | "guard";

const KIND_LABELS: Record<CardKind, { label: string; tone: string; sub: string }> = {
	live: { label: "● 直播中", tone: "#FF6699", sub: "2 分钟前 · 游戏" },
	dyn: { label: "动态", tone: "#00AEEC", sub: "12 分钟前 · 图文动态" },
	sc: { label: "SC ¥30", tone: "#fdcb6e", sub: "5 分钟前 · SuperChat" },
	guard: { label: "舰长", tone: "#f2a053", sub: "刚刚 · 开通大航海" },
};

const TITLES: Record<CardKind, string> = {
	live: "【赛博朋克2077】资料片实况首播！",
	dyn: "今天直播间发了一些新游戏的预告片，大家觉得哪个最值得期待？",
	sc: "感谢「孤勇者」 ¥30 SuperChat",
	guard: "感谢「梦梦」开通舰长！",
};

const DESCS: Record<CardKind, string> = {
	live: "游戏 · 单机 · 主机 — 一年一度的资料片首发，番茄哥带大家云一波",
	dyn: "配图来自前几天的发布会，等周五正式直播再细聊～",
	sc: "主播加油！这首要听到！老番茄唱得太好了！",
	guard: "从此以后这个舰队就是我的家了 (｡•̀ᴗ-)✧",
};

function CardPreview({ kind, style }: { kind: CardKind; style: CardStyle }) {
	const meta = KIND_LABELS[kind];
	const previewBg = `linear-gradient(135deg, ${style.cardColorStart}, ${style.cardColorEnd})`;
	const showImage = kind === "live" || kind === "dyn";
	return (
		<div
			className="flex min-h-[420px] items-center justify-center rounded-bn-card border border-gray-200 p-7 transition"
			style={{ background: previewBg }}
		>
			<div
				className="w-[380px] rounded-xl p-4 shadow-[0_6px_20px_rgba(0,0,0,0.14)] backdrop-blur-md"
				style={{
					background: style.cardBasePlateColor,
					border: `1px solid ${style.cardBasePlateBorder}`,
				}}
			>
				<div className="mb-3 flex items-center gap-2.5">
					<Avatar name="老番茄" color="#FF6699" size={44} />
					<div className="flex-1">
						<div className="text-sm font-bold text-bn-text-primary">老番茄</div>
						<div className="text-[11px] text-bn-text-secondary">{meta.sub}</div>
					</div>
					<Pill color={meta.tone}>{meta.label}</Pill>
				</div>
				<div className="mb-2 text-sm font-bold leading-snug text-bn-text-primary">
					{TITLES[kind]}
				</div>
				<div className="mb-2.5 text-xs leading-relaxed text-bn-text-tertiary">{DESCS[kind]}</div>
				{showImage ? (
					<div
						className="relative flex h-40 items-center justify-center overflow-hidden rounded-lg text-xs text-white/85"
						style={{
							background: "linear-gradient(135deg, #FB7299, #ffaaa7)",
						}}
					>
						{kind === "live" ? (
							<div className="absolute left-2 top-2 rounded bg-black/50 px-2 py-0.5 text-[10.5px] font-bold text-white">
								● LIVE · 23.4 万
							</div>
						) : null}
						<span>{kind === "live" ? "直播间封面" : "动态配图"}</span>
					</div>
				) : null}
				<div className="mt-3 flex items-center gap-3.5 text-[11px] text-bn-text-tertiary">
					<span className="inline-flex items-center gap-1">
						<Icon.eye size={12} /> 23.4 万
					</span>
					<span className="inline-flex items-center gap-1">
						<Icon.chat size={12} /> 5,891
					</span>
					<span className="inline-flex items-center gap-1">
						<Icon.gift size={12} /> 142
					</span>
				</div>
			</div>
		</div>
	);
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
						puppeteer 渲染将在 image-engine 接入后启用 · 1080×可变高
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
