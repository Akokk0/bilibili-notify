import { ImageRenderer } from "@bilibili-notify/image";
import type { Context } from "koishi";
import type {} from "koishi-plugin-puppeteer";
import type { RenderConfig } from "../config/render";
import { makeKoishiServiceContext } from "../runtime/service-context";
import { adaptPuppeteer } from "./puppeteer-adapter";

const SERVICE_NAME = "bilibili-notify-image";

/**
 * 图片渲染引擎。普通类(非 koishi Service)——由 runtime/engines.ts 在 bringUp() 内
 * 直接构造/析构,生命周期与 api/push 等核心运行时对象一致(见切片9)。
 */
class BilibiliNotifyImage {
	private readonly ctx: Context;
	readonly engine: ImageRenderer;

	constructor(ctx: Context, config: RenderConfig) {
		this.ctx = ctx;
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

	start(): void {
		this.engine.start();
		if (!this.ctx.puppeteer) {
			this.ctx.emit(
				"bilibili-notify/engine-error",
				"render",
				"未检测到 koishi-plugin-puppeteer，图片渲染已降级为纯文本",
			);
		}
	}

	stop(): void {
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
