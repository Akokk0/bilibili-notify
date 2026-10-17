/**
 * 冒烟:真实房间跑 connectLiveRoom 60 秒,统计事件分布。
 * 直接吃源码(tsx),不用先构建服务端。
 *
 * 用法(在 apps/server 下):vp exec tsx src/bilibili/live/protocol/scripts/__tests__/smoke-live.ts
 */
import { connectLiveRoom } from "../../client.js";
import { makeServiceCtx, openReadonlyApi } from "./_env.js";

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

const info = await api.fetchLiveRoomInfoStreamKey(String(top.roomid));
const infoData = info.ok ? info.data : null;
const token = typeof infoData?.token === "string" ? infoData.token : "";
const hostListRaw = (infoData?.host_list ?? []) as { host: string; wss_port: number }[];
if (!info.ok || !token || hostListRaw.length === 0) {
	console.error(`getDanmuInfo 失败 code=${info.ok ? "0" : (info.upstreamCode ?? info.code)}`);
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
	createSocket: (url) => api.openDanmakuSocket(url),
	onEvent: (ev) => {
		counts.set(ev.kind, (counts.get(ev.kind) ?? 0) + 1);
		if (ev.kind === "danmu" && (counts.get("danmu") ?? 0) <= 3) {
			console.log("弹幕:", ev.user.name, "→", ev.content);
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
