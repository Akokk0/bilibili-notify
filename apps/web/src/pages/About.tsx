import { EmptyNote, Icon, LoadingBlock, SELECTED_TINT_BG, SectionNav } from "@bilibili-notify/ui";
import { lazy, type ReactNode, Suspense, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { DOC_MARKDOWN_COMPONENTS } from "../components/doc-markdown";
import { i18n, useT } from "../i18n";
import { externalLinkClick } from "../utils/externalLink";

/**
 * `/about/:section?/:chapter?` — 关于 / 支持项目。聚合面向用户的项目元信息(非操作内容):
 * - 支持项目(爱发电入口 + 赞助者名单)—— 默认 section,温和引导现有用户赞助
 * - 新手指引(长图文教程,五轮定稿从独立路由并进来;chapter 深链给导览尾巴用)
 * - 更新日志(独立端 CHANGELOG.md,从原 `/logs` 页迁来)
 * - 关于本项目(仓库 · 交流群 · 协议)
 *
 * section 由 URL 驱动(SectionNav 点击 navigate),`/about/guide/render` 这类
 * 深链直达教程章节;认不出的 section 回退默认,不白屏。
 *
 * 与 Logs 同构。入场动画走 bn-anim-page-in(纯位移、无 filling),不会留下
 * 残留 transform 去改写 SectionNav 竖栏的包含块。
 */

// 主人:把下面换成你的真实爱发电主页地址。
const AFDIAN_URL = "https://afdian.com/a/akokko";
const GITHUB_URL = "https://github.com/Akokk0/bilibili-notify";
const QQ_GROUP = "801338523";

// 赞助者名单文件 —— 由 CI(scripts/fetch-sponsors.mjs)在每次独立端发版构建时从爱发电同步生成,
// 产物在 apps/web/public/sponsors.json。缺文件(本地 / 未配 token)时前端回退空态。
interface Sponsor {
	name: string;
	avatar: string;
}
interface SponsorsFile {
	sponsors: Sponsor[];
}

const ReactMarkdown = lazy(() => import("react-markdown"));

/**
 * 指引面板走懒加载 —— 它是 react-markdown / remark-gfm(约 153KB)与六份
 * `content/*.md?raw` 的唯一入口。静态引它等于把这一坨塞进初始包,连带把上面
 * 那句 `lazy(() => import("react-markdown"))` 变成摆设(库已在主包里,没东西
 * 可懒)。守卫见 __tests__/markdown-chunk.test.ts —— 它从 main.tsx 爬静态可达图,
 * 旧的那道(只扫 components/ai-chat/ 一个目录)正是漏掉本页这条路才被换掉的。
 */
const GuidePanel = lazy(() =>
	import("./guide/guide-panel").then((m) => ({ default: m.GuidePanel })),
);

// 模块级缓存:首次加载后复用。切回「更新日志」时 ChangelogPanel 直接以缓存初始化 markdown,
// 不再经历 null →「加载中」矮占位 → 内容的一帧高度跳变(切换抖动的成因之一)。
let changelogCache: string | null = null;

async function loadChangelogMarkdown(): Promise<string> {
	if (changelogCache != null) return changelogCache;
	const mod = await import("../../../CHANGELOG.md?raw");
	changelogCache = mod.default;
	return changelogCache;
}

type AboutSectionId = "sponsor" | "guide" | "changelog" | "about";

const ABOUT_SECTIONS: ReadonlyArray<{
	id: AboutSectionId;
	label: string;
	desc: string;
	icon: keyof typeof Icon;
}> = [
	{
		id: "sponsor",
		get label() {
			return i18n.t("panelUi.pages.About.1");
		},
		get desc() {
			return i18n.t("panelUi.pages.About.2");
		},
		icon: "heart",
	},
	{
		id: "guide",
		get label() {
			return i18n.t("panelUi.pages.About.3");
		},
		get desc() {
			return i18n.t("panelUi.pages.About.4");
		},
		icon: "list",
	},
	{
		id: "changelog",
		get label() {
			return i18n.t("panelUi.pages.About.5");
		},
		get desc() {
			return i18n.t("panelUi.pages.About.6");
		},
		icon: "sparkle",
	},
	{
		id: "about",
		get label() {
			return i18n.t("panelUi.pages.About.7");
		},
		get desc() {
			return i18n.t("panelUi.pages.About.8");
		},
		icon: "star",
	},
];

function isSectionId(v: string | undefined): v is AboutSectionId {
	return ABOUT_SECTIONS.some((s) => s.id === v);
}

export default function About() {
	const tx = useT();

	const params = useParams<{ section?: string; chapter?: string }>();
	const navigate = useNavigate();
	// 认不出的 section(URL 手改/过时收藏)回退默认,与未知教程章节回退总览同理。
	const section: AboutSectionId = isSectionId(params.section) ? params.section : "sponsor";

	return (
		<div className="bn-anim-page-in flex min-w-0 flex-col gap-4">
			<div className="grid min-w-0 grid-cols-1 gap-4 xl:grid-bn-rail">
				<SectionNav
					heading={tx("panelUi.pages.About.9")}
					activeId={section}
					onPick={(id) =>
						// replace:换 section 是看同一页的另一面,不是去了别的地方。push 的话逛
						// 几圈就把返回键堵死(点当前这个还会压一条重复的);URL 照旧是真源。
						navigate(id === "sponsor" ? "/about" : `/about/${id}`, { replace: true })
					}
					items={ABOUT_SECTIONS.map((s) => {
						const SectionIcon = Icon[s.icon];
						return { id: s.id, label: s.label, desc: s.desc, icon: <SectionIcon size={14} /> };
					})}
				/>
				<div className="min-w-0">
					{section === "sponsor" ? (
						<SponsorPanel />
					) : section === "guide" ? (
						<Suspense
							fallback={<LoadingBlock label={tx("panelUi.pages.About.10")} variant="inset" />}
						>
							<GuidePanel chapter={params.chapter} />
						</Suspense>
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

/**
 * 粉描边淡底的胶囊(赞助者名牌 / CHANGELOG 文件名标)。padding 与字号由摆放处给 ——
 * 名牌左边贴着圆头像要 pl-1,文件名标是等宽小字,两处天生不同,不算漂移。
 */
function PinkPill({ className, children }: { className?: string; children: ReactNode }) {
	return (
		// 装饰徽章不是选中态,描边留 /25 轻档;粉底吃 SELECTED_TINT_BG 的不透明出法
		// (旧 bg-bn-pink/8 是纱,皮肤换底后会隐形)。
		<span
			className={`inline-flex items-center gap-1.5 rounded-bn-pill border border-bn-pink/25 ${SELECTED_TINT_BG} font-semibold text-bn-pink ${className ?? ""}`}
		>
			{children}
		</span>
	);
}

/** About 页玻璃面板的头行:图标 + 粗标题(可带副行 / 右槽),下缘细分隔线 —— 三块面板此前各抄一份。 */
function PanelHead({
	icon,
	title,
	sub,
	right,
}: {
	icon: ReactNode;
	title: ReactNode;
	sub?: ReactNode;
	right?: ReactNode;
}) {
	return (
		<div className="mb-4 flex flex-wrap items-start justify-between gap-3 border-b border-bn-border-subtle pb-4">
			<div>
				<div className="flex items-center gap-2 text-bn-md font-extrabold text-bn-text-primary">
					{icon}
					{title}
				</div>
				{sub ? <p className="mt-1 text-bn-sm text-bn-text-tertiary">{sub}</p> : null}
			</div>
			{right}
		</div>
	);
}

function SponsorPanel() {
	const tx = useT();

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
			<div className="bn-glass rounded-bn-card p-5 shadow-bn-card">
				<PanelHead
					icon={<Icon.heart size={16} />}
					title={tx("panelUi.pages.About.11")}
					sub={tx("panelUi.pages.About.12")}
				/>
				<p className="text-bn-base leading-7 text-bn-text-secondary">
					{tx("panelUi.pages.About.13")}
				</p>
				{/*
				 * 它长得就是一颗实心粉主按钮,只是行为上是条外链,所以留 a 标签没换成 Btn ——
				 * Btn 只渲染 button,为一处调用给它开 href 分支不值当。挂点认的是「这是什么」
				 * 而不是「用什么标签写的」。
				 *
				 * **`btn btn-primary` 两个都要写,少一个就是白底白字**:实心底那半随皮肤走,
				 * 而当时的字色是写死的 `text-white`(现已改走 `on-solid` token)。皮肤惯常写 `[data-bn="btn"]`
				 * (精确匹配),它碰不到库里 `data-bn="btn btn-primary"` 的主按钮 —— 只写
				 * `"btn"` 的话,这颗就成了全站唯一被中性底刷中的主按钮,字还是白的。
				 * 真机上栽过一次(2026-08-21)。
				 *
				 * 圆角走 rounded-bn-pill 而非 rounded-full:后者是写死的 9999px,
				 * 皮肤的 radius.pill 压不平它。
				 */}
				<div className="mt-4">
					<a
						href={AFDIAN_URL}
						target="_blank"
						rel="noreferrer"
						onClick={externalLinkClick(AFDIAN_URL)}
						data-bn="btn btn-primary"
						className="inline-flex items-center gap-2 rounded-bn-pill bg-bn-pink px-5 py-2.5 text-bn-base font-bold text-bn-on-solid shadow-bn-accent-lg transition hover:opacity-90"
					>
						<Icon.heart size={15} />
						{tx("panelUi.pages.About.14")}
					</a>
				</div>
			</div>

			<div className="bn-glass rounded-bn-card p-5 shadow-bn-card">
				<div className="mb-3 flex items-center gap-2 text-bn-md font-extrabold text-bn-text-primary">
					<Icon.gift size={15} />
					{tx("panelUi.pages.About.15")}
				</div>
				{sponsors.length === 0 ? (
					<EmptyNote>{tx("panelUi.pages.About.16")}</EmptyNote>
				) : (
					<div className="flex flex-wrap gap-2">
						{sponsors.map((s) => (
							<PinkPill key={s.name} className="py-1 pr-3 pl-1 text-bn-sm">
								{s.avatar ? (
									<img
										src={s.avatar}
										alt={s.name}
										referrerPolicy="no-referrer"
										data-bn="avatar"
										className="h-5 w-5 rounded-full object-cover"
										onError={(e) => {
											e.currentTarget.style.display = "none";
										}}
									/>
								) : (
									<span className="grid h-5 w-5 place-items-center rounded-full bg-bn-pink/15 text-bn-2xs">
										{s.name.slice(0, 1)}
									</span>
								)}
								{s.name}
							</PinkPill>
						))}
					</div>
				)}
				<p className="mt-3 text-bn-xs text-bn-text-tertiary">
					{tx("panelUi.pages.About.17")}
					<Icon.heart size={10} className="mx-1 inline-block align-[-1px] text-bn-pink" />
					{tx("panelUi.pages.About.18")}
				</p>
			</div>
		</div>
	);
}

function AboutPanel() {
	const tx = useT();

	const links: ReadonlyArray<{
		icon: keyof typeof Icon;
		label: string;
		value: string;
		href?: string;
	}> = [
		{
			icon: "link",
			label: tx("panelUi.pages.About.19"),
			value: "Akokk0/bilibili-notify",
			href: GITHUB_URL,
		},
		{
			icon: "heart",
			label: tx("panelUi.pages.About.20"),
			value: tx("panelUi.pages.About.21"),
			href: AFDIAN_URL,
		},
		{ icon: "qq", label: tx("panelUi.pages.About.22"), value: QQ_GROUP },
	];

	return (
		<div className="bn-glass rounded-bn-card p-5 shadow-bn-card">
			<PanelHead icon={<Icon.star size={16} />} title={tx("panelUi.pages.About.23")} />
			<p className="text-bn-base leading-7 text-bn-text-secondary">
				{tx("panelUi.pages.About.24")}
			</p>
			<div className="mt-4 space-y-2">
				{links.map((l) => (
					<LinkRow key={l.label} {...l} />
				))}
			</div>
			<p className="mt-4 text-bn-xs text-bn-text-tertiary">{tx("panelUi.pages.About.25")}</p>
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
		<div className="flex items-center gap-3 rounded-bn-sm border border-bn-border-subtle bg-bn-surface/60 px-3 py-2.5 transition hover:border-bn-pink/30">
			<span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-bn-pink/10 text-bn-pink">
				<LinkIcon size={15} />
			</span>
			<span className="min-w-0 flex-1">
				<span className="block text-bn-sm font-bold text-bn-text-primary">{label}</span>
				<span className="block truncate text-bn-xs text-bn-text-tertiary">{value}</span>
			</span>
			{href ? <Icon.link size={13} /> : null}
		</div>
	);
	return href ? (
		<a
			href={href}
			target="_blank"
			rel="noreferrer"
			onClick={externalLinkClick(href)}
			className="block"
		>
			{body}
		</a>
	) : (
		body
	);
}

function ChangelogPanel() {
	const tx = useT();

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
		<div className="bn-glass rounded-bn-card p-5 shadow-bn-card">
			<PanelHead
				icon={<Icon.sparkle size={16} />}
				title={tx("panelUi.pages.About.26")}
				sub={tx("panelUi.pages.About.27")}
				right={<PinkPill className="px-3 py-1 font-mono text-bn-xs">apps/CHANGELOG.md</PinkPill>}
			/>
			<div className="max-w-none">
				{loadError ? (
					<div className="py-8 text-center text-bn-sm text-bn-danger">
						{tx("panelUi.pages.About.28")}
						{loadError}
					</div>
				) : markdown == null ? (
					<LoadingBlock label={tx("panelUi.pages.About.29")} variant="inset" />
				) : (
					<Suspense
						fallback={<LoadingBlock label={tx("panelUi.pages.About.30")} variant="inset" />}
					>
						<ReactMarkdown components={DOC_MARKDOWN_COMPONENTS}>{markdown}</ReactMarkdown>
					</Suspense>
				)}
			</div>
		</div>
	);
}
