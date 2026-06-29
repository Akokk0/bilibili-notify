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
export function createSerialGate(): () => Promise<() => void> {
	// 队尾:下一个 acquire 要等的 promise。初始已 resolve(首个立即放行)。
	let tail: Promise<void> = Promise.resolve();
	return async function acquire(): Promise<() => void> {
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
		await prev;
		return release;
	};
}
