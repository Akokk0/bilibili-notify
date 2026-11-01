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

import { createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import type { AuthState, ConnectionAuth, HttpClient, Logger } from "@bilibili-notify/internal";
import { fail, ok } from "@bilibili-notify/internal";
import QRCode from "qrcode";
import { t } from "../i18n/index.js";
import { upstreamMessage } from "./upstream-message.js";

/**
 * 轮询一次的结果。**server 内部的类型**(`created` 带着明文 AppSecret,只许在本文件的任务表里停留,
 * 不出 wire)。
 */
export type QQBindPollResult =
	| { status: "pending" }
	| { status: "expired" }
	| { status: "created"; appId: string; appSecret: string }
	/** 扫码侧完成但凭据缺失/解不开 —— 业务态错误,与上游故障(抛错)区分。 */
	| { status: "error"; message: string };

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
	if (key.length !== 32) throw new Error(t("qqBind.message.text1"));
	if (raw.length <= 28) throw new Error(t("qqBind.message.text2"));
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
 * 单次请求的上限。腾讯接了 TCP 却不回(区域性网络干扰下常见)就会把
 * `GET /api/adapters/:adapterKey/auth/:taskId` 永远挂住:任务不清、handler 不返回,
 * 而浏览器每 2 秒还在发下一轮,一路叠到用户关掉弹窗。宁可这一轮报错 —— 轮询本来
 * 就允许瞬时故障,下一轮会接着问。交给请求客户端按单跳算。
 */
const LITE_TIMEOUT_MS = 10_000;

/** POST 腾讯 lite 接口;retcode 非 0 或 HTTP 非 2xx 一律抛错(上游故障)。 */
async function postLite(
	http: HttpClient,
	host: string,
	path: string,
	payload: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<Record<string, unknown>> {
	// 不带浏览器身份、不碰 cookie 罐:腾讯这条通道不该看到 B 站那套指纹。
	const resp = await http.fetch(`https://${host}${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Accept: "application/json" },
		body: JSON.stringify(payload),
		signal,
		timeoutMs: LITE_TIMEOUT_MS,
		bare: true,
	});
	if (!resp.ok) {
		// 客户端自己的超时仍按 `TimeoutError` 抛,`upstreamFailure` 翻成 timeout;其余(含调用方中止)翻 unavailable。
		const err = new Error(resp.message);
		if (resp.code === "timeout") err.name = "TimeoutError";
		throw err;
	}
	if (!resp.isSuccess) throw new Error(t("qqBind.message.text3", { value0: resp.status }));
	const parsed = resp.json();
	if (!parsed.ok) throw new Error(parsed.message);
	const data = parsed.value as Record<string, unknown>;
	const retcode = Number(data.retcode ?? 0);
	if (retcode !== 0) {
		throw new Error(
			String(data.msg ?? data.message ?? t("qqBind.message.text4", { value0: retcode })),
		);
	}
	return data;
}

/** 创建绑定任务:生成密钥预递腾讯,返回 task_id 与二维码 URL。 */
export async function createBindTask(
	http: HttpClient,
	host: string = DEFAULT_BIND_HOST,
	signal?: AbortSignal,
): Promise<QQBindTask> {
	const bindKey = generateBindKey();
	const data = await postLite(http, host, "/lite/create_bind_task", { key: bindKey }, signal);
	const payload = (data.data ?? {}) as Record<string, unknown>;
	const taskId = String(payload.task_id ?? "").trim();
	if (!taskId) throw new Error(t("qqBind.message.text5"));
	const qrUrl = `https://${host}/qqbot/openclaw/connect.html?task_id=${encodeURIComponent(taskId)}&_wv=2`;
	return { taskId, bindKey, qrUrl };
}

/** 轮询一次绑定结果;完成态就地解密 AppSecret。 */
export async function pollBindTask(
	http: HttpClient,
	taskId: string,
	bindKey: string,
	host: string = DEFAULT_BIND_HOST,
): Promise<QQBindPollResult> {
	const data = await postLite(http, host, "/lite/poll_bind_result", { task_id: taskId });
	const payload = (data.data ?? {}) as Record<string, unknown>;
	const status = Number(payload.status ?? 0);
	if (status === 3) return { status: "expired" };
	if (status !== 2) return { status: "pending" };
	const appId = String(payload.bot_appid ?? "").trim();
	const encryptedSecret = String(payload.bot_encrypt_secret ?? "").trim();
	if (!appId || !encryptedSecret) {
		return { status: "error", message: t("qqBind.message.text6") };
	}
	try {
		return { status: "created", appId, appSecret: decryptBindSecret(encryptedSecret, bindKey) };
	} catch (e) {
		return {
			status: "error",
			message: t("qqBind.message.text7", { value0: (e as Error).message }),
		};
	}
}

// ── connectionAuth:任务表住适配器里 ──────────────────────────────────────────

/** 任务时限 —— 腾讯侧二维码本身会过期,这里兜「弹层开着人走了」的泄漏,也是 `expiresAt` 的算法。 */
const BIND_TASK_TTL_MS = 10 * 60_000;

/** 建议的问询间隔(秒),对齐 AstrBot 同通道的默认值。 */
const BIND_POLL_INTERVAL_SECONDS = 2;

/**
 * 任务表的一项。⚠️ 带着解 AppSecret 的钥匙与(成功后)明文草稿:只活在这张闭包里的表中,
 * 不落盘、不进事件总线、不进任何会被序列化的状态、不进日志 —— 日志里不许打整项、
 * `takeDraft` 的返回值、`state()` 的整个返回值。
 */
interface BindEntry {
	upstreamTaskId: string;
	bindKey: string;
	createdAt: number;
	/** 终态(logged-in / error)一旦钉住就不再问上游。 */
	state: AuthState;
	draft?: { appId: string; appSecret: string };
}

function isTimeout(err: unknown): boolean {
	return (
		typeof err === "object" && err !== null && (err as { name?: unknown }).name === "TimeoutError"
	);
}

/** 上游抛的错翻成标准码:超时单列 `timeout`,其余 `unavailable`。 */
function upstreamFailure(err: unknown, lead: string) {
	return fail(isTimeout(err) ? "timeout" : "unavailable", `${lead}：${upstreamMessage(err)}`);
}

/**
 * QQ 官方机器人的 `connectionAuth`。任务号由这里发(`randomUUID`),腾讯的 `task_id` 与解密钥匙
 * 只存在表里。惰性清扫(三个方法进门各扫一遍,不起定时器);`clear()` 给适配器 `stop()` 用。
 *
 * 三个方法是闭包,不用 `this`。
 */
export function createQQConnectionAuth(opts: {
	logger: Logger;
	/** 适配器 `start(ctx)` 接住的请求客户端;`connectionAuth` 在工厂里就造,所以每次现取。还没 start 时回 `undefined`。 */
	http: () => HttpClient | undefined;
}): {
	auth: ConnectionAuth;
	clear(): void;
} {
	const { logger } = opts;
	const tasks = new Map<string, BindEntry>();
	// 逃生口:腾讯哪天收紧通道可以不发版换主机。每次调用现读。
	const bindHost = (): string | undefined => process.env.BN_QQ_BIND_HOST || undefined;
	const sweep = (): void => {
		const now = Date.now();
		for (const [id, task] of tasks) {
			if (now - task.createdAt > BIND_TASK_TTL_MS) tasks.delete(id);
		}
	};

	const auth: ConnectionAuth = {
		async begin(signal) {
			sweep();
			const http = opts.http();
			if (!http) return fail("unavailable", t("connection.adapterNotStarted"));
			try {
				const task = await createBindTask(http, bindHost(), signal);
				const dataUrl = await QRCode.toDataURL(task.qrUrl, { margin: 1, width: 320 });
				const createdAt = Date.now();
				const state: AuthState = {
					status: "awaiting-scan",
					qr: { dataUrl, expiresAt: new Date(createdAt + BIND_TASK_TTL_MS).toISOString() },
				};
				const taskId = randomUUID();
				tasks.set(taskId, {
					upstreamTaskId: task.taskId,
					bindKey: task.bindKey,
					createdAt,
					state,
				});
				return ok({ taskId, state, pollIntervalSeconds: BIND_POLL_INTERVAL_SECONDS });
			} catch (err) {
				logger.warn(`[qq] 发起绑定失败: ${upstreamMessage(err)}`);
				return upstreamFailure(err, t("qqBind.message.text9"));
			}
		},

		// 对上游的那次问询**不跟调用方的 signal**:腾讯的成功结果可能只回一次,面板断开不该
		// 让已经在路上的那次成功被丢掉;问到了就收进表,下一轮读到。所以参数留着、这里不用。
		async state(taskId, _signal) {
			sweep();
			const entry = tasks.get(taskId);
			if (!entry) return fail("not_found", t("qqBind.message.text10"));
			if (entry.state.status !== "awaiting-scan") return ok({ state: entry.state });
			const http = opts.http();
			if (!http) return fail("unavailable", t("connection.adapterNotStarted"));
			let polled: QQBindPollResult;
			try {
				polled = await pollBindTask(http, entry.upstreamTaskId, entry.bindKey, bindHost());
			} catch (err) {
				// 上游故障保留任务,下一轮接着问。
				logger.warn(`[qq] 查询绑定结果失败: ${upstreamMessage(err)}`);
				return upstreamFailure(err, t("qqBind.message.text12"));
			}
			// await 期间这一项可能被取走 / 被清扫 / 被 clear:不复活它(复活 = 把明文草稿留在没人来取的表里)。
			if (tasks.get(taskId) !== entry) return fail("not_found", t("qqBind.message.text10"));
			// 并发的另一轮已经钉住终态:以先到的为准。
			if (entry.state.status !== "awaiting-scan") return ok({ state: entry.state });
			if (polled.status === "created") {
				entry.draft = { appId: polled.appId, appSecret: polled.appSecret };
				entry.state = { status: "logged-in", loggedInAt: new Date().toISOString() };
			} else if (polled.status === "expired") {
				// `expired` 只指「已经登着的登录失效了」;建连接没有这回事,码超时就是这一次没办成。
				entry.state = { status: "error", message: t("qqBind.message.text13") };
			} else if (polled.status === "error") {
				entry.state = { status: "error", message: polled.message };
			}
			return ok({ state: entry.state });
		},

		async takeDraft(taskId) {
			sweep();
			const entry = tasks.get(taskId);
			if (!entry) return fail("not_found", t("qqBind.message.text10"));
			if (entry.state.status === "awaiting-scan") {
				return fail("conflict", t("qqBind.message.text14"));
			}
			if (!entry.draft) return fail("conflict", t("qqBind.message.text15"));
			const { appId, appSecret } = entry.draft;
			// 取走即清:整项删,不是只删草稿那一格。
			tasks.delete(taskId);
			return ok({ settings: { appId, appSecret, botType: "public", sandbox: false } });
		},
	};

	return { auth, clear: () => tasks.clear() };
}
