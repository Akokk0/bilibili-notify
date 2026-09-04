/**
 * 三个真机脚本(probe-login / capture-frames / smoke-live)共用的启动样板:数据目录、
 * ServiceContext、只读打开服务端落盘的登录态。以前各抄一份,2026-08-27 那次写死路径的
 * 泄漏正是三份里有一份走了样 —— 收成一份,改一处三处都对。
 *
 * 只读铁律:loadCookies 绝不传 refreshToken —— 它会 fire-and-forget 触发 cookie 刷新舞步
 * (RSA 轮换),旧 cookie 被 B 站作废而新 cookie 只在本进程内存里,脚本一退出登录态就死。
 * 2026-08-27 就这样弄丢过一次主人的扫码登录。
 */
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BilibiliAPI } from "@bilibili-notify/api";
import type { Logger, ServiceContext } from "@bilibili-notify/internal";
import { StorageManager } from "@bilibili-notify/storage";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
/** 服务端的数据目录;跑别的实例用 BN_DATA_DIR 指过去。 */
export const dataDir = process.env.BN_DATA_DIR ?? join(repoRoot, "apps", "server", "data");

export const consoleLogger: Logger = {
	info: console.log,
	warn: console.warn,
	error: console.error,
	debug: () => {},
};

/** 真时钟的 ServiceContext。 */
export function makeServiceCtx(logger: Logger = consoleLogger): ServiceContext {
	return {
		logger,
		setInterval(fn, ms) {
			const h = setInterval(fn, ms);
			return { dispose: () => clearInterval(h) };
		},
		setTimeout(fn, ms) {
			const h = setTimeout(fn, ms);
			return { dispose: () => clearTimeout(h) };
		},
		onDispose() {},
	};
}

/**
 * 用服务端落盘的登录态起一个**只读**的 BilibiliAPI。没有登录态直接退出进程 —— 三个脚本
 * 没有登录态都没法往下走。
 */
export async function openReadonlyApi(serviceCtx: ServiceContext): Promise<BilibiliAPI> {
	const storage = new StorageManager({
		serviceCtx,
		dataDir,
		paths: {
			keyPath: join(dataDir, "secrets", "master.key"),
			cookiePath: join(dataDir, "secrets", "cookies.json"),
			saltPath: join(dataDir, "secrets", "kdf.salt"),
		},
	});
	await storage.init();
	const cookieData = await storage.cookieStore.load();
	if (!cookieData) {
		console.error(
			`没有登录态:${join(dataDir, "secrets", "cookies.json")} 为空,先在 dashboard 扫码登录`,
		);
		process.exit(1);
	}
	const api = new BilibiliAPI({ serviceCtx, config: {} });
	await api.start();
	await api.loadCookies({ ...cookieData, refreshToken: undefined as unknown as string });
	return api;
}
