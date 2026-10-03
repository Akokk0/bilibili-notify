import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { ApiError, api, apiErrorOf, issuesOf, setUnauthorizedHandler } from "../api";

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
		await api.patch("/api/settings", { app: { userAgent: undefined } });

		expect(sentBody()).toEqual({ app: { userAgent: null } });
	});

	it("reaches arbitrarily deep — a cleared glassOpacity survives as null", async () => {
		await api.patch("/api/settings", {
			defaults: { cardStyle: { font: "sans", glassOpacity: undefined } },
		});

		expect(sentBody()).toEqual({
			defaults: { cardStyle: { font: "sans", glassOpacity: null } },
		});
	});

	it("leaves an explicit null, real values, and arrays alone", async () => {
		await api.patch("/api/subscriptions/1", {
			overrides: { cardStyle: null },
			tagIds: ["11111111-1111-4111-8111-111111111111"],
			enabled: false,
		});

		expect(sentBody()).toEqual({
			overrides: { cardStyle: null },
			tagIds: ["11111111-1111-4111-8111-111111111111"],
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
 * 服务端的非 2xx 一律回平铺的 `{ code, message }`(可选 `issues`)。旧形状 `{err}` / `{error, message}` /
 * `{errors:[…]}` 不再被认 —— 服务端不会再回它们(④b 最后一组路由迁完),兼容代码已删。认不出的体退回
 * 线格式 `方法 路径 → 状态码`,至少带上状态码。
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

	it("读得出 {code, message} 形状的原因", async () => {
		fail(400, { code: "invalid", message: "清单里缺少 id" });
		await expect(api.post("/api/ext/install", {})).rejects.toThrow("清单里缺少 id");
	});

	it.each([
		["{ ok: false, err }", { ok: false, err: "动作没有执行成功" }],
		["{ error, message }", { error: "invalid_manifest", message: "清单里缺少 id" }],
		["{ ok: false, errors: […] }", { ok: false, errors: ["甲不对", "乙不对"] }],
	])("旧形状 %s 不再被认:退回线格式,至少带上状态码", async (_label, body) => {
		fail(400, body);
		await expect(api.post("/api/ext/install", {})).rejects.toThrow("POST /api/ext/install → 400");
	});

	it("什么都没有时退回线格式,至少带上状态码", async () => {
		fail(500, { nope: 1 });
		await expect(api.post("/api/whatever", {})).rejects.toThrow("500");
	});
});

/**
 * 非 2xx 只解析一次成 `ApiError`(ADR-0026 决策 6):只认平铺的 `{ code, message, issues? }`,
 * `code` 得在标准码表里。旧形状(`err` / `error` / `errors[]`)不再被认。
 */
describe("ApiError 解析非 2xx(只认平铺的 { code, message })", () => {
	const respond = (status: number, body: unknown) =>
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
	const caught = async (run: () => Promise<unknown>): Promise<ApiError> => {
		try {
			await run();
		} catch (e) {
			return e as ApiError;
		}
		throw new Error("应当抛 ApiError,却成功了");
	};

	it("新形状:code / message 直接取,status 与原始 body 都保留", async () => {
		const body = { code: "not_found", message: "没有这个订阅" };
		respond(404, body);
		const err = await caught(() => api.get("/api/subscriptions/x"));
		expect(err).toBeInstanceOf(ApiError);
		expect(err.status).toBe(404);
		expect(err.code).toBe("not_found");
		expect(err.message).toBe("没有这个订阅");
		expect(err.issues).toBeUndefined();
		expect(err.body).toEqual(body);
	});

	it("新形状带 issues:逐条原因原样挂在 ApiError 上(含拓展设置那处的 op)", async () => {
		respond(400, {
			code: "invalid",
			message: "配置不合规",
			issues: [{ path: ["links", "a", 0], message: "不能为空", op: 2 }, { message: "整体不对" }],
		});
		const err = await caught(() => api.patch("/api/x", {}));
		expect(err.code).toBe("invalid");
		expect(err.issues).toEqual([
			{ path: ["links", "a", 0], message: "不能为空", op: 2 },
			{ message: "整体不对" },
		]);
	});

	it("新形状的 upstreamCode 不占位:它留在原始 body 里,ApiError 不另开一格", async () => {
		respond(503, { code: "unavailable", message: "B 站没回应", upstreamCode: -352 });
		const err = await caught(() => api.get("/api/x"));
		expect(err.code).toBe("unavailable");
		expect(err.body).toMatchObject({ upstreamCode: -352 });
	});

	it("码表里没有的 code 不冒充标准码 —— 这份体不算认得,退回线格式", async () => {
		respond(400, { code: "no_such_code", message: "还是能读到这句" });
		const err = await caught(() => api.get("/api/x"));
		expect(err.code).toBeUndefined();
		expect(err.message).toBe("GET /api/x → 400");
	});

	it("数字 code(平台的码塞进 code 的旧写法)不冒充标准码", async () => {
		respond(502, { code: -352, message: "无法访问 B 站" });
		const err = await caught(() => api.get("/api/x"));
		expect(err.code).toBeUndefined();
		expect(err.message).toBe("GET /api/x → 502");
	});

	it("没有 message 的体不算认得:只有 code 说明不了什么", async () => {
		respond(400, { code: "invalid" });
		const err = await caught(() => api.get("/api/x"));
		expect(err.code).toBeUndefined();
		expect(err.message).toBe("GET /api/x → 400");
	});

	/** 旧形状不再被认:服务端一律回平铺的 { code, message },这几种不会再出现,认它们只会掩盖漏迁的路由。 */
	it.each([
		["{ ok: false, err }", { ok: false, err: "动作没有执行成功" }],
		["{ error, message }", { error: "upstream_failed", message: "无法访问 B 站" }],
		["{ ok: false, errors: […] }", { ok: false, errors: ["甲不对", "乙不对"] }],
		[
			"{ error: 'validation_failed', issues }",
			{ error: "validation_failed", issues: [{ path: ["a"], message: "不对" }] },
		],
	])("旧形状 %s 不再被认:code / issues 为空,message 退回线格式", async (_label, body) => {
		respond(400, body);
		const err = await caught(() => api.post("/api/x", {}));
		expect(err.status).toBe(400);
		expect(err.code).toBeUndefined();
		expect(err.issues).toBeUndefined();
		expect(err.message).toBe("POST /api/x → 400");
	});

	it("什么形状都不是:退回线格式 `方法 路径 → 状态码`", async () => {
		respond(500, { nope: 1 });
		const err = await caught(() => api.post("/api/whatever", {}));
		expect(err.message).toBe("POST /api/whatever → 500");
		expect(err.code).toBeUndefined();
	});

	it("上传走同一套解析", async () => {
		respond(413, { code: "invalid", message: "图片过大（上限 5MB）" });
		const err = await caught(() => api.upload("/api/cards/asset", new FormData()));
		expect(err.status).toBe(413);
		expect(err.code).toBe("invalid");
		expect(err.message).toBe("图片过大（上限 5MB）");
	});

	it("apiErrorOf 给拼 ApiError 的其它出口用(不走 api 的 fetch):同一套解析,兜底句自己给", () => {
		const err = apiErrorOf(429, { code: "rate_limited", message: "慢一点" }, "登录失败");
		expect(err).toBeInstanceOf(ApiError);
		expect([err.status, err.code, err.message]).toEqual([429, "rate_limited", "慢一点"]);
		expect(apiErrorOf(500, undefined, "登录失败").message).toBe("登录失败");
	});
});

describe("issuesOf", () => {
	const errorWith = (status: number, body: unknown) => new ApiError(status, body, "x");

	it("新形状:取 issues", () => {
		const err = errorWith(400, {
			code: "invalid",
			message: "配置不合规",
			issues: [{ path: ["a"], message: "不对" }],
		});
		expect(issuesOf(err)).toEqual([{ path: ["a"], message: "不对" }]);
	});

	it("路径里非 string / number 的段丢掉,缺话给兜底句,op 有才带", () => {
		const err = errorWith(400, {
			code: "invalid",
			message: "拓展设置没通过检查",
			issues: [
				{ path: ["links", 1, { x: 1 }], message: "不对", op: 3 },
				{ message: "整体不对" },
				"怪东西",
			],
		});
		expect(issuesOf(err)).toEqual([
			{ path: ["links", 1], message: "不对", op: 3 },
			{ message: "整体不对" },
			{ message: "不合规矩" },
		]);
	});

	it("旧形状(error: 'validation_failed')带 issues 不再被认", () => {
		expect(
			issuesOf(errorWith(400, { error: "validation_failed", issues: [{ message: "x" }] })),
		).toBeNull();
	});

	it("没有 issues 的 ApiError / 别的错误 / 非错误 → null", () => {
		expect(issuesOf(errorWith(404, { code: "not_found", message: "没有" }))).toBeNull();
		expect(issuesOf(new Error("boom"))).toBeNull();
		expect(issuesOf(undefined)).toBeNull();
	});

	it("空数组也是 issues(服务端明说了「没有逐条原因」),不该被当成没有", () => {
		expect(issuesOf(errorWith(400, { code: "invalid", message: "x", issues: [] }))).toEqual([]);
	});
});

/**
 * 全局 401 钩子(踢回登录框)靠**状态码**认,不看 code:`unauthorized` 默认回 403,
 * 只有看板自己的登录失效才显式回 401 —— 所以钩子一直认 401,`/api/session/*` 除外。
 */
describe("全局 401 钩子", () => {
	const respond = (status: number, body: unknown) =>
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
	afterEach(() => setUnauthorizedHandler(null));

	it("401(新形状)→ 钩子触发一次,错误照常抛", async () => {
		const hook = vi.fn();
		setUnauthorizedHandler(hook);
		respond(401, { code: "unauthorized", message: "需要先登录面板" });
		await expect(api.get("/api/settings")).rejects.toMatchObject({
			status: 401,
			code: "unauthorized",
		});
		expect(hook).toHaveBeenCalledTimes(1);
	});

	it("401 只看状态码:体认不出来也触发", async () => {
		const hook = vi.fn();
		setUnauthorizedHandler(hook);
		respond(401, { nope: "dashboard session required" });
		await expect(api.get("/api/settings")).rejects.toMatchObject({ status: 401 });
		expect(hook).toHaveBeenCalledTimes(1);
	});

	it("403 的 unauthorized(来源、平台的凭据失效)不踢人 —— 只有看板自己的 401 才踢", async () => {
		const hook = vi.fn();
		setUnauthorizedHandler(hook);
		respond(403, { code: "unauthorized", message: "B 站登录失效了" });
		await expect(api.get("/api/subscriptions/search")).rejects.toMatchObject({ status: 403 });
		expect(hook).not.toHaveBeenCalled();
	});

	it("/api/session/* 的 401 是「账号密码错」,不是会话过期,不触发", async () => {
		const hook = vi.fn();
		setUnauthorizedHandler(hook);
		respond(401, { code: "unauthorized", message: "账号或密码错误" });
		await expect(api.post("/api/session/login", {})).rejects.toMatchObject({ status: 401 });
		expect(hook).not.toHaveBeenCalled();
	});

	it("上传与取二进制两条出口也触发", async () => {
		const hook = vi.fn();
		setUnauthorizedHandler(hook);
		respond(401, { code: "unauthorized", message: "需要先登录面板" });
		await api.upload("/api/cards/asset", new FormData()).catch(() => undefined);
		await api.blob("/api/cards/asset/x").catch(() => undefined);
		expect(hook).toHaveBeenCalledTimes(2);
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

/**
 * `withOffline` 是按**异常类型**认断线的:`fetch` 只在连接层失败时抛 TypeError。
 * 可 TypeError 不是 fetch 的专利 —— 循环引用 / BigInt 会让 `JSON.stringify` 抛
 * TypeError,非法字符会让 `Headers.set` 抛 TypeError。这些活儿要是也跑在被包住的
 * 闭包里,一个前端自己的 bug 就会被报成「连接中断」,还附赠一句「去调反向代理的读
 * 超时」—— 人被支去查一个根本不存在的网络问题,真正的错误反倒不见了。
 *
 * 结论:只有**网络调用本身**该待在包装里,组请求的活儿必须挪到外面。
 */
describe("api 错误归因", () => {
	it("组不出请求体时原样抛出真错误,不谎报断线", async () => {
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		// 这次请求压根没发出去,说成「连接中断」就是把线索指反了方向。
		await expect(api.post("/api/cards/preview", circular)).rejects.toThrow(TypeError);
	});

	it("组不出请求体时连 fetch 都不该被调用", async () => {
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		await api.post("/api/cards/preview", circular).catch(() => undefined);
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});

	/**
	 * 另一头:响应**状态行已经回来了**(fetch 已 resolve、res.ok 为 true),body 却读
	 * 到一半断了 —— 服务端被 OOM 杀掉、反代读超时到点,都会这样。这时 withOffline
	 * 什么都看不到,而读 body 的失败被 `.catch(() => undefined)` 吞掉之后,ok 分支就
	 * 把 undefined 当成功结果返回,调用方再去读它的字段,炸出一句谁也看不懂的
	 * 「Cannot read properties of undefined」。得如实说这次没拿全。
	 */
	it("ok 响应的 body 读不全时如实报错,而不是返回 undefined", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response("{只有半", { status: 200, headers: { "content-type": "application/json" } }),
			),
		);
		await expect(api.get("/api/settings")).rejects.toMatchObject({ name: "ApiError" });
	});

	it("HTTP 错误响应的 body 坏掉时仍报那个状态码 —— 状态码比解析失败有用得多", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response("{坏", { status: 503, headers: { "content-type": "application/json" } }),
			),
		);
		await expect(api.get("/api/settings")).rejects.toMatchObject({ status: 503 });
	});
});
