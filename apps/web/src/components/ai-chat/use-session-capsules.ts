import { useEffect, useRef, useState } from "react";

/** 聊天窗口当下的面孔:日常聊天 / 皮肤工坊。见 {@link useSessionCapsules}。 */
export type ChatMode = "chat" | "skin";

/**
 * 会话级的两颗胶囊(深度思考 / 联网搜索)与**模式**。**不落盘**(主人定的):
 * 默认关 / 默认聊天、手动点亮、换个会话就归零 —— 曾经思考那颗直接写配置,于是
 * 刷新 / 换设备后「上次开的」还阴魂不散地烧钱。发送时随请求体走(见 send 的 flags)。
 *
 * 模式跟着一起归零是同一个道理,而且更要紧:皮肤工坊里的女仆没有人格、也不认识
 * B 站数据,把这副面孔悄悄留到下一场对话,主人会对着一个答非所问的窗口发懵。
 *
 * 归零只认「**换**会话」。activeId 还有一种变化来路:空态首发消息时
 * mutationFn 先 createConversation 再 setActiveId —— 那是同一场对话落了个
 * 户口,不是换会话。曾经两种来路走同一个 effect,用户刚点亮的胶囊在按下
 * 发送那一刻当场熄灭,同一会话的后续消息全部静默不思考/不搜索。发送方在
 * setActiveId 前先调 {@link adoptConversation} 声明豁免,豁免只吃一次。
 */
export function useSessionCapsules(activeId: string | null) {
	const [thinkingOn, setThinkingOn] = useState(false);
	const [searchOn, setSearchOn] = useState(false);
	const [mode, setMode] = useState<ChatMode>("chat");
	const adoptingRef = useRef(false);

	const adoptConversation = () => {
		adoptingRef.current = true;
	};

	// biome-ignore lint/correctness/useExhaustiveDependencies: 只按 activeId 归零,不读旧值
	useEffect(() => {
		if (adoptingRef.current) {
			adoptingRef.current = false;
			return;
		}
		setThinkingOn(false);
		setSearchOn(false);
		setMode("chat");
	}, [activeId]);

	return { thinkingOn, setThinkingOn, searchOn, setSearchOn, mode, setMode, adoptConversation };
}
