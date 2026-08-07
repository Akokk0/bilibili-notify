import type { ReactNode } from "react";
import { Btn } from "../../components/atoms";
import { GlassPanel } from "../../components/glass";
import { Icon } from "../../components/icons";

/**
 * 两张 AI 锐评卡(榜单版 / 单人版)共用的外壳。
 *
 * 抽出来的是**状态机**而不是版式:待生成 / 生成中 / 失败三种状态的处理完全一样,
 * 而且都有同一个容易翻的坑 —— 后端 4xx/5xx 走 mutation 的 error 分支,业务性
 * 失败(AI 没开、解析失败)却以 `ok:false` 正常返回,两条路都必须能显示原因。
 * 结果本身的版式两张卡差得很远,交给 children。
 */

// 十六进制字面量,不能用 var() —— GlassPanel 要拼 `${accent}1f` 造光晕。
export const ROAST_PURPLE = "#6c5ce7";
const PURPLE_LIGHT = "#a29bfe";

export interface RoastShellProps {
	title: string;
	subtitle: string;
	/** 未生成时展示的邀请文案。 */
	idle: ReactNode;
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
			accent={ROAST_PURPLE}
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
				<div className="flex flex-col items-center justify-center gap-3 py-7">
					<div
						className="h-8 w-8 animate-spin rounded-full border-4 border-bn-border"
						style={{ borderTopColor: ROAST_PURPLE }}
					/>
					<div className="text-xs text-bn-text-tertiary">{pendingText}</div>
				</div>
			) : children ? (
				children
			) : (
				/* 居中而不是左图右按钮:与定时周报并排之后面板只有半宽,
				   按钮贴到最右会离文案很远,读起来像两件事。 */
				<div className="flex flex-col items-center gap-3 px-1 py-4 text-center">
					<div
						className="flex h-11 w-11 shrink-0 items-center justify-center rounded-bn-card text-white"
						style={{
							background: `linear-gradient(135deg, ${PURPLE_LIGHT}, ${ROAST_PURPLE})`,
							boxShadow: `0 6px 16px ${ROAST_PURPLE}4d`,
						}}
					>
						<Icon.ai width={22} height={22} />
					</div>
					<div className="max-w-md text-xs leading-relaxed text-bn-text-tertiary">
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
