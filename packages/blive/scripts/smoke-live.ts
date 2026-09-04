/**
 * 冒烟:真实房间跑 connectLiveRoom 60 秒,统计事件分布。
 * 吃构建产物 lib(动过 src 先 vp run -F @bilibili-notify/blive build)。
 *
 * 用法:node --experimental-transform-types packages/blive/scripts/smoke-live.ts
 */
import { connectLiveRoom } from "../lib/index.mjs";
import { makeServiceCtx, openReadonlyApi } from "./_env.ts";

const serviceCtx = makeServiceCtx();
const api = await openReadonlyApi(serviceCtx);
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
	userAgent: api.getUserAgent(),
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
