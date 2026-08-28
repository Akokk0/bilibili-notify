/**
 * 单元测试 — QQ 机器人扫码绑定(借道腾讯 OpenClaw lite 通道)。
 *
 * 协议:预递 base64 AES-256 key → create_bind_task 拿 task_id → 用户扫码进腾讯
 * H5 建 bot → poll_bind_result 轮询;完成态回 bot_appid(明文)+ bot_encrypt_secret
 * (AES-256-GCM,payload = 12B nonce + 密文 + 16B tag,base64)。
 */
import { createCipheriv, randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createBindTask, decryptBindSecret, generateBindKey, pollBindTask } from "../qq-bind.js";

/** 按腾讯回传格式加密:nonce(12) + ciphertext + tag(16),整体 base64。 */
function encryptLikeTencent(plaintext: string, keyB64: string): string {
	const key = Buffer.from(keyB64, "base64");
	const nonce = randomBytes(12);
	const cipher = createCipheriv("aes-256-gcm", key, nonce);
	const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
	const tag = cipher.getAuthTag();
	return Buffer.concat([nonce, ct, tag]).toString("base64");
}

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

// ── 协议客户端(fetch 全局 stub)─────────────────────────────────────────────

let fetchMock: ReturnType<typeof vi.fn>;
function res(status: number, body: unknown): Response {
	return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}
beforeEach(() => {
	fetchMock = vi.fn();
	vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
	vi.unstubAllGlobals();
});

describe("createBindTask", () => {
	it("预递密钥拿 task_id,拼出 openclaw H5 二维码 URL", async () => {
		fetchMock.mockResolvedValue(res(200, { retcode: 0, data: { task_id: "T1" } }));
		const task = await createBindTask();
		expect(task.taskId).toBe("T1");
		expect(Buffer.from(task.bindKey, "base64")).toHaveLength(32);
		expect(task.qrUrl).toBe("https://q.qq.com/qqbot/openclaw/connect.html?task_id=T1&_wv=2");

		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("https://q.qq.com/lite/create_bind_task");
		expect(JSON.parse(String(init.body))).toEqual({ key: task.bindKey });
	});

	it("host 可注入(通道换道逃生口)", async () => {
		fetchMock.mockResolvedValue(res(200, { retcode: 0, data: { task_id: "T2" } }));
		const task = await createBindTask("mirror.example.com");
		expect(task.qrUrl).toBe(
			"https://mirror.example.com/qqbot/openclaw/connect.html?task_id=T2&_wv=2",
		);
		expect((fetchMock.mock.calls[0] as [string])[0]).toBe(
			"https://mirror.example.com/lite/create_bind_task",
		);
	});

	it("retcode 非 0 → 抛错并带上游 msg", async () => {
		fetchMock.mockResolvedValue(res(200, { retcode: 1001, msg: "系统繁忙" }));
		await expect(createBindTask()).rejects.toThrow("系统繁忙");
	});

	it("响应缺 task_id → 抛错", async () => {
		fetchMock.mockResolvedValue(res(200, { retcode: 0, data: {} }));
		await expect(createBindTask()).rejects.toThrow();
	});

	it("HTTP 非 2xx → 抛错", async () => {
		fetchMock.mockResolvedValue(res(502, {}));
		await expect(createBindTask()).rejects.toThrow();
	});
});

describe("pollBindTask", () => {
	const key = generateBindKey();

	function pollRes(payload: unknown): Response {
		return res(200, { retcode: 0, data: payload });
	}

	it("status 0/1 → pending", async () => {
		fetchMock.mockResolvedValueOnce(pollRes({ status: 0 }));
		expect(await pollBindTask("T1", key)).toEqual({ status: "pending" });
		fetchMock.mockResolvedValueOnce(pollRes({ status: 1 }));
		expect(await pollBindTask("T1", key)).toEqual({ status: "pending" });
	});

	it("status 3 → expired", async () => {
		fetchMock.mockResolvedValue(pollRes({ status: 3 }));
		expect(await pollBindTask("T1", key)).toEqual({ status: "expired" });
	});

	it("status 2 → 解密 secret,回 created + 凭据", async () => {
		fetchMock.mockResolvedValue(
			pollRes({
				status: 2,
				bot_appid: "102000001",
				bot_encrypt_secret: encryptLikeTencent("RealSecret42", key),
			}),
		);
		expect(await pollBindTask("T1", key)).toEqual({
			status: "created",
			appId: "102000001",
			appSecret: "RealSecret42",
		});
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("https://q.qq.com/lite/poll_bind_result");
		expect(JSON.parse(String(init.body))).toEqual({ task_id: "T1" });
	});

	it("status 2 但缺凭据字段 → error 带人话", async () => {
		fetchMock.mockResolvedValue(pollRes({ status: 2, bot_appid: "102000001" }));
		const r = await pollBindTask("T1", key);
		expect(r.status).toBe("error");
	});

	it("status 2 但解密失败(密钥不匹配)→ error", async () => {
		fetchMock.mockResolvedValue(
			pollRes({
				status: 2,
				bot_appid: "102000001",
				bot_encrypt_secret: encryptLikeTencent("secret", generateBindKey()),
			}),
		);
		const r = await pollBindTask("T1", key);
		expect(r.status).toBe("error");
	});

	it("retcode 非 0 → 抛错(上游故障,与业务态区分)", async () => {
		fetchMock.mockResolvedValue(res(200, { retcode: 500, msg: "内部错误" }));
		await expect(pollBindTask("T1", key)).rejects.toThrow("内部错误");
	});
});
