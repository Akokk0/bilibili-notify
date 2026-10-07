/**
 * 串行闸:经它发起的异步活**按发起次序一个接一个跑**,送达次序 = 发起次序。
 *
 * 防的是直播推送的倒序:主播下播后几秒内重开,下播流程与新场开播流程是两个互不排队
 * 的异步上下文,各自渲染 + 发送 —— 开播卡跑得快就先送达,接收端看到「开播 → 下播」。
 * 同一个房间(B 站直播,`RoomSessionBase.enqueuePush`)或同一条订阅(拓展直播,
 * ADR-0019 决策 67)的对外推送都过同一个闸;不同房间 / 订阅各开各的,互不排队。
 *
 * 失败不断链:排在后面的照常跑,异常原样抛回它自己的发起方。
 */
export interface SerialGate {
	run<T>(fn: () => Promise<T>): Promise<T>;
}

export function createSerialGate(): SerialGate {
	/** 链尾。永不 reject(失败在链上吞掉,但会经 `run` 的返回值抛回发起方)。 */
	let tail: Promise<unknown> = Promise.resolve();
	return {
		run<T>(fn: () => Promise<T>): Promise<T> {
			const run = tail.then(fn);
			tail = run.catch(() => undefined);
			return run;
		},
	};
}
