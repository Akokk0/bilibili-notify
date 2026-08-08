/**
 * 上传路由的**入口**闸门。
 *
 * 每条上传路由后面都有一道自己的上限(字体 20MB、背景图 / 聊天图各 5MB),但那道闸
 * 在 `parseBody()` + `arrayBuffer()` **之后** —— 也就是整个 multipart body 已经实体化
 * 进堆之后才拦。镜像里 V8 的 old-space 只有 512MB(见 `apps/Dockerfile`),拖一个几百
 * 兆的文件进来,结果不是那句「过大」,而是进程被 OOM 杀掉:`restart: unless-stopped`
 * 把它拉起来,主人看到的是面板断线又重连,而那句本该收到的提示永远不会来。
 *
 * 所以要在读之前先按 Content-Length / 流长度回绝。后面那道校验**照留** —— 它管的是
 * 「这个文件本身多大」,这道管的是「这次请求能往堆里塞多少」,骗得过前者的畸形请求
 * (谎报 Content-Length)还得靠后者兜住。
 */

import type { MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";

/**
 * multipart 信封的余量:boundary、part 头、文件名。几百字节足够,给到 64KB 是为了
 * 长中文文件名也不会被这道闸误伤 —— 误伤的话主人收到的会是「过大」,而文件其实合规。
 */
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;

/**
 * 造一道上传闸。`maxBytes` 传那条路由自己的资产上限,文案与后面那道校验对齐,
 * 免得同一个文件在两处得到两种说法。
 *
 * 413 而不是 400:这是「超出上限」的标准语义,与「文件类型不对」区分得开。
 */
export function uploadBodyLimit(maxBytes: number, what: string): MiddlewareHandler {
	const mb = Math.round(maxBytes / 1024 / 1024);
	return bodyLimit({
		maxSize: maxBytes + MULTIPART_OVERHEAD_BYTES,
		onError: (c) => c.json({ ok: false, err: `${what}过大（上限 ${mb}MB）` }, 413),
	});
}
