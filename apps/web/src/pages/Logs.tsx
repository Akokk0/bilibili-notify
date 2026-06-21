import { useQuery } from "@tanstack/react-query";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import type { Components } from "react-markdown";
import { Input } from "../components/atoms";
import { Icon } from "../components/icons";
import { SectionNav } from "../components/section-nav";
import { useLogChannel } from "../hooks/useLogChannel";
import { api } from "../services/api";
import {
	type LogLineLevel,
	type LogLineView,
	type LogsResponse,
	logsQueryKey,
} from "../services/dashboard";
import { withDesktopTokenHeader } from "../services/desktop-token";

/**
 * `/logs` — 日志输出 Tab。落盘 jsonl 归档(<dataDir>/logs/<日>.jsonl)的
 * 实时 + 历史查看。
 *
 * 取数(镜像 History):服务端 /api/logs 只按 day/limit 分页;level / source /
 * 文本过滤全在本页客户端做,所以 live query key 稳定、`useLogChannel` 的 WS
 * tail 能 setQueryData-append 不漂移。选过去某天 → 不同 key 的冻结历史视图,
 * WS 不污染。AlertShell(engine-error 红色面板)独立并存。
 */

const LEVELS: ReadonlyArray<LogLineLevel> = ["debug", "info", "warn", "error"];

const LEVEL_TONE: Record<LogLineLevel, string> = {
	debug: "#94a3b8",
	info: "#00AEEC",
	warn: "#f2a053",
	error: "#ef4444",
};

const RENDER_CAP = 800;

const ReactMarkdown = lazy(() => import("react-markdown"));

async function loadChangelogMarkdown(): Promise<string> {
	const mod = await import("../../../CHANGELOG.md?raw");
	return mod.default;
}

async function downloadRawLog(day: string): Promise<void> {
	const res = await fetch(`/api/logs/raw?day=${encodeURIComponent(day)}`, {
		headers: withDesktopTokenHeader(),
		credentials: "include",
	});
	if (!res.ok) {
		const message = await res.text().catch(() => `${res.status}`);
		throw new Error(message || `download failed: ${res.status}`);
	}
	const blob = await res.blob();
	const url = URL.createObjectURL(blob);
	try {
		const a = document.createElement("a");
		a.href = url;
		a.download = `bilibili-notify-${day}.jsonl`;
		document.body.appendChild(a);
		a.click();
		a.remove();
	} finally {
		URL.revokeObjectURL(url);
	}
}

type LogsSectionId = "logs" | "changelog";

const LOG_SECTIONS: ReadonlyArray<{
	id: LogsSectionId;
	label: string;
	desc: string;
	icon: keyof typeof Icon;
}> = [
	{ id: "logs", label: "运行日志", desc: "实时输出与归档检索", icon: "list" },
	{ id: "changelog", label: "更新日志", desc: "独立端版本变更记录", icon: "sparkle" },
];

const MARKDOWN_COMPONENTS: Components = {
	h1: ({ children }) => (
		<h1 className="mt-0 mb-4 border-b border-black/8 pb-3 text-[24px] font-extrabold tracking-tight text-bn-text-primary">
			{children}
		</h1>
	),
	h2: ({ children }) => (
		<h2 className="mt-7 mb-3 text-[18px] font-extrabold tracking-tight text-bn-text-primary">
			{children}
		</h2>
	),
	h3: ({ children }) => (
		<h3 className="mt-5 mb-2 text-[14px] font-bold uppercase tracking-wide text-bn-pink">
			{children}
		</h3>
	),
	p: ({ children }) => (
		<p className="my-2 text-[13px] leading-7 text-bn-text-secondary">{children}</p>
	),
	ul: ({ children }) => (
		<ul className="my-2 space-y-1.5 pl-5 text-[13px] text-bn-text-secondary">{children}</ul>
	),
	li: ({ children }) => <li className="list-disc leading-7 marker:text-bn-pink/70">{children}</li>,
	code: ({ node: _node, className, children, ...props }) => (
		<code
			className={`rounded-md bg-bn-code-bg px-1.5 py-0.5 font-mono text-[12px] text-bn-text-primary ${className ?? ""}`}
			{...props}
		>
			{children}
		</code>
	),
	pre: ({ children }) => (
		<pre className="my-3 overflow-x-auto rounded-xl border border-black/8 bg-[#0f1115] p-3 text-[12px] leading-relaxed text-gray-200">
			{children}
		</pre>
	),
	a: ({ children, href }) => (
		<a
			href={href}
			target="_blank"
			rel="noreferrer"
			className="font-semibold text-bn-pink underline-offset-2 hover:underline"
		>
			{children}
		</a>
	),
};

function todayStr(): string {
	return new Date().toISOString().slice(0, 10);
}

export default function Logs() {
	useLogChannel();

	const [section, setSection] = useState<LogsSectionId>("logs");
	const [day, setDay] = useState<string>(""); // "" = 实时(live key);否则某天
	const [levels, setLevels] = useState<Set<LogLineLevel>>(new Set(LEVELS));
	const [source, setSource] = useState<string>("");
	const [q, setQ] = useState("");
	const [paused, setPaused] = useState(false);
	const [autoscroll, setAutoscroll] = useState(true);

	const isLive = day === "";
	const logsQuery = useQuery({
		queryKey: logsQueryKey(isLive ? undefined : day),
		queryFn: () => api.get<LogsResponse>(`/api/logs?limit=500${isLive ? "" : `&day=${day}`}`),
		// 过去某天是冻结快照,不必刷;实时键由 useLogChannel 持续 prepend。
		refetchInterval: false,
	});

	const liveEntries = logsQuery.data?.entries ?? [];

	// 暂停:冻结视图。capture 当前 entries,暂停期间不反映新 WS 帧。
	const frozenRef = useRef<LogLineView[]>([]);
	if (!paused) frozenRef.current = liveEntries;
	const sourceEntries = paused ? frozenRef.current : liveEntries;

	// 源/子系统下拉项 —— 从当前数据集 distinct(含 engine-error 的 source)。
	const sources = useMemo(() => {
		const s = new Set<string>();
		for (const e of sourceEntries) if (e.name) s.add(e.name);
		return [...s].sort();
	}, [sourceEntries]);

	// 客户端过滤 + 转时序升序(终端式:新行在底部)。
	const displayed = useMemo(() => {
		const ql = q.trim().toLowerCase();
		const filtered = sourceEntries.filter((e) => {
			if (!levels.has(e.level)) return false;
			if (source && e.name !== source) return false;
			if (!ql) return true;
			const hay = `${e.msg} ${e.name ?? ""} ${e.args ? JSON.stringify(e.args) : ""}`.toLowerCase();
			return hay.includes(ql);
		});
		// cache 为新→旧;终端视图要旧→新,取最近 RENDER_CAP 条再反转。
		return filtered.slice(0, RENDER_CAP).reverse();
	}, [sourceEntries, levels, source, q]);

	const bottomRef = useRef<HTMLDivElement>(null);
	// biome-ignore lint/correctness/useExhaustiveDependencies: 仅在行数变化时滚动
	useEffect(() => {
		if (!paused && autoscroll) bottomRef.current?.scrollIntoView({ block: "end" });
	}, [displayed.length, paused, autoscroll]);

	function toggleLevel(l: LogLineLevel): void {
		setLevels((prev) => {
			const next = new Set(prev);
			if (next.has(l)) next.delete(l);
			else next.add(l);
			return next;
		});
	}

	const viewDay = isLive ? todayStr() : day;

	const runtimeLogs = (
		<div className="space-y-3">
			<div className="flex flex-wrap items-center gap-2">
				<Input
					value={q}
					onChange={setQ}
					placeholder="搜索日志正文 / 源 / 参数..."
					icon={<Icon.search size={14} />}
				/>
				<div className="flex gap-1">
					{LEVELS.map((l) => {
						const active = levels.has(l);
						const tone = LEVEL_TONE[l];
						return (
							<button
								key={l}
								type="button"
								onClick={() => toggleLevel(l)}
								className="rounded-full border px-3 py-1 text-[12px] font-semibold uppercase transition"
								style={
									active
										? { background: `${tone}1f`, color: tone, borderColor: `${tone}55` }
										: {
												background: "transparent",
												color: "var(--color-bn-text-secondary)",
												borderColor: "var(--color-bn-border)",
											}
								}
							>
								{l}
							</button>
						);
					})}
				</div>

				<select
					value={source}
					onChange={(e) => setSource(e.target.value)}
					className="rounded-lg border border-black/10 bg-bn-surface px-2.5 py-1.5 text-[12px] text-bn-text-secondary"
				>
					<option value="">全部来源</option>
					{sources.map((s) => (
						<option key={s} value={s}>
							{s}
						</option>
					))}
				</select>

				<div className="flex-1" />

				<input
					type="date"
					value={isLive ? "" : day}
					max={todayStr()}
					onChange={(e) => setDay(e.target.value)}
					className="rounded-lg border border-black/10 bg-bn-surface px-2.5 py-1.5 text-[12px] text-bn-text-secondary"
				/>
				{!isLive && (
					<button
						type="button"
						onClick={() => setDay("")}
						className="rounded-full border border-bn-pink/40 bg-bn-pink/10 px-3 py-1 text-[12px] font-semibold text-bn-pink"
					>
						回到实时
					</button>
				)}
				<button
					type="button"
					onClick={() => setPaused((p) => !p)}
					className="rounded-full border px-3 py-1 text-[12px] font-semibold transition"
					style={
						paused
							? { background: "#f2a05320", color: "#f2a053", borderColor: "#f2a05355" }
							: {
									background: "transparent",
									color: "var(--color-bn-text-tertiary)",
									borderColor: "var(--color-bn-border)",
								}
					}
				>
					{paused ? "已暂停" : "暂停"}
				</button>
				<button
					type="button"
					onClick={() => setAutoscroll((a) => !a)}
					className="rounded-full border px-3 py-1 text-[12px] font-semibold transition"
					style={
						autoscroll
							? { background: "#00AEEC1f", color: "#00AEEC", borderColor: "#00AEEC55" }
							: {
									background: "transparent",
									color: "var(--color-bn-text-tertiary)",
									borderColor: "var(--color-bn-border)",
								}
					}
				>
					自动滚动
				</button>
				<button
					type="button"
					onClick={() => {
						void downloadRawLog(viewDay).catch((err) => {
							alert(`下载失败:${String((err as Error).message ?? err)}`);
						});
					}}
					className="inline-flex items-center gap-1 rounded-full border border-black/10 px-3 py-1 text-[12px] font-semibold text-bn-text-secondary hover:text-bn-text-primary"
				>
					↓ {viewDay}.jsonl
				</button>
			</div>

			<div className="flex items-center justify-between px-1 text-[11px] text-bn-text-tertiary">
				<span>
					{isLive ? "实时" : `归档 · ${day}`} · 显示 {displayed.length} 行
					{paused ? " · 已冻结" : ""}
				</span>
				{logsQuery.isLoading ? <span>加载中…</span> : null}
			</div>

			<div className="rounded-[10px] border border-black/6 bg-[#0f1115] px-3 py-2.5 font-mono text-[12px] leading-relaxed">
				{logsQuery.error ? (
					<div className="text-red-400">加载失败:{String((logsQuery.error as Error).message)}</div>
				) : displayed.length === 0 ? (
					<div className="py-10 text-center text-[12px] text-gray-500">没有符合条件的日志</div>
				) : (
					// biome-ignore lint/suspicious/noArrayIndexKey: 日志行无稳定 id;append-only tail 视图,行不会原地重排,index 复用无状态副作用
					displayed.map((e, i) => <LogRow key={`${e.ts}-${i}`} entry={e} />)
				)}
				<div ref={bottomRef} />
			</div>
		</div>
	);

	// bn-anim-fade-in 的 `both` fill-mode 保留 translateY(0) 残留 transform;若它直接挂在
	// grid 上,会把内部 sticky aside 的包含块改成本容器,窄视口单列时 aside 偏移压住内容 → 坍缩。
	// 故 transform(fade-in) 与 grid/sticky 分层,与 Targets/Rules 一致(参 dialog.tsx 顶注)。
	return (
		<div className="bn-anim-fade-in flex flex-col gap-4">
			<div className="grid gap-4 xl:grid-cols-[220px_1fr]">
				<LogsSectionList current={section} onChange={setSection} />
				<div className="min-w-0">{section === "logs" ? runtimeLogs : <ChangelogPanel />}</div>
			</div>
		</div>
	);
}

function LogsSectionList({
	current,
	onChange,
}: {
	current: LogsSectionId;
	onChange: (section: LogsSectionId) => void;
}) {
	return (
		<SectionNav
			heading="日志"
			activeId={current}
			onPick={(id) => onChange(id as LogsSectionId)}
			items={LOG_SECTIONS.map((s) => {
				const SectionIcon = Icon[s.icon];
				return {
					id: s.id,
					label: s.label,
					desc: s.desc,
					icon: <SectionIcon size={14} />,
				};
			})}
		/>
	);
}

function ChangelogPanel() {
	const [markdown, setMarkdown] = useState<string | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		void loadChangelogMarkdown()
			.then((text) => {
				if (cancelled) return;
				setMarkdown(text);
				setLoadError(null);
			})
			.catch((err: unknown) => {
				if (cancelled) return;
				setLoadError(err instanceof Error ? err.message : String(err));
			});
		return () => {
			cancelled = true;
		};
	}, []);

	return (
		<div className="rounded-bn-card border border-black/6 bg-bn-surface/80 p-5 shadow-[0_12px_36px_rgba(15,23,42,0.04)] backdrop-blur-sm">
			<div className="mb-4 flex flex-wrap items-start justify-between gap-3 border-b border-black/6 pb-4">
				<div>
					<div className="flex items-center gap-2 text-[15px] font-extrabold text-bn-text-primary">
						<Icon.sparkle size={16} />
						更新日志
					</div>
					<p className="mt-1 text-[12px] text-bn-text-tertiary">独立端版本变更记录</p>
				</div>
				<span className="rounded-full border border-bn-pink/25 bg-bn-pink/8 px-3 py-1 font-mono text-[11px] font-semibold text-bn-pink">
					apps/CHANGELOG.md
				</span>
			</div>
			<div className="max-w-none">
				{loadError ? (
					<div className="py-8 text-center text-[12px] text-red-500">
						更新日志加载失败: {loadError}
					</div>
				) : markdown == null ? (
					<div className="py-8 text-center text-[12px] text-bn-text-tertiary">加载更新日志…</div>
				) : (
					<Suspense
						fallback={
							<div className="py-8 text-center text-[12px] text-bn-text-tertiary">
								加载更新日志…
							</div>
						}
					>
						<ReactMarkdown components={MARKDOWN_COMPONENTS}>{markdown}</ReactMarkdown>
					</Suspense>
				)}
			</div>
		</div>
	);
}

export function formatLocalTime(iso: string): string {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return iso.slice(0, 23).replace("T", " "); // ISO 解析失败回退
	const yyyy = d.getFullYear();
	const MM = String(d.getMonth() + 1).padStart(2, "0");
	const dd = String(d.getDate()).padStart(2, "0");
	const hh = String(d.getHours()).padStart(2, "0");
	const mm = String(d.getMinutes()).padStart(2, "0");
	const ss = String(d.getSeconds()).padStart(2, "0");
	const ms = String(d.getMilliseconds()).padStart(3, "0");
	return `${yyyy}-${MM}-${dd} ${hh}:${mm}:${ss}.${ms}`;
}

function LogRow({ entry }: { entry: LogLineView }) {
	const tone = LEVEL_TONE[entry.level];
	const time = formatLocalTime(entry.ts); // yyyy-MM-dd HH:MM:SS.sss(浏览器本地时区)
	return (
		<div className="flex gap-2 whitespace-pre-wrap break-all py-0.5 text-gray-300">
			<span className="shrink-0 text-gray-500">{time}</span>
			<span className="shrink-0 font-bold uppercase" style={{ color: tone }}>
				{entry.level}
			</span>
			{entry.name ? <span className="shrink-0 text-gray-500">[{entry.name}]</span> : null}
			<span className="min-w-0">
				{entry.msg}
				{entry.args && entry.args.length > 0 ? (
					<span className="text-gray-500"> {JSON.stringify(entry.args)}</span>
				) : null}
			</span>
		</div>
	);
}
