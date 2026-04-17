import { BILIBILI_NOTIFY_TOKEN } from "@bilibili-notify/internal";
import type BilibiliNotifyServerManager from "../server-manager";

export function biliCommands(this: BilibiliNotifyServerManager): void {
	const biliCom = this.ctx.command("bili", "bilibili-notify 插件相关指令", {
		permissions: ["authority:3"],
	});

	biliCom
		.subcommand(".list", "展示订阅对象")
		.usage("展示订阅对象")
		.example("bili list")
		.action(() => this.subList());

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
			const subMap = this.subManager;
			// biome-ignore lint/suspicious/noExplicitAny: API response shape
			const result = (await internals.api.getTheUserWhoIsLiveStreaming()) as any;
			const liveUsers = result?.data?.live_users?.items ?? [];
			// biome-ignore lint/suspicious/noExplicitAny: API response shape
			const liveUidSet = new Set(liveUsers.map((u: any) => String(u.mid)));

			let table = "";
			for (const [uid, sub] of subMap) {
				const onLive = sub.live && liveUidSet.has(uid);
				table += `[UID:${uid}] 「${sub.uname}」 ${onLive ? "正在直播" : "未开播"}\n`;
			}
			return table || "没有订阅任何UP";
		});
}
