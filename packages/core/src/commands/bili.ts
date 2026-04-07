import { BILIBILI_NOTIFY_TOKEN } from "@bilibili-notify/internal";
import type BilibiliNotifyServerManager from "../server-manager";

export function biliCommands(this: BilibiliNotifyServerManager): void {
	const biliCom = this.ctx.command("bili", "bili-notify 插件相关指令", {
		permissions: ["authority:3"],
	});

	biliCom
		.subcommand(".list", "展示订阅对象")
		.usage("展示订阅对象")
		.example("bili list")
		.action(() => this.subShow());

	biliCom
		.subcommand(".private", "向管理员账号发送一条测试消息", { hidden: true })
		.usage("向管理员账号发送一条测试消息")
		.example("bili private")
		.action(async ({ session }) => {
			const internals = this.getInternals(BILIBILI_NOTIFY_TOKEN);
			if (!internals) return "插件尚未就绪";
			await internals.push.sendPrivateMsg("测试消息");
			await session?.send(
				"已发送测试消息。如果未收到，可能是机器人不支持发送私聊消息或配置信息有误",
			);
		});

	biliCom
		.subcommand(".ll", "展示当前正在直播的订阅对象")
		.usage("展示当前正在直播的订阅对象")
		.example("bili ll")
		.action(async () => {
			const internals = this.getInternals(BILIBILI_NOTIFY_TOKEN);
			if (!internals) return "插件尚未就绪";
			// biome-ignore lint/suspicious/noExplicitAny: API response shape
			const result = (await internals.api.getTheUserWhoIsLiveStreaming()) as any;
			const liveUsers = result?.data?.live_users?.items ?? [];
			// biome-ignore lint/suspicious/noExplicitAny: API response shape
			const liveUidSet = new Set(liveUsers.map((u: any) => String(u.mid)));

			let table = "";
			for (const [uid, sub] of this.subManager) {
				const onLive = sub.live && liveUidSet.has(uid);
				table += `[UID:${uid}] 「${sub.uname}」 ${onLive ? "正在直播" : "未开播"}\n`;
			}
			return table || "没有订阅任何UP";
		});

	biliCom
		.subcommand(".dyn <uid:string> [index:number]", "手动推送一条动态信息", { hidden: true })
		.usage("手动推送一条动态信息")
		.example("bili dyn 233 1 手动推送UID为233用户空间的第一条动态信息")
		.action(async ({ session }, uid, index) => {
			if (!uid) return "请提供 UID";
			const internals = this.getInternals(BILIBILI_NOTIFY_TOKEN);
			if (!internals) return "插件尚未就绪";
			// biome-ignore lint/suspicious/noExplicitAny: API response shape
			const data = (await internals.api.getUserSpaceDynamic(uid)) as any;
			const items = data?.data?.items;
			if (!items?.length) return "获取动态失败或该用户没有动态";
			const i = index ? index - 1 : 0;
			const item = items[i];
			if (!item) return `没有第 ${i + 1} 条动态`;
			const dynService = this.ctx.get("bilibili-notify-dynamic");
			if (dynService?.pushOneDynamic) {
				await dynService.pushOneDynamic(item, uid);
				return;
			}
			await session?.send(`动态 ID: ${item.id_str ?? item.id ?? "未知"}`);
		});
}
