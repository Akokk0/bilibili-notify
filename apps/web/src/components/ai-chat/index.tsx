import type { AiConversationDTO } from "@bilibili-notify/contract";
import type { GlobalConfig } from "@bilibili-notify/internal";
import { resolveActivePersona, resolveAIProfile } from "@bilibili-notify/internal/constants";
import { Icon } from "@bilibili-notify/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
	chatImageUrl,
	conversationQueryKey,
	conversationsQueryKey,
	createConversation,
	deleteConversation,
	getConversation,
	listConversations,
	retitleConversation,
	sendChatMessage,
	uploadChatImage,
} from "../../services/aiChat";
import { api } from "../../services/api";
import { useAiChatStore } from "../../store/aiChat";
import { useAuthStore } from "../../store/auth";
import { BiliLoginStatus } from "../../types/auth";
import { Composer, type ComposerAttachment, MAX_ATTACHMENTS } from "./composer";
import { MessageList, preloadChatMarkdown, type ToolChipData } from "./messages";
import { resolveChatPersona } from "./persona";
import { SearchControl } from "./search-control";
import { ChatSidebar } from "./sidebar";
import { AI_SKILLS, resolveOutgoing } from "./skills";
import { ThinkingControl } from "./thinking-control";
import { useSessionCapsules } from "./use-session-capsules";

/**
 * 女仆 AI 聊天 —— 一条独立路由(/chat)的整页对话界面,右下角的胶囊
 * ({@link AiChatDock})是它的全局入口。
 *
 * 取代了旧的「贴底建议条」:那条是**单向**的,按当前路由播一句预置话术,主人
 * 没法回话,读完只能关掉。会话记录落在服务端(见 apps/server 的 ConversationStore),
 * 所以换设备、重启服务都还在;女仆带只读工具,查得到订阅 / 直播状态 / 粉丝数,
 * 但改不动任何东西。
 *
 * 曾经是盖在当前 tab 上的 overlay(开合态在 store 里)。改成路由之后,开没开由
 * URL 说了算:刷新留在聊天里、浏览器返回键好使、/chat 也能存成书签直达。
 */

/** 聊天页的路由。App 的 Route 与胶囊的跳转共用这一份,免得两处各写各的字符串。 */
export const CHAT_PATH = "/chat";

/**
 * 首屏闲下来之后跑一次 `fn`,返回撤销函数。
 *
 * 用途是预取那个 153KB 的 Markdown chunk。要守住的是首屏的**解析与执行**不变重 ——
 * 那才是卡交互的东西,不是那点带宽;所以不能同步跟着首屏一起加载,但也没必要抠到
 * 「主人碰了胶囊才去取」(试过,提前量根本不够,一点进聊天页就看见纯文本闪成
 * 排版好的)。空闲时段两头都占得住。
 *
 * `requestIdleCallback` 带 timeout 兜底,免得页面一直忙就永远排不上;没有这个 API
 * 的浏览器退回一个宏任务 —— 那也已经在首次绘制之后了。
 */
function onIdle(fn: () => void): () => void {
	if (typeof requestIdleCallback === "function") {
		const id = requestIdleCallback(fn, { timeout: 2000 });
		return () => cancelIdleCallback(id);
	}
	const id = setTimeout(fn, 1);
	return () => clearTimeout(id);
}

/**
 * 右下角的「女仆 AI」胶囊。挂在 App 根部而非某个页面里:它是全局的,任何一页
 * 都能召唤;已经在聊天页时不渲染 —— 自己叠在自己的入口上没有意义。
 */
export function AiChatDock() {
	const navigate = useNavigate();
	const onChatPage = useLocation().pathname === CHAT_PATH;

	// 闲下来就把 Markdown chunk 取回来。这颗胶囊在每一页都挂着,所以这条**总会**跑,
	// 与聊天开没开无关 —— 目的正是让主人第一次点进去时它已经在了。
	useEffect(() => onIdle(preloadChatMarkdown), []);

	if (onChatPage) return null;
	return (
		<button
			type="button"
			onClick={() => navigate(CHAT_PATH)}
			// 主人露出「要进来」的意思时就去取 Markdown 那个 chunk(约 153KB)。
			//
			// 站内进聊天页只有这颗胶囊一个入口,在它身上预热就覆盖了站内全部路径
			// (直接输 /chat 进来的那条由 ChatPage 挂载时的兜底预热接住)。挪上来 /
			// 聚焦到它,比真正点开早几百毫秒 —— 足够取回来,于是进去之后纯文本那条
			// 退路根本不会露面。
			//
			// 三个事件各管一类人:pointerEnter 是鼠标,focus 是键盘 Tab,
			// pointerDown 是触屏(那儿没有 hover)。预热本身幂等,重复调只是
			// 拿同一个已解析的 promise。
			onPointerEnter={preloadChatMarkdown}
			onPointerDown={preloadChatMarkdown}
			onFocus={preloadChatMarkdown}
			title="打开女仆 AI 聊天"
			className="bn-ai-fab fixed bottom-5 right-5 z-30 flex h-12 cursor-pointer items-center gap-2.25 rounded-[26px] pl-4 pr-5 text-[13.5px] font-bold text-white shadow-[0_10px_28px_rgba(108,92,231,0.42)]"
		>
			<Icon.ai size={20} />
			女仆 AI
		</button>
	);
}

/**
 * 在途的一条工具痕迹。比落盘那份多一个 `id` —— `end` 事件靠它认回自己的 `start`,
 * 而落盘时结论已定,不再需要这个中间量,所以契约里没有它。
 */
type PendingTool = ToolChipData & { id: string };

/**
 * 一次发送的全部输入 —— 正文**与附件**。
 *
 * 附件走 variables 而不是让 `mutationFn` 回头读组件状态,是必需的而非讲究:
 * `onMutate` 会把待发送列表清空,而它跑在 `mutationFn` **之前**(返回值被 await,
 * 那一让步足够 React 把重渲染 flush 掉)。闭包里读到的于是恒为空数组 —— 图能选、
 * 能预览、也照常挂在自己那条消息上,唯独服务端一张都收不到。
 */
type SendVars = {
	text: string;
	attachments: readonly ComposerAttachment[];
	/**
	 * 会话级胶囊在**点发送那一刻**的状态。走 variables 而不是让 mutationFn 从
	 * 组件闭包里读 —— 见 react-query onMutate 的时序坑:要发的东西必须随载荷走。
	 */
	flags: { thinking: boolean; search: boolean };
};

/** /chat 路由页。除了「返回控制台」的去向,不感知路由 —— 其余全是聊天自己的事。 */
export function ChatPage() {
	const navigate = useNavigate();
	const location = useLocation();
	// 「返回控制台」回**来路**:从统计页点进来就该回统计页。直接输网址 / 书签进来时
	// 历史里没有上一页(初始 entry 的 key 恒为 "default"),navigate(-1) 要么退出站点
	// 要么原地不动 —— 这种时候显式回首页。
	const onClose = () => {
		if (location.key === "default") navigate("/", { replace: true });
		else navigate(-1);
	};

	const rail = useAiChatStore((s) => s.rail);
	const setRail = useAiChatStore((s) => s.setRail);
	const activeId = useAiChatStore((s) => s.activeId);
	const setActiveId = useAiChatStore((s) => s.setActiveId);

	const [input, setInput] = useState("");
	const [error, setError] = useState<string | null>(null);
	const qc = useQueryClient();
	const scrollRef = useRef<HTMLDivElement>(null);

	const globalsQuery = useQuery({
		queryKey: ["globals"],
		queryFn: () => api.get<GlobalConfig>("/api/globals"),
	});
	// 模型名在当前生效的那个服务商桶里(各家一套配置)。
	const ai = globalsQuery.data?.defaults.ai;
	const modelName = ai ? resolveAIProfile(ai).model : undefined;
	// 名字 / 自称 / 对主人的称呼一律跟**当前选中的那份人格**走(`activePreset` 指的
	// 那份),界面上不写死。直读 `ai.persona` 的话主人换了人格这里也不动 —— 那个字段
	// 自人格指针上线就没有界面入口、永远冻在老值上,而她开口自称的是新那位。
	const persona = resolveChatPersona(ai ? resolveActivePersona(ai).persona : undefined);

	const snapshot = useAuthStore((s) => s.snapshot);
	const card =
		snapshot?.status === BiliLoginStatus.LOGGED_IN
			? (snapshot?.data as { card?: { name?: string; face?: string } } | undefined)?.card
			: undefined;
	// 没登录 / 还没拿到账号时,用人格里那个称呼顶上 —— 傲娇预设下就是「笨蛋」,
	// 比硬写「主人」更贴合主人自己配的那套口吻。
	const userName = card?.name?.trim() || persona.user;

	const listQuery = useQuery({
		queryKey: conversationsQueryKey,
		queryFn: listConversations,
	});
	const conversations = listQuery.data?.conversations ?? [];

	const activeQuery = useQuery({
		queryKey: conversationQueryKey(activeId ?? ""),
		queryFn: () => getConversation(activeId ?? ""),
		enabled: activeId !== null,
	});
	const messages = activeQuery.data?.messages ?? [];

	// 会话被别处删掉(另一个标签页 / 超出上限被修剪)时,activeId 会指向一个
	// 取不回来的会话。回落到空态,而不是卡在一个永远转圈的详情上。
	useEffect(() => {
		if (activeId && activeQuery.isError) setActiveId(null);
	}, [activeId, activeQuery.isError, setActiveId]);

	// 页面一挂载再取一次 —— 兜底。正常路径上首屏空闲那次早就取完了(见 AiChatDock),
	// 这条覆盖的是「刚加载完、空闲回调还没排上就直奔胶囊」,以及**直接输 /chat 进来**
	// (根本没经过胶囊)。预热幂等,白调无害。
	useEffect(() => {
		preloadChatMarkdown();
	}, []);

	/**
	 * 本轮问答的**在途**状态 —— 还没落盘,只活在这次渲染里。
	 *
	 * 分成三半:`ask` 是主人刚发出的那句(按下回车立刻上屏),`draft` 是女仆
	 * 正在逐字吐的回复,`tools` 是这一轮她动过的工具。服务端要整轮成功才落盘,
	 * 所以这段时间里两条消息都不在 `messages` 里 —— 没有这份在途状态,主人会盯着
	 * 一个空屏等十几秒,完全不知道自己那句发出去没有。
	 */
	const [pending, setPending] = useState<{
		ask: string;
		draft: string;
		tools: readonly PendingTool[];
		/** 思考草稿(思考模型专有),同样逐字长出来。 */
		think: string;
		/** 这一问带上去的图(显示地址)。在途期间也得看得见,否则像是没发出去。 */
		images?: readonly string[];
	} | null>(null);

	/**
	 * 已经传好、等着随下一句发出去的附件。
	 *
	 * 传在**挑图那一刻**而不是发送那一刻:格式不对 / 超过 5MB 能当场报出来,
	 * 而不是主人打完一整段话点了发送才发现图根本没进去。
	 */
	const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);

	/**
	 * 这个会话里**已经由在途副本交接成真身**的消息 id,逐轮累积。
	 *
	 * 它们都是主人眼看着长出来的 —— 自己那句飞上去、回复一个字一个字冒出来。
	 * 真身接手时若照常播入场动画,就是凭空又淡入上移一次,看上去正是「闪一下」。
	 *
	 * 只留最近一轮不够:下一轮结束时,上一轮那两条会**重新**被加上动画类,于是
	 * 轮到它们闪。所以是累积。
	 *
	 * 记会话 id 是为了切走再切回时自动失效:那时整个列表本来就是新挂载的,该播。
	 */
	const [settled, setSettled] = useState<{ conv: string; ids: readonly string[] } | null>(null);
	// 换了会话就作废。切回来时这几条是**重新挂载**的,跟主人眼看着长出来的那次
	// 已经没关系了,该跟其它消息一样播入场动画。
	// biome-ignore lint/correctness/useExhaustiveDependencies: 只按 activeId 变化清,不读 settled
	useEffect(() => {
		setSettled(null);
	}, [activeId]);

	// 会话级的两颗胶囊(深度思考 / 联网搜索)。归零策略连同「首发落地新会话
	// 不算换会话」的豁免都住在 hook 里 —— 见 use-session-capsules.ts。
	const { thinkingOn, setThinkingOn, searchOn, setSearchOn, adoptConversation } =
		useSessionCapsules(activeId);
	// 空态与会话态两个 Composer 用同一份 —— 各写一遍的话,加第三颗胶囊只改到
	// 一处,问候屏和聊天里的工具栏就长得不一样了(正是本文件头警告过的分裂态)。
	const composerExtras = (
		<>
			<ThinkingControl on={thinkingOn} onToggle={setThinkingOn} />
			<SearchControl on={searchOn} onToggle={setSearchOn} />
		</>
	);

	/**
	 * 起标题。刻意**不**把错误摊给主人:服务端起名失败也回 200 + 当前标题,
	 * 真到网络层断了也只是标题没变 —— 为一个装饰在刚聊完的界面上弹红字,
	 * 比标题还是「你好」更烦人。
	 */
	const retitle = useMutation({
		mutationFn: retitleConversation,
		onSuccess: () => qc.invalidateQueries({ queryKey: conversationsQueryKey }),
		onError: () => {},
	});

	const send = useMutation({
		mutationFn: async ({ text, attachments: outgoingFiles, flags }: SendVars) => {
			const imageIds = outgoingFiles.map((a) => a.id);
			// 还没有会话就先开一个 —— 主人在空态直接打字发送时走这条路,
			// 不必先去点「新对话」。
			const id = activeId ?? (await createConversation()).id;
			if (id !== activeId) {
				// 这次 activeId 变化是首发落的户口,不是换会话 —— 别把刚点亮的胶囊打回默认。
				adoptConversation();
				setActiveId(id);
			}
			return sendChatMessage(
				id,
				text,
				{
					onDelta: (chunk) => setPending((p) => (p ? { ...p, draft: p.draft + chunk } : p)),
					// 思考流单独累积,不混进正文 —— 它是要折叠、要用另一副面孔渲染的。
					onReasoning: (chunk) => setPending((p) => (p ? { ...p, think: p.think + chunk } : p)),
					// 工具轮不产生正文,所以那几秒原本只有三个跳动的点 —— 跟「模型卡住了」
					// 长得一模一样。start 就上屏、end 只回填结论:这样「正在查订阅」是在查的
					// **当时**说的,而不是查完了才补一句。
					//
					// 按 id 认人而不是「改最后一条」:一轮里可以同时开好几个工具,end 回来的
					// 次序不保证跟 start 一致。
					onTool: (ev) =>
						setPending((p) => {
							if (!p) return p; // 已经切走 / 撤掉了,这一拍没人要
							if (ev.phase === "start") {
								return { ...p, tools: [...p.tools, { id: ev.id, name: ev.name, args: ev.args }] };
							}
							return {
								...p,
								tools: p.tools.map((t) =>
									t.id === ev.id
										? { ...t, ok: ev.ok, ...(ev.sources ? { sources: ev.sources } : {}) }
										: t,
								),
							};
						}),
				},
				imageIds,
				flags,
			);
		},
		onMutate: ({ text, attachments: outgoingFiles }: SendVars) => {
			// 立刻上屏 + 立刻清空输入框。这两件事一起做才自然:消息「离开」了
			// 输入框,出现在对话里。图也一样跟着走。
			setInput("");
			setError(null);
			setPending({
				ask: text,
				draft: "",
				tools: [],
				think: "",
				images: outgoingFiles.map((a) => a.url),
			});
			setAttachments([]);
		},
		onSuccess: (res, _vars) => {
			const id = res.conversation.id;
			// 真身**同步**写进缓存,和下面清在途副本落在同一批渲染里 —— 交接在一帧内
			// 完成,中间不留空窗。
			//
			// 换成 invalidate 去重拉一次会话就不行了:那中间隔着一整个网络往返,副本
			// 已退场、真身还没到,整轮问答会从屏幕上消失再出现(会话里只有这一轮时
			// 更狠,直接闪回空态问候页)。done 事件本来就把落盘后的两条带回来了,
			// 再去问服务端要一遍纯属白等。
			qc.setQueryData<AiConversationDTO>(conversationQueryKey(id), (prev) => ({
				...res.conversation,
				messages: [...(prev?.messages ?? []), res.user, res.reply],
			}));
			// **累积**而不是替换。只留最近一轮的话,下一轮结束时上一轮那两条会重新
			// 被加上入场动画类 —— CSS 于是又演一遍,表现就是「上一条闪了一下」。
			// 已经在屏幕上待着的消息,任何时候都不该再演入场。
			setSettled((prev) => ({
				conv: id,
				ids:
					prev?.conv === id
						? [...prev.ids, res.user.id, res.reply.id]
						: [res.user.id, res.reply.id],
			}));
			setPending(null);
			// 列表还是得重拉:标题可能刚由这条首问定下来,而那只有服务端知道。
			qc.invalidateQueries({ queryKey: conversationsQueryKey });

			// 标题还没被 AI 起过 → 去要一个。
			//
			// 判据是这个标记而**不是**「刚聊完第一轮」。拿轮次当判据的话,主人在
			// 这功能上线前就建好的那些会话里早有好几条消息,永远不满足条件 ——
			// 一屋子叫「你好」的会话一个都轮不上,而且请求压根不发出去,连日志里
			// 都查不到任何痕迹。
			//
			// 服务端那头也拿同一个标记把关(起过就直接回当前标题),所以这里多问
			// 一次最多是一次空跑。
			if (!res.conversation.autoTitled) void retitle.mutate(id);
		},
		onError: (err: Error, { text, attachments: outgoingFiles }: SendVars) => {
			// 服务端那一轮什么都没落盘,所以这里也把在途副本整个撤掉 —— 留着的话
			// 屏幕上会挂着一轮「看起来存在、刷新就消失」的问答。
			// 原文退回输入框:主人按个回车就能重试,不用把刚才那段话重打一遍。
			setPending(null);
			setInput((cur) => (cur.trim() ? cur : text));
			// 图跟着退回来。这一轮什么都没落盘、图还好端端在磁盘上,而发图最常见的
			// 失败(那家没配看图能力,服务端当场 400)恰恰是去设置页点一下就能好的
			// —— 让主人回来重挑一遍图,纯属白丢。
			// 已经又挑了新图就不覆盖:那是主人这会儿正想发的,比上一轮的更要紧。
			setAttachments((cur) => (cur.length > 0 ? cur : [...outgoingFiles]));
			setError(err.message);
		},
	});

	const removeConv = useMutation({
		mutationFn: deleteConversation,
		onSuccess: (_r, id) => {
			if (id === activeId) setActiveId(null);
			qc.invalidateQueries({ queryKey: conversationsQueryKey });
		},
	});

	/**
	 * 「开启新对话」**不碰服务端** —— 只把界面退回空态。
	 *
	 * 先建一个空会话的话,主人一个字都还没说,左侧就先多出一条记录躺在那儿;
	 * 点两下就是两条空的。真到要落盘的时候,发送那条路上的
	 * `activeId ?? createConversation()` 自然会建。
	 *
	 * 顺带清掉在途副本:上一轮要是还在流,那半截回复属于**上一个**会话,不该
	 * 跟着进到新对话的空白页里。它的 onSuccess 认的是服务端返回的会话 id,
	 * 所以照样会正确落到原来那个会话上。
	 */
	const startNew = () => {
		setActiveId(null);
		setInput("");
		setError(null);
		setPending(null);
	};

	const busy = send.isPending;
	// 一有在途消息就离开空态 —— 主人发了话,问候页就该让位给对话。
	const empty = messages.length === 0 && pending === null;

	// 内容一长就贴底。依赖里带上 `pending.draft.length` 是要紧的:流式回复是逐字
	// 长出来的,只盯消息数的话,整段生成过程中视图纹丝不动,新字全长在视野之外。
	// 思考流同理 —— 它先于正文长出来,不跟着它滚,思考阶段就全长在视野之外。
	// biome-ignore lint/correctness/useExhaustiveDependencies: 这几个值只作触发条件,不在函数体内读
	useEffect(() => {
		const el = scrollRef.current;
		if (el) el.scrollTop = el.scrollHeight;
	}, [busy, messages.length, pending?.draft.length, pending?.think.length]);

	const submit = (text?: string) => {
		const outgoing = resolveOutgoing(text ?? input);
		// 只有图、一个字没打也算数 —— 图本身就是问题。
		if ((!outgoing && attachments.length === 0) || busy) return;
		// 附件快照必须在**这里**取。`mutationFn` 是在 `onMutate` 之后才跑的
		// (onMutate 的返回值被 await,那一让步足够 React 把重渲染 flush 掉),
		// 那时 `setAttachments([])` 已经生效 —— 从 mutationFn 的闭包里读
		// `attachments` 只能读到空数组,于是服务端一张图也收不到。
		// 两颗胶囊同理随载荷走。
		send.mutate({
			text: outgoing,
			attachments,
			flags: { thinking: thinkingOn, search: searchOn },
		});
	};

	/** 挑了图就立刻传,传完塞进待发送列表。格式 / 大小不对当场报,不等到点发送。 */
	const pickFiles = async (files: FileList) => {
		setError(null);
		const room = MAX_ATTACHMENTS - attachments.length;
		for (const file of Array.from(files).slice(0, room)) {
			try {
				const id = await uploadChatImage(file);
				setAttachments((prev) => [...prev, { id, url: chatImageUrl(id) }]);
			} catch (e) {
				setError(e instanceof Error ? e.message : String(e));
			}
		}
	};

	return (
		<section
			// 四色预设已砍,不再有 data-chat-theme:默认主题样式定义在 styles.css 的
			// :root 上,皮肤注入的 root 内联变量天然顶掉它;换观感一律走皮肤包。
			// 玻璃质感同理不再有 chat 专属参数 —— 玻璃族直接吃 --bn-glass-* token,
			// 调玻璃去皮肤编辑器。data-bn-chat-root 给 chat 专属壁纸寻址。
			data-bn-chat-root=""
			className="bn-anim-chat-in fixed inset-0 z-40 flex"
			style={{ background: "var(--bn-chat-bg)" }}
			// overlay 时代这里是 div + role="dialog"。成了路由页之后它不再是「盖在
			// 页面上的对话框」,对屏幕阅读器自称 dialog 会让人找「关闭」而不是「返回」。
			// 带名字的 <section> 暴露出来就是 region 地标;不用 <main> —— App 壳里
			// 已经有一个 <main>,页面里嵌第二个是违规的。
			aria-label="女仆 AI 聊天"
		>
			{rail ? (
				<ChatSidebar
					conversations={conversations}
					activeId={activeId}
					onSelect={(id) => {
						setActiveId(id);
						setError(null);
					}}
					onNew={startNew}
					onDelete={(id) => removeConv.mutate(id)}
					onCollapse={() => setRail(false)}
					modelName={modelName}
					userName={userName}
					userFace={card?.face}
					aiName={persona.name}
				/>
			) : null}

			<div className="relative flex min-w-0 flex-1 flex-col">
				{!rail ? (
					<button
						type="button"
						title="打开侧栏"
						aria-label="打开侧栏"
						onClick={() => setRail(true)}
						className="bn-glass-sheen bn-glass-soft bn-glass-lift bn-glass-chip absolute left-4 top-4 z-10 grid h-8.5 w-8.5 cursor-pointer place-items-center rounded-[9px] text-bn-text-tertiary shadow-[0_6px_18px_rgba(42,30,72,0.14)]"
					>
						<Icon.panelExpand size={18} />
					</button>
				) : null}

				<button
					type="button"
					onClick={onClose}
					className="bn-glass-sheen bn-glass-soft bn-glass-lift bn-glass-chip absolute right-4 top-4 z-10 flex h-9.5 cursor-pointer items-center gap-1.75 rounded-[19px] px-4 text-[12.5px] font-semibold text-bn-text-tertiary shadow-[0_6px_18px_rgba(42,30,72,0.14)]"
				>
					<Icon.arrowLeft size={15} />
					返回控制台
				</button>

				{empty ? (
					<div className="relative flex flex-1 flex-col justify-center overflow-y-auto p-6">
						<div
							className="pointer-events-none absolute left-1/2 top-[52%] h-155 w-[min(1100px,92%)] -translate-x-1/2 -translate-y-1/2 blur-[6px]"
							style={{ background: "var(--bn-chat-glow)" }}
							aria-hidden="true"
						/>
						<div className="relative mx-auto w-full max-w-180">
							<div className="bn-anim-fade-up mb-7.5 text-center">
								<h1 className="mb-1.5 text-[32px] font-bold leading-tight tracking-tight text-bn-text-primary">
									{greeting()}
									<span className="bn-chat-accent-grad-x bg-clip-text text-transparent">
										{userName}
									</span>
								</h1>
								<div className="text-[15.5px] text-bn-text-secondary">
									今天想让{persona.self}帮{persona.user}做点什么呢?
								</div>
							</div>
							<Composer
								value={input}
								onChange={setInput}
								onSubmit={() => submit()}
								busy={busy}
								attachments={attachments}
								onPickFiles={pickFiles}
								onRemoveAttachment={(id) => setAttachments((p) => p.filter((a) => a.id !== id))}
								autoFocus
								aiName={persona.name}
								extras={composerExtras}
							/>
							{error ? (
								<div
									role="alert"
									className="mx-auto mt-3 max-w-180 rounded-xl border border-bn-danger-border bg-bn-danger-soft px-4 py-3 text-[13px] leading-relaxed text-bn-danger-text"
								>
									呜…{persona.self}出错了:{error}
								</div>
							) : null}
							<div className="bn-anim-fade-up mt-4 flex flex-wrap justify-center gap-2">
								{AI_SKILLS.map((s) => {
									const Glyph = Icon[s.icon];
									return (
										<button
											key={s.cmd}
											type="button"
											onClick={() => submit(s.prompt)}
											className="bn-glass-lift bn-nohl bn-glass-chip flex cursor-pointer items-center gap-1.75 rounded-[20px] px-3.75 py-2 text-[12.5px] font-semibold text-bn-text-tertiary shadow-[0_6px_18px_rgba(42,30,72,0.12)]"
										>
											<span className="bn-chat-accent flex">
												<Glyph size={14} />
											</span>
											{s.desc}
										</button>
									);
								})}
							</div>
						</div>
					</div>
				) : (
					<>
						<div ref={scrollRef} className="flex-1 overflow-y-auto px-6 pb-2 pt-15.5">
							<MessageList
								messages={messages}
								pending={pending}
								busy={busy}
								error={error}
								aiSelf={persona.self}
								noAnimIds={settled?.conv === activeId ? settled.ids : undefined}
							/>
						</div>
						<div className="px-6 pb-5 pt-2.5">
							<Composer
								value={input}
								onChange={setInput}
								onSubmit={() => submit()}
								busy={busy}
								attachments={attachments}
								onPickFiles={pickFiles}
								onRemoveAttachment={(id) => setAttachments((p) => p.filter((a) => a.id !== id))}
								autoFocus
								aiName={persona.name}
								extras={composerExtras}
							/>
							<div className="mt-2 text-center text-[11px] text-bn-text-secondary">
								{persona.name}可能会出错,请核对重要信息
							</div>
						</div>
					</>
				)}
			</div>
		</section>
	);
}

/** 按本地时段问好。凌晨算「晚上」—— 三点还没睡的主人不需要被提醒「早上好」。 */
function greeting(now = new Date()): string {
	const h = now.getHours();
	if (h >= 5 && h < 11) return "早上好,";
	if (h >= 11 && h < 14) return "中午好,";
	if (h >= 14 && h < 18) return "下午好,";
	return "晚上好,";
}
