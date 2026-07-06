import type { BiliDataServer } from "@bilibili-notify/api";
import { BiliLoginStatus } from "@bilibili-notify/api";
import { DataService } from "@koishijs/plugin-console";
import type { Context } from "koishi";

export default class BilibiliNotifyDataServer extends DataService<BiliDataServer> {
	private biliData: BiliDataServer = {
		status: BiliLoginStatus.LOADING_LOGIN_INFO,
		msg: "正在加载登录信息...",
	};

	constructor(ctx: Context) {
		super(ctx, "bilibili-notify" as keyof import("@koishijs/plugin-console").Console.Services);

		ctx.on("bilibili-notify/login-status-report", (data: BiliDataServer) => {
			this.biliData = data;
			this.refresh();
		});
	}

	async get(): Promise<BiliDataServer> {
		return this.biliData;
	}
}
