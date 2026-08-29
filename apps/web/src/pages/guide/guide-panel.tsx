import { GlassPanel, Picker, Pill, StatusDot } from "@bilibili-notify/ui";
import { useNavigate } from "react-router-dom";
import { useOnboardingState } from "../../components/onboarding/use-onboarding-view";
import aiMd from "./content/ai.md?raw";
import loginMd from "./content/login.md?raw";
import overviewMd from "./content/overview.md?raw";
import pushMd from "./content/push.md?raw";
import renderMd from "./content/render.md?raw";
import subsMd from "./content/subs.md?raw";
import { GuideMarkdown } from "./guide-markdown";

/**
 * 新手指引面板 —— 关于页的一个 section(五轮定稿:独立路由撤销,教程并进
 * 关于;`/about/guide/:chapter?` 深链直达章节,导览尾巴链接靠它)。
 *
 * - 章节正文是 content/*.md(`?raw` 随 bundle,GuideMarkdown 渲染)——
 *   改教程文案只动 md,不碰代码;
 * - 未知章节回退总览:外部链接坏了也不该白屏;
 * - 章节顺序跟导览主步一致(登录 → 推送通道 → 订阅),看完教程照着做不用跳序;
 * - 顶部常驻进度(与左缘导览同一份判据 useOnboardingState)。
 */

const CHAPTERS: { key: string; title: string; source: string }[] = [
	{ key: "overview", title: "总览与选型", source: overviewMd },
	{ key: "login", title: "登录 B 站", source: loginMd },
	{ key: "push", title: "推送通道", source: pushMd },
	{ key: "subs", title: "订阅 UP", source: subsMd },
	{ key: "render", title: "图片渲染", source: renderMd },
	{ key: "ai", title: "AI 能力", source: aiMd },
];

export function GuidePanel({ chapter }: { chapter?: string | undefined }) {
	const navigate = useNavigate();
	const current = CHAPTERS.find((c) => c.key === (chapter ?? "overview")) ?? CHAPTERS[0];
	const { view, ready } = useOnboardingState();

	return (
		<div className="flex flex-col gap-4">
			<div className="flex flex-wrap items-center justify-between gap-3">
				{/* 章节切换走库件 Picker(段选钮组);URL 仍是真源 —— 选中态由路由推回来 */}
				<Picker
					value={current.key}
					onChange={(key) =>
						// replace 同 About 的 section 切换:翻章节不是「去了别的地方」,
						// push 会让读完三章的人按三次返回才退得出去。
						navigate(key === "overview" ? "/about/guide" : `/about/guide/${key}`, {
							replace: true,
						})
					}
					options={CHAPTERS.map((c) => ({ value: c.key, label: c.title }))}
				/>
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
				<div className="max-w-180">
					<GuideMarkdown source={current.source} />
				</div>
			</GlassPanel>
		</div>
	);
}
