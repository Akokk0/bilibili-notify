/**
 * 调 `stop()`:抛了 / 失败了都交给 `onError`(各登记表记一行 warn)—— 收尾要往下走,
 * 不能被一个集成拦住。适配器登记表与来源登记表共用这一段。
 * 交回的 promise 在 `stop()` 落定(成功、同步抛、异步拒都算)之后落定,**永不拒**:要等的(来源登记表)
 * 接着它,不等的(适配器登记表)丢掉它就行。
 * (从前引擎里是 `void ad.dispose?.()` 外包 try/catch,异步的失败没人接。)
 */
export function stopQuietly(
	stop: () => void | Promise<void>,
	onError: (err: unknown) => void,
): Promise<void> {
	try {
		// `Promise.resolve` 连非原生的 thenable 也认;同步抛的由外面的 try/catch 接。
		return Promise.resolve(stop()).then(undefined, onError);
	} catch (err) {
		onError(err);
		return Promise.resolve();
	}
}
