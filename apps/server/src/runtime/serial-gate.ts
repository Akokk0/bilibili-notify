/**
 * 渲染串行闸 —— 一把 FIFO 互斥锁。`acquire()` 等上一把锁释放后才 resolve,返回一个
 * `release` 函数;调用方在 try/finally 里 release。任意时刻只有一个临界区在跑。
 *
 * 用途:puppeteer 浏览器冷启动后,多张卡片并发渲染(newPage→setContent→截图)会在刚
 * 启动的浏览器上触发 CDP 截图竞态 —— deviceScaleFactor / captureScreenshot 尚未稳定就
 * 截图,clip 被按错误倍率处理,同一张卡被平铺成 2×2 并裁切(用户报告的「全家福动态
 * 发布第一次启动就 4 连图」)。热启动后并发无碍,但首批请求恰好命中冷启动窗口。把所有
 * 渲染串起来即可彻底消除竞态;卡片渲染量小、非延迟敏感,串行的吞吐代价可接受。
 */
export interface SerialGate {
	/** 排队进临界区。resolve 出来的是 release,调用方在 try/finally 里调。 */
	acquire(): Promise<() => void>;
	/**
	 * 还在排队等着的数量,**不含正在跑的那个**。
	 *
	 * 独立端的 `/status` 拿它回答「是不是卡住了」—— 一个正在渲染是正常状态,
	 * 后面堆着一串才是积压。
	 */
	waiting(): number;
}

export function createSerialGate(): SerialGate {
	// 队尾:下一个 acquire 要等的 promise。初始已 resolve(首个立即放行)。
	let tail: Promise<void> = Promise.resolve();
	let waiting = 0;
	return {
		waiting: () => waiting,
		async acquire(): Promise<() => void> {
			const prev = tail;
			let release!: () => void;
			let released = false;
			tail = new Promise<void>((resolve) => {
				release = () => {
					if (released) return; // 幂等:重复 release 无副作用
					released = true;
					resolve();
				};
			});
			waiting += 1;
			// finally 而不是等 await 之后加一行:prev 若被 reject(今天不会,但这把锁
			// 的 release 是外部代码在调),计数会永久漏一个,而漏掉的数字只会在
			// 「状态」里显示成一个永不归零的积压。
			try {
				await prev;
			} finally {
				waiting -= 1;
			}
			return release;
		},
	};
}
