import { ImageRenderer } from "@bilibili-notify/image";
import { makeKoishiServiceContext } from "@bilibili-notify/koishi-runtime";
import { type Context, Service } from "koishi";
import type {} from "koishi-plugin-puppeteer";
import type { RenderConfig } from "../config/render";
import { adaptPuppeteer } from "./puppeteer-adapter";

declare module "koishi" {
	interface Context {
		"bilibili-notify-image": BilibiliNotifyImage;
	}
}

const SERVICE_NAME = "bilibili-notify-image";

class BilibiliNotifyImage extends Service<RenderConfig> {
	static readonly [Service.provide] = SERVICE_NAME;
	static inject = { puppeteer: { required: false } };

	readonly engine: ImageRenderer;

	constructor(ctx: Context, config: RenderConfig) {
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
				showPopularity: config.showPopularity,
				showArea: config.showArea,
				showFans: config.showFans,
			},
		});
	}

	protected start() {
		this.engine.start();
		if (!this.ctx.puppeteer) {
			this.ctx.emit(
				"bilibili-notify/engine-error",
				"render",
				"未检测到 koishi-plugin-puppeteer，图片渲染已降级为纯文本",
			);
		}
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
