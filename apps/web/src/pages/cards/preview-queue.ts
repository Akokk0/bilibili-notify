/**
 * 卡片预览请求的**客户端**串行队列。
 *
 * 服务端那边所有 puppeteer 渲染本来就是串行的(`apps/server/src/runtime/serial-gate.ts`
 * —— 冷启动窗口期并发截图会触发 CDP 竞态,把一张卡平铺成 2×2)。问题出在排队排在哪:
 *
 * 全家福一次挂四张卡,四个 `POST /api/cards/preview` **同时发出**,于是后三个请求就
 * 挂在服务端的闸门口干等。最后一张要等前三张全部渲完 —— Docker 里 chromium 还得冷
 * 启动,累计到几十秒轻而易举。而中间只要有一层反向代理(nginx 默认 60s、Cloudflare
 * Tunnel、frp…),超时一到就把连接切了。用户看到的是「渲染失败 · Failed to fetch」,
 * 服务端日志却一路「渲染完成」—— 两边对不上,谁都查不动。
 *
 * 治法是把等待挪个地方:**在浏览器这边排队,轮到了才发请求**。总耗时一模一样,但每
 * 条 HTTP 连接的存活时间只剩它自己那一张卡的渲染时间,反代的超时再也计不到排队上。
 * 顺带还让服务端闸门口不再堆着一串半死的连接。
 *
 * 只管预览这一条路 —— 它是唯一「一屏并发好几个、每个都重」的请求。
 */

/**
 * 造一条 FIFO 串行队列。返回的 `enqueue` 会等前面所有任务 settle 后才跑自己的,
 * 并原样透传返回值 / 错误。
 *
 * 失败**不锁队**:任务抛错只落到它自己的调用方头上,后面的照跑。否则一张卡渲染失败
 * 就能让后面三张永远转圈,还不给任何错误看。
 */
export function createSerialQueue(): <T>(task: () => Promise<T> | T) => Promise<T> {
	// 队尾。永远是一个**必定 resolve** 的 promise —— 用 rejected 的做队尾会让下一个
	// await 直接抛,把失败传染给无辜的后继者(还会冒 unhandled rejection)。
	let tail: Promise<void> = Promise.resolve();

	return function enqueue<T>(task: () => Promise<T> | T): Promise<T> {
		const result = tail.then(task);
		// 用 result 的「结束」而非「成功」当下一个的起跑线。
		tail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	};
}

/**
 * 全家福 / 单卡预览共用的那一条队列。**必须是模块级单例** —— 每个组件各建一条就等于
 * 没排队,四张卡照样一起打出去。
 */
export const enqueuePreview = createSerialQueue();
