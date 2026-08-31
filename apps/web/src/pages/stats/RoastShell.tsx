import { Btn, GlassPanel, Icon, LoadingBlock } from "@bilibili-notify/ui";
import type { ReactNode } from "react";
import { AI_PURPLE } from "../../config/colors";

/**
 * 两张 AI 锐评卡(榜单版 / 单人版)共用的外壳。
 *
 * 抽出来的是**状态机**而不是版式:待生成 / 生成中 / 失败三种状态的处理完全一样,
 * 而且都有同一个容易翻的坑 —— 后端 4xx/5xx 走 mutation 的 error 分支,业务性
 * 失败(AI 没开、解析失败)却以 `ok:false` 正常返回,两条路都必须能显示原因。
 * 结果本身的版式两张卡差得很远,交给 children。
 */

export interface RoastShellProps {
	title: string;
	subtitle: string;
	/** 未生成时展示的邀请文案。 */
	idle: ReactNode;
	/** 生成中的提示语。**别自带省略号** —— 走 `LoadingBlock`,它统一补。 */
	pendingText: string;
	isPending: boolean;
	err?: string;
	/** 有结果时渲染的正文;为空表示还没生成。 */
	children?: ReactNode;
	onRun: () => void;
}

export function RoastShell({
	title,
	subtitle,
	idle,
	pendingText,
	isPending,
	err,
	children,
	onRun,
}: RoastShellProps) {
	return (
		<GlassPanel
			title={title}
			subtitle={subtitle}
			accent={AI_PURPLE}
			icon={<Icon.ai width={15} height={15} />}
			right={
				children ? (
					<Btn size="sm" variant="outline" onClick={onRun}>
						重新生成
					</Btn>
				) : null
			}
		>
			{isPending ? (
				/* `inset`:已经在 GlassPanel 里了,`card` 会再叠一层玻璃。`h-full` 同下方
				   邀请态 —— 栅格把这张卡拉到与定时周报等高,不撑满的话转圈吊在顶上。 */
				<LoadingBlock label={pendingText} variant="inset" className="h-full" />
			) : children ? (
				children
			) : (
				/* 居中而不是左图右按钮:与定时周报并排之后面板只有半宽,
				   按钮贴到最右会离文案很远,读起来像两件事。
				   正文里不再放大图标 —— 面板标题左边已经有一枚同样的 AI 图标了。
				   `h-full` + `justify-center`:栅格把这张卡拉到与定时周报等高,不撑满
				   的话邀请文案会吊在顶上、下面空一大片。 */
				<div className="flex h-full flex-col items-center justify-center gap-3 px-1 py-4 text-center">
					<div className="max-w-md text-bn-sm leading-relaxed text-bn-text-tertiary">
						{err ? <span className="text-bn-danger-text">生成失败:{err}</span> : idle}
					</div>
					<Btn variant="primary" onClick={onRun}>
						{err ? "重试" : "生成 AI 锐评"}
					</Btn>
				</div>
			)}
		</GlassPanel>
	);
}

/**
 * 把 mutation 的两种失败路径归一成一条错误信息。
 *
 * `isError` 是 HTTP 层的(4xx/5xx 抛异常),`data.ok === false` 是业务层的。
 * 漏掉任何一条都会变成「点了没反应」。
 */
export function roastError(m: {
	isError: boolean;
	error: unknown;
	data?: { ok: boolean; err?: string };
}): string | undefined {
	if (m.isError) return (m.error as Error)?.message ?? "生成失败";
	if (m.data && !m.data.ok) return m.data.err;
	return undefined;
}
