// biome-ignore lint/correctness/noUnusedImports: module augmentation
import {} from "@koishijs/plugin-notifier";
import { type Bot, type Context, h, type Logger, Universal } from "koishi";
import { type MasterConfig, PUSH_TYPE_LABEL, type PushArrMap, PushType } from "./types";

const INITIAL_RETRY_DELAY_MS = 3000;
const MAX_RETRY_DELAY_MS = INITIAL_RETRY_DELAY_MS * 2 ** 5;
const SEND_THROTTLE_MS = 500;
const MAX_PUSH_MAP_WAIT_ATTEMPTS = 12; // 12 * 5s = 60s total

/** Treat as a transient transport-layer failure that warrants refreshing the Bot reference. */
function isTransportError(err: Error): boolean {
	const msg = err.message ?? "";
	return (
		msg.includes("_request is not a function") ||
		msg.includes("request is not a function") ||
		msg.includes("ECONNRESET") ||
		msg.includes("socket hang up")
	);
}

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
		const master = this.config.master;
		if (master.enable && master.platform && !this.getBot(master.platform)) {
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
		const cfg = this.config.master;
		if (!cfg.enable) return;
		if (!cfg.platform || !cfg.masterAccount) {
			this.logger.warn("[push] master 已启用但缺少 platform / masterAccount，跳过推送");
			return;
		}

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

		// Wait for pushArrMap to be initialized, capped to avoid an infinite loop
		// when the core plugin is misconfigured or never finishes loading subs.
		let waitedAttempts = 0;
		while (!this.pushArrMapReady) {
			if (waitedAttempts >= MAX_PUSH_MAP_WAIT_ATTEMPTS) {
				this.logger.error(
					`[push] 推送对象信息超过 ${MAX_PUSH_MAP_WAIT_ATTEMPTS * 5}s 仍未初始化，放弃推送 (uid=${uid}, type=${PUSH_TYPE_LABEL[type]})`,
				);
				return;
			}
			this.logger.warn(
				`[push] 推送对象信息尚未初始化，等待5秒后重试 (uid=${uid}, type=${PUSH_TYPE_LABEL[type]}, attempt=${waitedAttempts + 1}/${MAX_PUSH_MAP_WAIT_ATTEMPTS})`,
			);
			await this.sleep(5000);
			if (this.disposed) return;
			waitedAttempts++;
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
			let succeeded = 0;
			let failed = 0;

			for (const channelId of channelIds) {
				const ok = await this.sendOnceWithRetry(platform, channelId, content);
				if (ok) succeeded++;
				else failed++;
			}
			if (failed === 0) {
				this.logger.info(`[push] 成功推送 ${succeeded} 条消息到 ${platform}`);
			} else {
				this.logger.warn(`[push] 推送到 ${platform} 完成：成功 ${succeeded} 条，失败 ${failed} 条`);
			}
		}
	}

	/**
	 * 推送单条消息到指定 channel，失败时在多 bot 之间轮转 + 指数退避重试。
	 * 返回 true 表示成功，false 表示放弃。
	 */
	private async sendOnceWithRetry(
		platform: string,
		channelId: string,
		// biome-ignore lint/suspicious/noExplicitAny: Koishi message content
		content: any,
	): Promise<boolean> {
		if (this.disposed) return false;

		let delay = INITIAL_RETRY_DELAY_MS;
		// 抽取在线 bot 时刷新引用，覆盖 bot 重连/替换的场景
		const triedBotIds = new Set<string>();

		while (!this.disposed) {
			const bots = this.ctx.bots.filter((b) => b.platform === platform);
			if (bots.length === 0) {
				this.logger.warn(`[push] 平台 ${platform} 当前没有可用机器人，跳过 ${channelId}`);
				return false;
			}

			// 优先选还没试过的在线 bot
			const onlineBot = bots.find(
				(b) => b.status === Universal.Status.ONLINE && !triedBotIds.has(b.selfId),
			);

			if (!onlineBot) {
				if (delay > MAX_RETRY_DELAY_MS) {
					this.logger.error(
						`[push] 平台 ${platform} 所有机器人均不可用（已尝试 ${triedBotIds.size} 个），放弃推送到 ${channelId}`,
					);
					await this.sendPrivateMsg(`机器人持续不可用，放弃推送到 ${channelId}`);
					return false;
				}
				this.logger.warn(
					`[push] 平台 ${platform} 暂无可用在线机器人，${delay / 1000}s 后重试 ${channelId}`,
				);
				await this.sleep(delay);
				if (this.disposed) return false;
				delay *= 2;
				triedBotIds.clear(); // 等待后重新尝试所有 bot
				continue;
			}

			triedBotIds.add(onlineBot.selfId);
			try {
				await onlineBot.sendMessage(channelId, content);
				await this.sleep(SEND_THROTTLE_MS);
				return true;
			} catch (e) {
				if (this.disposed) return false;
				const err = e as Error;

				if (isTransportError(err)) {
					this.logger.warn(
						`[push] 机器人 ${onlineBot.selfId} transport 不可用（${err.message}），换 bot 重试 ${channelId}`,
					);
					// 不计入 triedBotIds：重新刷新 bot 列表后再选其他在线 bot
					triedBotIds.delete(onlineBot.selfId);
					continue;
				}

				this.logger.error(
					`[push] 机器人 ${onlineBot.selfId} 发送到 ${channelId} 失败: ${err.message}`,
				);
				// 其他错误：换下一个 bot；该 bot 已记入 triedBotIds 不再选中
			}
		}
		return false;
	}

	private sleep(ms: number): Promise<void> {
		if (this.disposed) return Promise.resolve();
		return new Promise((resolve) => setTimeout(resolve, ms));
	}
}
