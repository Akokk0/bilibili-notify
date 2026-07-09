import type BilibiliNotifyServerManager from "../runtime/bootstrap";

export function sysCommands(this: BilibiliNotifyServerManager): void {
	const sysCom = this.ctx.command("bn", "bilibili-notify 插件运行相关指令", {
		permissions: ["authority:5"],
	});

	sysCom
		.subcommand(".restart", "重启插件（重新加载订阅并通知 live/dynamic 插件）")
		.usage("重启插件")
		.example("bn restart")
		.action(async () => {
			if (await this.restartPlugin()) {
				return "主人～女仆成功重启插件啦～乖乖继续为主人服务呢 (>ω<)♡";
			}
			return "主人呜呜 (；>_<) 女仆重启插件失败啦～请主人检查一下再试哦 (>ω<)♡";
		});

	sysCom
		.subcommand(".stop", "停止插件")
		.usage("停止插件")
		.example("bn stop")
		.action(() => {
			if (this.disposePlugin()) {
				return "主人～女仆已经停止插件啦～休息一下先 (>ω<)♡";
			}
			return "主人呜呜 (；>_<) 女仆停止插件失败啦～请主人检查一下再试哦 (>ω<)♡";
		});

	sysCom
		.subcommand(".start", "启动插件")
		.usage("启动插件")
		.example("bn start")
		.action(async () => {
			if (await this.registerPlugin()) {
				return "主人～女仆成功启动插件啦～准备好乖乖为主人工作呢 (>ω<)♡";
			}
			return "主人呜呜 (；>_<) 女仆启动插件失败啦～请主人检查一下再试哦 (>ω<)♡";
		});
}
