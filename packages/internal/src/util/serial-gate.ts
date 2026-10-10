/**
 * 渲染串行闸 —— 一把 FIFO 互斥锁,外加一条低优先级车道。`acquire()` 等上一把锁释放后
 * 才 resolve,返回一个 `release` 函数;调用方在 try/finally 里 release。任意时刻只有
 * 一个临界区在跑。
 *
 * 用途:puppeteer 浏览器冷启动后,多张卡片并发渲染(newPage→setContent→截图)会在刚
 * 启动的浏览器上触发 CDP 截图竞态 —— deviceScaleFactor / captureScreenshot 尚未稳定就
 * 截图,clip 被按错误倍率处理,同一张卡被平铺成 2×2 并裁切(用户报告的「全家福动态
 * 发布第一次启动就 4 连图」)。热启动后并发无碍,但首批请求恰好命中冷启动窗口。把所有
 * 渲染串起来即可彻底消除竞态;卡片渲染量小、非延迟敏感,串行的吞吐代价可接受。
 *
 * **两条车道**:推送卡(开播 / 动态)走正常车道;群里谁都能触发的链接卡走低优先级
 * 车道 —— 只要正常车道里还有人在等,低优先级就不动。这条规矩放在闸上而不是放在
 * 链接解析那边数自己发了几张:数自己的计数器看不见队列里已经堆着的推送卡,「同时
 * 只处理三张」在队列 20 深的时候照样把开播卡挤到后面。低优先级可能一直等(被饿着),
 * 这是刻意的:它的调用方自己有上限并且会放弃,推送卡没有。
 *
 * 放在 internal 而不是 server:`ImageRenderer` 自己也有一条串行队列,优先级得在**每一级**
 * FIFO 上都生效,否则低优先级的渲染在渲染器那级就已经排到推送卡前面了。同一个原语,两级共用。
 */

export type SerialPriority = "normal" | "low";

export interface SerialAcquireOptions {
	/** 缺省 `normal`。`low` = 正常车道排空之前不放行。 */
	priority?: SerialPriority;
}

export interface SerialGate {
	/** 排队进临界区。resolve 出来的是 release,调用方在 try/finally 里调。 */
	acquire(options?: SerialAcquireOptions): Promise<() => void>;
	/**
	 * 经闸跑一件异步活:`acquire` + `try/finally release`。经它发起的活**按发起次序一个接一个跑**,
	 * 送达次序 = 发起次序;失败不断链 —— 排在后面的照常跑,异常原样抛回它自己的发起方
	 * (`fn` 同步抛错同样只变成这一个的 reject)。
	 *
	 * 直播推送与拓展作品 / 拓展直播用它防倒序:主播下播后几秒内重开,下播流程与新场开播流程是两个
	 * 互不排队的异步上下文,各自渲染 + 发送 —— 开播卡跑得快就先送达,接收端看到「开播 → 下播」。
	 * 同一个房间 / 同一条订阅过同一个闸;不同房间 / 订阅各开各的,互不排队。
	 */
	run<T>(fn: () => Promise<T>, options?: SerialAcquireOptions): Promise<T>;
	/**
	 * 还在排队等着的数量(两条车道加起来),**不含正在跑的那个**。
	 *
	 * 独立端的 `/status` 拿它回答「是不是卡住了」—— 一个正在渲染是正常状态,
	 * 后面堆着一串才是积压。
	 */
	waiting(): number;
}

export function createSerialGate(): SerialGate {
	let busy = false;
	const normal: (() => void)[] = [];
	const low: (() => void)[] = [];

	// 只在这里挑下一个:锁空着且有人在等才放行,正常车道永远先于低优先级。
	const pump = (): void => {
		if (busy) return;
		const next = normal.shift() ?? low.shift();
		if (!next) return;
		busy = true;
		next();
	};

	const acquire = (options?: SerialAcquireOptions): Promise<() => void> => {
		const lane = options?.priority === "low" ? low : normal;
		return new Promise<() => void>((resolve) => {
			lane.push(() => {
				let released = false;
				resolve(() => {
					if (released) return; // 幂等:重复 release 无副作用
					released = true;
					busy = false;
					pump();
				});
			});
			pump();
		});
	};

	return {
		waiting: () => normal.length + low.length,
		acquire,
		run(fn, options) {
			let release: () => void = () => undefined;
			const result = acquire(options).then((r) => {
				release = r;
				return fn();
			});
			// 成败都放(失败不断链)。放锁挂在发起方的处理之前,但下一个活要多过一轮微任务才开跑,
			// 所以它不会抢在上一个活的结果 / 异常交回发起方之前动手。
			result.then(
				() => release(),
				() => release(),
			);
			return result;
		},
	};
}
