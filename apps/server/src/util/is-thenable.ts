/**
 * 拓展交回来的是不是一个 Promise(或别的 thenable),以及「是的话就接住它日后的拒绝」。
 *
 * 宿主的三个同步读口(`ctx.publishView`、来源的 `health()`、开发入口的 `devtools()`)要的都是同步
 * 交回的值,而第三方 JS 不受类型约束,交回 Promise 照样会发生。判断时 `then` 可能是个会抛的 getter,
 * 所以读它包在 try/catch 里:判不出来按不是 thenable 处理,交给各口的形状核去点名。
 */

export function isThenable(value: unknown): value is PromiseLike<unknown> {
	if ((typeof value !== "object" && typeof value !== "function") || value === null) return false;
	try {
		return typeof (value as { then?: unknown }).then === "function";
	} catch {
		return false;
	}
}

/**
 * 是 thenable 就接住它日后的拒绝并回 `true`;不是回 `false`。
 *
 * 🔴 没人接的 rejection 在 Node 里默认让整个进程退出。调用方判出 thenable 之后本来就拒收这个值,
 * 但那个 Promise 还会继续跑完 —— 这里替它接住,免得到时候把宿主带走。
 */
export function catchThenableRejection(value: unknown): boolean {
	if (!isThenable(value)) return false;
	Promise.resolve(value).catch(() => {});
	return true;
}
