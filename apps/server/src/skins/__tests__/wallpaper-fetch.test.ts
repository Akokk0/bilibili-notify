/**
 * 壁纸下载器 —— 皮肤工坊里唯一会让服务端**主动出站**的东西,所以这份测试主要
 * 在钉安全边界:内网地址不碰、重定向不跟、字节不是图就拒、体积有顶。
 *
 * URL 从哪来这件事不在这一层管(调用方只准传候选表里的),但**候选表本身也是
 * 第三方数据** —— 搜索后端被投毒一样能塞进指向内网的链接,所以这些闸一道都不能省。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { fetchWallpaperImage, imageExtOf, isPrivateAddress } from "../wallpaper-fetch.js";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 1, 2]);

let fetchMock: ReturnType<typeof vi.fn>;
const publicLookup = async () => ["93.184.216.34"];

function imageRes(bytes: Uint8Array, init: { status?: number; length?: number } = {}): Response {
	return new Response(bytes, {
		status: init.status ?? 200,
		headers: { "content-length": String(init.length ?? bytes.byteLength) },
	});
}

beforeEach(() => {
	fetchMock = vi.fn();
	vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("isPrivateAddress", () => {
	it("内网 / 环回 / 链路本地 / CGNAT 一律算私有", () => {
		for (const ip of [
			"127.0.0.1",
			"10.1.2.3",
			"172.16.0.1",
			"172.31.255.255",
			"192.168.1.1",
			// 云上取元数据的经典目标
			"169.254.169.254",
			"100.64.0.1",
			"0.0.0.0",
			"::1",
			"fe80::1",
			"fd00::1",
			"::ffff:127.0.0.1",
		]) {
			expect(isPrivateAddress(ip), ip).toBe(true);
		}
	});

	it("公网地址放行;认不出形状的东西按私有拒", () => {
		expect(isPrivateAddress("93.184.216.34")).toBe(false);
		expect(isPrivateAddress("2606:2800:220:1::")).toBe(false);
		expect(isPrivateAddress("不是地址")).toBe(true);
	});
});

describe("imageExtOf", () => {
	it("按字节魔数认 PNG / JPEG / WebP,别的返回 null", () => {
		expect(imageExtOf(PNG)).toBe("png");
		expect(imageExtOf(JPG)).toBe("jpg");
		expect(imageExtOf(WEBP)).toBe("webp");
		expect(imageExtOf(new Uint8Array([0x3c, 0x68, 0x74, 0x6d, 0x6c]))).toBeNull();
	});
});

describe("fetchWallpaperImage", () => {
	it("正常的一张 png → 字节与扩展名", async () => {
		fetchMock.mockResolvedValueOnce(imageRes(PNG));
		const res = await fetchWallpaperImage("https://img.example.com/a.png", {
			lookupAddresses: publicLookup,
		});

		expect(res.ext).toBe("png");
		expect(res.bytes).toEqual(PNG);
	});

	it("不跟重定向 —— 跟了就等于把 IP 那道闸作废", async () => {
		fetchMock.mockResolvedValueOnce(imageRes(PNG));
		await fetchWallpaperImage("https://img.example.com/a.png", { lookupAddresses: publicLookup });

		const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
		expect(init.redirect).toBe("error");
	});

	it("域名解析到内网 → 拒,而且一个请求都不发", async () => {
		await expect(
			fetchWallpaperImage("https://evil.example.com/a.png", {
				lookupAddresses: async () => ["127.0.0.1"],
			}),
		).rejects.toThrow(/内网/);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("一个域名同时指向公网和内网 → 照样拒", async () => {
		await expect(
			fetchWallpaperImage("https://mixed.example.com/a.png", {
				lookupAddresses: async () => ["93.184.216.34", "10.0.0.5"],
			}),
		).rejects.toThrow(/内网/);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("字面量内网 IP 直接拒,不必解析", async () => {
		await expect(fetchWallpaperImage("http://169.254.169.254/latest/meta-data/")).rejects.toThrow(
			/内网/,
		);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("非 http(s) → 拒", async () => {
		await expect(fetchWallpaperImage("file:///etc/passwd")).rejects.toThrow(/http/);
		await expect(fetchWallpaperImage("data:image/png;base64,AAAA")).rejects.toThrow(/http/);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("下下来的是网页不是图 → 拒(Content-Type 是对方说了算的,只信字节)", async () => {
		fetchMock.mockResolvedValueOnce(
			new Response("<html>逗你玩</html>", { headers: { "content-type": "image/png" } }),
		);

		await expect(
			fetchWallpaperImage("https://img.example.com/a.png", { lookupAddresses: publicLookup }),
		).rejects.toThrow(/PNG|图片/);
	});

	it("声称的大小超限 → 不读正文就拒", async () => {
		fetchMock.mockResolvedValueOnce(imageRes(PNG, { length: 9 * 1024 * 1024 }));

		await expect(
			fetchWallpaperImage("https://img.example.com/a.png", { lookupAddresses: publicLookup }),
		).rejects.toThrow(/太大/);
	});

	it("声称的大小骗人,真实字节超限 → 照样拒", async () => {
		const huge = new Uint8Array(6 * 1024 * 1024);
		huge.set(PNG.slice(0, 8));
		fetchMock.mockResolvedValueOnce(imageRes(huge, { length: 10 }));

		await expect(
			fetchWallpaperImage("https://img.example.com/a.png", { lookupAddresses: publicLookup }),
		).rejects.toThrow(/太大/);
	});

	it("HTTP 非 2xx → 拒", async () => {
		fetchMock.mockResolvedValueOnce(new Response("no", { status: 404 }));

		await expect(
			fetchWallpaperImage("https://img.example.com/a.png", { lookupAddresses: publicLookup }),
		).rejects.toThrow(/404/);
	});
});
