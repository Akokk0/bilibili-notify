/**
 * 单元测试 — QQ 机器人扫码绑定(借道腾讯 OpenClaw lite 通道)。
 *
 * 协议:预递 base64 AES-256 key → create_bind_task 拿 task_id → 用户扫码进腾讯
 * H5 建 bot → poll_bind_result 轮询;完成态回 bot_appid(明文)+ bot_encrypt_secret
 * (AES-256-GCM,payload = 12B nonce + 密文 + 16B tag,base64)。
 */
import { randomBytes } from "node:crypto";
import type { HttpClient } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { integrationIo } from "../../__tests__/support/integration-io.js";
import { i18n } from "../../i18n/index.js";
import { createBindTask, decryptBindSecret, generateBindKey, pollBindTask } from "../qq-bind.js";
import { encryptLikeTencent } from "./tencent-bind-crypto.js";

describe("generateBindKey", () => {
	it("产出 base64 的 32 字节密钥,两次不同", () => {
		const a = generateBindKey();
		const b = generateBindKey();
		expect(Buffer.from(a, "base64")).toHaveLength(32);
		expect(Buffer.from(b, "base64")).toHaveLength(32);
		expect(a).not.toBe(b);
	});
});

describe("decryptBindSecret", () => {
	it("解出用同一把钥匙加密的 AppSecret(对拍往返)", () => {
		const key = generateBindKey();
		const encrypted = encryptLikeTencent("AbCd1234EfGh5678", key);
		expect(decryptBindSecret(encrypted, key)).toBe("AbCd1234EfGh5678");
	});

	it("密文被篡改 → 抛错(GCM tag 校验失败)", () => {
		const key = generateBindKey();
		const raw = Buffer.from(encryptLikeTencent("secret", key), "base64");
		raw[14] = (raw[14] ?? 0) ^ 0xff; // 翻转密文区一个字节
		expect(() => decryptBindSecret(raw.toString("base64"), key)).toThrow();
	});

	it("密钥不是 32 字节 → 抛错", () => {
		const shortKey = Buffer.from(randomBytes(16)).toString("base64");
		const encrypted = encryptLikeTencent("secret", generateBindKey());
		expect(() => decryptBindSecret(encrypted, shortKey)).toThrow();
	});

	it("payload 太短(容不下 nonce+tag)→ 抛错", () => {
		const key = generateBindKey();
		expect(() => decryptBindSecret(Buffer.from("short").toString("base64"), key)).toThrow();
	});
});

// ── 协议客户端(底下的 fetch 全局 stub,客户端是真的)───────────────────────────

let fetchMock: ReturnType<typeof vi.fn>;
let http: HttpClient;
/** 真的 `Response`:请求客户端要读头、读字节。 */
function res(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), { status });
}
beforeEach(() => {
	fetchMock = vi.fn();
	vi.stubGlobal("fetch", fetchMock);
	http = integrationIo().http;
});
afterEach(() => {
	vi.unstubAllGlobals();
});

describe("createBindTask", () => {
	it("预递密钥拿 task_id,拼出 openclaw H5 二维码 URL", async () => {
		fetchMock.mockResolvedValue(res(200, { retcode: 0, data: { task_id: "T1" } }));
		const task = await createBindTask(http);
		expect(task.taskId).toBe("T1");
		expect(Buffer.from(task.bindKey, "base64")).toHaveLength(32);
		expect(task.qrUrl).toBe("https://q.qq.com/qqbot/openclaw/connect.html?task_id=T1&_wv=2");

		const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
		expect(String(url)).toBe("https://q.qq.com/lite/create_bind_task");
		expect(JSON.parse(String(init.body))).toEqual({ key: task.bindKey });
	});

	it("线上只带内容类型与接受类型两个头:不带浏览器身份、不带 Cookie", async () => {
		fetchMock.mockResolvedValue(res(200, { retcode: 0, data: { task_id: "T1" } }));
		await createBindTask(http);
		const [, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
		expect(Object.fromEntries(new Headers(init.headers))).toEqual({
			accept: "application/json",
			"content-type": "application/json",
		});
	});

	it("host 可注入(通道换道逃生口)", async () => {
		fetchMock.mockResolvedValue(res(200, { retcode: 0, data: { task_id: "T2" } }));
		const task = await createBindTask(http, "mirror.example.com");
		expect(task.qrUrl).toBe(
			"https://mirror.example.com/qqbot/openclaw/connect.html?task_id=T2&_wv=2",
		);
		expect(String((fetchMock.mock.calls[0] as [URL])[0])).toBe(
			"https://mirror.example.com/lite/create_bind_task",
		);
	});

	it("retcode 非 0 → 抛错并带上游 msg", async () => {
		fetchMock.mockResolvedValue(res(200, { retcode: 1001, msg: "系统繁忙" }));
		await expect(createBindTask(http)).rejects.toThrow("系统繁忙");
	});

	it("响应缺 task_id → 抛错", async () => {
		fetchMock.mockResolvedValue(res(200, { retcode: 0, data: {} }));
		await expect(createBindTask(http)).rejects.toThrow();
	});

	it("HTTP 非 2xx → 抛错", async () => {
		fetchMock.mockResolvedValue(res(502, {}));
		await expect(createBindTask(http)).rejects.toThrow("QQ 绑定接口 HTTP 502");
	});
});

describe("pollBindTask", () => {
	const key = generateBindKey();

	function pollRes(payload: unknown): Response {
		return res(200, { retcode: 0, data: payload });
	}

	it("status 0/1 → pending", async () => {
		fetchMock.mockResolvedValueOnce(pollRes({ status: 0 }));
		expect(await pollBindTask(http, "T1", key)).toEqual({ status: "pending" });
		fetchMock.mockResolvedValueOnce(pollRes({ status: 1 }));
		expect(await pollBindTask(http, "T1", key)).toEqual({ status: "pending" });
	});

	it("status 3 → expired", async () => {
		fetchMock.mockResolvedValue(pollRes({ status: 3 }));
		expect(await pollBindTask(http, "T1", key)).toEqual({ status: "expired" });
	});

	it("status 2 → 解密 secret,回 created + 凭据", async () => {
		fetchMock.mockImplementation(async () =>
			pollRes({
				status: 2,
				bot_appid: "102000001",
				bot_encrypt_secret: encryptLikeTencent("RealSecret42", key),
			}),
		);
		expect(await pollBindTask(http, "T1", key)).toEqual({
			status: "created",
			appId: "102000001",
			appSecret: "RealSecret42",
		});
		const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
		expect(String(url)).toBe("https://q.qq.com/lite/poll_bind_result");
		expect(JSON.parse(String(init.body))).toEqual({ task_id: "T1" });
	});

	it("status 2 但缺凭据字段 → error 带人话", async () => {
		fetchMock.mockResolvedValue(pollRes({ status: 2, bot_appid: "102000001" }));
		const r = await pollBindTask(http, "T1", key);
		expect(r.status).toBe("error");
	});

	it("status 2 但解密失败(密钥不匹配)→ error", async () => {
		fetchMock.mockImplementation(async () =>
			pollRes({
				status: 2,
				bot_appid: "102000001",
				bot_encrypt_secret: encryptLikeTencent("secret", generateBindKey()),
			}),
		);
		const r = await pollBindTask(http, "T1", key);
		expect(r.status).toBe("error");
	});

	it("retcode 非 0 → 抛错(上游故障,与业务态区分)", async () => {
		fetchMock.mockResolvedValue(res(200, { retcode: 500, msg: "内部错误" }));
		await expect(pollBindTask(http, "T1", key)).rejects.toThrow("内部错误");
	});
});

describe("上游超时", () => {
	/**
	 * 腾讯那边接了 TCP 却不回(区域性网络干扰下很常见)时,`GET /api/adapters/:adapterKey/auth/:taskId`
	 * 就永远不返回:任务不清、handler 挂着,而浏览器每 2 秒还在发下一轮,一路叠到用户关掉弹窗为止。
	 */
	it("每次请求都带 AbortSignal —— 上游挂起不能把 handler 钉死", async () => {
		fetchMock.mockResolvedValue(res(200, { retcode: 0, data: { task_id: "T9" } }));
		await createBindTask(http);
		const [, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
		expect(init.signal).toBeInstanceOf(AbortSignal);
	});

	it("上游一直不回:10 秒后抛 TimeoutError(`connectionAuth` 据此翻 timeout)", async () => {
		vi.useFakeTimers();
		try {
			fetchMock.mockImplementation(
				(_url: URL, init: RequestInit) =>
					new Promise((_resolve, reject) => {
						(init.signal as AbortSignal).addEventListener("abort", () => {
							reject(
								Object.assign(new Error("This operation was aborted"), { name: "AbortError" }),
							);
						});
					}),
			);
			const pending = createBindTask(http).catch((e: unknown) => e);
			await vi.advanceTimersByTimeAsync(9_999);
			let settled = false;
			void pending.then(() => {
				settled = true;
			});
			await vi.advanceTimersByTimeAsync(0);
			expect(settled).toBe(false);
			await vi.advanceTimersByTimeAsync(1);
			const err = await pending;
			expect(err).toBeInstanceOf(Error);
			expect((err as Error).name).toBe("TimeoutError");
		} finally {
			vi.useRealTimers();
		}
	});
});

it.each([
	["en", "QQ binding API returned HTTP 502"],
	["ja", "QQ連携APIがHTTP 502を返しました"],
	["zh-TW", "QQ 綁定介面回應 HTTP 502"],
] as const)(
	"reports QQ binding HTTP failure in %s without changing the request",
	async (locale, message) => {
		const previous = i18n.state();
		i18n.set({ locale, voice: "plain" });
		try {
			fetchMock.mockResolvedValue(res(502, { msg: "原始诊断" }));
			await expect(createBindTask(http)).rejects.toThrow(message);
			expect(fetchMock).toHaveBeenCalledTimes(1);
			const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
			expect(String(url)).toBe("https://q.qq.com/lite/create_bind_task");
			expect(Object.fromEntries(new Headers(init.headers))).toEqual({
				"content-type": "application/json",
				accept: "application/json",
			});
		} finally {
			i18n.set({ locale: previous.locale, voice: previous.voice });
		}
	},
);
