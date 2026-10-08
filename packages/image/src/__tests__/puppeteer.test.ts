/**
 * `isEmbeddedUrl` —— 渲染页请求闸的唯一判断:只有 `data:` 地址算内嵌内容,别的一律不放行。
 * 闸本身在浏览器适配层(`apps/server/src/runtime/puppeteer.ts`),那边的测试钉接线。
 */

import { describe, expect, it } from "vite-plus/test";
import { isEmbeddedUrl } from "../puppeteer";

describe("isEmbeddedUrl", () => {
	it("data: 地址算内嵌", () => {
		expect(isEmbeddedUrl("data:image/png;base64,AAAA")).toBe(true);
		expect(isEmbeddedUrl("data:font/woff2;base64,AAAA")).toBe(true);
		expect(isEmbeddedUrl("data:,")).toBe(true);
	});

	it("别的协议都不算:没有主机白名单,也没有协议白名单", () => {
		for (const url of [
			"http://example.invalid/a.png",
			"https://example.invalid/a.png",
			"//example.invalid/a.png",
			"file:///etc/hosts",
			"blob:null/0000",
			"about:blank",
			"ws://example.invalid/",
			"/local/a.png",
			"",
		]) {
			expect(isEmbeddedUrl(url), url).toBe(false);
		}
	});

	it("data: 不在开头的不算(地址里夹着 data: 的远端请求)", () => {
		expect(isEmbeddedUrl("https://example.invalid/?next=data:text/html,x")).toBe(false);
		expect(isEmbeddedUrl(" data:image/png;base64,AAAA")).toBe(false);
	});
});
