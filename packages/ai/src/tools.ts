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
	{
		type: "function",
		function: {
			name: "get_user_stats",
			description: "获取指定 UP 主的数据概览，包括总播放量、总获赞数、视频数、动态数",
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
			name: "get_user_videos",
			description: "获取指定 UP 主最近发布的视频列表（最多 5 条），含标题、播放量、发布时间",
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
			name: "search_user",
			description: "按关键词搜索 B 站用户，返回匹配的 UP 主列表（含 UID、粉丝数、简介）",
			parameters: {
				type: "object",
				properties: {
					keyword: { type: "string", description: "搜索关键词，如 UP 主名字或领域" },
				},
				required: ["keyword"],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "subscribe_user",
			description:
				"订阅指定 UP 主的动态和/或直播通知，自动推送到当前对话频道。订阅前建议先用 search_user 确认 UID。",
			parameters: {
				type: "object",
				properties: {
					uid: { type: "string", description: "UP 主的 UID" },
					name: { type: "string", description: "UP 主的昵称（用于显示）" },
					dynamic: { type: "boolean", description: "订阅动态通知，默认 true" },
					dynamicAtAll: { type: "boolean", description: "动态时@全体成员，默认 false" },
					live: { type: "boolean", description: "订阅直播通知，默认 true" },
					liveAtAll: { type: "boolean", description: "开播时@全体成员，默认 false" },
					liveGuardBuy: { type: "boolean", description: "订阅上舰消息，默认 false" },
					superchat: { type: "boolean", description: "订阅 SC（醒目留言）消息，默认 false" },
					wordcloud: { type: "boolean", description: "直播结束后生成弹幕词云，默认 true" },
					liveSummary: { type: "boolean", description: "直播结束后生成 AI 总结，默认 true" },
				},
				required: ["uid", "name"],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "unsubscribe_user",
			description: "取消订阅指定 UP 主，从通知列表中移除",
			parameters: {
				type: "object",
				properties: {
					uid: { type: "string", description: "要取消订阅的 UP 主 UID" },
				},
				required: ["uid"],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "update_subscription",
			description: "修改已订阅 UP 主的通知选项，只需传入要变更的字段，未传入的字段保持不变",
			parameters: {
				type: "object",
				properties: {
					uid: { type: "string", description: "要修改的 UP 主 UID" },
					dynamic: { type: "boolean", description: "是否订阅动态通知" },
					dynamicAtAll: { type: "boolean", description: "动态时是否@全体成员" },
					live: { type: "boolean", description: "是否订阅直播通知" },
					liveAtAll: { type: "boolean", description: "开播时是否@全体成员" },
					liveGuardBuy: { type: "boolean", description: "是否订阅上舰消息" },
					superchat: { type: "boolean", description: "是否订阅 SC（醒目留言）消息" },
					wordcloud: { type: "boolean", description: "直播结束后是否生成弹幕词云" },
					liveSummary: { type: "boolean", description: "直播结束后是否生成 AI 总结" },
				},
				required: ["uid"],
			},
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

export interface SessionContext {
	platform: string;
	channelId: string;
}

export interface SubManagement {
	addSub: (params: {
		uid: string;
		name: string;
		platform: string;
		target: string;
		dynamic?: boolean;
		dynamicAtAll?: boolean;
		live?: boolean;
		liveAtAll?: boolean;
		liveGuardBuy?: boolean;
		superchat?: boolean;
		wordcloud?: boolean;
		liveSummary?: boolean;
	}) => Promise<string>;
	removeSub: (uid: string) => string;
	updateSub: (params: {
		uid: string;
		dynamic?: boolean;
		dynamicAtAll?: boolean;
		live?: boolean;
		liveAtAll?: boolean;
		liveGuardBuy?: boolean;
		superchat?: boolean;
		wordcloud?: boolean;
		liveSummary?: boolean;
	}) => Promise<string>;
}

export async function executeTool(
	name: string,
	args: Record<string, string>,
	api: BilibiliAPI,
	subs: Subscriptions | null,
	sessionCtx?: SessionContext,
	subMgmt?: SubManagement,
	deferredActions?: Array<() => Promise<void>>,
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
		case "get_user_stats": {
			// biome-ignore lint/suspicious/noExplicitAny: bilibili API responses have no declared types
			const [upstat, navnum]: [any, any] = await Promise.all([
				api.getUserUpstat(args.uid),
				api.getUserNavnum(args.uid),
			]);
			if (upstat.code !== 0) return `获取数据失败: ${upstat.message}`;
			const view = upstat.data?.archive?.view ?? 0;
			const likes = upstat.data?.likes ?? 0;
			const videos = navnum.data?.video ?? "?";
			const dynamics = navnum.data?.upos ?? "?";
			return `总播放量: ${view}, 总获赞: ${likes}, 视频数: ${videos}, 动态数: ${dynamics}`;
		}
		case "get_user_videos": {
			// biome-ignore lint/suspicious/noExplicitAny: bilibili API response
			const res = (await api.getUserVideos(args.uid)) as any;
			if (res.code !== 0) return `获取视频失败: ${res.message}`;
			// biome-ignore lint/suspicious/noExplicitAny: bilibili API response
			const vlist: any[] = res.data?.list?.vlist ?? [];
			if (!vlist.length) return "暂无投稿视频";
			return vlist
				.map((v, i) => {
					const date = new Date(v.created * 1000).toLocaleDateString("zh-CN");
					return `${i + 1}. [${date}] ${v.title}（播放: ${v.play}）`;
				})
				.join("\n");
		}
		case "search_user": {
			// biome-ignore lint/suspicious/noExplicitAny: bilibili API response
			const res = (await api.searchByType("bili_user", args.keyword)) as any;
			if (res.code !== 0) return `搜索失败: ${res.message}`;
			// biome-ignore lint/suspicious/noExplicitAny: bilibili API response
			const results: any[] = (res.data?.result ?? []).slice(0, 5);
			if (!results.length) return "没有找到相关用户";
			return results
				.map(
					(u, i) =>
						`${i + 1}. ${u.uname}（UID: ${u.mid}）粉丝: ${u.fans}, 视频数: ${u.videos}${u.usign ? `，简介: ${u.usign}` : ""}`,
				)
				.join("\n");
		}
		case "subscribe_user": {
			if (!subMgmt || !deferredActions) return "订阅管理功能不可用";
			if (!sessionCtx) return "无法获取当前频道信息，无法确定推送目标";
			if (subs?.[args.uid]) return `${subs[args.uid].uname}（UID: ${args.uid}）已在订阅列表中`;
			const { uid, name } = args;
			const bool = (v: string | undefined, def: boolean) => (v === undefined ? def : v !== "false");
			const { platform, channelId: target } = sessionCtx;
			deferredActions.push(async () => {
				await subMgmt.addSub({
					uid,
					name,
					platform,
					target,
					dynamic: bool(args.dynamic, true),
					dynamicAtAll: bool(args.dynamicAtAll, false),
					live: bool(args.live, true),
					liveAtAll: bool(args.liveAtAll, false),
					liveGuardBuy: bool(args.liveGuardBuy, false),
					superchat: bool(args.superchat, false),
					wordcloud: bool(args.wordcloud, true),
					liveSummary: bool(args.liveSummary, true),
				});
			});
			return `订阅请求已提交（UID: ${uid}，昵称: ${name}），操作将在本次回复发送后执行`;
		}
		case "unsubscribe_user": {
			if (!subMgmt) return "订阅管理功能不可用";
			// Execute immediately: removal doesn't trigger push notifications so no race condition.
			// Returning the real result lets the AI report failures accurately.
			return subMgmt.removeSub(args.uid);
		}
		case "update_subscription": {
			if (!subMgmt) return "订阅管理功能不可用";
			const bool = (v: string | undefined) => (v === undefined ? undefined : v !== "false");
			return subMgmt.updateSub({
				uid: args.uid,
				dynamic: bool(args.dynamic),
				dynamicAtAll: bool(args.dynamicAtAll),
				live: bool(args.live),
				liveAtAll: bool(args.liveAtAll),
				liveGuardBuy: bool(args.liveGuardBuy),
				superchat: bool(args.superchat),
				wordcloud: bool(args.wordcloud),
				liveSummary: bool(args.liveSummary),
			});
		}
		default:
			return `未知工具: ${name}`;
	}
}
