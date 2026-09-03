import type { Disposable, Logger, MessageBus } from "@bilibili-notify/internal";
import type { BilibiliPush } from "@bilibili-notify/push";

/**
 * 60s 节流窗口。同一 sourceKey 上次告警之后 60s 内的后续告警吞掉，避免连串错误
 * (cron 每 2 分钟一轮、风控/网络抖动连续触发) 时刷屏 OneBot 私信。
 */
const NOTIFY_DEBOUNCE_MS = 60_000;

/** master-notifier 内部用的"逻辑 source"字符串。专门用 `auth` 区分 auth-lost。 */
type SourceKey = string;

export interface MasterNotifierOptions {
	bus: MessageBus;
	push: BilibiliPush;
	logger: Logger;
}

/**
 * standalone 端的 master 私聊聚合器。同时观察两个事件源：
 *   - `engine-error(source, message)`：业务 engine 报告的运行时错误
 *   - `auth-lost()`：登录态失效（独立 sourceKey="auth"）
 *
 * 两个事件**独立订阅**，但共用一张以"逻辑 source"为 key 的节流表。Per-source
 * 60s 防抖：同 source 60s 内重复告警合并为一条；不同 source 各自独立放行。
 *
 * 设计取舍参考 plan §"engine-error 与 auth-lost"对齐讨论 —— 事件本身保持各自
 * 纯粹语义，master-notifier 是消费端的聚合内部实现细节，sourceKey 命名空间
 * 与 BiliEvents 事件名无耦合。
 */
export class MasterNotifier {
	private readonly opts: MasterNotifierOptions;
	private readonly lastNotifiedBySource = new Map<SourceKey, number>();
	private readonly handles: Disposable[] = [];

	constructor(opts: MasterNotifierOptions) {
		this.opts = opts;
	}

	install(): void {
		this.handles.push(
			this.opts.bus.on("engine-error", (source, message) => {
				// 每条 engine-error 都先落 warn(不节流) —— 主人 push 未配置 / send
				// PrivateMsg no-op 时,日志是唯一可观测通道,丢日志=运行时错误对运维
				// 彻底静默。DM 仍走 notify() 的 per-source 60s 节流避免刷屏。两端对称。
				this.opts.logger.warn(`[${source}] ${message}`);
				void this.notify(source, `[${source}] ${message}`);
			}),
		);
		this.handles.push(
			this.opts.bus.on("auth-lost", () => {
				void this.notify("auth", "账号登录已失效，请到控制台重新扫码登录");
			}),
		);
	}

	dispose(): void {
		while (this.handles.length > 0) this.handles.pop()?.dispose();
	}

	private async notify(sourceKey: SourceKey, text: string): Promise<void> {
		const now = Date.now();
		const last = this.lastNotifiedBySource.get(sourceKey) ?? 0;
		if (now - last < NOTIFY_DEBOUNCE_MS) return;
		this.lastNotifiedBySource.set(sourceKey, now);
		try {
			await this.opts.push.sendPrivateMsg(text);
		} catch (e) {
			this.opts.logger.warn(`[master-notifier] 私信失败 source=${sourceKey}：${String(e)}`);
		}
	}
}
