import { describe, expect, it } from "vite-plus/test";
import { BilibiliAPI } from "../bilibili-api";

/**
 * User-Agent 判定必须单点收口(getUserAgent):配置为空 / 纯空白 → 回退内置
 * 身份 UA,有值 → trim 后使用。HTTP 默认头与弹幕 WSS 都从这里取 ——
 * 判定分叉(trim 与 || 各一套)会让一个进程发两套指纹,恰与同指纹目标相反。
 */
function makeApi(userAgent: string | undefined) {
	const logger = { info() {}, warn() {}, error() {}, debug() {} };
	return new BilibiliAPI({
		serviceCtx: { logger } as never,
		config: { userAgent } as never,
		callbacks: {},
	});
}

describe("getUserAgent", () => {
	it("配置为纯空白 → 回退内置身份 UA,不发空白串", () => {
		const api = makeApi("   ");

		const ua = api.getUserAgent();
		expect(ua.trim()).not.toBe("");
		expect(ua).toContain("Mozilla");
	});

	it("配置带前后空白 → 返回 trim 后的值", () => {
		const api = makeApi("  MyUA/1.0  ");

		expect(api.getUserAgent()).toBe("MyUA/1.0");
	});

	it("未配置 → 内置身份 UA", () => {
		const api = makeApi(undefined);

		expect(api.getUserAgent()).toContain("Mozilla");
	});
});

describe("setUserAgent", () => {
	it("热替换也走同一判定:带空白的新值 trim 后进请求头", () => {
		const api = makeApi(undefined);
		const headers: Record<string, string> = {};
		(api as unknown as { client: { setHeader(k: string, v: string): void } }).client = {
			setHeader: (k, v) => {
				headers[k] = v;
			},
		};

		api.setUserAgent("  MyUA/2.0  ");
		expect(headers["User-Agent"]).toBe("MyUA/2.0");
		expect(api.getUserAgent()).toBe("MyUA/2.0");

		api.setUserAgent("   ");
		expect(headers["User-Agent"]).toContain("Mozilla");
	});
});
