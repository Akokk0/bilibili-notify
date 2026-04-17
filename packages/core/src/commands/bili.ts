import { BILIBILI_NOTIFY_TOKEN } from "@bilibili-notify/internal";
import { h } from "koishi";
import type BilibiliNotifyServerManager from "../server-manager";

export function biliCommands(this: BilibiliNotifyServerManager): void {
	const biliCom = this.ctx.command("bili", "bili-notify 插件相关指令", {
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

	biliCom
		.subcommand(".sc [price:number]", "生成测试 SC 卡片", { hidden: true })
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

	biliCom
		.subcommand(".guard [level:number]", "生成测试上舰卡片", { hidden: true })
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

	biliCom
		.subcommand(".live <uid:string>", "预览直播卡片", { hidden: true })
		.usage("根据 UID 拉取真实直播间数据并预览卡片，若 image 插件未启用则显示文字信息")
		.example("bili live 233 预览 UID 为 233 的直播间卡片")
		.action(async ({ session }, uid) => {
			if (!uid) return "请提供 UID";
			const internals = this.getInternals(BILIBILI_NOTIFY_TOKEN);
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

	biliCom
		.subcommand(".dyn <uid:string> [index:number]", "手动推送一条动态信息", { hidden: true })
		.usage("手动推送一条动态信息，若 image 插件已启用则直接预览卡片图片")
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

			const imageService = this.ctx.get("bilibili-notify-image");
			if (imageService) {
				try {
					const buf = await imageService.generateDynamicCard(item);
					await session?.send(h.image(buf, "image/jpeg"));
					return;
				} catch (e) {
					return `生成卡片失败：${e}`;
				}
			}

			const dynService = this.ctx.get("bilibili-notify-dynamic");
			if (dynService?.pushOneDynamic) {
				await dynService.pushOneDynamic(item, uid);
				return;
			}
			await session?.send(`动态 ID: ${item.id_str ?? item.id ?? "未知"}`);
		});
}
