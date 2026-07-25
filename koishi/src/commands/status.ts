import { BiliLoginStatus } from "@bilibili-notify/api";
import { Universal } from "koishi";
import type BilibiliNotifyServerManager from "../runtime/bootstrap";

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
			if (this.engines?.dynamic) return "动态监测正在运行";
			return "动态监测尚未启动（请检查插件是否已启动，bn start / bn restart）";
		});

	statusCom
		.subcommand(".live", "查看直播监测运行状态")
		.usage("查看直播监测运行状态")
		.example("status live")
		.action(() => {
			if (this.engines?.live) return "直播监测正在运行";
			return "直播监测尚未启动（请检查插件是否已启动，bn start / bn restart）";
		});

	statusCom
		.subcommand(".sm", "查看订阅管理对象")
		.usage("查看订阅管理对象")
		.example("status sm")
		.action(() => {
			this.ctx.logger.info("[status]", this.store?.list());
			return "查看控制台";
		});

	// 这条是「指定发送账号」的发现路径:高级订阅里那个 selfId 要填什么，只能从这儿查。
	// 所以它必须**回话**(原来只写 logger.debug，不调日志级别根本看不见)，也不能再
	// hidden(不知道它存在的人永远找不到)——与 .auth / .dyn / .live 一致。
	statusCom
		.subcommand(".bot", "查询当前连着的机器人")
		.usage("查询当前连着的机器人。高级订阅里「指定发送账号」要填的就是这里的账号 ID")
		.example("status bot")
		.action(() => {
			const bots = [...this.ctx.bots];
			if (!bots.length) return "当前没有连接任何机器人。";
			const lines = bots.map((bot) => {
				const online = bot.status === Universal.Status.ONLINE ? "在线" : "离线";
				return `${online}｜平台：${bot.platform}｜账号 ID：${bot.selfId}｜名称：${bot.user?.name ?? "(未知)"}`;
			});
			return [
				`当前连着 ${bots.length} 个机器人：`,
				...lines,
				"",
				"（高级订阅里的「指定发送账号」填上面的「账号 ID」；留空则自动挑该平台第一个在线的）",
			].join("\n");
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
