import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { api } from "../api";

/**
 * SY1 的线格式收口。`JSON.stringify` 会把值为 `undefined` 的键整个丢掉,于是
 * 「把一个可选字段清空」在 PATCH body 里根本表达不出来 —— 键消失了,服务端
 * deepMerge 读作「本字段不改」,旧值原样留下(玻璃片透明度关掉后存不掉、日志
 * 覆盖清不干净都是这一个根因)。服务端约定显式 `null` = 清除,所以 PATCH 出口
 * 统一把 `undefined` 改写成 `null`。POST 不做这件事:那是创建语义,`undefined`
 * 表示「没有这个字段」,擅自转成 null 会被后端 schema 拒掉。
 */
function jsonResponse(): Response {
	return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
}

function sentBody(): unknown {
	const call = vi.mocked(globalThis.fetch).mock.calls.at(-1);
	const init = call?.[1] as RequestInit;
	return JSON.parse(String(init.body));
}

beforeEach(() => {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => jsonResponse()),
	);
});
afterEach(() => vi.unstubAllGlobals());

describe("api.patch wire format", () => {
	it("rewrites a cleared optional field to the null clear-sentinel", async () => {
		await api.patch("/api/globals", { app: { userAgent: undefined } });

		expect(sentBody()).toEqual({ app: { userAgent: null } });
	});

	it("reaches arbitrarily deep — a cleared glassOpacity survives as null", async () => {
		await api.patch("/api/globals", {
			defaults: { cardStyle: { font: "sans", glassOpacity: undefined } },
		});

		expect(sentBody()).toEqual({
			defaults: { cardStyle: { font: "sans", glassOpacity: null } },
		});
	});

	it("leaves an explicit null, real values, and arrays alone", async () => {
		await api.patch("/api/subs/1", {
			overrides: { cardStyle: null },
			groups: ["重点"],
			enabled: false,
		});

		expect(sentBody()).toEqual({
			overrides: { cardStyle: null },
			groups: ["重点"],
			enabled: false,
		});
	});

	it("does not rewrite POST bodies — there `undefined` means 'no such field'", async () => {
		await api.post("/api/cards/preview", { kind: "dynamic", layout: undefined });

		expect(sentBody()).toEqual({ kind: "dynamic" });
	});
});

/**
 * 错误信息的取字段。
 *
 * 服务端有**两种**错误体形状:`{err}`(锐评 / 推送测试 …)和 `{message}`
 * (backup …)。`request` 原来只认 `message`,于是所有 `{err}` 类失败都被降级成
 * 「POST /api/… → 400」这种线格式噪音 —— 用户看到的不是「智能女仆尚未启用」,
 * 而是一个毫无指向的状态码,只能来问「功能是不是没写」。
 */
describe("api 错误信息", () => {
	const fail = (status: number, body: unknown) =>
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(JSON.stringify(body), {
						status,
						headers: { "content-type": "application/json" },
					}),
			),
		);

	it("读得出 {err} 形状的原因", async () => {
		fail(400, { ok: false, err: "智能女仆尚未启用" });
		await expect(api.post("/api/stats/roast/1", {})).rejects.toThrow("智能女仆尚未启用");
	});

	it("读得出 {message} 形状的原因", async () => {
		fail(400, { error: "pin_required", message: "a full backup requires a PIN" });
		await expect(api.post("/api/backup/export", {})).rejects.toThrow(
			"a full backup requires a PIN",
		);
	});

	it("两个字段都没有时退回线格式,至少带上状态码", async () => {
		fail(500, { nope: 1 });
		await expect(api.post("/api/whatever", {})).rejects.toThrow("500");
	});
});

/**
 * 断线(压根没拿到 HTTP 响应)与「服务端返回了一个错误」是两码事,给用户的话也该
 * 两样。`fetch` 在连接被切断时抛的是原生 `TypeError: Failed to fetch` —— 那句话
 * 对用户零信息量:他不知道是没网、是服务挂了、还是反代把长请求掐了。
 *
 * 真实案例:卡片全家福四张卡同时请求,服务端串行渲染,最后几张排队超过反代超时被
 * 切断。服务端日志一路「渲染完成」,用户屏幕上只有三块「渲染失败 · Failed to fetch」,
 * 两边对不上,根本没法查。
 */
describe("api 断线", () => {
	const offline = (message = "Failed to fetch") =>
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new TypeError(message);
			}),
		);

	it("包装成 status=0 的 ApiError —— 调用方据此把断线与 HTTP 错误分开处理", async () => {
		offline();
		await expect(api.post("/api/cards/preview", {})).rejects.toMatchObject({
			name: "ApiError",
			status: 0,
		});
	});

	it("消息说人话,并保留原始那句供排查", async () => {
		offline();
		// 「连接中断」是给用户看的结论,「Failed to fetch」是给排查的人对线索用的。
		await expect(api.post("/api/cards/preview", {})).rejects.toThrow(/连接中断.*Failed to fetch/);
	});

	it("上传与取二进制走同一套 —— 三条出口都会断线,不能只包一条", async () => {
		offline();
		await expect(api.upload("/api/cards/font-asset", new FormData())).rejects.toMatchObject({
			status: 0,
		});
		await expect(api.blob("/api/cards/asset/x")).rejects.toMatchObject({ status: 0 });
	});

	it("不吞掉真正的程序错误 —— 非 TypeError 原样抛出", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new RangeError("boom");
			}),
		);
		await expect(api.post("/api/whatever", {})).rejects.toThrow(RangeError);
	});
});

/**
 * 预览请求走客户端串行队列(cards/preview-queue.ts):后一张卡要等前一张 settle 才
 * 发得出去。于是「一个永不落地的请求」不再只坑它自己 —— 服务端收下了 POST 却不回应
 * (puppeteer 挂住并占着渲染闸门、代理不 reset 而是干晾着连接),那条 fetch 永远不
 * settle,队尾就永远不前进,后面几张卡连请求都发不出去,屏幕上只剩一排转圈、连错误
 * 文字都没有。请求本身必须有个死线,到点就断,让队伍能往前挪。
 */
describe("api 请求死线", () => {
	/** 只认 abort、否则永不落地的 fetch —— 模拟「服务端收下了但不回应」。 */
	const neverSettles = () =>
		vi.stubGlobal(
			"fetch",
			vi.fn(
				(_url: string, init: RequestInit) =>
					new Promise((_resolve, reject) => {
						init.signal?.addEventListener("abort", () =>
							reject(
								Object.assign(new Error("This operation was aborted"), { name: "TimeoutError" }),
							),
						);
					}),
			),
		);

	it("到点就断,而不是把整条队伍一起挂死", async () => {
		neverSettles();
		await expect(api.post("/api/cards/preview", {}, { timeoutMs: 20 })).rejects.toMatchObject({
			name: "ApiError",
			status: 0,
		});
	});

	it("说清楚是等超时了,别跟「连接被切」混为一谈", async () => {
		neverSettles();
		await expect(api.post("/api/cards/preview", {}, { timeoutMs: 20 })).rejects.toThrow(/超时/);
	});

	it("真的把 signal 交给了 fetch —— 否则那条连接还在后台吊着", async () => {
		neverSettles();
		await api.post("/api/cards/preview", {}, { timeoutMs: 20 }).catch(() => undefined);
		const init = vi.mocked(globalThis.fetch).mock.calls.at(-1)?.[1] as RequestInit;
		expect(init.signal).toBeInstanceOf(AbortSignal);
	});

	it("没给死线的请求不受影响 —— 别给所有请求平白加一道超时", async () => {
		neverSettles();
		let settled = false;
		void api.post("/api/whatever", {}).then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		await new Promise((r) => setTimeout(r, 60));
		expect(settled).toBe(false);
	});
});
