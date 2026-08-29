import { GlassPanel, Pill, StatusDot } from "@bilibili-notify/ui";
import type { ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { useOnboardingState } from "../../components/onboarding/use-onboarding-view";
import { ChapterPush } from "./chapter-push";
import { ChapterAi, ChapterLogin, ChapterOverview, ChapterRender, ChapterSubs } from "./chapters";

/**
 * /guide/:chapter? —— 新手指引页(2026-08-29 grilling 定案:独立路由承载长图文)。
 *
 * - 未知章节回退总览:进度卡里的链接坏了也不该白屏;
 * - 顶部常驻进度(与首页进度卡同一份判据 useOnboardingState)——
 *   首页卡收起后,这里是「再看进度」的去处;
 * - 章节导航走 xl:grid-bn-rail 双栏骨架(窄视口横向 chip 条)。
 */

const CHAPTERS: { key: string; title: string; body: ReactNode }[] = [
	{ key: "overview", title: "总览与选型", body: <ChapterOverview /> },
	{ key: "login", title: "登录 B 站", body: <ChapterLogin /> },
	{ key: "subs", title: "订阅 UP", body: <ChapterSubs /> },
	{ key: "push", title: "推送通道", body: <ChapterPush /> },
	{ key: "render", title: "图片渲染", body: <ChapterRender /> },
	{ key: "ai", title: "AI 能力", body: <ChapterAi /> },
];

export function Guide() {
	const { chapter } = useParams<{ chapter: string }>();
	const current = CHAPTERS.find((c) => c.key === (chapter ?? "overview")) ?? CHAPTERS[0];
	const { view, ready } = useOnboardingState();

	return (
		<div className="bn-anim-page-in flex flex-col gap-4">
			<div className="flex flex-wrap items-center gap-3">
				<h1 className="text-bn-xl font-semibold text-bn-text-primary">新手指引</h1>
				{ready && view ? (
					<span className="flex items-center gap-1.5">
						{view.steps.map((s) => (
							<StatusDot key={s.key} kind={s.done ? "ok" : "pending"} size="sm" />
						))}
						<Pill subtle size="sm" className="ml-1">
							{view.doneCount}/{view.steps.length}
						</Pill>
					</span>
				) : null}
			</div>
			<div className="grid gap-4 xl:grid-bn-rail">
				<nav aria-label="指引章节" className="flex flex-row flex-wrap gap-1.5 xl:flex-col">
					{CHAPTERS.map((c) => {
						const active = c.key === current.key;
						return (
							<Link
								key={c.key}
								to={c.key === "overview" ? "/guide" : `/guide/${c.key}`}
								data-bn="btn"
								className={
									active
										? "rounded-bn-pill bg-bn-pink px-3 py-1.5 text-bn-sm font-medium text-bn-on-solid"
										: "rounded-bn-pill px-3 py-1.5 text-bn-sm text-bn-text-secondary transition-colors hover:text-bn-text-primary"
								}
							>
								{c.title}
							</Link>
						);
					})}
				</nav>
				<GlassPanel title={current.title}>
					<div className="max-w-[720px]">{current.body}</div>
				</GlassPanel>
			</div>
		</div>
	);
}
