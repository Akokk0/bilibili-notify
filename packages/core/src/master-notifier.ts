import type { Context, Logger } from "koishi";

export interface MasterNotifierOptions {
	ctx: Context;
	logger: Logger;
}

/**
 * Listener for `bilibili-notify/plugin-error`. Today this is a thin warn-level log
 * forwarder so sub-plugins can surface their own errors without hard-coupling to
 * the koishi `ctx.logger` namespace. Future work in Stage 2 will extend this to
 * relay to the master account and to a `Notifier` console widget.
 */
export class MasterNotifier {
	private readonly opts: MasterNotifierOptions;

	constructor(opts: MasterNotifierOptions) {
		this.opts = opts;
	}

	install(): void {
		this.opts.ctx.on("bilibili-notify/plugin-error", (source, message) => {
			this.opts.logger.warn(`[${source}] ${message}`);
		});
	}
}
