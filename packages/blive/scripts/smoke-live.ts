/**
 * 冒烟:真实房间跑 connectLiveRoom 60 秒,统计事件分布。
 * 吃构建产物 lib(动过 src 先 vp run -F @bilibili-notify/blive build)。
 *
 * 用法:node --experimental-transform-types packages/blive/scripts/smoke-live.ts
 */
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BilibiliAPI } from "@bilibili-notify/api";
import { StorageManager } from "@bilibili-notify/storage";
import { connectLiveRoom } from "../lib/index.mjs";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const dataDir = process.env.BN_DATA_DIR ?? join(repoRoot, "apps", "server", "data");
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
	console.error("没有登录态,先在 dashboard 扫码登录");
	process.exit(1);
}
const api = new BilibiliAPI({ serviceCtx, config: {} });
await api.start();
// 只读铁律:绝不传 refreshToken(会触发 cookie 轮换,脚本不落盘则登录态丢失)
await api.loadCookies({ ...cookieData, refreshToken: undefined as unknown as string });
const myself = await api.getMyselfInfoCached();
if (myself.code !== 0 || !myself.data) {
	console.error(`登录态失效 code=${myself.code}`);
	process.exit(1);
}

const rec = (await (
	await fetch("https://api.live.bilibili.com/room/v1/room/get_user_recommend?page=1&page_size=3")
).json()) as { code: number; data?: { roomid: number; uname: string }[] };
const top = rec.data?.[0];
if (rec.code !== 0 || !top) {
	console.error(`取热门房间失败 code=${rec.code}`);
	process.exit(1);
}
console.log("room:", top.roomid, top.uname);

const info = await api.getLiveRoomInfoStreamKey(String(top.roomid));
const token = typeof info.data?.token === "string" ? info.data.token : "";
const hostListRaw = (info.data?.host_list ?? []) as { host: string; wss_port: number }[];
if (info.code !== 0 || !token || hostListRaw.length === 0) {
	console.error(`getDanmuInfo 失败 code=${info.code}`);
	process.exit(1);
}
const buvid = await api.getBuvid3();
console.log("buvid:", buvid ? "已取得" : "缺失");

const counts = new Map<string, number>();
const client = connectLiveRoom({
	roomId: top.roomid,
	uid: myself.data.mid,
	token,
	buvid,
	hostList: hostListRaw.map((h) => ({ host: h.host, wssPort: h.wss_port })),
	cookieHeader: api.getCookiesHeader(),
	onEvent: (ev) => {
		counts.set(ev.kind, (counts.get(ev.kind) ?? 0) + 1);
		if (ev.kind === "danmu" && (counts.get("danmu") ?? 0) <= 3) {
			console.log("弹幕:", ev.user.uname, "→", ev.content);
		}
		if (ev.kind === "auth-ok" || ev.kind === "auth-failed" || ev.kind === "error") {
			console.log("事件:", JSON.stringify(ev));
		}
	},
});
setTimeout(() => {
	client.close();
	console.log("分布:", [...counts.entries()].map(([k, v]) => `${k}×${v}`).join(" "));
	process.exit(0);
}, 60_000);
