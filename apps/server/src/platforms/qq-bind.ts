/**
 * QQ 官方机器人「扫码一键创建」—— 借道腾讯给 OpenClaw 开的 lite 绑定通道。
 *
 * 机制(与 AstrBot `login_registration.py` 同款,零逆向):
 * 1. 本地生成 AES-256 密钥,POST `/lite/create_bind_task` 预递给腾讯,拿 task_id;
 * 2. 二维码内容是腾讯 H5 `/qqbot/openclaw/connect.html?task_id=…`,用户手机 QQ
 *    扫码后在腾讯页面里完成登录与建 bot(每 QQ 号上限 5 个);
 * 3. POST `/lite/poll_bind_result` 轮询,完成态回 bot_appid(明文)+
 *    bot_encrypt_secret —— 用第 1 步那把钥匙 AES-256-GCM 加密(12B nonce +
 *    密文 + 16B tag,base64),本地解密得 AppSecret。
 *
 * 预递密钥的意义:轮询只认 task_id、无会话鉴权,secret 加密后旁观者 poll 到也
 * 解不开。通道预期消费者是 OpenClaw,腾讯可能哪天收紧 —— 手填 appid/secret
 * 永远是降级路径,host 留注入口以便不发版换道。
 */

import { createDecipheriv, randomBytes } from "node:crypto";
import type { QQBindPollResult } from "@bilibili-notify/contract";

/** 生成一把 base64 编码的 AES-256(32 字节)绑定密钥。 */
export function generateBindKey(): string {
	return randomBytes(32).toString("base64");
}

/**
 * 解密腾讯回传的 AppSecret。
 *
 * @param encryptedB64 base64 payload:12 字节 nonce + 密文 + 16 字节 GCM tag。
 * @param keyB64 create_bind_task 时预递的 base64 AES-256 密钥。
 * @throws 密钥长度不对 / payload 过短 / GCM 校验失败时抛错。
 */
export function decryptBindSecret(encryptedB64: string, keyB64: string): string {
	const key = Buffer.from(keyB64, "base64");
	const raw = Buffer.from(encryptedB64, "base64");
	if (key.length !== 32) throw new Error("绑定密钥长度异常(非 32 字节)");
	if (raw.length <= 28) throw new Error("凭证密文格式异常(容不下 nonce+tag)");
	const nonce = raw.subarray(0, 12);
	const tag = raw.subarray(raw.length - 16);
	const ciphertext = raw.subarray(12, raw.length - 16);
	const decipher = createDecipheriv("aes-256-gcm", key, nonce);
	decipher.setAuthTag(tag);
	return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

const DEFAULT_BIND_HOST = "q.qq.com";

/**
 * 建任务的产物。**server 进程内的东西**,不是 wire 类型 —— `bindKey` 是解
 * AppSecret 的钥匙,不出响应也不落盘,所以它刻意留在这儿,没跟 QQBindPollResult
 * 一起搬去 `@bilibili-notify/internal` 的 wire。
 */
export interface QQBindTask {
	taskId: string;
	/** 预递给腾讯的 base64 AES-256 密钥,轮询解密要用,只该活在 server 内存。 */
	bindKey: string;
	/** 二维码内容 —— 腾讯 openclaw H5 的 URL,扫码后在腾讯页面里完成建 bot。 */
	qrUrl: string;
}

/**
 * 单次请求的上限。node 的 fetch 没有默认超时,腾讯接了 TCP 却不回(区域性网络
 * 干扰下常见)就会把 `POST /api/qq/bind/poll` 永远挂住:任务不清、handler 不返回,
 * 而浏览器每 2 秒还在发下一轮,一路叠到用户关掉弹窗。宁可这一轮报错 —— 轮询本来
 * 就允许瞬时故障,下一轮会接着问。
 */
const LITE_TIMEOUT_MS = 10_000;

/** POST 腾讯 lite 接口;retcode 非 0 或 HTTP 非 2xx 一律抛错(上游故障)。 */
async function postLite(
	host: string,
	path: string,
	payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const resp = await fetch(`https://${host}${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Accept: "application/json" },
		body: JSON.stringify(payload),
		signal: AbortSignal.timeout(LITE_TIMEOUT_MS),
	});
	if (!resp.ok) throw new Error(`QQ 绑定接口 HTTP ${resp.status}`);
	const data = (await resp.json()) as Record<string, unknown>;
	const retcode = Number(data.retcode ?? 0);
	if (retcode !== 0) {
		throw new Error(String(data.msg ?? data.message ?? `QQ 绑定接口 retcode ${retcode}`));
	}
	return data;
}

/** 创建绑定任务:生成密钥预递腾讯,返回 task_id 与二维码 URL。 */
export async function createBindTask(host: string = DEFAULT_BIND_HOST): Promise<QQBindTask> {
	const bindKey = generateBindKey();
	const data = await postLite(host, "/lite/create_bind_task", { key: bindKey });
	const payload = (data.data ?? {}) as Record<string, unknown>;
	const taskId = String(payload.task_id ?? "").trim();
	if (!taskId) throw new Error("QQ 绑定任务响应缺少 task_id");
	const qrUrl = `https://${host}/qqbot/openclaw/connect.html?task_id=${encodeURIComponent(taskId)}&_wv=2`;
	return { taskId, bindKey, qrUrl };
}

/** 轮询一次绑定结果;完成态就地解密 AppSecret。 */
export async function pollBindTask(
	taskId: string,
	bindKey: string,
	host: string = DEFAULT_BIND_HOST,
): Promise<QQBindPollResult> {
	const data = await postLite(host, "/lite/poll_bind_result", { task_id: taskId });
	const payload = (data.data ?? {}) as Record<string, unknown>;
	const status = Number(payload.status ?? 0);
	if (status === 3) return { status: "expired" };
	if (status !== 2) return { status: "pending" };
	const appId = String(payload.bot_appid ?? "").trim();
	const encryptedSecret = String(payload.bot_encrypt_secret ?? "").trim();
	if (!appId || !encryptedSecret) {
		return { status: "error", message: "扫码成功但腾讯未返回完整机器人凭据" };
	}
	try {
		return { status: "created", appId, appSecret: decryptBindSecret(encryptedSecret, bindKey) };
	} catch (e) {
		return { status: "error", message: `机器人凭据解密失败:${(e as Error).message}` };
	}
}
