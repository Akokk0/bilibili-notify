import { BILIBILI_NOTIFY_TOKEN } from "@bilibili-notify/internal";
import type {} from "@koishijs/plugin-help";
import { h } from "koishi";
import type { BilibiliNotifyDynamic } from "./dynamic-service";

export function dynamicCommands(this: BilibiliNotifyDynamic): void {
	this.ctx
		.command("bili.dyn <uid:string> [index:number]", "手动推送一条动态信息", { hidden: true })
		.usage("手动推送一条动态信息，若 image 插件已启用则直接预览卡片图片")
		.example("bili dyn 233 1 手动推送UID为233用户空间的第一条动态信息")
		.action(async ({ session }, uid, index) => {
			if (!uid) return "请提供 UID";
			const internals = this.ctx["bilibili-notify"].getInternals(BILIBILI_NOTIFY_TOKEN);
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

			await session?.send(`动态 ID: ${item.id_str ?? item.id ?? "未知"}`);
		});
}
