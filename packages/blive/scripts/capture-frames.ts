/**
 * 弹幕服录帧脚本(只读):用服务端落盘的登录态连真实直播间,把服务器下行的
 * 原始 WS 二进制帧原样录成 JSONL,供 codec / parser 测试当 fixture。
 *
 * 只录**下行**帧 —— 上行认证包里带 token,永远不落盘。
 *
 * 用法(仓库根目录):
 *   node --experimental-strip-types packages/blive/scripts/capture-frames.ts <roomId> [分钟=3] [输出.jsonl]
 *
 * 蹲守模式:BLIVE_WATCH_CMDS=USER_TOAST_MSG,USER_TOAST_MSG_V2,GUARD_BUY(逗号
 * 分隔)—— 录到匹配命令时立刻在终端播报完整 payload,长录蹲稀罕帧(如上舰
 * 续费)不用盯文件。播报只是旁路,录制本身不受影响。
 *
 * 依赖已构建的 lib(@bilibili-notify/storage / api):动过那些包先 vp run build。
 */

import { appendFileSync } from "node:fs";
import { join } from "node:path";
import WebSocket from "ws";
import { decodeFrames, encodePacket, WsOp } from "../src/codec.ts";
import { makeServiceCtx, openReadonlyApi } from "./_env.ts";

const roomIdInput = process.argv[2];
if (!roomIdInput) {
	console.error("用法: capture-frames.ts <roomId|auto> [分钟=3] [输出.jsonl]");
	process.exit(1);
}
const minutes = Number(process.argv[3] ?? "3");

const logger = {
	info: (m: string) => console.log(`[info] ${m}`),
	warn: (m: string) => console.warn(`[warn] ${m}`),
	error: (m: string) => console.error(`[error] ${m}`),
	debug: () => {},
};
const serviceCtx = makeServiceCtx(logger);
const api = await openReadonlyApi(serviceCtx);

const myself = await api.getMyselfInfoCached();
if (myself.code !== 0 || !myself.data) {
	console.error(`登录态失效 code=${myself.code}`);
	process.exit(1);
}
const uid = myself.data.mid;
logger.info(`登录态 OK,uid=${uid}`);

let roomIdArg = roomIdInput;
if (roomIdInput === "auto") {
	// getListByArea 已挂 wbi(-352),这个老推荐接口裸请求即通
	const listRes = (await (
		await fetch("https://api.live.bilibili.com/room/v1/room/get_user_recommend?page=1&page_size=6")
	).json()) as {
		code: number;
		data?: { roomid: number; online: number; title: string; uname: string }[];
	};
	const top = listRes.data?.[0];
	if (listRes.code !== 0 || !top) {
		console.error(`取热门房间失败 code=${listRes.code}`);
		process.exit(1);
	}
	roomIdArg = String(top.roomid);
	logger.info(`选中热门房间 ${roomIdArg}(${top.uname}:${top.title},online=${top.online})`);
}
const outFile = process.argv[4] ?? join(process.cwd(), `blive-capture-${roomIdArg}.jsonl`);

const danmuInfo = await api.getLiveRoomInfoStreamKey(roomIdArg);
if (danmuInfo.code !== 0 || !danmuInfo.data?.token) {
	console.error(`getDanmuInfo 失败 code=${danmuInfo.code} message=${danmuInfo.message ?? ""}`);
	process.exit(1);
}
const hostList = danmuInfo.data.host_list as { host: string; wss_port: number }[];
const host = hostList[0];
if (!host) {
	console.error("host_list 为空");
	process.exit(1);
}

const cookieHeader = api.getCookiesHeader();
const buvidRes = (await (
	await fetch("https://api.bilibili.com/x/frontend/finger/spi", {
		headers: { Cookie: cookieHeader },
	})
).json()) as { code: number; data?: { b_3?: string } };
const buvid = buvidRes.data?.b_3 ?? "";
logger.info(`buvid=${buvid ? "已取得" : "缺失"}`);

const url = `wss://${host.host}${host.wss_port === 443 ? "" : `:${host.wss_port}`}/sub`;
logger.info(`连接 ${url},录 ${minutes} 分钟 → ${outFile}`);

const ws = new WebSocket(url, {
	headers: {
		Cookie: cookieHeader,
		// 与同进程 HTTP 同指纹(api 的生成身份),不再自带一份写死的 UA
		"User-Agent": api.getUserAgent(),
	},
});
ws.binaryType = "nodebuffer";

const t0 = Date.now();
let frames = 0;
let bytes = 0;
const opsSeen = new Map<number, number>();

// 蹲守目标命令(BLIVE_WATCH_CMDS,逗号分隔);空 = 不解码、纯录制
const watchCmds = new Set(
	(process.env.BLIVE_WATCH_CMDS ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean),
);
let watchHits = 0;
if (watchCmds.size > 0) logger.info(`蹲守命令: ${[...watchCmds].join(", ")}`);

ws.on("open", () => {
	logger.info("已连接,发认证包");
	ws.send(
		encodePacket(WsOp.Auth, {
			uid,
			roomid: Number(roomIdArg),
			protover: 3,
			platform: "web",
			type: 2,
			key: danmuInfo.data?.token,
			buvid: buvid || undefined,
		}),
	);
	setInterval(() => ws.send(encodePacket(WsOp.Heartbeat, {})), 30_000);
	setTimeout(() => ws.send(encodePacket(WsOp.Heartbeat, {})), 1_000);
});

ws.on("message", (data: Buffer) => {
	frames++;
	bytes += data.length;
	const op = data.length >= 12 ? data.readUInt32BE(8) : -1;
	opsSeen.set(op, (opsSeen.get(op) ?? 0) + 1);
	appendFileSync(
		outFile,
		`${JSON.stringify({ t: Date.now() - t0, op, b64: data.toString("base64") })}\n`,
	);
	// 蹲守播报(decodeFrames 坏包内部丢弃不抛,旁路安全)
	if (watchCmds.size > 0) {
		for (const p of decodeFrames(data)) {
			if (p.op !== WsOp.Message) continue;
			const cmd = (p.body as { cmd?: unknown } | null)?.cmd;
			if (typeof cmd === "string" && watchCmds.has(cmd)) {
				watchHits++;
				const at = Math.round((Date.now() - t0) / 1000);
				logger.info(`🎯 蹲到 ${cmd}(第 ${watchHits} 条,t+${at}s):${JSON.stringify(p.body)}`);
			}
		}
	}
});

ws.on("error", (e) => logger.error(`ws error: ${e.message}`));
ws.on("close", (code) => logger.warn(`ws closed code=${code}`));

setTimeout(
	() => {
		ws.close();
		const ops = [...opsSeen.entries()].map(([op, n]) => `op${op}×${n}`).join(" ");
		const watchNote = watchCmds.size > 0 ? ` / 蹲到 ${watchHits} 条目标命令` : "";
		logger.info(`收工:${frames} 帧 / ${bytes} 字节 / ${ops}${watchNote}`);
		process.exit(0);
	},
	minutes * 60 * 1000,
);
