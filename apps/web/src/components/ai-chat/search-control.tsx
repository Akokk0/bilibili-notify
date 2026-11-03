import { webSearchBackendMeta } from "@bilibili-notify/internal/ai";
import { Icon } from "@bilibili-notify/ui";
import { useCoreSettings } from "../../hooks/useSettings";
import { useT } from "../../i18n";
import { ComposerPill } from "./composer-pill";

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
	const tx = useT();

	const globalsQuery = useCoreSettings();
	const ai = globalsQuery.data?.ai;
	// 配置还没到手就先不画 —— 一颗状态未知的开关比没有开关更误导。
	// search 段单独再兜一次:这个组件消费的是网络数据,残缺入参不炸是这一层的
	// 通用纪律(providerMeta / resolveAIProfile 同款)。
	const search = ai?.search;
	if (!search) return null;

	const backend = webSearchBackendMeta(search.backend);
	const configured = Boolean(search.keys[search.backend]);

	return (
		<ComposerPill
			label={tx("panelUi.components.ai-chat.search-control.1")}
			icon={<Icon.search size={14} />}
			on={on}
			disabled={!configured}
			title={
				configured
					? configured && on
						? tx("panelUi.components.ai-chat.search-control.2", { value0: backend.label })
						: tx("panelUi.components.ai-chat.search-control.3")
					: tx("panelUi.components.ai-chat.search-control.4", { value0: backend.label })
			}
			onToggle={onToggle}
		/>
	);
}
