import { BILIBILI_NOTIFY_TOKEN } from "@bilibili-notify/internal";
import type {} from "@koishijs/plugin-help";
import { h } from "koishi";
import type { BilibiliNotifyLive } from "./live-service";

export function liveCommands(this: BilibiliNotifyLive): void {
	this.ctx
		.command("bili.sc [price:number]", "生成测试 SC 卡片", { hidden: true })
		.usage("生成测试 SC 卡片预览")
		.example("bili sc 100 生成价格为 100 元的测试 SC 卡片")
		.action(async ({ session }, price = 50) => {
			const mockData = {
				senderFace: "https://i1.hdslb.com/bfs/face/aebb2639a0d47f2ce1fec0631f412eaf53d4a0be.jpg",
				senderName: "测试用户",
				masterName: "主播大人",
				masterAvatarUrl:
					"https://i1.hdslb.com/bfs/face/aebb2639a0d47f2ce1fec0631f412eaf53d4a0be.jpg",
				text: "这是一条测试醒目留言！\n感谢主播的精彩直播 (ﾉ◕ヮ◕)ﾉ*:･ﾟ✧",
				price,
			};
			const imageService = this.ctx.get("bilibili-notify-image");
			if (imageService) {
				try {
					const buf = await imageService.generateSCCard(mockData);
					await session?.send(h.image(buf, "image/jpeg"));
					return;
				} catch (e) {
					return `生成卡片失败：${e}`;
				}
			}
			return `[SC 测试] 用户「${mockData.senderName}」发送了 ¥${price} 醒目留言：${mockData.text}`;
		});

	this.ctx
		.command("bili.guard [level:number]", "生成测试上舰卡片", { hidden: true })
		.usage("生成测试上舰卡片预览，level 可选 1（舰长）/ 2（提督）/ 3（总督），默认 3")
		.example("bili guard 2 生成提督测试卡片")
		.action(async ({ session }, level = 3) => {
			const guardLevel = ([1, 2, 3].includes(level) ? level : 3) as 1 | 2 | 3;
			const guardName = { 1: "舰长", 2: "提督", 3: "总督" }[guardLevel];
			const imageService = this.ctx.get("bilibili-notify-image");
			if (imageService) {
				try {
					const buf = await imageService.generateGuardCard(
						{
							guardLevel,
							uname: "测试舰长用户",
							face: "https://i1.hdslb.com/bfs/face/aebb2639a0d47f2ce1fec0631f412eaf53d4a0be.jpg",
							isAdmin: 0,
						},
						{
							masterAvatarUrl:
								"https://i1.hdslb.com/bfs/face/aebb2639a0d47f2ce1fec0631f412eaf53d4a0be.jpg",
							masterName: "主播大人",
						},
					);
					await session?.send(h.image(buf, "image/jpeg"));
					return;
				} catch (e) {
					return `生成卡片失败：${e}`;
				}
			}
			return `[上舰测试] 用户「测试舰长用户」成为了「主播大人」的${guardName}`;
		});

	this.ctx
		.command("bili.wordcloud [uid:string]", "生成测试词云卡片", { hidden: true })
		.usage("生成测试弹幕词云卡片，可选传入 UID 以使用真实主播信息")
		.example("bili wordcloud 233 使用 UID 为 233 的主播信息生成测试词云")
		.action(async ({ session }, uid) => {
			const mockWords: Array<[string, number]> = [
				["666", 120],
				["主播", 98],
				["好看", 85],
				["牛啊", 76],
				["哈哈哈", 70],
				["关注", 65],
				["来了", 60],
				["加油", 58],
				["冲冲冲", 55],
				["弹幕", 50],
				["真棒", 48],
				["好玩", 45],
				["帅", 42],
				["厉害", 40],
				["打call", 38],
				["前排", 35],
				["感谢", 32],
				["直播", 30],
				["爱了", 28],
				["爷青回", 26],
				["支持", 25],
				["哇", 24],
				["绝了", 23],
				["yyds", 22],
				["宝", 20],
				["xdm", 19],
				["太强了", 18],
				["求关注", 17],
				["舒服", 16],
				["懂了", 15],
				["裂开", 14],
				["啊啊啊", 13],
				["破防了", 12],
				["好家伙", 11],
				["顶", 10],
				["完了", 9],
				["原来如此", 8],
				["草", 7],
				["稳", 7],
				["神", 6],
				["妙啊", 6],
				["哈", 5],
				["我的天", 5],
				["优质", 5],
				["大佬", 4],
				["逆天", 4],
				["整活", 4],
				["赞", 3],
				["牛", 3],
				["震撼", 3],
				["真实", 3],
				["没错", 2],
				["奥里给", 2],
				["冲", 2],
				["笑死", 2],
			];

			let masterName = "测试主播";
			let masterAvatarUrl: string | undefined =
				"https://i1.hdslb.com/bfs/face/aebb2639a0d47f2ce1fec0631f412eaf53d4a0be.jpg";

			if (uid) {
				const internals = this.ctx["bilibili-notify"].getInternals(BILIBILI_NOTIFY_TOKEN);
				if (internals) {
					const masterInfo = await internals.api.getMasterInfo(uid);
					if (masterInfo.code === 0) {
						masterName = masterInfo.data.info.uname;
						masterAvatarUrl = masterInfo.data.info.face;
					}
				}
			}

			const imageService = this.ctx.get("bilibili-notify-image");
			if (imageService) {
				try {
					const buf = await imageService.generateWordCloudImg(
						mockWords,
						masterName,
						masterAvatarUrl,
					);
					await session?.send(h.image(buf, "image/jpeg"));
					return;
				} catch (e) {
					return `生成词云失败：${e}`;
				}
			}
			return "[词云测试] image 插件未启用，无法生成词云图片";
		});

	this.ctx
		.command("bili.live <uid:string>", "预览直播卡片", { hidden: true })
		.usage("根据 UID 拉取真实直播间数据并预览卡片，若 image 插件未启用则显示文字信息")
		.example("bili live 233 预览 UID 为 233 的直播间卡片")
		.action(async ({ session }, uid) => {
			if (!uid) return "请提供 UID";
			const internals = this.ctx["bilibili-notify"].getInternals(BILIBILI_NOTIFY_TOKEN);
			if (!internals) return "插件尚未就绪";
			const masterInfo = await internals.api.getMasterInfo(uid);
			if (masterInfo.code !== 0) return `获取主播信息失败：${masterInfo.code}`;
			const { info, room_id, follower_num } = masterInfo.data;
			const roomInfo = await internals.api.getLiveRoomInfo(String(room_id));
			if (roomInfo.code !== 0) return `获取直播间信息失败：${roomInfo.code}`;
			const { live_status, live_time, title, area_name } = roomInfo.data;
			const imageService = this.ctx.get("bilibili-notify-image");
			if (imageService) {
				try {
					const buf = await imageService.generateLiveCard(
						roomInfo.data,
						info.uname,
						info.face,
						{ fansNum: follower_num },
						live_status,
					);
					await session?.send(h.image(buf, "image/jpeg"));
					return;
				} catch (e) {
					return `生成卡片失败：${e}`;
				}
			}
			const statusText = ["未开播", "直播中", "轮播中", "下播"][live_status] ?? "未知";
			return `[直播信息] 「${info.uname}」 ${statusText}\n标题：${title}\n分区：${area_name}\n${live_status === 1 ? `开播时间：${live_time}` : ""}`.trim();
		});
}
