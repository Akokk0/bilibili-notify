import type { GlobalConfig } from "@bilibili-notify/internal";
import { webSearchBackendMeta } from "@bilibili-notify/internal/constants";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../services/api";
import { Icon } from "../icons";

/**
 * 聊天输入框工具栏里的「联网搜索」胶囊 —— 学 DeepSeek 的 Search,与隔壁
 * 「深度思考」同一副面孔、同一套纪律:**会话级,不落盘**,默认关、手动点亮,
 * 状态由聊天页持有、随这一问的请求体走。
 *
 * 「能不能开」看的是**当前搜索后端那格 key 配没配**。GET 回来的 globals 里
 * key 是脱敏占位,但「非空 = 配了」这个判据恰好照常成立 —— 这里只认真假,
 * 不认内容。没配时灰着并指路设置页:点不亮的开关必须说清为什么。
 */
export function SearchControl({ on, onToggle }: { on: boolean; onToggle: (v: boolean) => void }) {
	const globalsQuery = useQuery({
		queryKey: ["globals"],
		queryFn: () => api.get<GlobalConfig>("/api/globals"),
	});
	const ai = globalsQuery.data?.defaults.ai;
	// 配置还没到手就先不画 —— 一颗状态未知的开关比没有开关更误导。
	// search 段单独再兜一次:这个组件消费的是网络数据,残缺入参不炸是这一层的
	// 通用纪律(providerMeta / resolveAIProfile 同款)。
	const search = ai?.search;
	if (!search) return null;

	const backend = webSearchBackendMeta(search.backend);
	const configured = Boolean(search.keys[search.backend]);
	const lit = configured && on;

	return (
		<button
			type="button"
			aria-label="联网搜索"
			aria-pressed={lit}
			disabled={!configured}
			title={
				configured
					? lit
						? `联网搜索已开启(${backend.label}),只管当前会话`
						: "联网搜索:她会先搜再答,按次计费。只管当前会话,不落盘"
					: `还没配搜索后端 —— 到「智能女仆 → 全局配置 → 联网搜索」填 ${backend.label} 的 API Key`
			}
			onClick={() => onToggle(!on)}
			className={`flex h-9 shrink-0 cursor-pointer items-center gap-1.5 rounded-full border px-3 text-[12.5px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
				lit
					? "bn-chat-accent bn-chat-accent-soft border-transparent"
					: "border-bn-border text-bn-text-secondary hover:bg-bn-hover-muted"
			}`}
		>
			<Icon.search size={14} />
			联网搜索
		</button>
	);
}
