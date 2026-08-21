import type { GlobalConfig, ThinkingLevel } from "@bilibili-notify/internal";
import {
	canProfileThink,
	resolveAIProfile,
	resolveChatThinkingLevel,
} from "@bilibili-notify/internal/constants";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../services/api";

/**
 * 侧栏设置弹层里的「思考深度」—— `ai.chat.thinkingLevel` 的编辑口。
 *
 * 原来住在「智能女仆 → 全局配置」页:调聊天的思考深度得离开聊天、跨半个控制台
 * 再找回来。这个深度只有聊天在用,编辑口就该跟着聊天走(主人定的)。落盘语义
 * 不变:没写 = 跟随当前实例的等级,调过一次就写实、从此与实例配置互不牵动
 * (见 resolveChatThinkingLevel)。开关不在这里 —— 输入框旁那颗 ✦ 胶囊是
 * 会话级的,这里只管点亮之后想多深。
 *
 * 直接 PATCH 而不是走设置页的草稿 + 保存条:聊天页没有灵动岛,弹层里的另外
 * 几项(主题色 / 玻璃质感)也都是点了立即生效 —— 这一格攒着等一个不存在的
 * 保存按钮,表现就是「调了没反应」。载荷只带这一片叶子,永远是写实、没有
 * 删除语义,所以不需要 buildPatch。
 */

const LEVELS: readonly { value: ThinkingLevel; label: string }[] = [
	{ value: "low", label: "低" },
	{ value: "medium", label: "中" },
	{ value: "high", label: "高" },
];

export function ThinkingLevelSetting() {
	const qc = useQueryClient();
	const globalsQuery = useQuery({
		queryKey: ["globals"],
		queryFn: () => api.get<GlobalConfig>("/api/globals"),
	});

	const save = useMutation({
		mutationFn: (level: ThinkingLevel) =>
			api.patch<GlobalConfig>("/api/globals", {
				defaults: { ai: { chat: { thinkingLevel: level } } },
			}),
		// 点了立刻亮(乐观写缓存),失败退回 —— 弹层里其余几项都是即点即变,
		// 这一格等一个网络往返才亮会显得「点不动」。
		onMutate: async (level) => {
			const prev = qc.getQueryData<GlobalConfig>(["globals"]);
			if (prev) {
				qc.setQueryData<GlobalConfig>(["globals"], {
					...prev,
					defaults: {
						...prev.defaults,
						ai: { ...prev.defaults.ai, chat: { ...prev.defaults.ai.chat, thinkingLevel: level } },
					},
				});
			}
			return { prev };
		},
		onError: (_err, _level, ctx) => {
			if (ctx?.prev) qc.setQueryData(["globals"], ctx.prev);
		},
		// 响应就是 redact 后的新 globals,直接落缓存 —— 不必再 invalidate 白拉一次。
		onSuccess: (next) => qc.setQueryData(["globals"], next),
	});

	const ai = globalsQuery.data?.defaults.ai;
	// 配置还没到手就整节不画 —— 一排状态未知的档位比没有档位更误导。
	if (!ai) return null;

	// 能力位与 ✦ 胶囊同一颗谓词:chat completions 下自定义服务商方言未知,
	// 深浅调了也发不出去,摆出来就是骗人。
	const canThink = canProfileThink(resolveAIProfile(ai));
	const current = resolveChatThinkingLevel(ai);

	return (
		<>
			<div className="mb-2 mt-3.5 pl-0.5 text-bn-xs font-bold tracking-wide text-bn-text-secondary">
				思考深度
			</div>
			{canThink ? (
				<>
					<div className="flex gap-1.5">
						{LEVELS.map((o) => {
							const active = current === o.value;
							return (
								<button
									key={o.value}
									type="button"
									aria-pressed={active}
									onClick={() => save.mutate(o.value)}
									data-bn="btn"
									className={`flex-1 cursor-pointer rounded-bn-sm border-[1.5px] px-1 py-1.5 text-bn-xs font-semibold transition ${
										active
											? "bg-(--bn-glass-strong-bg) border-(--bn-chat-dot) text-bn-text-primary"
											: "border-transparent text-bn-text-secondary hover:bg-bn-code-bg"
									}`}
								>
									{o.label}
								</button>
							);
						})}
					</div>
					<div className="mt-1.5 px-0.5 text-bn-2xs leading-relaxed text-bn-text-secondary">
						管的是 ✦ 胶囊点亮后想多深；初始跟随所选实例的等级，调过就分家
					</div>
				</>
			) : (
				<div className="px-0.5 text-bn-2xs leading-relaxed text-bn-text-secondary">
					当前实例是自定义服务商，女仆不会自作主张发思考参数 ——
					需要的话写进那份实例的「额外请求参数」里
				</div>
			)}
		</>
	);
}
