import type { AiConversationDTO } from "@bilibili-notify/contract";
import type { GlobalConfig } from "@bilibili-notify/internal";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type CSSProperties, useEffect, useRef, useState } from "react";
import {
	conversationQueryKey,
	conversationsQueryKey,
	createConversation,
	deleteConversation,
	getConversation,
	listConversations,
	sendChatMessage,
} from "../../services/aiChat";
import { api } from "../../services/api";
import { useAiChatStore } from "../../store/aiChat";
import { useAuthStore } from "../../store/auth";
import { BiliLoginStatus } from "../../types/auth";
import { Icon } from "../icons";
import { Composer } from "./composer";
import { MessageList } from "./messages";
import { resolveChatPersona } from "./persona";
import { ChatSidebar } from "./sidebar";
import { AI_SKILLS, resolveOutgoing } from "./skills";

/**
 * 女仆 AI 聊天 —— 右下角一颗胶囊,点开是整页覆盖的对话界面。
 *
 * 取代了旧的「贴底建议条」:那条是**单向**的,按当前路由播一句预置话术,主人
 * 没法回话,读完只能关掉。会话记录落在服务端(见 apps/server 的 ConversationStore),
 * 所以换设备、重启服务都还在;女仆带只读工具,查得到订阅 / 直播状态 / 粉丝数,
 * 但改不动任何东西。
 *
 * 挂在 App 根部而非某个页面里:它是全局的,任何一页都能召唤。
 */
export function AiChatDock() {
	const open = useAiChatStore((s) => s.open);
	const setOpen = useAiChatStore((s) => s.setOpen);

	if (!open) {
		return (
			<button
				type="button"
				onClick={() => setOpen(true)}
				title="打开女仆 AI 聊天"
				className="bn-ai-fab fixed bottom-5 right-5 z-30 flex h-12 cursor-pointer items-center gap-[9px] rounded-[26px] pl-4 pr-5 text-[13.5px] font-bold text-white shadow-[0_10px_28px_rgba(108,92,231,0.42)]"
			>
				<Icon.ai size={20} />
				女仆 AI
			</button>
		);
	}
	// 拆成两个组件而不是一路 if:关着的时候不该挂那一堆 query 和订阅,
	// 更不该在后台轮询会话列表。
	return <ChatOverlay onClose={() => setOpen(false)} />;
}

function ChatOverlay({ onClose }: { onClose: () => void }) {
	const rail = useAiChatStore((s) => s.rail);
	const setRail = useAiChatStore((s) => s.setRail);
	const theme = useAiChatStore((s) => s.theme);
	const setTheme = useAiChatStore((s) => s.setTheme);
	const glassOpacity = useAiChatStore((s) => s.glassOpacity);
	const setGlassOpacity = useAiChatStore((s) => s.setGlassOpacity);
	const glassClear = useAiChatStore((s) => s.glassClear);
	const setGlassClear = useAiChatStore((s) => s.setGlassClear);
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
	const modelName = globalsQuery.data?.defaults.ai.model;
	// 名字 / 自称 / 对主人的称呼一律跟「智能女仆」页配的人格走,界面上不写死。
	const persona = resolveChatPersona(globalsQuery.data?.defaults.ai.persona);

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

	/**
	 * 本轮问答的**在途**状态 —— 还没落盘,只活在这次渲染里。
	 *
	 * 分成两半:`ask` 是主人刚发出的那句(按下回车立刻上屏),`draft` 是女仆
	 * 正在逐字吐的回复。服务端要整轮成功才落盘,所以这段时间里两条消息都不在
	 * `messages` 里 —— 没有这份在途状态,主人会盯着一个空屏等十几秒,完全不知道
	 * 自己那句发出去没有。
	 */
	const [pending, setPending] = useState<{ ask: string; draft: string } | null>(null);

	/**
	 * 刚由在途副本交接成真身的那两条消息。
	 *
	 * 它们**已经在屏幕上待了一整轮**了 —— 主人眼看着自己那句飞上去、回复一个字
	 * 一个字长出来。真身接手时若照常播入场动画,就是凭空又淡入上移一次,看上去
	 * 正是「回复吐完最后整段闪一下」。
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

	const send = useMutation({
		mutationFn: async (text: string) => {
			// 还没有会话就先开一个 —— 主人在空态直接打字发送时走这条路,
			// 不必先去点「新对话」。
			const id = activeId ?? (await createConversation()).id;
			if (id !== activeId) setActiveId(id);
			return sendChatMessage(id, text, {
				onDelta: (chunk) => setPending((p) => (p ? { ...p, draft: p.draft + chunk } : p)),
			});
		},
		onMutate: (text: string) => {
			// 立刻上屏 + 立刻清空输入框。这两件事一起做才自然:消息「离开」了
			// 输入框,出现在对话里。
			setInput("");
			setError(null);
			setPending({ ask: text, draft: "" });
		},
		onSuccess: (res, _text) => {
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
			setSettled({ conv: id, ids: [res.user.id, res.reply.id] });
			setPending(null);
			// 列表还是得重拉:标题可能刚由这条首问定下来,而那只有服务端知道。
			qc.invalidateQueries({ queryKey: conversationsQueryKey });
		},
		onError: (err: Error, text: string) => {
			// 服务端那一轮什么都没落盘,所以这里也把在途副本整个撤掉 —— 留着的话
			// 屏幕上会挂着一轮「看起来存在、刷新就消失」的问答。
			// 原文退回输入框:主人按个回车就能重试,不用把刚才那段话重打一遍。
			setPending(null);
			setInput((cur) => (cur.trim() ? cur : text));
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

	const startNew = useMutation({
		mutationFn: createConversation,
		onSuccess: (conv) => {
			setActiveId(conv.id);
			setInput("");
			setError(null);
			qc.invalidateQueries({ queryKey: conversationsQueryKey });
		},
	});

	const busy = send.isPending;
	// 一有在途消息就离开空态 —— 主人发了话,问候页就该让位给对话。
	const empty = messages.length === 0 && pending === null;

	// 内容一长就贴底。依赖里带上 `pending.draft.length` 是要紧的:流式回复是逐字
	// 长出来的,只盯消息数的话,整段生成过程中视图纹丝不动,新字全长在视野之外。
	// biome-ignore lint/correctness/useExhaustiveDependencies: 这几个值只作触发条件,不在函数体内读
	useEffect(() => {
		const el = scrollRef.current;
		if (el) el.scrollTop = el.scrollHeight;
	}, [busy, messages.length, pending?.draft.length]);

	const submit = (text?: string) => {
		const outgoing = resolveOutgoing(text ?? input);
		if (!outgoing || busy) return;
		send.mutate(outgoing);
	};

	/** 玻璃片实际生效的透明度。完全透明优先,压过滑块拉到哪一档。 */
	const glass = glassClear ? 0 : glassOpacity;

	return (
		<div
			data-chat-theme={theme}
			className="bn-anim-chat-in fixed inset-0 z-40 flex"
			// 玻璃片的三个值,算法照搬推送卡片的卡片内容层:
			//     glass = 完全透明 ? 0 : 设置值      blur = 完全透明 ? 0 : 基线
			// 「完全透明」就是这些值一起归零,不是另一套规则 —— 那边一直这么写。
			// blur 送的是**倍率**而不是像素:各玻璃件的基线半径不一样(面板 32px、
			// 胶囊 20px),送倍率才不用把那张表复制一份到 JS 里来。
			//
			// saturate 是推送卡片没有的那一项(那边只有 blur),但它必须跟着透明度
			// 一起退:backdrop-filter 加工的是**背后**的像素,底色一透,它还在那儿
			// 把背后的主题辉光按倍数放大 —— 表现就是「玻璃拉到最低,显出来的背景
			// 反而比背景本身还鲜艳」。1 = 原样不动;默认档落在 1.82,与这功能之前
			// 写死的 1.8 基本同观感。
			style={
				{
					background: "var(--bn-chat-bg)",
					"--bn-chat-glass": glass,
					"--bn-chat-blur": glassClear ? 0 : 1,
					"--bn-chat-saturate": 1 + glass,
				} as CSSProperties
			}
			role="dialog"
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
					onNew={() => startNew.mutate()}
					onDelete={(id) => removeConv.mutate(id)}
					onCollapse={() => setRail(false)}
					theme={theme}
					onThemeChange={setTheme}
					modelName={modelName}
					userName={userName}
					userFace={card?.face}
					aiName={persona.name}
					glassOpacity={glassOpacity}
					onGlassOpacityChange={setGlassOpacity}
					glassClear={glassClear}
					onGlassClearChange={setGlassClear}
				/>
			) : null}

			<div className="relative flex min-w-0 flex-1 flex-col">
				{!rail ? (
					<button
						type="button"
						title="打开侧栏"
						aria-label="打开侧栏"
						onClick={() => setRail(true)}
						className="bn-glass-sheen bn-glass-soft bn-glass-lift bn-glass-chip absolute left-4 top-4 z-10 grid h-[34px] w-[34px] cursor-pointer place-items-center rounded-[9px] text-bn-text-tertiary shadow-[0_6px_18px_rgba(42,30,72,0.14)]"
					>
						<Icon.panelExpand size={18} />
					</button>
				) : null}

				<button
					type="button"
					onClick={onClose}
					className="bn-glass-sheen bn-glass-soft bn-glass-lift bn-glass-chip absolute right-4 top-4 z-10 flex h-[38px] cursor-pointer items-center gap-[7px] rounded-[19px] px-4 text-[12.5px] font-semibold text-bn-text-tertiary shadow-[0_6px_18px_rgba(42,30,72,0.14)]"
				>
					<Icon.arrowLeft size={15} />
					返回控制台
				</button>

				{empty ? (
					<div className="relative flex flex-1 flex-col justify-center overflow-y-auto p-6">
						<div
							className="pointer-events-none absolute left-1/2 top-[52%] h-[620px] w-[min(1100px,92%)] -translate-x-1/2 -translate-y-1/2 blur-[6px]"
							style={{ background: "var(--bn-chat-glow)" }}
							aria-hidden="true"
						/>
						<div className="relative mx-auto w-full max-w-[720px]">
							<div className="bn-anim-fade-up mb-[30px] text-center">
								<h1 className="mb-1.5 text-[32px] font-bold leading-tight tracking-tight text-bn-text-primary">
									{greeting()}
									<span
										className="bg-clip-text text-transparent"
										style={{ backgroundImage: "linear-gradient(92deg, #6c5ce7, #fb7299)" }}
									>
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
								autoFocus
								aiName={persona.name}
							/>
							{error ? (
								<div
									role="alert"
									className="mx-auto mt-3 max-w-[720px] rounded-xl border border-bn-danger-border bg-bn-danger-soft px-4 py-3 text-[13px] leading-relaxed text-bn-danger-text"
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
											className="bn-glass-lift bn-nohl bn-glass-chip flex cursor-pointer items-center gap-[7px] rounded-[20px] px-[15px] py-2 text-[12.5px] font-semibold text-bn-text-tertiary shadow-[0_6px_18px_rgba(42,30,72,0.12)]"
										>
											<span className="flex text-[#6c5ce7] dark:text-bn-purple">
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
						<div ref={scrollRef} className="flex-1 overflow-y-auto px-6 pb-2 pt-[62px]">
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
								autoFocus
								aiName={persona.name}
							/>
							<div className="mt-2 text-center text-[11px] text-bn-text-secondary">
								{persona.name}可能会出错,请核对重要信息
							</div>
						</div>
					</>
				)}
			</div>
		</div>
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
