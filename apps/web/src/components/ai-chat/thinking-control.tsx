import type { GlobalConfig } from "@bilibili-notify/internal";
import { canProfileThink, resolveAIProfile } from "@bilibili-notify/internal/constants";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../services/api";
import { Icon } from "../icons";
import { ComposerPill } from "./composer-pill";

/**
 * 聊天输入框工具栏里的「深度思考」胶囊开关 —— 学 DeepSeek 的 DeepThink:
 * 图标 + 文字的药丸按钮,不是一个谁都认不出的纯图标。
 *
 * **会话级,不落盘**(主人定的):默认关、手动点亮,状态由聊天页持有、随这一问
 * 的请求体走 —— 这颗胶囊曾经直接写配置,于是换台设备 / 刷新后「上次开的思考」
 * 还阴魂不散地烧钱。等级也不在这里调 —— 「智能女仆 → 全局配置 → AI 聊天」。
 *
 * 组件自己只留一件事:**能不能开**。自定义服务商没有这颗开关能翻译成的方言
 * (我们不知道对面是哪家),按钮灰着并指路去「额外请求参数」—— 藏起来的话,
 * 主人只会觉得功能时有时无。
 */
export function ThinkingControl({ on, onToggle }: { on: boolean; onToggle: (v: boolean) => void }) {
	const globalsQuery = useQuery({
		queryKey: ["globals"],
		queryFn: () => api.get<GlobalConfig>("/api/globals"),
	});
	const ai = globalsQuery.data?.defaults.ai;
	// 配置还没到手就先不画 —— 一颗状态未知的开关比没有开关更误导。
	if (!ai) return null;

	const profile = resolveAIProfile(ai);
	// responses 风味下思考是标准字段(reasoning.effort),custom 档案也能开 ——
	// 「方言未知不敢发」只是 chat completions 的处境。谓词一份,住 constants。
	const canThink = canProfileThink(profile);

	return (
		<ComposerPill
			label="深度思考"
			icon={<Icon.sparkle size={14} />}
			on={on}
			disabled={!canThink}
			title={
				canThink
					? canThink && on
						? "深度思考已开启,只管当前会话(等级在「智能女仆 → 全局配置」里调)"
						: "深度思考:让她想清楚再答,响应会慢一些。只管当前会话,不落盘"
					: '自定义服务商的方言未知,请到「智能女仆」页的「额外请求参数」手写(如 DeepSeek 填 {"thinking":{"type":"enabled"}});或把那份实例的接口风味换成 responses,思考在那套协议里是标准字段'
			}
			onToggle={onToggle}
		/>
	);
}
