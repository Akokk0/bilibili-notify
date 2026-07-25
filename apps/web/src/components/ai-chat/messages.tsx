import type { AiChatMessageDTO } from "../../services/aiChat";
import { Icon } from "../icons";
import { toolLabel } from "./tools";

/**
 * 消息流。用户靠右、气泡带底色;女仆靠左、**不套气泡**。
 *
 * 不对称是有意的:女仆的回答常常是分点的长文,套进气泡会被压成一条窄柱,
 * 读起来比问题还费劲。留白式排版让长回答铺满宽度,气泡则用来标记「这句是
 * 我说的」——短、且需要一眼跟回答区分开。
 */

/**
 * 一条工具调用小条要显示的东西。
 *
 * `ok` 缺席 = 还在跑。落盘后的痕迹一定是有结论的(服务端只存收了尾的),所以
 * 「进行中」这个态只会出现在在途那一份上。
 */
export interface ToolChipData {
	name: string;
	args: Record<string, string>;
	ok?: boolean;
}

export interface MessageListProps {
	messages: readonly AiChatMessageDTO[];
	/**
	 * 在途的这一轮 —— 还没落盘,只活在这次渲染里。`ask` 是主人刚发出的那句,
	 * `draft` 是正在逐字长出来的回复(空串 = 第一个字还没到),`tools` 是这一轮
	 * 已经动过的工具。
	 */
	pending?: { ask: string; draft: string; tools: readonly ToolChipData[] } | null;
	/** 正在等回复 → 第一个字到达之前显示打字点。 */
	busy: boolean;
	/** 上一轮失败时的错误文案;失败的问答不落盘,所以只存在于本次渲染。 */
	error?: string | null;
	/** 女仆的自称,用于以她口吻写的那两句(正在思考 / 出错了)。 */
	aiSelf: string;
	/**
	 * 不播入场动画的消息 id —— 刚由在途副本交接成真身的那两条。
	 *
	 * 它们上一帧还以副本形态挂在同一个位置,主人已经看着它们长出来了;真身接手
	 * 时再淡入上移一次,就是回复吐完最后那一下「闪」。
	 */
	noAnimIds?: readonly string[];
}

export function MessageList({
	messages,
	pending,
	busy,
	error,
	aiSelf,
	noAnimIds,
}: MessageListProps) {
	const anim = (id: string) => (noAnimIds?.includes(id) ? "" : "bn-anim-msg-in ");
	return (
		// testid 不是随手加的:输入框里的字、侧栏底部的用户名都会被 getByText 命中
		// (受控 textarea 在 DOM 里也有同样的 textContent),不圈定范围的话,
		// 「消息有没有上屏」这类断言会被那两处冒名顶替,测试假绿。
		<div
			data-testid="chat-messages"
			className="mx-auto flex w-full max-w-[720px] flex-col gap-[22px]"
		>
			{messages.map((m) =>
				m.role === "user" ? (
					<div key={m.id} className={`${anim(m.id)}flex justify-end`}>
						<div className="bn-chat-accent-soft max-w-[74%] whitespace-pre-wrap break-words rounded-[22px] rounded-br-[7px] px-[17px] py-[11px] text-[15px] leading-relaxed text-bn-text-primary">
							{m.content}
						</div>
					</div>
				) : (
					<AssistantTurn key={m.id} animClass={anim(m.id)} tools={m.tools} text={m.content} />
				),
			)}

			{/* 在途的这一轮。女仆那半边**走同一个组件** —— 样式一致才能在 done 到达、
			    真身替换上来的那一刻毫无痕迹地交接。曾经这里是复制的一份 className,
			    改动只落到其中一处就又跳起来了,所以现在由构造本身保证一致。 */}
			{pending ? (
				<>
					<div className="bn-anim-msg-in flex justify-end">
						<div className="bn-chat-accent-soft max-w-[74%] whitespace-pre-wrap break-words rounded-[22px] rounded-br-[7px] px-[17px] py-[11px] text-[15px] leading-relaxed text-bn-text-primary">
							{pending.ask}
						</div>
					</div>
					{/* 工具还在跑、正文一个字都没有时也要出现 —— 那正是最需要说话的一刻。 */}
					{pending.tools.length > 0 || pending.draft ? (
						<AssistantTurn animClass="" tools={pending.tools} text={pending.draft} caret />
					) : null}
				</>
			) : null}

			{/* 打字点只在**第一个字还没到**的时候出现:字一开始流出来,光标就接手了,
			    两个同时在场会显得有两处都在动。 */}
			{busy && !pending?.draft ? (
				// role="status" 而不是裸 div:三个跳动的点对读屏器是完全不可见的,
				// 加上它才会念出「女仆正在思考」,否则按下发送后那边一片死寂。
				<div
					className="bn-anim-msg-in flex gap-[5px] pl-0.5"
					role="status"
					aria-label={`${aiSelf}正在思考`}
				>
					{[0, 1, 2].map((d) => (
						<span
							key={d}
							className="bn-anim-typing bn-chat-accent-bg h-[7px] w-[7px] rounded-full"
							style={{ animationDelay: `${d * 0.15}s` }}
						/>
					))}
				</div>
			) : null}

			{error ? (
				// 错误不进消息流的原因:那一轮问答根本没落盘(见服务端「整轮成败一致」),
				// 把它画成一条助手消息,刷新后凭空消失,像是被谁偷偷删了。
				<div
					role="alert"
					className="rounded-xl border border-bn-danger-border bg-bn-danger-soft px-4 py-3 text-[13px] leading-relaxed text-bn-danger-text"
				>
					呜…{aiSelf}出错了:{error}
				</div>
			) : null}
		</div>
	);
}

/**
 * 女仆那半边的一整轮:先是几条工具小条,再是正文。
 *
 * 在途副本与落盘真身**共用**这一个组件,而不是各写一份 className。之前是复制的
 * 两份,改动只落到其中一处,交接那一刻就又跳一下 —— 这类一致性靠人眼盯不住,
 * 只能由构造本身保证。
 */
function AssistantTurn({
	animClass,
	tools,
	text,
	caret,
}: {
	/** 入场动画类(含尾随空格)或空串。 */
	animClass: string;
	tools?: readonly ToolChipData[];
	text: string;
	/** 跟在最后一个字后面的光标,只有在途那一份有。 */
	caret?: boolean;
}) {
	return (
		// 小条与正文之间的 8px 由 gap 给,不挂在小条自己身上 —— 工具还在跑、正文
		// 一个字都没有时,那就是一段悬在空处的下边距。
		<div className={`${animClass}flex flex-col gap-2`}>
			{tools?.length ? <ToolChips traces={tools} /> : null}
			{/* whitespace-pre-wrap 只包正文:套在外层的话,JSX 里的换行缩进会
			    变成小条与正文之间凭空多出的空行。 */}
			{text ? (
				<div className="whitespace-pre-wrap break-words text-[15px] leading-[1.78] text-bn-text-primary">
					{text}
					{caret ? (
						<span
							className="bn-anim-caret bn-chat-accent-bg ml-0.5 inline-block h-[1.05em] w-[2px] translate-y-[0.18em]"
							aria-hidden="true"
						/>
					) : null}
				</div>
			) : null}
		</div>
	);
}

/**
 * 「她刚查了什么」的那一排小条。
 *
 * 工具轮不产生正文,那几秒在界面上原本跟「模型卡住了」一模一样。三个态各给一个
 * 图标:转圈=还在查、勾=查到了、叉=没查成。失败的那条**留在原地**而不是抹掉 ——
 * 「查了但没查到」和「压根没查」会导出完全不同的追查方向。
 */
function ToolChips({ traces }: { traces: readonly ToolChipData[] }) {
	return (
		<div className="flex flex-wrap gap-1.5">
			{traces.map((t, i) => {
				const state = t.ok === undefined ? "running" : t.ok ? "ok" : "failed";
				const label = toolLabel(t.name, t.args);
				return (
					<span
						// 同名工具在一轮里可能被调两次(查两个 UP),name 单独当不了 key。
						// biome-ignore lint/suspicious/noArrayIndexKey: 这一排只在末尾追加、不删不重排(在途那份逐个 append,落盘那份整个不可变),下标就是稳定身份
						key={`${t.name}-${i}`}
						data-testid="tool-trace"
						data-state={state}
						title={`${label} · ${STATE_TEXT[state]}`}
						className="bn-glass-chip flex max-w-full items-center gap-[6px] rounded-[13px] px-[9px] py-[3px] text-[11.5px] text-bn-text-tertiary"
					>
						<span
							className={state === "failed" ? "flex text-bn-danger-text" : "bn-chat-accent flex"}
							aria-hidden="true"
						>
							{state === "running" ? (
								<Icon.refresh size={11} className="bn-anim-spin" />
							) : state === "ok" ? (
								<Icon.check size={11} />
							) : (
								<Icon.close size={11} />
							)}
						</span>
						{/* 状态只靠图标和颜色区分,读屏器看不见 —— 靠上面那个 title
						    把它念出来(图标本身是 aria-hidden 的)。 */}
						<span className="truncate">{label}</span>
					</span>
				);
			})}
		</div>
	);
}

const STATE_TEXT = { running: "正在查", ok: "已完成", failed: "没查成" } as const;
