// biome-ignore lint/correctness/noUnusedImports: module augmentation
import {} from "@koishijs/plugin-notifier";
import { type Bot, type Context, h, type Logger, Universal } from "koishi";
import { type MasterConfig, PUSH_TYPE_LABEL, type PushArrMap, PushType } from "./types";

const INITIAL_RETRY_DELAY_MS = 3000;
const MAX_RETRY_DELAY_MS = INITIAL_RETRY_DELAY_MS * 2 ** 5;
const SEND_THROTTLE_MS = 500;

export interface BilibiliPushConfig {
	logLevel: number;
	master: MasterConfig;
}

export class BilibiliPush {
	readonly logger: Logger;
	private readonly ctx: Context;
	private readonly config: BilibiliPushConfig;
	private disposed = false;

	/** Set by core after subscriptions are loaded */
	pushArrMap: PushArrMap = new Map();
	pushArrMapReady = false;

	constructor(ctx: Context, config: BilibiliPushConfig) {
		this.ctx = ctx;
		this.config = config;
		this.logger = ctx.logger("bilibili-notify-push");
		this.logger.level = config.logLevel;
	}

	start(): void {
		this.disposed = false;
		if (this.config.master.enable && !this.getBot(this.config.master.platform)) {
			this.ctx.notifier?.create({
				content: "未找到管理员平台机器人，无法推送运行状态，请尽快配置",
			});
		}
	}

	stop(): void {
		this.disposed = true;
	}

	// ---- Bot helpers ----

	// biome-ignore lint/suspicious/noExplicitAny: Bot generic context compatibility
	getBot(platform: string, selfId?: string): Bot<any> | undefined {
		return this.ctx.bots.find(
			(b) => b.platform === platform && (!selfId || selfId === "" || b.selfId === selfId),
		);
	}

	// ---- Private message to admin ----

	async sendPrivateMsg(content: string): Promise<void> {
		const cfg = (this.config as BilibiliPushConfig).master;
		if (!cfg.enable) return;

		const bot = this.ctx.bots.find((b) => b.platform === cfg.platform) ?? this.getBot(cfg.platform);
		if (!bot) {
			this.logger.warn("[push] 未找到管理员机器人实例，暂时无法推送");
			return;
		}
		if (bot.status !== Universal.Status.ONLINE) {
			this.logger.warn(`[push] ${bot.platform} 机器人未在线，暂时无法推送私信`);
			return;
		}

		if (cfg.masterAccountGuildId) {
			await bot.sendPrivateMessage(cfg.masterAccount, content, cfg.masterAccountGuildId);
		} else {
			await bot.sendPrivateMessage(cfg.masterAccount, content);
		}
	}

	async sendErrorMsg(reason: string): Promise<void> {
		this.logger.error(`[push] ${reason}`);
		await this.sendPrivateMsg(reason);
	}

	// ---- Broadcast ----

	async broadcastToTargets(
		uid: string,
		// biome-ignore lint/suspicious/noExplicitAny: Koishi h() element
		content: any,
		type: PushType,
	): Promise<void> {
		if (this.disposed) return;

		if (!this.pushArrMapReady) {
			this.logger.warn(
				`[push] 推送对象信息尚未初始化，等待5秒后重试 (uid=${uid}, type=${PUSH_TYPE_LABEL[type]})`,
			);
			await this.sleep(5000);
			if (this.disposed) return;
			return this.broadcastToTargets(uid, content, type);
		}

		const record = this.pushArrMap.get(uid);
		if (!record) return;

		const label = `推送对象: ${uid}, 推送类型: ${PUSH_TYPE_LABEL[type]}`;
		switch (type) {
			case PushType.StartBroadcasting:
				await this.pushToArr(record.liveAtAllArr, h.at("all"));
				await this.pushToArr(record.liveArr, h("message", content), label);
				break;

			case PushType.Live:
				await this.pushToArr(record.liveArr, h("message", content), label);
				break;

			case PushType.Dynamic:
				await this.pushToArr(record.dynamicAtAllArr, h.at("all"));
				await this.pushToArr(record.dynamicArr, h("message", content), label);
				break;

			case PushType.LiveGuardBuy:
				await this.pushToArr(record.liveGuardBuyArr, h("message", content), label);
				break;

			case PushType.Superchat:
				await this.pushToArr(record.superchatArr, h("message", content), label);
				break;

			case PushType.WordCloudAndLiveSummary: {
				// content is [wordcloudMsg, liveSummaryMsg]
				const [wcMsg, summaryMsg] = content as [unknown, unknown];
				const wcArr = record.wordcloudArr ?? [];
				const sumArr = record.liveSummaryArr ?? [];
				const both = wcArr.filter((x) => sumArr.includes(x));
				const wcOnly = wcArr.filter((x) => !sumArr.includes(x));
				const sumOnly = sumArr.filter((x) => !wcArr.includes(x));

				// biome-ignore lint/suspicious/noExplicitAny: content items are Koishi h() elements
				const bothMsgs = [wcMsg, summaryMsg].filter(Boolean) as any[];
				await this.pushToArr(bothMsgs.length > 0 ? both : [], h("message", bothMsgs), label);
				// biome-ignore lint/suspicious/noExplicitAny: content items are Koishi h() elements
				await this.pushToArr(wcMsg ? wcOnly : [], h("message", wcMsg as any), label);
				// biome-ignore lint/suspicious/noExplicitAny: content items are Koishi h() elements
				await this.pushToArr(summaryMsg ? sumOnly : [], h("message", summaryMsg as any), label);
				break;
			}

			case PushType.UserDanmakuMsg:
				await this.pushToArr(record.specialDanmakuArr, h("message", content), label);
				break;

			case PushType.UserActions:
				await this.pushToArr(record.specialUserEnterTheRoomArr, h("message", content), label);
				break;
		}
	}

	/** 仅在数组非空时推送，减少调用方的重复判断 */
	// biome-ignore lint/suspicious/noExplicitAny: Koishi message content
	private async pushToArr(arr: string[] | undefined, content: any, label?: string): Promise<void> {
		if (arr?.length) {
			if (label) this.logger.info(`[push] ${label}`);
			await this.push(arr, content);
		} else if (label) {
			this.logger.debug(`[push] ${label} — 目标数组为空，跳过`);
		}
	}

	// ---- Low-level message sender ----

	// biome-ignore lint/suspicious/noExplicitAny: Koishi message content
	private async push(targets: string[], content: any): Promise<void> {
		// Group targets by platform
		const byPlatform: Record<string, string[]> = {};
		for (const target of targets) {
			const [platform, channelId] = target.split(":");
			if (!byPlatform[platform]) byPlatform[platform] = [];
			byPlatform[platform].push(channelId);
		}

		for (const [platform, channelIds] of Object.entries(byPlatform)) {
			const bots = this.ctx.bots.filter((b) => b.platform === platform);
			let sent = 0;

			for (const channelId of channelIds) {
				await this.sendWithRetry(bots, channelId, content, 0, INITIAL_RETRY_DELAY_MS);
				sent++;
			}
			this.logger.info(`[push] 成功推送 ${sent} 条消息到 ${platform}`);
		}
	}

	private async sendWithRetry(
		// biome-ignore lint/suspicious/noExplicitAny: Bot generic context compatibility
		bots: Bot<any>[],
		channelId: string,
		// biome-ignore lint/suspicious/noExplicitAny: Koishi message content
		content: any,
		botIndex: number,
		delay: number,
	): Promise<void> {
		if (this.disposed) return;

		const bot = bots[botIndex];
		if (!bot) {
			this.logger.warn(`[push] 没有可用机器人来推送到 ${channelId}`);
			return;
		}

		if (bot.status !== Universal.Status.ONLINE) {
			if (delay >= MAX_RETRY_DELAY_MS) {
				this.logger.error(`[push] 机器人未在线，已重试5次，放弃推送到 ${channelId}`);
				await this.sendPrivateMsg(`机器人未在线，放弃推送到 ${channelId}`);
				return;
			}
			this.logger.warn(`[push] 机器人未在线，${delay / 1000}秒后重试`);
			await this.sleep(delay);
			return this.sendWithRetry(bots, channelId, content, botIndex, delay * 2);
		}

		try {
			await bot.sendMessage(channelId, content);
			await this.sleep(SEND_THROTTLE_MS);
		} catch (e) {
			if (this.disposed) return;
			const err = e as Error;

			if (err.message === "this._request is not a function") {
				if (delay < MAX_RETRY_DELAY_MS) {
					this.logger.warn(`[push] 机器人 _request 不可用，${delay / 1000}秒后重试`);
					await this.sleep(delay);
					// Refresh bot reference
					const freshBots = this.ctx.bots.filter((b) => b.platform === bot.platform);
					return this.sendWithRetry(freshBots, channelId, content, 0, delay * 2);
				}
				this.logger.error(`[push] 机器人 _request 持续不可用，放弃推送到 ${channelId}`);
				return;
			}

			this.logger.error(`[push] 发送到 ${channelId} 失败: ${err.message}`);
			// Try next bot
			if (botIndex + 1 < bots.length) {
				return this.sendWithRetry(bots, channelId, content, botIndex + 1, delay);
			}
		}
	}

	private sleep(ms: number): Promise<void> {
		if (this.disposed) return Promise.resolve();
		return new Promise((resolve) => setTimeout(resolve, ms));
	}
}
