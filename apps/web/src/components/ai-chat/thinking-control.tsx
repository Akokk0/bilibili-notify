import { canProfileThink, resolveAIProfile } from "@bilibili-notify/internal/ai";
import { Icon } from "@bilibili-notify/ui";
import { useCoreSettings } from "../../hooks/useSettings";
import { useT } from "../../i18n";
import { ComposerPill } from "./composer-pill";

/**
 * 聊天输入框工具栏里的「深度思考」胶囊开关 —— 学 DeepSeek 的 DeepThink:
 * 图标 + 文字的药丸按钮,不是一个谁都认不出的纯图标。
 *
 * **会话级,不落盘**(主人定的):默认关、手动点亮,状态由聊天页持有、随这一问
 * 的请求体走 —— 这颗胶囊曾经直接写配置,于是换台设备 / 刷新后「上次开的思考」
 * 还阴魂不散地烧钱。等级也不在这里调 —— 在侧栏的「设置」弹层里(思考深度)。
 *
 * 组件自己只留一件事:**能不能开**。自定义服务商没有这颗开关能翻译成的方言
 * (我们不知道对面是哪家),按钮灰着并指路去「额外请求参数」—— 藏起来的话,
 * 主人只会觉得功能时有时无。
 */
export function ThinkingControl({ on, onToggle }: { on: boolean; onToggle: (v: boolean) => void }) {
	const tx = useT();

	const globalsQuery = useCoreSettings();
	const ai = globalsQuery.data?.ai;
	// 配置还没到手就先不画 —— 一颗状态未知的开关比没有开关更误导。
	if (!ai) return null;

	const profile = resolveAIProfile(ai);
	// responses 风味下思考是标准字段(reasoning.effort),custom 档案也能开 ——
	// 「方言未知不敢发」只是 chat completions 的处境。谓词一份,住 ai.ts。
	const canThink = canProfileThink(profile);

	return (
		<ComposerPill
			label={tx("panelUi.components.ai-chat.thinking-control.1")}
			icon={<Icon.sparkle size={14} />}
			on={on}
			disabled={!canThink}
			title={
				canThink
					? canThink && on
						? tx("panelUi.components.ai-chat.thinking-control.2")
						: tx("panelUi.components.ai-chat.thinking-control.3")
					: tx("panelUi.components.ai-chat.thinking-control.4", {
							example: '{"thinking":{"type":"enabled"}}',
						})
			}
			onToggle={onToggle}
		/>
	);
}
