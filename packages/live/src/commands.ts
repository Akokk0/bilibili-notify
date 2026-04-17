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
