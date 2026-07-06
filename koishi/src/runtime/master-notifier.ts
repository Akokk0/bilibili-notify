import type { BilibiliPush } from "@bilibili-notify/push";
import type { Context, Logger } from "koishi";

/**
 * 60s 节流窗口。同 sourceKey 60s 内的后续告警吞掉,避免连串错误(cron 每 2 分钟一
 * 轮、风控/网络抖动)时刷屏主人私聊。与独立端 `apps/server/src/runtime/master-
 * notifier.ts` 的 `NOTIFY_DEBOUNCE_MS` 同值,两端行为对称。
 */
const NOTIFY_DEBOUNCE_MS = 60_000;

/** 内部用的"逻辑 source"字符串。`auth` 专给 auth-lost,其余按 engine-error 的 source。 */
type SourceKey = string;

export interface MasterNotifierOptions {
	ctx: Context;
	logger: Logger;
	/**
	 * Lazy push 取值:controller 在 service `start()` 里 install,比 `bringUp()` 早,
	 * `BilibiliPush` 尚未构造;事件触发时再取最新实例。
	 */
	getPush: () => BilibiliPush | null;
}

/**
 * koishi 端的 master 私聊聚合器。同时观察两个事件源:
 *   - `bilibili-notify/engine-error(source, message)`:业务 engine 报告的运行时错误
 *   - `bilibili-notify/auth-lost()`:登录态失效(sourceKey 固定 "auth")
 *
 * 两个事件**独立订阅**,共用一张以"逻辑 source"为 key 的节流表 —— 同 source 60s
 * 内合并为一条,不同 source 各自独立放行。与独立端 `apps/server/src/runtime/
 * master-notifier.ts` 设计对齐。
 */
export class MasterNotifier {
	private readonly opts: MasterNotifierOptions;
	private readonly lastNotifiedBySource = new Map<SourceKey, number>();
	/**
	 * ctx.on release 函数集合。dispose() 时统一调用 —— 跟齐独立端 `MasterNotifier`
	 * 的 handles[] 模式,也契合 `lifecycle.ts:34` 注释强调的"listener release 必须
	 * 入显式清理"约定(当前 Service 整体 dispose 时 selfCtx 已自动卸,不会泄漏;
	 * 显式 dispose 是对称性 + 防御未来 controller 生命周期改动)。
	 */
	private readonly releases: Array<() => void> = [];

	constructor(opts: MasterNotifierOptions) {
		this.opts = opts;
	}

	install(): void {
		this.releases.push(
			this.opts.ctx.on("bilibili-notify/engine-error", (source, message) => {
				// 每条 engine-error 都先落 warn(不节流) —— 主人 push 未配置 / sendPrivateMsg
				// no-op 时,日志是唯一可观测通道,丢日志=运行时错误对运维彻底静默。DM 仍
				// 走 notify() 的 per-source 60s 节流避免刷屏。
				this.opts.logger.warn(`[${source}] ${message}`);
				void this.notify(source, `[${source}] ${message}`);
			}),
		);
		this.releases.push(
			this.opts.ctx.on("bilibili-notify/auth-lost", () => {
				void this.notify("auth", "账号登录已失效，请到控制台重新扫码登录");
			}),
		);
	}

	dispose(): void {
		while (this.releases.length > 0) this.releases.pop()?.();
	}

	private async notify(sourceKey: SourceKey, text: string): Promise<void> {
		const now = Date.now();
		const last = this.lastNotifiedBySource.get(sourceKey) ?? 0;
		if (now - last < NOTIFY_DEBOUNCE_MS) return;
		this.lastNotifiedBySource.set(sourceKey, now);
		try {
			await this.opts.getPush()?.sendPrivateMsg(text);
		} catch (e) {
			this.opts.logger.warn(`[master-notifier] 私信失败 source=${sourceKey}：${String(e)}`);
		}
	}
}
