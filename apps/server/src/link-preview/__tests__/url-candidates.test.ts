import { describe, expect, it } from "vite-plus/test";
import { extractUrlCandidates } from "../url-candidates.js";

describe("extractUrlCandidates", () => {
	it("带协议头的网址按出现顺序交出,原样不改", () => {
		expect(
			extractUrlCandidates("看 https://acme.invalid/link/a1 和 http://example.com/x?y=1#z 都行"),
		).toEqual(["https://acme.invalid/link/a1", "http://example.com/x?y=1#z"]);
	});

	it("没有协议头的裸写法也认(域名加路径)", () => {
		expect(extractUrlCandidates("bilibili.com/video/BV1zMtU6uEEb 好看")).toEqual([
			"bilibili.com/video/BV1zMtU6uEEb",
		]);
		expect(extractUrlCandidates("www.bilibili.com/video/av170001")).toEqual([
			"www.bilibili.com/video/av170001",
		]);
	});

	it("句末的标点和中文紧贴在网址后面时不算进去", () => {
		expect(extractUrlCandidates("https://b23.tv/abc123，真好看。")).toEqual([
			"https://b23.tv/abc123",
		]);
		expect(extractUrlCandidates("(https://acme.invalid/link/a1).")).toEqual([
			"https://acme.invalid/link/a1",
		]);
	});

	it("同一条原文只交一次", () => {
		expect(
			extractUrlCandidates("https://acme.invalid/link/a1 https://acme.invalid/link/a1"),
		).toEqual(["https://acme.invalid/link/a1"]);
	});

	it("不是网址的不交:没有点的词、版本号、空串", () => {
		expect(extractUrlCandidates("今天天气不错 v1.2.3 BV1zMtU6uEEb")).toEqual([]);
		expect(extractUrlCandidates("")).toEqual([]);
	});

	it("宁可多挑:长得像的域名(x.notbilibili.com)也交,由解析器的 matches 去挡;邮箱不算", () => {
		expect(extractUrlCandidates("x.notbilibili.com/video/BV1zMtU6uEEb")).toEqual([
			"x.notbilibili.com/video/BV1zMtU6uEEb",
		]);
		expect(extractUrlCandidates("a@acme.invalid")).toEqual([]);
	});
});
