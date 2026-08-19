import { Icon } from "@bilibili-notify/ui";
import { Fragment, type ReactNode, useEffect, useState, useSyncExternalStore } from "react";
import { type AiChatMessageDTO, chatImageUrl } from "../../services/aiChat";
import { toolArgClipped, toolArgText, toolLabel } from "./tools";

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
	/**
	 * 还在跑时的进度:已经产出多少字符。只有肯报进度的慢工具才有(做皮肤那种一趟
	 * 几分钟的);收了尾就不再显示 —— 那时该说的是成败,不是「已写 860 字」。
	 */
	progress?: number;
	/** `web_search` 专属:搜到的来源(标题 + 链接),画「来源」折叠列表。 */
	sources?: readonly { title: string; url: string; siteName?: string }[];
}

export interface MessageListProps {
	messages: readonly AiChatMessageDTO[];
	/**
	 * 在途的这一轮 —— 还没落盘,只活在这次渲染里。`ask` 是主人刚发出的那句,
	 * `draft` 是正在逐字长出来的回复(空串 = 第一个字还没到),`tools` 是这一轮
	 * 已经动过的工具。
	 */
	pending?: {
		ask: string;
		draft: string;
		tools: readonly ToolChipData[];
		/** 正在逐字长出来的思考草稿(思考模型专有);空串 = 这轮没思考(或还没开始)。 */
		think: string;
		/** 这一问带上去的图(显示地址)。在途期间也得看得见,否则像是没发出去。 */
		images?: readonly string[];
	} | null;
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
	/**
	 * 哪几条小条把完整入参展开着。**放在这一层**而不是小条自己身上:在途那份和
	 * 落盘那份是两个不同的渲染位置,状态挂在小条上就会随实例一起没掉 —— 主人正读着
	 * 几百字的需求,女仆一说完就啪地合上。MessageList 跨交接不重建,状态活得下来。
	 *
	 * 身份用「工具名 + 完整入参」而不是下标:交接前后这两样一字不差,下标却会随
	 * 消息进列表而挪位。同名同参的两条会一起开合 —— 那两条本来就一模一样,无害。
	 */
	const [openArgs, setOpenArgs] = useState<ReadonlySet<string>>(() => new Set());
	const toggleArgs = (key: string) =>
		setOpenArgs((prev) => {
			const next = new Set(prev);
			if (!next.delete(key)) next.add(key);
			return next;
		});
	return (
		// testid 不是随手加的:输入框里的字、侧栏底部的用户名都会被 getByText 命中
		// (受控 textarea 在 DOM 里也有同样的 textContent),不圈定范围的话,
		// 「消息有没有上屏」这类断言会被那两处冒名顶替,测试假绿。
		<div data-testid="chat-messages" className="mx-auto flex w-full max-w-180 flex-col gap-5.5">
			{messages.map((m) =>
				m.role === "user" ? (
					<UserTurn
						key={m.id}
						animClass={anim(m.id)}
						text={m.content}
						images={m.images?.map(chatImageUrl)}
					/>
				) : (
					<AssistantTurn
						key={m.id}
						animClass={anim(m.id)}
						tools={m.tools}
						text={m.content}
						reasoning={m.reasoning}
						// 刚交接的真身保持展开:它上一帧还以在途形态开着挂在同一个位置,
						// 交接那一刻塌下去就是又一种「闪」。重开的老会话则默认折叠 ——
						// 那时主人要看的是结论,草稿点开才看。
						reasoningOpen={noAnimIds?.includes(m.id) ?? false}
						openArgs={openArgs}
						onToggleArgs={toggleArgs}
						Markdown={Markdown}
					/>
				),
			)}

			{/* 在途的这一轮。女仆那半边**走同一个组件** —— 样式一致才能在 done 到达、
			    真身替换上来的那一刻毫无痕迹地交接。曾经这里是复制的一份 className,
			    改动只落到其中一处就又跳起来了,所以现在由构造本身保证一致。 */}
			{pending ? (
				<>
					<UserTurn animClass="bn-anim-msg-in " text={pending.ask} images={pending.images} />
					{/* 思考或工具已经在动、正文一个字都没有时也要出现 —— 那正是最需要
					    说话的一刻。 */}
					{pending.tools.length > 0 || pending.draft || pending.think ? (
						<AssistantTurn
							animClass=""
							tools={pending.tools}
							text={pending.draft}
							reasoning={pending.think}
							// 正文一开口思考就算收笔 —— DeepSeek 的「思考中→已深度思考」
							// 同一个翻转。
							reasoningLive={!pending.draft}
							reasoningOpen
							openArgs={openArgs}
							onToggleArgs={toggleArgs}
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
/**
 * 主人那半边的一条消息。**在途副本与落盘真身共用它** —— 样式一致才能在 done
 * 到达、真身替换上来的那一刻毫无痕迹地交接。
 *
 * (从前这里是复制的两份 className,其中一份还漏了个空格、把 `text-[15px]` 粘成
 * 了 `py-2.75ext-[15px]`,于是真身接手时字号会跳一下。现在由构造本身保证一致。)
 */
function UserTurn({
	animClass,
	text,
	images,
}: {
	animClass: string;
	text: string;
	images?: readonly string[];
}) {
	return (
		<div className={`${animClass}flex flex-col items-end gap-1.5`}>
			{images?.length ? (
				<div className="flex max-w-[74%] flex-wrap justify-end gap-1.5">
					{images.map((url) => (
						<img
							key={url}
							src={url}
							alt="主人发送的图片"
							className="max-h-44 rounded-bn-card border border-bn-border object-cover"
						/>
					))}
				</div>
			) : null}
			{/* 只有图没有字时不画空气泡 —— 那会是一小块突兀的色块。 */}
			{text ? (
				<div className="bn-chat-bubble-user max-w-[74%] whitespace-pre-wrap wrap-break-word rounded-[22px] rounded-br-[7px] px-4.25 py-2.75 text-[15px] leading-relaxed text-bn-text-primary">
					{text}
				</div>
			) : null}
		</div>
	);
}

function AssistantTurn({
	animClass,
	tools,
	text,
	reasoning,
	reasoningLive,
	reasoningOpen,
	openArgs,
	onToggleArgs,
	Markdown,
	caret,
}: {
	/** 入场动画类(含尾随空格)或空串。 */
	animClass: string;
	tools?: readonly ToolChipData[];
	text: string;
	/** 思考草稿。空 / 缺席 = 这一轮没思考,块整个不画。 */
	reasoning?: string;
	/** 还在想(正文一个字都没有)→ 标头是进行时「思考中…」。 */
	reasoningLive?: boolean;
	/** 思考块初始是否展开。在途与刚交接的真身展开,重开的老会话折叠。 */
	reasoningOpen?: boolean;
	/** 哪几条小条展开着完整入参(键见 {@link toolArgKey}),与开合入口一起由上层攥着。 */
	openArgs: ReadonlySet<string>;
	onToggleArgs: (key: string) => void;
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
			{/* 思考排最前 —— 她是想完才决定查什么、说什么的,画面顺序跟真实顺序一致。 */}
			{reasoning ? (
				<ThinkingBlock
					text={reasoning}
					live={reasoningLive ?? false}
					defaultOpen={reasoningOpen ?? false}
				/>
			) : null}
			{tools?.length ? <ToolChips traces={tools} open={openArgs} onToggle={onToggleArgs} /> : null}
			{/* 联网搜索的来源列表 —— 主人要能点开核对女仆的说法,不点开时不占地方。
			    跟着痕迹走(在途与落盘同一条路),不是跟着正文走:没搜就没有这一块。 */}
			{(tools ?? [])
				.filter((t) => t.sources?.length)
				.map((t, i) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: 同 ToolChips —— 只追加不重排
					<SourcesBlock key={`src-${i}`} sources={t.sources ?? []} />
				))}
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
 * 思考预览(DeepSeek 式)—— 模型「先想后说」的那段草稿。
 *
 * 三条设计判断:
 * - **纯文本渲染**,不走 Markdown:这是草稿纸,不值得为它扛一份渲染面;灰字 +
 *   左边线的引用式排版本身就在说「这不是回答」。
 * - **标头随进度翻转**:正文一个字都没有时是进行时「思考中…」,开口之后变
 *   「已深度思考」—— 回答到来之前那十几秒不能是一片死寂。
 * - **折叠是本地状态**:初始开合由调用方定(在途展开、重开折叠),之后归主人,
 *   长思考不能占着整屏赶不走。
 */
/**
 * 「回答之外的过程注记」的折叠外壳 —— 小胶囊标头(图标 + 文案 + 文本三角
 * chevron,图标库里没有 chevron,一个字符不值得为它开一枚)+ 展开的正文。
 * 思考块与来源块同族,长相与开合手感只许有这一份;正文容器由内容自带
 * (两块的排版语义不同:一个是引用式草稿,一个是编号来源列表)。
 */
function CollapsibleNote({
	testId,
	icon,
	label,
	defaultOpen,
	children,
}: {
	testId: string;
	icon: ReactNode;
	label: ReactNode;
	defaultOpen?: boolean;
	children: ReactNode;
}) {
	const [open, setOpen] = useState(defaultOpen ?? false);
	return (
		<div data-testid={testId} className="flex flex-col gap-1.5">
			<button
				type="button"
				aria-expanded={open}
				onClick={() => setOpen((v) => !v)}
				className="bn-glass-chip flex w-fit cursor-pointer items-center gap-1.5 rounded-[13px] px-2.25 py-0.75 text-[11.5px] font-semibold text-bn-text-tertiary transition-colors hover:text-bn-text-secondary"
			>
				{icon}
				{label}
				<span aria-hidden="true" className="text-[9px] opacity-70">
					{open ? "▾" : "▸"}
				</span>
			</button>
			{open ? children : null}
		</div>
	);
}

function ThinkingBlock({
	text,
	live,
	defaultOpen,
}: {
	text: string;
	live: boolean;
	defaultOpen: boolean;
}) {
	return (
		<CollapsibleNote
			testId="thinking-block"
			defaultOpen={defaultOpen}
			icon={
				<span className={live ? "bn-chat-accent flex" : "flex opacity-70"} aria-hidden="true">
					<Icon.sparkle size={11} />
				</span>
			}
			label={live ? "思考中…" : "已深度思考"}
		>
			{/* 草稿要**一眼让位给正文**:比正文小两号(12px vs 15px)、行距收紧、
			    颜色再退半档(opacity),配一条安静的左线 —— 引用式排版本身就在说
			    「这不是回答」。截图反馈过的问题正是它和正文长得太像、喧宾夺主。 */}
			<div className="whitespace-pre-wrap wrap-break-word border-l-2 border-bn-border pl-3.5 text-[12px] leading-[1.7] text-bn-text-tertiary opacity-[0.88]">
				{text}
			</div>
		</CollapsibleNote>
	);
}

/**
 * 联网搜索的来源折叠列表 —— 标题可点、新窗口打开,主人能核对女仆的说法。
 *
 * 与 {@link ThinkingBlock} 同族(小胶囊标头 + 折叠内容):它们都是「回答之外的
 * 过程注记」。**默认折叠**:来源是给存疑的那一刻用的,不是每次都要读的正文。
 */
function SourcesBlock({
	sources,
}: {
	sources: readonly { title: string; url: string; siteName?: string }[];
}) {
	return (
		<CollapsibleNote
			testId="sources-block"
			icon={
				<span className="flex opacity-70" aria-hidden="true">
					<Icon.search size={11} />
				</span>
			}
			label={<>来源 · {sources.length}</>}
		>
			<ol className="flex list-none flex-col gap-1 border-l-2 border-bn-border pl-3.5 text-[12px] leading-[1.7]">
				{sources.map((s, i) => (
					<li key={s.url} className="truncate">
						<span className="text-bn-text-tertiary">{i + 1}. </span>
						{/* 新窗口打开 —— 点个来源不该把整个对话顶掉。 */}
						<a
							href={s.url}
							target="_blank"
							rel="noreferrer noopener"
							className="text-bn-text-secondary underline decoration-bn-border underline-offset-2 transition-colors hover:text-bn-pink"
						>
							{s.title || s.url}
						</a>
						{s.siteName ? <span className="text-bn-text-tertiary">（{s.siteName}）</span> : null}
					</li>
				))}
			</ol>
		</CollapsibleNote>
	);
}

/**
 * 「她刚查了什么」的那一排小条。
 *
 * 工具轮不产生正文,那几秒在界面上原本跟「模型卡住了」一模一样。三个态各给一个
 * 图标:转圈=还在查、勾=查到了、叉=没查成。失败的那条**留在原地**而不是抹掉 ——
 * 「查了但没查到」和「压根没查」会导出完全不同的追查方向。
 */
/** 一条小条在展开账本里的身份 —— 交接前后一字不差的那两样。 */
function toolArgKey(t: ToolChipData): string {
	return `${t.name}|${toolArgText(t.name, t.args) ?? ""}`;
}

/**
 * 展开态**受控**:宿主是 MessageList(理由见那儿的注释)。各开各的 —— 一轮里可以
 * 同时开好几个工具,主人想对照着看,不该点开一条就把另一条合上。
 */
function ToolChips({
	traces,
	open: openKeys,
	onToggle,
}: {
	traces: readonly ToolChipData[];
	open: ReadonlySet<string>;
	onToggle: (key: string) => void;
}) {
	return (
		<div className="flex flex-wrap gap-1.5">
			{traces.map((t, i) => {
				const state = t.ok === undefined ? "running" : t.ok ? "ok" : "failed";
				const label = toolLabel(t.name, t.args);
				// 只在跑着的时候报数:收了尾还挂着字数,主人会以为它卡在那儿了。
				const progress = state === "running" && t.progress ? `已写 ${t.progress} 字` : null;
				// 只有真被截短的才给展开钮 —— 「搜索 UP 主「咩栗」」点开也没有别的可看,
				// 那个 ▾ 只会是个骗人的暗示。
				const clipped = toolArgClipped(t.name, t.args);
				const open = openKeys.has(toolArgKey(t));
				const chipClass = `bn-glass-chip flex max-w-full items-center gap-1.5 rounded-[13px] px-2.25 py-0.75 text-[11.5px] text-bn-text-tertiary${clipped ? " cursor-pointer transition-colors hover:text-bn-text-secondary" : ""}`;
				const inner = (
					<>
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
						{/* 单独一格、不参与 truncate:长入参把标签挤掉是可以的,把「她还
						    活着」这个信号挤掉不行。 */}
						{progress ? <span className="shrink-0 tabular-nums opacity-70">{progress}</span> : null}
						{clipped ? (
							<span aria-hidden="true" className="shrink-0 text-[9px] opacity-70">
								{open ? "▾" : "▸"}
							</span>
						) : null}
					</>
				);
				return (
					// 同名工具在一轮里可能被调两次(查两个 UP),name 单独当不了 key。
					// biome-ignore lint/suspicious/noArrayIndexKey: 这一排只在末尾追加、不删不重排(在途那份逐个 append,落盘那份整个不可变),下标就是稳定身份
					<Fragment key={`${t.name}-${i}`}>
						{clipped ? (
							<button
								type="button"
								data-testid="tool-trace"
								data-state={state}
								title={`${label} · ${progress ?? STATE_TEXT[state]}`}
								aria-expanded={open}
								onClick={() => onToggle(toolArgKey(t))}
								className={chipClass}
							>
								{inner}
							</button>
						) : (
							<span
								data-testid="tool-trace"
								data-state={state}
								title={`${label} · ${progress ?? STATE_TEXT[state]}`}
								className={chipClass}
							>
								{inner}
							</span>
						)}
						{/* 展开那一段独占一行:`w-full` 在 flex-wrap 里就是换行,不必把这排
						    小条拆成两层布局。排版照思考块的引用式来 —— 这是**她收到的
						    需求原文**,不是回答;也刻意不给底色,免得玻璃叠玻璃。 */}
						{open ? (
							<p className="w-full whitespace-pre-wrap wrap-break-word border-bn-border border-l-2 pl-3 text-[11.5px] text-bn-text-tertiary leading-[1.7]">
								{toolArgText(t.name, t.args)}
							</p>
						) : null}
					</Fragment>
				);
			})}
		</div>
	);
}

const STATE_TEXT = { running: "正在查", ok: "已完成", failed: "没查成" } as const;
