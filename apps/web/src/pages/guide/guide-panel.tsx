import { GlassPanel, Pill, StatusDot } from "@bilibili-notify/ui";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { useOnboardingState } from "../../components/onboarding/use-onboarding-view";
import { ChapterPush } from "./chapter-push";
import { ChapterAi, ChapterLogin, ChapterOverview, ChapterRender, ChapterSubs } from "./chapters";

/**
 * 新手指引面板 —— 关于页的一个 section(五轮定稿:独立路由撤销,教程并进
 * 关于;`/about/guide/:chapter?` 深链直达章节,导览尾巴链接靠它)。
 *
 * - 未知章节回退总览:外部链接坏了也不该白屏;
 * - 章节顺序跟导览主步一致(登录 → 推送通道 → 订阅),看完教程照着做不用跳序;
 * - 顶部常驻进度(与左缘导览同一份判据 useOnboardingState)。
 */

const CHAPTERS: { key: string; title: string; body: ReactNode }[] = [
	{ key: "overview", title: "总览与选型", body: <ChapterOverview /> },
	{ key: "login", title: "登录 B 站", body: <ChapterLogin /> },
	{ key: "push", title: "推送通道", body: <ChapterPush /> },
	{ key: "subs", title: "订阅 UP", body: <ChapterSubs /> },
	{ key: "render", title: "图片渲染", body: <ChapterRender /> },
	{ key: "ai", title: "AI 能力", body: <ChapterAi /> },
];

export function GuidePanel({ chapter }: { chapter?: string | undefined }) {
	const current = CHAPTERS.find((c) => c.key === (chapter ?? "overview")) ?? CHAPTERS[0];
	const { view, ready } = useOnboardingState();

	return (
		<div className="flex flex-col gap-4">
			<div className="flex flex-wrap items-center gap-3">
				<nav aria-label="指引章节" className="flex flex-1 flex-row flex-wrap gap-1.5">
					{CHAPTERS.map((c) => {
						const active = c.key === current.key;
						return (
							<Link
								key={c.key}
								to={c.key === "overview" ? "/about/guide" : `/about/guide/${c.key}`}
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
			<GlassPanel title={current.title}>
				<div className="max-w-[720px]">{current.body}</div>
			</GlassPanel>
		</div>
	);
}
