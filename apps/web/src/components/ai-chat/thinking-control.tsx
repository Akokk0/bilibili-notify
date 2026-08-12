import type { GlobalConfig } from "@bilibili-notify/internal";
import {
	providerMeta,
	resolveAIProfile,
	type ThinkingLevel,
} from "@bilibili-notify/internal/constants";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../services/api";
import { Icon } from "../icons";

/**
 * 聊天输入框旁的「深度思考」开关 + 档位 —— 不离开对话就能开思考。
 *
 * 它是**同一份配置的另一个入口**:读写的就是智能女仆页那套
 * `ai.providers.<id>.enableThinking / thinkingLevel`,不另起一份状态。保存走
 * PATCH /api/globals,服务端 `config-changed` 会把新配置热推给引擎,下一句就生效;
 * 只动这两个字段不会触发 AI 探活,所以开关是即点即应的。
 *
 * 自定义服务商没有这颗开关能翻译成的方言(我们不知道对面是哪家),按钮灰着并
 * 指路去「额外请求参数」—— 藏起来的话,主人只会觉得功能时有时无。
 */

const LEVELS: ReadonlyArray<{ id: ThinkingLevel; label: string }> = [
	{ id: "low", label: "低" },
	{ id: "medium", label: "中" },
	{ id: "high", label: "高" },
];

/** 一次保存的载荷。走 variables 而不是闭包 —— 见 react-query onMutate 的时序坑。 */
type SaveVars = {
	provider: GlobalConfig["defaults"]["ai"]["provider"];
	delta: { enableThinking?: boolean; thinkingLevel?: ThinkingLevel };
};

export function ThinkingControl() {
	const qc = useQueryClient();
	const globalsQuery = useQuery({
		queryKey: ["globals"],
		queryFn: () => api.get<GlobalConfig>("/api/globals"),
	});
	const save = useMutation({
		mutationFn: ({ provider, delta }: SaveVars) =>
			api.patch("/api/globals", { defaults: { ai: { providers: { [provider]: delta } } } }),
		/**
		 * 乐观更新:点下去缓存立刻改,界面**当场**就是终态。
		 *
		 * 曾经是等服务端回话 + invalidate 重拉,并在在途期间连坐禁用整个控件 ——
		 * `disabled:opacity-40` 一来一回,主人看到的就是「切个档,开关闪一下」。
		 * 配置这种毫秒级往返的小字段,观感不该被网络牵着走。
		 */
		onMutate: async ({ provider, delta }: SaveVars) => {
			await qc.cancelQueries({ queryKey: ["globals"] });
			const prev = qc.getQueryData<GlobalConfig>(["globals"]);
			qc.setQueryData<GlobalConfig>(["globals"], (cur) => {
				if (!cur) return cur;
				// 桶可能还不存在(从没在设置页动过这家)—— 拿 resolve 出来的完整
				// 缺省当底,别往缓存里塞半个桶。
				const base = cur.defaults.ai.providers[provider] ?? resolveAIProfile(cur.defaults.ai);
				return {
					...cur,
					defaults: {
						...cur.defaults,
						ai: {
							...cur.defaults.ai,
							providers: { ...cur.defaults.ai.providers, [provider]: { ...base, ...delta } },
						},
					},
				};
			});
			return { prev };
		},
		// 失败弹回原样 —— 留一个骗人的高亮,主人会以为开成了。
		onError: (_err, _vars, ctx) => {
			if (ctx?.prev) qc.setQueryData(["globals"], ctx.prev);
		},
		// 收尾重拉一次对账:这份配置设置页也在看,以服务端落盘的为准。
		onSettled: () => qc.invalidateQueries({ queryKey: ["globals"] }),
	});

	const ai = globalsQuery.data?.defaults.ai;
	// 配置还没到手就先不画 —— 一颗状态未知的开关比没有开关更误导。
	if (!ai) return null;

	const meta = providerMeta(ai.provider);
	const profile = resolveAIProfile(ai);
	const on = meta.supportsThinking && profile.enableThinking;

	return (
		<div className="flex shrink-0 items-center gap-1.5 self-center">
			<button
				type="button"
				aria-pressed={on}
				// 只有「不支持」才禁用。保存在途**不**禁用 —— 乐观更新下界面已是终态,
				// 这时再灰一下就是主人报过的那个「闪」。连点的最后一下赢,与服务端
				// merge-patch 的语义一致。
				disabled={!meta.supportsThinking}
				title={
					meta.supportsThinking
						? "让她想清楚再答,响应会慢一些"
						: '自定义服务商的方言未知,请到「智能女仆」页的「额外请求参数」手写(如 DeepSeek 填 {"thinking":{"type":"enabled"}})'
				}
				onClick={() =>
					save.mutate({ provider: ai.provider, delta: { enableThinking: !profile.enableThinking } })
				}
				className={`flex h-8 cursor-pointer items-center gap-1.25 rounded-full border px-3 text-[12px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
					on
						? "bn-chat-accent bn-chat-accent-soft border-transparent"
						: "border-bn-border text-bn-text-secondary hover:bg-bn-hover-muted"
				}`}
			>
				<Icon.sparkle size={12} />
				深度思考
			</button>
			{/* 档位只在开着时出现 —— 灰着一排点不动的按钮只会让人怀疑坏了。 */}
			{on ? (
				<div className="flex items-center gap-0.5 rounded-full border border-bn-border p-0.5">
					{LEVELS.map((l) => {
						const active = profile.thinkingLevel === l.id;
						return (
							<button
								key={l.id}
								type="button"
								aria-pressed={active}
								onClick={() =>
									save.mutate({ provider: ai.provider, delta: { thinkingLevel: l.id } })
								}
								className={`h-6.5 cursor-pointer rounded-full px-2.5 text-[11.5px] font-semibold transition-colors ${
									active ? "bn-chat-accent bn-chat-accent-soft" : "text-bn-text-tertiary"
								}`}
							>
								{l.label}
							</button>
						);
					})}
				</div>
			) : null}
		</div>
	);
}
