import { ImageRenderer, type PuppeteerLike } from "@bilibili-notify/image";
import { makeKoishiServiceContext } from "@bilibili-notify/koishi-runtime";
import { type Context, Service } from "koishi";
import type {} from "koishi-plugin-puppeteer";
import type { BilibiliNotifyImageConfig } from "./config";

declare module "koishi" {
	interface Context {
		"bilibili-notify-image": BilibiliNotifyImage;
	}
}

const SERVICE_NAME = "bilibili-notify-image";

/**
 * koishi-plugin-puppeteer 的 `ctx.puppeteer.page()` 返回的 Page 与 image-engine
 * 的 PuppeteerLike.PageLike 结构等价（setContent / waitForFunction / $ /
 * screenshot / close 全部存在且签名相容）。这里只做一次类型擦除。
 */
function adaptPuppeteer(ctx: Context): PuppeteerLike {
	return {
		async page() {
			const page = await ctx.puppeteer.page();
			return page as unknown as Awaited<ReturnType<PuppeteerLike["page"]>>;
		},
	};
}

class BilibiliNotifyImage extends Service<BilibiliNotifyImageConfig> {
	static inject = ["puppeteer"];

	readonly engine: ImageRenderer;

	constructor(ctx: Context, config: BilibiliNotifyImageConfig) {
		super(ctx, SERVICE_NAME);
		this.config = config;
		const serviceCtx = makeKoishiServiceContext(ctx, SERVICE_NAME, config.logLevel);
		this.engine = new ImageRenderer({
			serviceCtx,
			puppeteer: adaptPuppeteer(ctx),
			config: {
				cardColorStart: config.cardColorStart,
				cardColorEnd: config.cardColorEnd,
				font: config.font,
				hideDesc: config.hideDesc,
				// koishi plugin config 用 hideFollower(隐藏=true)对齐 hideDesc 命名;
				// ImageRenderer 公共 API 保留正向 followerDisplay,这里取反传。
				followerDisplay: !config.hideFollower,
			},
		});
	}

	protected start() {
		this.engine.start();
	}

	protected stop() {
		this.engine.stop();
	}

	// ── 代理至 engine（保留原始 Service 公共 API） ───────────────────────────

	numberToStr(num: number) {
		return this.engine.numberToStr(num);
	}

	unixTimestampToString(ts: number) {
		return this.engine.unixTimestampToString(ts);
	}

	getTimeDifference(dateString: string) {
		return this.engine.getTimeDifference(dateString);
	}

	getLiveStatus(time: string, liveStatus: number) {
		return this.engine.getLiveStatus(time, liveStatus);
	}

	generateLiveCard(
		// biome-ignore lint/suspicious/noExplicitAny: Bilibili 直播 API 返回类型
		data: any,
		username: string,
		userface: string,
		liveData: Parameters<ImageRenderer["generateLiveCard"]>[3],
		liveStatus: number,
		colorOptions?: Parameters<ImageRenderer["generateLiveCard"]>[5],
	) {
		return this.engine.generateLiveCard(
			data,
			username,
			userface,
			liveData,
			liveStatus,
			colorOptions,
		);
	}

	generateGuardCard(
		body: Parameters<ImageRenderer["generateGuardCard"]>[0],
		master: Parameters<ImageRenderer["generateGuardCard"]>[1],
	) {
		return this.engine.generateGuardCard(body, master);
	}

	generateSCCard(opts: Parameters<ImageRenderer["generateSCCard"]>[0]) {
		return this.engine.generateSCCard(opts);
	}

	generateDynamicCard(
		data: Parameters<ImageRenderer["generateDynamicCard"]>[0],
		colorOptions?: Parameters<ImageRenderer["generateDynamicCard"]>[1],
	) {
		return this.engine.generateDynamicCard(data, colorOptions);
	}

	generateWordCloudImg(
		words: Array<[string, number]>,
		masterName: string,
		masterAvatarUrl?: string,
	) {
		return this.engine.generateWordCloudImg(words, masterName, masterAvatarUrl);
	}
}

export default BilibiliNotifyImage;
export { BilibiliNotifyImage };
