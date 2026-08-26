/** 只读探针:不带 refreshToken 加载(绝不触发刷新舞步),问一次身份。 */
import { join } from "node:path";
import { BilibiliAPI } from "@bilibili-notify/api";
import { StorageManager } from "@bilibili-notify/storage";

const repoRoot = "/Users/akokko/NodeProject/bilibili-notify-dev/external/bilibili-notify";
const dataDir = join(repoRoot, "apps", "server", "data");
const logger = { info: console.log, warn: console.warn, error: console.error, debug: () => {} };
const serviceCtx = {
	logger,
	setInterval(fn: () => void, ms: number) {
		const h = setInterval(fn, ms);
		return { dispose: () => clearInterval(h) };
	},
	setTimeout(fn: () => void, ms: number) {
		const h = setTimeout(fn, ms);
		return { dispose: () => clearTimeout(h) };
	},
	onDispose() {},
};
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
	console.error("没有登录态");
	process.exit(1);
}
const api = new BilibiliAPI({ serviceCtx, config: {} });
await api.start();
// 只读铁律:绝不传 refreshToken(会触发 cookie 轮换,脚本不落盘则登录态丢失)
await api.loadCookies({ ...cookieData, refreshToken: undefined as unknown as string });
const myself = await api.getMyselfInfoCached();
console.log("probe:", JSON.stringify({ code: myself.code, mid: myself.data?.mid }));
process.exit(0);
