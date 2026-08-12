import type { GlobalConfig } from "@bilibili-notify/internal";
import {
	providerMeta,
	resolveAIProfile,
	resolveChatThinking,
} from "@bilibili-notify/internal/constants";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../services/api";
import { Icon } from "../icons";

/**
 * 聊天输入框工具栏里的「深度思考」胶囊开关 —— 学 DeepSeek 的 DeepThink:
 * 图标 + 文字的药丸按钮,不是一个谁都认不出的纯图标。不离开对话就能开思考。
 *
 * 读写的是 `ai.chat.enableThinking`,**聊天页自己的**思考设置:实例桶里那两格是
 * 引擎的(动态点评 / 直播总结 / 锐评),这颗开关曾经直接改它,于是在对话里拨一下,
 * 整个女仆的点评行为跟着变。分家后 chat 段没写 = 跟随当前实例(初始默认值从女仆
 * 读取),拨过一次就写实分叉,此后两边互不牵动。
 *
 * 思考**等级**不在这里调 —— 「智能女仆 → 全局配置 → AI 聊天」。低频的档位不值得
 * 在聊天工具栏常驻一排,这颗胶囊只管开关。
 *
 * 自定义服务商没有这颗开关能翻译成的方言(我们不知道对面是哪家),按钮灰着并
 * 指路去「额外请求参数」—— 藏起来的话,主人只会觉得功能时有时无。
 */

export function ThinkingControl() {
	const qc = useQueryClient();
	const globalsQuery = useQuery({
		queryKey: ["globals"],
		queryFn: () => api.get<GlobalConfig>("/api/globals"),
	});
	const save = useMutation({
		// 载荷走 variables 而不是闭包 —— 见 react-query onMutate 的时序坑。
		mutationFn: (delta: { enableThinking: boolean }) =>
			api.patch("/api/globals", { defaults: { ai: { chat: delta } } }),
		/**
		 * 乐观更新:点下去缓存立刻改,界面**当场**就是终态,保存在途什么都不禁用
		 * —— 等服务端回话再刷新的话,开关会闪一下(主人报过的那个)。失败弹回,
		 * 收尾静默重拉对账(这份配置设置页也在看)。
		 */
		onMutate: async (delta: { enableThinking: boolean }) => {
			await qc.cancelQueries({ queryKey: ["globals"] });
			const prev = qc.getQueryData<GlobalConfig>(["globals"]);
			qc.setQueryData<GlobalConfig>(["globals"], (cur) => {
				if (!cur) return cur;
				return {
					...cur,
					defaults: {
						...cur.defaults,
						ai: { ...cur.defaults.ai, chat: { ...cur.defaults.ai.chat, ...delta } },
					},
				};
			});
			return { prev };
		},
		onError: (_err, _vars, ctx) => {
			if (ctx?.prev) qc.setQueryData(["globals"], ctx.prev);
		},
		onSettled: () => qc.invalidateQueries({ queryKey: ["globals"] }),
	});

	const ai = globalsQuery.data?.defaults.ai;
	// 配置还没到手就先不画 —— 一颗状态未知的开关比没有开关更误导。
	if (!ai) return null;

	// 方言归属认当前实例桶里的 provider 章;想不想思考看的是 chat 段(带继承)。
	const meta = providerMeta(resolveAIProfile(ai).provider);
	const thinking = resolveChatThinking(ai);
	const on = meta.supportsThinking && thinking.enableThinking;

	return (
		<button
			type="button"
			aria-label="深度思考"
			aria-pressed={on}
			disabled={!meta.supportsThinking}
			title={
				meta.supportsThinking
					? on
						? "深度思考已开启,想清楚再答(等级在「智能女仆 → 全局配置」里调)"
						: "深度思考:让她想清楚再答,响应会慢一些"
					: '自定义服务商的方言未知,请到「智能女仆」页的「额外请求参数」手写(如 DeepSeek 填 {"thinking":{"type":"enabled"}})'
			}
			onClick={() => save.mutate({ enableThinking: !thinking.enableThinking })}
			className={`flex h-9 shrink-0 cursor-pointer items-center gap-1.5 rounded-full border px-3 text-[12.5px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
				on
					? "bn-chat-accent bn-chat-accent-soft border-transparent"
					: "border-bn-border text-bn-text-secondary hover:bg-bn-hover-muted"
			}`}
		>
			<Icon.sparkle size={14} />
			深度思考
		</button>
	);
}
