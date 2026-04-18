import type { BilibiliAPI } from "@bilibili-notify/api";
import type { Subscriptions } from "@bilibili-notify/push";
import type OpenAI from "openai";

export const TOOL_DEFINITIONS: OpenAI.ChatCompletionTool[] = [
	{
		type: "function",
		function: {
			name: "list_subscriptions",
			description: "查询当前订阅的所有 UP 主，返回 UID、名称及订阅类型（动态/直播）",
			parameters: { type: "object", properties: {} },
		},
	},
	{
		type: "function",
		function: {
			name: "get_user_dynamics",
			description: "获取指定 UP 主最近发布的动态内容（最多 5 条）",
			parameters: {
				type: "object",
				properties: {
					uid: { type: "string", description: "UP 主的 UID" },
				},
				required: ["uid"],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "get_user_info",
			description: "获取指定 UP 主的基本信息，包括名称、粉丝数、等级",
			parameters: {
				type: "object",
				properties: {
					uid: { type: "string", description: "UP 主的 UID" },
				},
				required: ["uid"],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "get_live_status",
			description: "查询订阅的 UP 主中哪些正在直播，返回直播状态和标题",
			parameters: { type: "object", properties: {} },
		},
	},
];

// biome-ignore lint/suspicious/noExplicitAny: bilibili API response shape varies
function extractDynamicText(item: Record<string, any>): string {
	const mod = item?.modules?.module_dynamic;
	if (!mod) return "";
	const parts: string[] = [];
	if (mod.desc?.text) parts.push(mod.desc.text);
	if (mod.major?.opus?.summary?.text) {
		if (mod.major.opus.title) parts.push(`标题：${mod.major.opus.title}`);
		parts.push(mod.major.opus.summary.text);
	}
	if (mod.major?.archive?.title) parts.push(`视频标题：${mod.major.archive.title}`);
	return parts.join(" ").trim();
}

export async function executeTool(
	name: string,
	args: Record<string, string>,
	api: BilibiliAPI,
	subs: Subscriptions | null,
): Promise<string> {
	switch (name) {
		case "list_subscriptions": {
			if (!subs || Object.keys(subs).length === 0) return "当前没有订阅";
			return Object.values(subs)
				.map(
					(s) =>
						`${s.uname}（UID: ${s.uid}）动态:${s.dynamic ? "✓" : "✗"} 直播:${s.live ? "✓" : "✗"}`,
				)
				.join("\n");
		}
		case "get_user_dynamics": {
			// biome-ignore lint/suspicious/noExplicitAny: bilibili API response
			const res = (await api.getUserSpaceDynamic(args.uid)) as any;
			if (res.code !== 0) return `获取动态失败: ${res.message}`;
			// biome-ignore lint/suspicious/noExplicitAny: bilibili API response
			const items: any[] = (res.data?.items ?? []).slice(0, 5);
			if (!items.length) return "暂无动态";
			return items
				.map((item, i) => {
					const text = extractDynamicText(item);
					const ts: number | undefined = item.modules?.module_author?.pub_ts;
					const date = ts ? new Date(ts * 1000).toLocaleDateString("zh-CN") : "未知时间";
					return `${i + 1}. [${date}] ${text || "（无文字内容）"}`;
				})
				.join("\n");
		}
		case "get_user_info": {
			// biome-ignore lint/suspicious/noExplicitAny: bilibili API response
			const res = (await api.getUserCardInfo(args.uid)) as any;
			if (res.code !== 0) return `获取用户信息失败: ${res.message}`;
			const card = res.data?.card;
			if (!card) return "未找到用户";
			return `名称: ${card.name}, 粉丝数: ${card.fans ?? 0}, 等级: ${card.level_info?.current_level ?? "?"}`;
		}
		case "get_live_status": {
			if (!subs || Object.keys(subs).length === 0) return "当前没有订阅";
			const liveItems = Object.values(subs).filter((s) => s.live);
			if (!liveItems.length) return "当前订阅中没有开启直播监控的 UP 主";
			const uids = liveItems.map((s) => s.uid);
			// biome-ignore lint/suspicious/noExplicitAny: bilibili API response
			const res = (await api.getLiveRoomInfoByUids(uids)) as any;
			if (res.code !== 0) return `获取直播状态失败: ${res.message}`;
			// biome-ignore lint/suspicious/noExplicitAny: bilibili API response
			const rooms: Record<string, any> = res.data ?? {};
			const lines = liveItems.map((s) => {
				const room = rooms[s.uid];
				const statusText = ["未开播", "直播中", "轮播中", "下播"][room?.live_status] ?? "未知";
				const title = room?.title ? `「${room.title}」` : "";
				return `${s.uname}：${statusText}${title}`;
			});
			return lines.join("\n");
		}
		default:
			return `未知工具: ${name}`;
	}
}
