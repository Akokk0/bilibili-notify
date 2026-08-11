/**
 * 全局静音 —— 「安静一会儿,到点自己恢复」。
 *
 * ## 读时判定,不用定时器
 *
 * 到期**不是一个会发生的事件**,只是同一个比较的结果变了。所以这里存的是「静音到
 * 哪一刻」,每次问的时候现算 `now < until`。
 *
 * 定时器方案要额外扛三件事,而这三件在这个部署里都不是假想:
 *
 * - **重启** —— 容器一重启 `setTimeout` 就没了。要么静音永远解不掉,要么得在启动时
 *   重建一套恢复逻辑(而那套逻辑只有真重启过才验得到)。
 * - **时钟跳变** —— 定时器按相对时间走,系统时间被调整后到期时刻就飘了。
 * - **dispose 时序** —— 又一个要记得清理的句柄。
 *
 * 读时判定对以上三件全部免疫,代价是零。
 *
 * ## 静音挡的是什么
 *
 * 挡**订阅推送**(动态 / 直播 / SC / 上舰 / 词云 / 总结 / 下播),闸在
 * `BilibiliPush.broadcastToFeature`。
 *
 * **不挡**发给主人的私聊 —— 运行错误告警、还有指令回复本身。否则主人敲下 `/mute`
 * 之后连「好的,静音到几点」这句都收不到,他只会以为指令坏了。
 */

export interface MuteStateOptions {
	/**
	 * 读当前存着的到期时刻(epoch ms)。`0` = 没在静音。
	 *
	 * 每次都现读而不是构造时快照:独立端把它存在 globals 里,网页上也能改。
	 */
	read: () => number;
	/** 写回到期时刻。持久化归调用方(独立端落 globals.json,所以重启不丢)。 */
	write: (until: number) => Promise<void>;
	/** 可注入的时钟。测试用,生产不传。 */
	now?: () => number;
}

export interface MuteState {
	/** 此刻是否静音。 */
	isMuted(): boolean;
	/** 静音到哪一刻(epoch ms)。`0` = 没在静音。 */
	mutedUntil(): number;
	/**
	 * 静音 `ms` 毫秒,从现在算起。**以最后一次为准**,不取 max ——
	 * 主人敲「静音 10 分钟」就是想把之前那 3 小时缩短,取 max 会让他以为指令没生效。
	 *
	 * `ms <= 0` 即解除。读时判定下 `until = now` 天然就不静音了,所以「解除」不需要
	 * 单开一条路径;存回 `0` 只是为了让盘上那个值一眼可读。
	 *
	 * @returns 新的到期时刻(`0` = 已解除),调用方拿去拼回复。
	 */
	muteFor(ms: number): Promise<number>;
}

export function createMuteState(opts: MuteStateOptions): MuteState {
	const now = opts.now ?? Date.now;

	function mutedUntil(): number {
		return opts.read();
	}

	return {
		mutedUntil,
		// 严格小于:到期那一刻算已恢复。差一个等号就是「说好 3 点恢复,3 点整那条推送
		// 还是被吞了」—— 偶发一毫秒,现场根本抓不到。
		isMuted: () => now() < mutedUntil(),
		async muteFor(ms) {
			const until = ms > 0 ? now() + ms : 0;
			await opts.write(until);
			return until;
		},
	};
}
