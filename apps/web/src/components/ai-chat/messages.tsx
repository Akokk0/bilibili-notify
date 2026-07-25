import { useEffect, useSyncExternalStore } from "react";
import type { AiChatMessageDTO } from "../../services/aiChat";
import { Icon } from "../icons";
import { toolLabel } from "./tools";

/**
 * Markdown 渲染**动态**加载。
 *
 * `react-markdown` 连带 micromark / mdast 那一整套约 153KB(实测:主 chunk
 * 1029KB → 876KB)。`AiChatDock` 静态挂在 App 根上,静态引入就等于让每次打开
 * dashboard 都扛这 153KB —— 而主人可能从不点开聊天。顺带还会毁掉 About 页那边
 * `lazy(() => import("react-markdown"))` 的努力:库进了主包,那个 lazy 没东西可懒。
 *
 * **刻意不用 `lazy` + `Suspense`**,而是自己攥着模块。原因是 lazy 的 init 要等到
 * 组件第一次真被渲染才跑,那时哪怕 chunk 早已在缓存里,`import()` 拿回来的仍是个
 * promise —— React 照样先抛它、提交一帧 fallback,下个微任务才换成 Markdown。
 * 于是**新会话**的第一句回复必然先闪一下纯文本(有历史消息的会话里这一帧被面板
 * 入场动画盖住了,所以一直没露馅)。预取解决不了这个:那不是网络,是那一帧。
 *
 * 换成模块级变量 + `useSyncExternalStore` 之后,「到手了没」是个能**同步**读出来的
 * 值:已经在手上,第一帧就是终态。顺带还去掉了一个隐患 —— 挂在 lazy 上时这里没有
 * error boundary,chunk 取不到(离线 / 部署换版本)就是整个聊天白屏;现在退回纯文本。
 */
type MarkdownModule = typeof import("./markdown");

/** 已到手的模块。非空 = 可以同步用。 */
let markdownModule: MarkdownModule | null = null;
/** 正在路上的那一次。预热会被调好几次(空闲、hover、面板挂载),靠它去重。 */
let markdownInflight: Promise<MarkdownModule | null> | null = null;
const markdownWaiters = new Set<() => void>();

/**
 * 取 Markdown 模块。幂等 —— 重复调只是拿同一个 promise。
 *
 * 加载与预热共用这一个 specifier,不各写一份 —— 两个字符串一旦写歪,预热的就是
 * 另一个 chunk,而症状只是「偶尔闪一下」,极难查。
 */
function loadMarkdown(): Promise<MarkdownModule | null> {
	if (markdownModule) return Promise.resolve(markdownModule);
	markdownInflight ??= import("./markdown").then(
		(m) => {
			markdownModule = m;
			for (const notify of markdownWaiters) notify();
			return m;
		},
		(err) => {
			// 把 inflight 清掉,下一次预热(空闲 / hover / 面板挂载)能重试;这期间
			// 正文一直按纯文本显示,不白屏。
			markdownInflight = null;
			console.error("[ai-chat] Markdown 渲染模块没取到,先按纯文本显示", err);
			return null;
		},
	);
	return markdownInflight;
}

/**
 * 预热 Markdown chunk。首屏空闲时就调,别等主人点开聊天。
 *
 * 不预热的话,首条回复到达时先落到纯文本、chunk 落地后再翻成 Markdown ——
 * 那一下重排正是主人报过的「闪一下」。
 *
 * 返回 promise 是给测试用的:「预取已经完成」这个前提必须能被**等到**,否则断言
 * 「第一帧就是排版好的」只能靠猜微任务次序。调用方一律当即弃即忘用。
 */
export function preloadChatMarkdown(): Promise<void> {
	return loadMarkdown().then(() => undefined);
}

function subscribeMarkdown(onChange: () => void): () => void {
	markdownWaiters.add(onChange);
	return () => {
		markdownWaiters.delete(onChange);
	};
}

/** Markdown 渲染组件,还没到手时是 null(这一帧先用纯文本)。 */
type MarkdownComp = MarkdownModule["ChatMarkdown"] | null;

function useChatMarkdown(): MarkdownComp {
	// 第三个参数(getServerSnapshot)在这个纯客户端应用里跑不到,但缺了它就没法用
	// 单趟渲染(renderToStaticMarkup)去查「提交的第一帧长什么样」—— 那是**唯一**
	// 能把「已在手上却慢一帧」这个 bug 抓出来的角度:RTL 的 render 裹在 act 里,
	// effect 引起的重渲染在它返回之前就冲洗完了,查不出差别(试过,假绿)。
	const mod = useSyncExternalStore(
		subscribeMarkdown,
		() => markdownModule,
		() => markdownModule,
	);
	// 兜底:谁都没预热过(或上次取失败了)也得自己去取。
	useEffect(() => {
		if (!mod) preloadChatMarkdown();
	}, [mod]);
	return mod?.ChatMarkdown ?? null;
}

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
	// 订阅放在这里而不是每条消息里:一屋子消息就只有一个订阅者,模块落地时也只重渲染
	// 一次。往下传的是同一个组件引用,所以在途那份和落盘那份用的必然是同一个渲染器。
	const Markdown = useChatMarkdown();
	const anim = (id: string) => (noAnimIds?.includes(id) ? "" : "bn-anim-msg-in ");
	return (
		// testid 不是随手加的:输入框里的字、侧栏底部的用户名都会被 getByText 命中
		// (受控 textarea 在 DOM 里也有同样的 textContent),不圈定范围的话,
		// 「消息有没有上屏」这类断言会被那两处冒名顶替,测试假绿。
		<div data-testid="chat-messages" className="mx-auto flex w-full max-w-180 flex-col gap-5.5">
			{messages.map((m) =>
				m.role === "user" ? (
					<div key={m.id} className={`${anim(m.id)}flex justify-end`}>
						<div className="bn-chat-accent-soft max-w-[74%] whitespace-pre-wrap wrap-break-word rounded-[22px] rounded-br-[7px] px-4.25 py-2.75ext-[15px] leading-relaxed text-bn-text-primary">
							{m.content}
						</div>
					</div>
				) : (
					<AssistantTurn
						key={m.id}
						animClass={anim(m.id)}
						tools={m.tools}
						text={m.content}
						Markdown={Markdown}
					/>
				),
			)}

			{/* 在途的这一轮。女仆那半边**走同一个组件** —— 样式一致才能在 done 到达、
			    真身替换上来的那一刻毫无痕迹地交接。曾经这里是复制的一份 className,
			    改动只落到其中一处就又跳起来了,所以现在由构造本身保证一致。 */}
			{pending ? (
				<>
					<div className="bn-anim-msg-in flex justify-end">
						<div className="bn-chat-accent-soft max-w-[74%] whitespace-pre-wrap wrap-break-word rounded-[22px] rounded-br-[7px] px-4.25 py-2.75 text-[15px] leading-relaxed text-bn-text-primary">
							{pending.ask}
						</div>
					</div>
					{/* 工具还在跑、正文一个字都没有时也要出现 —— 那正是最需要说话的一刻。 */}
					{pending.tools.length > 0 || pending.draft ? (
						<AssistantTurn
							animClass=""
							tools={pending.tools}
							text={pending.draft}
							Markdown={Markdown}
							caret
						/>
					) : null}
				</>
			) : null}

			{/* 打字点只在**第一个字还没到**的时候出现:字一开始流出来,光标就接手了,
			    两个同时在场会显得有两处都在动。 */}
			{busy && !pending?.draft ? (
				// role="status" 而不是裸 div:三个跳动的点对读屏器是完全不可见的,
				// 加上它才会念出「女仆正在思考」,否则按下发送后那边一片死寂。
				<div
					className="bn-anim-msg-in flex gap-1.25 pl-0.5"
					role="status"
					aria-label={`${aiSelf}正在思考`}
				>
					{[0, 1, 2].map((d) => (
						<span
							key={d}
							className="bn-anim-typing bn-chat-accent-bg h-1.75 w-1.75 rounded-full"
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
	Markdown,
	caret,
}: {
	/** 入场动画类(含尾随空格)或空串。 */
	animClass: string;
	tools?: readonly ToolChipData[];
	text: string;
	/** Markdown 渲染器;还没到手时为 null,这一帧退回纯文本。 */
	Markdown: MarkdownComp;
	/** 跟在最后一个字后面的光标,只有在途那一份有。 */
	caret?: boolean;
}) {
	return (
		// 小条与正文之间的 8px 由 gap 给,不挂在小条自己身上 —— 工具还在跑、正文
		// 一个字都没有时,那就是一段悬在空处的下边距。
		//
		// testid 是给测试找「这一轮的最外层」用的:入场动画类挂在这儿,而正文经
		// Markdown 渲染后要往里套两层(样式层 + <p>),靠 parentElement 数层数的断言
		// 会随渲染结构变化悄悄失准 —— 层数不对时 not.toContain 恰好无条件通过。
		<div data-testid="assistant-turn" className={`${animClass}flex flex-col gap-2`}>
			{tools?.length ? <ToolChips traces={tools} /> : null}
			{/* 正文按 Markdown 渲染。**在途与落盘走的是同一个 ChatMarkdown**,所以同一段
			    文字两处长得一模一样,交接那一刻不会跳 —— 这是这个共用组件存在的全部理由。
			    光标由 CSS 挂在最后一个块的尾巴上(见 .bn-chat-md-caret),不是一个真节点:
			    Markdown 渲染出来的是块元素,跟在它们后面的 span 会掉到下一行去。 */}
			{text ? (
				<div
					className={`wrap-break-word text-[15px] leading-[1.78] text-bn-text-primary ${
						caret ? "bn-chat-md-caret" : ""
					}`}
				>
					{/* 退路是**纯文本**而不是空白或转圈:chunk 还在路上时,主人看到的就是加
					    Markdown 之前的样子,退化得毫无痕迹。用 <p> 包着是为了让
					    .bn-chat-md-caret 那条 `> *:last-child::after` 照样够得着,光标不会
					    在这一瞬间消失。正常情况下这条根本走不到 —— preloadChatMarkdown 在
					    首屏空闲时就把 chunk 取回来了。 */}
					{Markdown ? <Markdown text={text} /> : <p className="whitespace-pre-wrap">{text}</p>}
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
						className="bn-glass-chip flex max-w-full items-center gap-1.5 rounded-[13px] px-2.25 py-0.75 text-[11.5px] text-bn-text-tertiary"
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
