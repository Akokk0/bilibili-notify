import type { PuppeteerLike } from "@bilibili-notify/image";
import type { Context } from "koishi";
import type {} from "koishi-plugin-puppeteer";

/**
 * puppeteer 是可选依赖(顶层插件 `inject.optional` 里声明,见 `../index.ts`):没装时
 * render 仍然照常构造,只是 `page()` 现取 `ctx.puppeteer` 每次都判一遍——没装就抛错,
 * 被下游 generateXxx 调用点的既有 try/catch(packages/live room-helpers/room-session)
 * 接住,自然退化成纯文字。puppeteer 之后再装上也无需重启,下次调用自动生效。
 */
export function adaptPuppeteer(ctx: Context): PuppeteerLike {
	return {
		async page() {
			if (!ctx.puppeteer) {
				throw new Error("koishi-plugin-puppeteer 未安装或未启用，图片渲染不可用");
			}
			const page = await ctx.puppeteer.page();
			return page as unknown as Awaited<ReturnType<PuppeteerLike["page"]>>;
		},
	};
}
