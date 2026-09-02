import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { fetchThroughMirrors } from "../fetch-through-mirrors.js";

/**
 * 升级用的取字节通道。清单和 25MB 载荷走**同一条**路径 —— 一条传输、一条信任链,
 * 全程不碰 `api.github.com`(代理站基本不代它,而且 API 的回答没有我们的签名)。
 *
 * 候选顺序由调用方给,这里不含策略:直连排第几是上层的事。
 */
afterEach(() => {
	vi.unstubAllGlobals();
});

const RELEASE_URL =
	"https://github.com/Akokk0/bilibili-notify/releases/download/v0.9.0/latest.json";

function okResponse(body: string): Response {
	return new Response(body, { status: 200 });
}

/** 照单全收 —— 只测传输层那几条时用。 */
const takeAll = (bytes: Uint8Array) => ({ ok: true as const, value: bytes });

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe("fetchThroughMirrors", () => {
	it("候选返回非 2xx 也算失败 → 换下一个,而不是把错误页当内容收下", async () => {
		// 代理站挂掉时**多半不是抛错,而是返回一个 502/404 页面**。只 catch 异常的
		// 实现会把那张错误页当成清单收下,然后在验签那里报「签名不对」—— 用户看到
		// 的是一条完全指错方向的错误信息。
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(new Response("<html>502 Bad Gateway</html>", { status: 502 }))
			.mockResolvedValueOnce(okResponse("真正的清单"));
		vi.stubGlobal("fetch", fetchMock);

		const result = await fetchThroughMirrors({
			url: RELEASE_URL,
			mirrors: ["https://mirror-down.example", "https://mirror-ok.example"],
			maxBytes: 1024,
			timeoutMs: 1000,
			accept: takeAll,
		});

		if (!result.ok) throw new Error(`expected ok, got reason=${result.reason}`);
		expect(new TextDecoder().decode(result.value)).toBe("真正的清单");
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("候选往死里灌 body → 超过上限当场中断,不缓冲完再检查", async () => {
		// 恶意或坏掉的代理站可以一直往我们这儿灌。容器堆上限才 512MB,「先全收下
		// 再看大小」等于把内存交给对方决定 —— 那不是防护,是把炸弹先抱进怀里。
		const CHUNK = 256;
		const MAX = 1024;
		let chunksPulled = 0;
		const flood = new ReadableStream({
			pull(controller) {
				chunksPulled++;
				if (chunksPulled > 10_000) return controller.close();
				controller.enqueue(new Uint8Array(CHUNK));
			},
		});

		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(new Response(flood, { status: 200 }))
			.mockResolvedValueOnce(okResponse("小小的清单"));
		vi.stubGlobal("fetch", fetchMock);

		const result = await fetchThroughMirrors({
			url: RELEASE_URL,
			mirrors: ["https://mirror-flood.example", "https://mirror-ok.example"],
			maxBytes: MAX,
			timeoutMs: 1000,
			accept: takeAll,
		});

		if (!result.ok) throw new Error(`expected ok, got reason=${result.reason}`);
		expect(new TextDecoder().decode(result.value)).toBe("小小的清单");
		// 上限 / 每块大小 = 拉到第 4 块就该收手。给一点余量,但**远小于**那 10000 块
		// —— 缓冲式的假防护会把它们全拉完,这条断言就是用来分辨这两者的。
		expect(chunksPulled).toBeLessThanOrEqual(MAX / CHUNK + 4);
	});

	it("候选卡住不响应 → 超时后换下一个,不无限等", { timeout: 1000 }, async () => {
		// **卡住的站比失败的站更糟** —— 失败会立刻换下一个,卡住会把整次检查更新
		// 挂在那儿。而代理站最常见的死法恰恰是卡住,不是干脆地拒绝。
		//
		// 这个假 fetch 故意写成「拿不到 signal 就永远不 settle」:如果实现根本没传
		// signal,测试会**超时失败**而不是悄悄走到下一个候选 —— 否则这条断言是空跑。
		const TIMEOUT_MS = 30;
		const fetchMock = vi
			.fn()
			.mockImplementationOnce(
				(_url: string, init?: RequestInit) =>
					new Promise((_resolve, reject) => {
						init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
					}),
			)
			.mockResolvedValueOnce(okResponse("终于拿到了"));
		vi.stubGlobal("fetch", fetchMock);

		const result = await fetchThroughMirrors({
			url: RELEASE_URL,
			mirrors: ["https://mirror-hangs.example", "https://mirror-ok.example"],
			maxBytes: 1024,
			timeoutMs: TIMEOUT_MS,
			accept: takeAll,
		});

		if (!result.ok) throw new Error(`expected ok, got reason=${result.reason}`);
		expect(new TextDecoder().decode(result.value)).toBe("终于拿到了");
	});

	it("第一个候选就成功 → 后面的一个都不碰", async () => {
		const fetchMock = vi.fn().mockResolvedValue(okResponse("拿到了"));
		vi.stubGlobal("fetch", fetchMock);

		await fetchThroughMirrors({
			url: RELEASE_URL,
			mirrors: ["https://first.example", "https://second.example"],
			maxBytes: 1024,
			timeoutMs: 1000,
			accept: takeAll,
		});

		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("空串候选表示直连;其余按 {前缀}/{原地址} 拼,末尾斜杠不重复", async () => {
		const fetchMock = vi
			.fn()
			.mockRejectedValueOnce(new Error("直连不通"))
			.mockResolvedValueOnce(okResponse("经代理站拿到了"));
		vi.stubGlobal("fetch", fetchMock);

		await fetchThroughMirrors({
			url: RELEASE_URL,
			// 海外用户会把直连排在最前,国内用户排在最后 —— 顺序是上层的策略,
			// 这个函数只负责照单全试。
			mirrors: ["", "https://ghproxy.example/"],
			maxBytes: 1024,
			timeoutMs: 1000,
			accept: takeAll,
		});

		expect(fetchMock.mock.calls[0]?.[0]).toBe(RELEASE_URL);
		expect(fetchMock.mock.calls[1]?.[0]).toBe(`https://ghproxy.example/${RELEASE_URL}`);
	});

	it("候选回 200 但内容验收不过 → 换下一个,直连排在末尾也照样轮得到", async () => {
		// 国内代理站最常见的死法不是 502,而是 **200 + 一张限流 / 门户 HTML**。只在
		// 非 2xx 时换站的实现会把那张页当内容收下,验签一失败整条更新就死了 ——
		// 而直连(永远在列表末尾)从没被试过。验收必须在候选循环**里面**。
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(okResponse("<html>请求过快,请稍后再试</html>"))
			.mockResolvedValueOnce(okResponse("真正的清单"));
		vi.stubGlobal("fetch", fetchMock);

		const result = await fetchThroughMirrors({
			url: RELEASE_URL,
			mirrors: ["https://mirror-garbage.example", ""],
			maxBytes: 1024,
			timeoutMs: 1000,
			accept: (bytes) =>
				decode(bytes) === "真正的清单"
					? { ok: true, value: decode(bytes) }
					: { ok: false, reason: "malformed" as const },
		});

		if (!result.ok) throw new Error(`expected ok, got reason=${result.reason}`);
		expect(result.value).toBe("真正的清单");
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(fetchMock.mock.calls[1]?.[0]).toBe(RELEASE_URL);
	});

	it("全部候选都拿到了字节但都验收不过 → 归因用**最后一个**候选的验收理由", async () => {
		// 直连永远是最后一个:它说「签名不对」才是真信号;前面代理站说什么都可能是抽风。
		vi.stubGlobal(
			"fetch",
			vi.fn().mockImplementation(async () => okResponse("垃圾")),
		);

		const result = await fetchThroughMirrors({
			url: RELEASE_URL,
			mirrors: ["https://a.example", ""],
			maxBytes: 1024,
			timeoutMs: 1000,
			accept: () => ({ ok: false, reason: "untrusted" as const }),
		});

		expect(result.ok).toBe(false);
		expect(result.ok === false && result.reason).toBe("untrusted");
	});

	it("前面的候选验收不过、最后一个候选网络失败 → all-mirrors-failed,不把代理站的垃圾页报成安全事件", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(okResponse("垃圾"))
			.mockRejectedValueOnce(new Error("直连不通"));
		vi.stubGlobal("fetch", fetchMock);

		const result = await fetchThroughMirrors({
			url: RELEASE_URL,
			mirrors: ["https://a.example", ""],
			maxBytes: 1024,
			timeoutMs: 1000,
			accept: () => ({ ok: false, reason: "untrusted" as const }),
		});

		expect(result.ok).toBe(false);
		expect(result.ok === false && result.reason).toBe("all-mirrors-failed");
	});

	it("所有候选都失败 → 返回失败结果,不抛", async () => {
		// 检查更新失败是**常态**(用户断网、代理站集体抽风),它绝不能变成一个能把
		// 推送服务带走的异常。
		const fetchMock = vi.fn().mockRejectedValue(new Error("网络不通"));
		vi.stubGlobal("fetch", fetchMock);

		const result = await fetchThroughMirrors({
			url: RELEASE_URL,
			mirrors: ["https://a.example", "https://b.example"],
			maxBytes: 1024,
			timeoutMs: 1000,
			accept: takeAll,
		});

		expect(result.ok).toBe(false);
		expect(result.ok === false && result.reason).toBe("all-mirrors-failed");
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});
});
