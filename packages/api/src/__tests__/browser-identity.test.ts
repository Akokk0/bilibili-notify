/**
 * 浏览器身份生成 —— 取代冻结的 Firefox 115 默认 UA。
 *
 * 背景:旧默认头是拼接怪(UA 自称 Firefox 115、sec-ch-ua 却自称 Chrome 139,
 * 而真实 Firefox 根本不发 sec-ch-ua),且全网实例共享同一冻结 UA。现改为启动时
 * 生成一次自洽的 Chrome 身份:UA 与 sec-ch-ua 版本互相咬合、平台一致,
 * **单实例内稳定不变**(逐请求随机跳变是机器人特征,绝不可做)。
 */

import { describe, expect, it } from "vite-plus/test";
import { BilibiliAPI } from "../bilibili-api";
import { CHROME_MAJOR_MAX, CHROME_MAJOR_MIN, generateBrowserIdentity } from "../browser-identity";
import type { BiliHttpClient } from "../http-client";

describe("generateBrowserIdentity — 自洽的 Chrome 身份", () => {
	it("UA 是 Linux Chrome 形状,且大版本落在维护区间内", () => {
		const id = generateBrowserIdentity();
		const m =
			/^Mozilla\/5\.0 \(X11; Linux x86_64\) AppleWebKit\/537\.36 \(KHTML, like Gecko\) Chrome\/(\d+)\.0\.0\.0 Safari\/537\.36$/.exec(
				id.userAgent,
			);
		expect(m).not.toBeNull();
		const major = Number(m?.[1]);
		expect(major).toBeGreaterThanOrEqual(CHROME_MAJOR_MIN);
		expect(major).toBeLessThanOrEqual(CHROME_MAJOR_MAX);
	});

	it("sec-ch-ua 与 UA 的 Chrome 大版本互相咬合,平台一致为 Linux", () => {
		const id = generateBrowserIdentity();
		const major = /Chrome\/(\d+)\./.exec(id.userAgent)?.[1];
		expect(id.secChUa).toContain(`"Google Chrome";v="${major}"`);
		expect(id.secChUa).toContain(`"Chromium";v="${major}"`);
		expect(id.secChUaMobile).toBe("?0");
		expect(id.secChUaPlatform).toBe('"Linux"');
	});

	it("注入随机源可确定性生成(0 → 区间下界,~1 → 区间上界)", () => {
		const low = generateBrowserIdentity(() => 0);
		const high = generateBrowserIdentity(() => 0.999999);
		expect(low.userAgent).toContain(`Chrome/${CHROME_MAJOR_MIN}.`);
		expect(high.userAgent).toContain(`Chrome/${CHROME_MAJOR_MAX}.`);
	});
});

describe("BilibiliAPI — 浏览器身份接线", () => {
	function makeApi(userAgent?: string) {
		const logger = { info() {}, warn() {}, error() {}, debug() {} };
		const api = new BilibiliAPI({
			serviceCtx: { logger } as never,
			config: { userAgent },
			callbacks: {},
		});
		(api as unknown as { initClient(): void }).initClient();
		const client = (api as unknown as { client: BiliHttpClient }).client;
		return { api, client };
	}

	it("未配置 UA → 用生成身份,UA 与 sec-ch-ua 版本自洽,且同实例重建 client 后不变", () => {
		const { api, client } = makeApi();
		const ua = client.getHeader("user-agent");
		const major = /Chrome\/(\d+)\./.exec(ua ?? "")?.[1];
		expect(major).toBeDefined();
		expect(client.getHeader("sec-ch-ua")).toContain(`"Google Chrome";v="${major}"`);
		expect(client.getHeader("sec-ch-ua-platform")).toBe('"Linux"');

		// loadCookies/clearCookies 会重建 client —— 身份必须随实例稳定,不得漂移
		(api as unknown as { initClient(): void }).initClient();
		const rebuilt = (api as unknown as { client: BiliHttpClient }).client;
		expect(rebuilt.getHeader("user-agent")).toBe(ua);
	});

	it("配置了自定义 UA → 自定义值优先生效(现有开关语义不变)", () => {
		const { client } = makeApi("my-custom-ua/9.9");
		expect(client.getHeader("user-agent")).toBe("my-custom-ua/9.9");
	});

	it("setUserAgent 清空 → 回退到本实例的生成身份,而非冻结常量", () => {
		const { api, client } = makeApi("my-custom-ua/9.9");
		api.setUserAgent(undefined);
		const ua = client.getHeader("user-agent");
		expect(ua).toMatch(/Chrome\/\d+\.0\.0\.0/);
	});
});
