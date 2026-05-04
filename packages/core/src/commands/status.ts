import { BiliLoginStatus } from "@bilibili-notify/api";
import type BilibiliNotifyServerManager from "../server-manager";

export function statusCommands(this: BilibiliNotifyServerManager): void {
	const statusCom = this.ctx.command("status", "插件状态相关指令", {
		permissions: ["authority:5"],
	});

	statusCom
		.subcommand(".auth", "查看登录状态")
		.usage("查看登录状态")
		.example("status auth")
		.action(() => {
			const snap = this.getAuthSnapshot();
			const label = BiliLoginStatus[snap.status] ?? `unknown(${snap.status})`;
			return `登录状态：${label}\n信息：${snap.msg || "(无)"}`;
		});

	statusCom
		.subcommand(".dyn", "查看动态监测运行状态")
		.usage("查看动态监测运行状态")
		.example("status dyn")
		.action(() => {
			const dynService = this.ctx.get("bilibili-notify-dynamic");
			if (dynService) return "动态监测正在运行";
			return "动态插件未运行（请检查是否已安装并启用 koishi-plugin-bilibili-notify-dynamic）";
		});

	statusCom
		.subcommand(".live", "查看直播监测运行状态")
		.usage("查看直播监测运行状态")
		.example("status live")
		.action(() => {
			const liveService = this.ctx.get("bilibili-notify-live");
			if (liveService) return "直播监测正在运行";
			return "直播插件未运行（请检查是否已安装并启用 koishi-plugin-bilibili-notify-live）";
		});

	statusCom
		.subcommand(".sm", "查看订阅管理对象")
		.usage("查看订阅管理对象")
		.example("status sm")
		.action(() => {
			this.ctx.logger.info("[status]", this.subManager);
			return "查看控制台";
		});

	statusCom
		.subcommand(".bot", "查询当前拥有的机器人信息", { hidden: true })
		.usage("查询当前拥有的机器人信息")
		.example("status bot")
		.action(() => {
			this.ctx.logger.debug("[status] 开始输出BOT信息");
			for (const bot of this.ctx.bots) {
				this.ctx.logger.debug("[status] --------------------------------");
				this.ctx.logger.debug(`[status] 平台：${bot.platform}`);
				this.ctx.logger.debug(`[status] 名称：${bot.user?.name}`);
				this.ctx.logger.debug("[status] --------------------------------");
			}
		});

	statusCom
		.subcommand(".env", "查询当前环境的信息", { hidden: true })
		.usage("查询当前环境的信息")
		.example("status env")
		.action(async ({ session }) => {
			await session?.send(`Guild ID:${session.event.guild?.id}`);
			await session?.send(`Channel ID: ${session.event.channel?.id}`);
		});
}
