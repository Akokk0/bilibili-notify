import type { AiChatMessageDTO } from "../../services/aiChat";

/**
 * 消息流。用户靠右、气泡带底色;女仆靠左、**不套气泡**。
 *
 * 不对称是有意的:女仆的回答常常是分点的长文,套进气泡会被压成一条窄柱,
 * 读起来比问题还费劲。留白式排版让长回答铺满宽度,气泡则用来标记「这句是
 * 我说的」——短、且需要一眼跟回答区分开。
 */

export interface MessageListProps {
	messages: readonly AiChatMessageDTO[];
	/**
	 * 在途的这一轮 —— 还没落盘,只活在这次渲染里。`ask` 是主人刚发出的那句,
	 * `draft` 是正在逐字长出来的回复(空串 = 第一个字还没到)。
	 */
	pending?: { ask: string; draft: string } | null;
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
					<div
						key={m.id}
						className={`${anim(m.id)}whitespace-pre-wrap break-words text-[15px] leading-[1.78] text-bn-text-primary`}
					>
						{m.content}
					</div>
				),
			)}

			{/* 在途的这一轮。样式与落盘后的那两条**完全一致** —— 一样才能在
			    done 到达、真身替换上来的那一刻毫无痕迹地交接;长得不一样的话,
			    每次回答结束都会看到一下跳变。 */}
			{pending ? (
				<>
					<div className="bn-anim-msg-in flex justify-end">
						<div className="bn-chat-accent-soft max-w-[74%] whitespace-pre-wrap break-words rounded-[22px] rounded-br-[7px] px-[17px] py-[11px] text-[15px] leading-relaxed text-bn-text-primary">
							{pending.ask}
						</div>
					</div>
					{pending.draft ? (
						<div className="whitespace-pre-wrap break-words text-[15px] leading-[1.78] text-bn-text-primary">
							{pending.draft}
							{/* 光标跟在最后一个字后面,说明「还在写」。回复结束后随整块一起
							    被真身替换,不需要单独收尾。 */}
							<span
								className="bn-anim-caret bn-chat-accent-bg ml-0.5 inline-block h-[1.05em] w-[2px] translate-y-[0.18em]"
								aria-hidden="true"
							/>
						</div>
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
