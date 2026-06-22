import { lazy, Suspense, useEffect, useState } from "react";
import type { Components } from "react-markdown";
import { Icon } from "../components/icons";
import { SectionNav } from "../components/section-nav";

/**
 * `/about` — 关于 / 支持项目。聚合面向用户的项目元信息(非操作内容):
 * - 支持项目(爱发电入口 + 赞助者名单)—— 默认 section,温和引导现有用户赞助
 * - 更新日志(独立端 CHANGELOG.md,从原 `/logs` 页迁来)
 * - 关于本项目(仓库 · 交流群 · 协议)
 *
 * 与 Logs 同构:bn-anim-fade-in 的残留 transform 与 grid/sticky 分层,避免改写
 * SectionNav 竖栏的包含块,导致窄视口坍缩。
 */

// 主人:把下面换成你的真实爱发电主页地址。
const AFDIAN_URL = "https://afdian.com/a/akokko";
const GITHUB_URL = "https://github.com/Akokk0/bilibili-notify";
const QQ_GROUP = "801338523";

// 赞助者名单文件 —— 由 CI(scripts/fetch-sponsors.mjs)定时从爱发电同步生成,
// 产物在 apps/web/public/sponsors.json。缺文件(本地 / 未配 token)时前端回退空态。
interface Sponsor {
	name: string;
	avatar: string;
}
interface SponsorsFile {
	sponsors: Sponsor[];
}

const ReactMarkdown = lazy(() => import("react-markdown"));

// 模块级缓存:首次加载后复用。切回「更新日志」时 ChangelogPanel 直接以缓存初始化 markdown,
// 不再经历 null →「加载中」矮占位 → 内容的一帧高度跳变(切换抖动的成因之一)。
let changelogCache: string | null = null;

async function loadChangelogMarkdown(): Promise<string> {
	if (changelogCache != null) return changelogCache;
	const mod = await import("../../../CHANGELOG.md?raw");
	changelogCache = mod.default;
	return changelogCache;
}

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

type AboutSectionId = "sponsor" | "changelog" | "about";

const ABOUT_SECTIONS: ReadonlyArray<{
	id: AboutSectionId;
	label: string;
	desc: string;
	icon: keyof typeof Icon;
}> = [
	{ id: "sponsor", label: "支持项目", desc: "爱发电赞助与鸣谢", icon: "heart" },
	{ id: "changelog", label: "更新日志", desc: "独立端版本变更记录", icon: "sparkle" },
	{ id: "about", label: "关于本项目", desc: "仓库 · 交流群 · 协议", icon: "star" },
];

export default function About() {
	const [section, setSection] = useState<AboutSectionId>("sponsor");

	return (
		<div className="bn-anim-fade-in flex flex-col gap-4">
			<div className="grid gap-4 xl:grid-cols-[220px_1fr]">
				<SectionNav
					heading="关于"
					activeId={section}
					onPick={(id) => setSection(id as AboutSectionId)}
					items={ABOUT_SECTIONS.map((s) => {
						const SectionIcon = Icon[s.icon];
						return { id: s.id, label: s.label, desc: s.desc, icon: <SectionIcon size={14} /> };
					})}
				/>
				<div className="min-w-0">
					{section === "sponsor" ? (
						<SponsorPanel />
					) : section === "changelog" ? (
						<ChangelogPanel />
					) : (
						<AboutPanel />
					)}
				</div>
			</div>
		</div>
	);
}

function SponsorPanel() {
	const [sponsors, setSponsors] = useState<Sponsor[]>([]);

	// 名单来自 CI 同步生成的静态文件;缺文件或解析失败时静默回退空态(本地/未配 token)。
	useEffect(() => {
		let cancelled = false;
		fetch("/sponsors.json")
			.then((r) => (r.ok ? (r.json() as Promise<SponsorsFile>) : null))
			.then((data) => {
				if (!cancelled && data && Array.isArray(data.sponsors)) setSponsors(data.sponsors);
			})
			.catch(() => {
				/* 无名单文件 → 保持空态 */
			});
		return () => {
			cancelled = true;
		};
	}, []);

	return (
		<div className="space-y-4">
			<div className="rounded-bn-card border border-black/6 bg-bn-surface/80 p-5 shadow-[0_12px_36px_rgba(15,23,42,0.04)] backdrop-blur-sm">
				<div className="mb-4 flex flex-wrap items-start justify-between gap-3 border-b border-black/6 pb-4">
					<div>
						<div className="flex items-center gap-2 text-[15px] font-extrabold text-bn-text-primary">
							<Icon.heart size={16} />
							支持项目
						</div>
						<p className="mt-1 text-[12px] text-bn-text-tertiary">用爱发电,让女仆值班室持续运转</p>
					</div>
				</div>
				<p className="text-[13px] leading-7 text-bn-text-secondary">
					Bilibili Notify 是 MIT 开源、永久免费的项目。服务器、测试设备与持续开发都需要成本,
					如果它帮到了你,欢迎在爱发电请女仆喝杯奶茶 —— 每一份心意,都会化作新功能与更少的 bug。
				</p>
				<div className="mt-4">
					<a
						href={AFDIAN_URL}
						target="_blank"
						rel="noreferrer"
						className="inline-flex items-center gap-2 rounded-full bg-bn-pink px-5 py-2.5 text-[13px] font-bold text-white shadow-[0_6px_18px_rgba(251,114,153,0.3)] transition hover:opacity-90"
					>
						<Icon.heart size={15} />
						前往爱发电支持
					</a>
				</div>
			</div>

			<div className="rounded-bn-card border border-black/6 bg-bn-surface/80 p-5 shadow-[0_12px_36px_rgba(15,23,42,0.04)] backdrop-blur-sm">
				<div className="mb-3 flex items-center gap-2 text-[14px] font-extrabold text-bn-text-primary">
					<Icon.gift size={15} />
					赞助者名单
				</div>
				{sponsors.length === 0 ? (
					<p className="py-6 text-center text-[12.5px] text-bn-text-tertiary">
						还没有人发电,期待第一位供电的主人～
					</p>
				) : (
					<div className="flex flex-wrap gap-2">
						{sponsors.map((s) => (
							<span
								key={s.name}
								className="flex items-center gap-1.5 rounded-full border border-bn-pink/25 bg-bn-pink/8 py-1 pr-3 pl-1 text-[12.5px] font-semibold text-bn-pink"
							>
								{s.avatar ? (
									<img
										src={s.avatar}
										alt={s.name}
										referrerPolicy="no-referrer"
										className="h-5 w-5 rounded-full object-cover"
										onError={(e) => {
											e.currentTarget.style.display = "none";
										}}
									/>
								) : (
									<span className="grid h-5 w-5 place-items-center rounded-full bg-bn-pink/15 text-[10px]">
										{s.name.slice(0, 1)}
									</span>
								)}
								{s.name}
							</span>
						))}
					</div>
				)}
				<p className="mt-3 text-[11px] text-bn-text-tertiary">
					感谢每一位主人的供电 ♡ 名单每日自动同步自爱发电。
				</p>
			</div>
		</div>
	);
}

function AboutPanel() {
	const links: ReadonlyArray<{
		icon: keyof typeof Icon;
		label: string;
		value: string;
		href?: string;
	}> = [
		{ icon: "link", label: "GitHub 仓库", value: "Akokk0/bilibili-notify", href: GITHUB_URL },
		{ icon: "heart", label: "爱发电", value: "支持项目持续更新", href: AFDIAN_URL },
		{ icon: "qq", label: "QQ 交流群", value: QQ_GROUP },
	];

	return (
		<div className="rounded-bn-card border border-black/6 bg-bn-surface/80 p-5 shadow-[0_12px_36px_rgba(15,23,42,0.04)] backdrop-blur-sm">
			<div className="mb-4 flex items-center gap-2 border-b border-black/6 pb-4 text-[15px] font-extrabold text-bn-text-primary">
				<Icon.star size={16} />
				关于本项目
			</div>
			<p className="text-[13px] leading-7 text-bn-text-secondary">
				Bilibili Notify —— 监听 B 站 UP 主动态 / 直播,渲染成卡片图片推送到 QQ 群等渠道。
				一套业务核心、两种形态:Koishi 插件 与 独立 Web Dashboard。MIT 开源。
			</p>
			<div className="mt-4 space-y-2">
				{links.map((l) => (
					<LinkRow key={l.label} {...l} />
				))}
			</div>
			<p className="mt-4 text-[11px] text-bn-text-tertiary">协议 · MIT License</p>
		</div>
	);
}

function LinkRow({
	icon,
	label,
	value,
	href,
}: {
	icon: keyof typeof Icon;
	label: string;
	value: string;
	href?: string;
}) {
	const LinkIcon = Icon[icon];
	const body = (
		<div className="flex items-center gap-3 rounded-[10px] border border-black/6 bg-bn-surface/60 px-3 py-2.5 transition hover:border-bn-pink/30">
			<span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-bn-pink/10 text-bn-pink">
				<LinkIcon size={15} />
			</span>
			<span className="min-w-0 flex-1">
				<span className="block text-[12.5px] font-bold text-bn-text-primary">{label}</span>
				<span className="block truncate text-[11.5px] text-bn-text-tertiary">{value}</span>
			</span>
			{href ? <Icon.link size={13} /> : null}
		</div>
	);
	return href ? (
		<a href={href} target="_blank" rel="noreferrer" className="block">
			{body}
		</a>
	) : (
		body
	);
}

function ChangelogPanel() {
	const [markdown, setMarkdown] = useState<string | null>(changelogCache);
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
