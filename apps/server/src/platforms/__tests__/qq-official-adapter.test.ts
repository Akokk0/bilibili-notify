import type {
	Disposable,
	Logger,
	NotificationPayload,
	PushAdapter,
	PushTarget,
	ServiceContext,
} from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createQQOfficialAdapter, createQQSessionRegistry } from "../qq-official";

function makeLogger(): Logger {
	return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}
function makeServiceCtx(): ServiceContext {
	return {
		logger: makeLogger(),
		setTimeout(fn, ms): Disposable {
			const h = setTimeout(fn, ms);
			return { dispose: () => clearTimeout(h) };
		},
		setInterval(fn, ms): Disposable {
			const h = setInterval(fn, ms);
			return { dispose: () => clearInterval(h) };
		},
		onDispose() {},
	};
}

function adapterOpts() {
	return {
		logger: makeLogger(),
		serviceCtx: makeServiceCtx(),
		registry: createQQSessionRegistry(),
	};
}

function qqAdapter(over: Record<string, unknown> = {}): PushAdapter {
	return {
		id: "a1",
		name: "qq",
		platform: "qq-official",
		enabled: true,
		config: { appId: "APPID", appSecret: "SECRET", sandbox: false, botType: "public", ...over },
	} as unknown as PushAdapter;
}

function qqTarget(scope: string, session: Record<string, unknown>): PushTarget {
	return {
		id: "t1",
		name: "目标",
		adapterId: "a1",
		platform: "qq-official",
		scope,
		enabled: true,
		session,
	} as unknown as PushTarget;
}

const TEXT: NotificationPayload = { kind: "text", text: "阿绫发布了动态" };

// fetch 按 URL 路由:token / gateway / files / messages。
let fetchMock: ReturnType<typeof vi.fn>;
function res(status: number, body: unknown): Response {
	return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}
beforeEach(() => {
	fetchMock = vi.fn(async (url: string) => {
		if (url.includes("getAppAccessToken"))
			return res(200, { access_token: "TKN", expires_in: 7200 });
		if (url.endsWith("/files"))
			return res(200, { file_uuid: "FUUID", file_info: "FILEINFO", ttl: 3600 });
		if (url.endsWith("/messages")) return res(200, { id: "MSG1", timestamp: "t" });
		return res(200, {});
	});
	vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

function callsTo(suffix: string) {
	return fetchMock.mock.calls.filter((c) => String(c[0]).endsWith(suffix));
}
function bodyOf(call: unknown[]): Record<string, unknown> {
	return JSON.parse((call[1] as { body: string }).body);
}

describe("createQQOfficialAdapter — isAvailable", () => {
	it("enabled + 有 appId/appSecret → true", () => {
		const ad = createQQOfficialAdapter(adapterOpts());
		expect(ad.isAvailable(qqAdapter(), qqTarget("group", { groupOpenid: "G1" }))).toBe(true);
	});
	it("缺 appSecret → false", () => {
		const ad = createQQOfficialAdapter(adapterOpts());
		expect(
			ad.isAvailable(qqAdapter({ appSecret: "" }), qqTarget("group", { groupOpenid: "G1" })),
		).toBe(false);
	});
	it("adapter disabled → false", () => {
		const ad = createQQOfficialAdapter(adapterOpts());
		const disabled = { ...qqAdapter(), enabled: false } as PushAdapter;
		expect(ad.isAvailable(disabled, qqTarget("group", { groupOpenid: "G1" }))).toBe(false);
	});
});

describe("createQQOfficialAdapter — send 文本", () => {
	it("group:取 token → POST /v2/groups/{openid}/messages,QQBot 头 + msg_type 0", async () => {
		const ad = createQQOfficialAdapter(adapterOpts());
		const r = await ad.send(qqAdapter(), qqTarget("group", { groupOpenid: "G1" }), TEXT);
		expect(r.ok).toBe(true);
		const msg = callsTo("/v2/groups/G1/messages");
		expect(msg).toHaveLength(1);
		const init = msg[0]?.[1] as { headers: Record<string, string> };
		expect(init.headers.authorization).toBe("QQBot TKN");
		expect(init.headers["x-union-appid"]).toBe("APPID");
		expect(bodyOf(msg[0] as unknown[])).toEqual({ content: "阿绫发布了动态", msg_type: 0 });
	});

	it("private:POST /v2/users/{openid}/messages", async () => {
		const ad = createQQOfficialAdapter(adapterOpts());
		const r = await ad.send(qqAdapter(), qqTarget("private", { userOpenid: "U1" }), TEXT);
		expect(r.ok).toBe(true);
		expect(callsTo("/v2/users/U1/messages")).toHaveLength(1);
	});

	it("channel:POST /channels/{channelId}/messages,JSON content", async () => {
		const ad = createQQOfficialAdapter(adapterOpts());
		const r = await ad.send(qqAdapter(), qqTarget("channel", { channelId: "C1" }), TEXT);
		expect(r.ok).toBe(true);
		const msg = callsTo("/channels/C1/messages");
		expect(msg).toHaveLength(1);
		expect(bodyOf(msg[0] as unknown[]).content).toBe("阿绫发布了动态");
	});

	it("session 缺字段 → 直接失败,不发 token/REST", async () => {
		const ad = createQQOfficialAdapter(adapterOpts());
		const r = await ad.send(qqAdapter(), qqTarget("group", {}), TEXT);
		expect(r.ok).toBe(false);
		expect(r.err).toMatch(/groupOpenid/);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe("createQQOfficialAdapter — send 图片(群/C2C 两步上传)", () => {
	const IMG: NotificationPayload = {
		kind: "image",
		image: { buffer: Buffer.from("png-bytes"), mime: "image/png" },
		caption: "阿绫开播了",
	};

	it("group 图片:先 POST /files(base64 file_data)→ 再 POST /messages media(msg_type 7)", async () => {
		const ad = createQQOfficialAdapter(adapterOpts());
		const r = await ad.send(qqAdapter(), qqTarget("group", { groupOpenid: "G1" }), IMG);
		expect(r.ok).toBe(true);
		const upload = callsTo("/v2/groups/G1/files");
		expect(upload).toHaveLength(1);
		const uploadBody = bodyOf(upload[0] as unknown[]);
		expect(uploadBody.file_type).toBe(1);
		expect(uploadBody.srv_send_msg).toBe(false);
		expect(uploadBody.file_data).toBe(Buffer.from("png-bytes").toString("base64"));
		const msg = callsTo("/v2/groups/G1/messages");
		expect(msg).toHaveLength(1);
		const msgBody = bodyOf(msg[0] as unknown[]);
		expect(msgBody.msg_type).toBe(7);
		expect(msgBody.media).toEqual({ file_uuid: "FUUID", file_info: "FILEINFO", ttl: 3600 });
		expect(msgBody.content).toBe("阿绫开播了");
	});

	it("group composite 卡片图+文案:合并成一条 media 消息", async () => {
		const ad = createQQOfficialAdapter(adapterOpts());
		const r = await ad.send(qqAdapter(), qqTarget("group", { groupOpenid: "G1" }), {
			kind: "composite",
			segments: [
				{ type: "image", buffer: Buffer.from("png-bytes"), mime: "image/png" },
				{ type: "text", text: "阿绫开播了" },
			],
		});
		expect(r.ok).toBe(true);
		expect(callsTo("/v2/groups/G1/files")).toHaveLength(1);
		const msg = callsTo("/v2/groups/G1/messages");
		expect(msg).toHaveLength(1);
		const msgBody = bodyOf(msg[0] as unknown[]);
		expect(msgBody).toMatchObject({
			content: "阿绫开播了",
			msg_type: 7,
			media: { file_uuid: "FUUID", file_info: "FILEINFO", ttl: 3600 },
		});
	});

	it("channel 图片:multipart file_image 单条(body 是 FormData,无 content-type 头)", async () => {
		const ad = createQQOfficialAdapter(adapterOpts());
		const r = await ad.send(qqAdapter(), qqTarget("channel", { channelId: "C1" }), IMG);
		expect(r.ok).toBe(true);
		const msg = callsTo("/channels/C1/messages");
		expect(msg).toHaveLength(1);
		const init = msg[0]?.[1] as { body: unknown; headers: Record<string, string> };
		expect(init.body).toBeInstanceOf(FormData);
		expect(init.headers["content-type"]).toBeUndefined();
		// 频道不走 /files 两步上传。
		expect(callsTo("/files")).toHaveLength(0);
	});
});

describe("createQQOfficialAdapter — 图集 markdown 门控(按 botType)", () => {
	const GALLERY: NotificationPayload = {
		kind: "forward-images",
		images: [
			{ url: "https://i0.hdslb.com/1.jpg", width: 800, height: 600 },
			{ url: "https://i0.hdslb.com/2.jpg", width: 1000, height: 1000 },
		],
		forward: true,
	};

	it("私域 group:图集合并成一条 markdown(msg_type 2),不走 /files 上传", async () => {
		const ad = createQQOfficialAdapter(adapterOpts());
		const r = await ad.send(
			qqAdapter({ botType: "private" }),
			qqTarget("group", { groupOpenid: "G1" }),
			GALLERY,
		);
		expect(r.ok).toBe(true);
		expect(callsTo("/files")).toHaveLength(0); // markdown 不上传
		const msg = callsTo("/v2/groups/G1/messages");
		expect(msg).toHaveLength(1); // 一条搞定
		const body = bodyOf(msg[0] as unknown[]);
		expect(body.msg_type).toBe(2);
		const content = (body.markdown as { content: string }).content;
		expect(content).toContain("![图片 #800px #600px](https://i0.hdslb.com/1.jpg)");
		expect(content).toContain("![图片 #1000px #1000px](https://i0.hdslb.com/2.jpg)");
	});

	it("公域 group:图集走 N 条 media(每图 /files + /messages),不发 markdown", async () => {
		const ad = createQQOfficialAdapter(adapterOpts());
		const r = await ad.send(
			qqAdapter({ botType: "public" }),
			qqTarget("group", { groupOpenid: "G1" }),
			GALLERY,
		);
		expect(r.ok).toBe(true);
		expect(callsTo("/v2/groups/G1/files")).toHaveLength(2); // 两图各上传一次
		const msgs = callsTo("/v2/groups/G1/messages");
		expect(msgs).toHaveLength(2);
		expect(bodyOf(msgs[0] as unknown[]).msg_type).toBe(7); // media,非 markdown
	});

	it("私域 channel:图集不走 markdown(频道用频道消息 API,markdown 仅群/C2C)", async () => {
		const ad = createQQOfficialAdapter(adapterOpts());
		const r = await ad.send(
			qqAdapter({ botType: "private" }),
			qqTarget("channel", { channelId: "C1" }),
			GALLERY,
		);
		expect(r.ok).toBe(true);
		const msgs = callsTo("/channels/C1/messages");
		expect(msgs).toHaveLength(2); // 每图一条频道消息(image url)
		expect(bodyOf(msgs[0] as unknown[]).markdown).toBeUndefined();
	});
});

describe("createQQOfficialAdapter — A+ 投递语义 / 失败", () => {
	it("202 + 审核中 → DeliveryResult ok(已提交)", async () => {
		fetchMock.mockImplementation(async (url: string) => {
			if (url.includes("getAppAccessToken"))
				return res(200, { access_token: "T", expires_in: 7200 });
			return res(202, {
				code: 304023,
				message: "waiting for audit",
				data: { message_audit: { audit_id: "A1" } },
			});
		});
		const ad = createQQOfficialAdapter(adapterOpts());
		const r = await ad.send(qqAdapter(), qqTarget("group", { groupOpenid: "G1" }), TEXT);
		expect(r.ok).toBe(true);
	});

	it("4xx 业务错误 → DeliveryResult 失败(带 code)", async () => {
		fetchMock.mockImplementation(async (url: string) => {
			if (url.includes("getAppAccessToken"))
				return res(200, { access_token: "T", expires_in: 7200 });
			return res(400, { code: 11293, message: "bad request" });
		});
		const ad = createQQOfficialAdapter(adapterOpts());
		const r = await ad.send(qqAdapter(), qqTarget("group", { groupOpenid: "G1" }), TEXT);
		expect(r.ok).toBe(false);
		expect(r.err).toMatch(/11293/);
	});
});

describe("createQQOfficialAdapter — probe / 生命周期", () => {
	it("未 reconcile(无网关连接)→ probe ok:false", async () => {
		const ad = createQQOfficialAdapter(adapterOpts());
		const p = await ad.probe(qqAdapter());
		expect(p.ok).toBe(false);
	});

	it("dispose 幂等不抛", () => {
		const ad = createQQOfficialAdapter(adapterOpts());
		expect(() => ad.dispose?.()).not.toThrow();
		expect(() => ad.dispose?.()).not.toThrow();
	});
});
