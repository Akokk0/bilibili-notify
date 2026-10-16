import { describe, expect, it } from "vite-plus/test";
import { extractUrls } from "../extract-urls.js";

describe("extractUrls", () => {
	it("带协议头的网址按出现顺序交出,原样不改", () => {
		expect(
			extractUrls("看 https://acme.invalid/link/a1 和 http://example.com/x?y=1#z 都行"),
		).toEqual(["https://acme.invalid/link/a1", "http://example.com/x?y=1#z"]);
	});

	it("没有协议头的裸写法也认(域名加路径)", () => {
		expect(extractUrls("bilibili.com/video/BV1zMtU6uEEb 好看")).toEqual([
			"bilibili.com/video/BV1zMtU6uEEb",
		]);
		expect(extractUrls("www.bilibili.com/video/av170001")).toEqual([
			"www.bilibili.com/video/av170001",
		]);
	});

	it("句末的标点和中文紧贴在网址后面时不算进去", () => {
		expect(extractUrls("https://b23.tv/abc123，真好看。")).toEqual(["https://b23.tv/abc123"]);
		expect(extractUrls("(https://acme.invalid/link/a1).")).toEqual([
			"https://acme.invalid/link/a1",
		]);
	});

	it("同一条原文只交一次", () => {
		expect(extractUrls("https://acme.invalid/link/a1 https://acme.invalid/link/a1")).toEqual([
			"https://acme.invalid/link/a1",
		]);
	});

	it("不是网址的不交:没有点的词、版本号、空串", () => {
		expect(extractUrls("今天天气不错 v1.2.3 BV1zMtU6uEEb")).toEqual([]);
		expect(extractUrls("")).toEqual([]);
	});

	it("宁可多挑:长得像的域名(x.notbilibili.com)也交,由解析器的 matches 去挡;邮箱不算", () => {
		expect(extractUrls("x.notbilibili.com/video/BV1zMtU6uEEb")).toEqual([
			"x.notbilibili.com/video/BV1zMtU6uEEb",
		]);
		expect(extractUrls("a@acme.invalid")).toEqual([]);
	});
});
