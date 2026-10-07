/**
 * 抓图服务(`createImageFetcher`,ADR-0025 决策 8、10):把远端的图抓进图库 / 把手里的字节存进图库,回引用。
 *
 * 用**真的请求客户端 + 真的图库(临时目录)+ 回环假服务**:假名字解析到哪由注入的解析表说了算,真 DNS 一次不查。
 * 回环本身算内网,所以正向用例注入放行回环的地址判定;「内网」那一条用生产默认的判定去连回环假服务。
 * 判定挂在哪一次解析上(重绑定、逐跳、字面量)由 `packages/http` 的 `address-check.test.ts` 钉着,这里只钉这一层
 * 自己的事:结果码逐条怎么判、调用方的头跨域不带、图床的 Set-Cookie 不进罐、8MB、嗅探、存库。
 *
 * 这个文件不用假定时器(超时那条注入一个很短的真超时)。
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CookieJar, HttpClient, requirePublicAddress } from "@bilibili-notify/http";
import { ok, type Result } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { gif, png } from "../../__tests__/support/report-images.js";
import { createImageFetcher, type ImageFetcher } from "../image-fetcher.js";
import {
	createImageStore,
	IMAGE_MAX_BYTES,
	type ImageStore,
	type ImageWriter,
	imageRefOf,
} from "../image-store.js";

const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 9, 9]);
const WEBP = Uint8Array.from([...Buffer.from("RIFF"), 0, 0, 0, 0, ...Buffer.from("WEBP"), 5]);
const PNG = png(10, 10, 1);

/** 回环放行(假服务就在回环上),其余照生产的规矩。 */
const loopbackAllowed = (address: string): Result =>
	address.startsWith("127.") ? ok() : requirePublicAddress(address);

/** 假服务按路径回什么:状态码、头、体。 */
type Reply = { status?: number; headers?: Record<string, string | string[]>; body?: Uint8Array };

let server: Server;
let port: number;
let routes: Record<string, Reply | "hang" | "endless">;
/** 假服务收到的每个请求:`<Host> <路径>` 与它带的头。 */
let seen: Array<{ at: string; headers: IncomingMessage["headers"] }>;
let dir: string;
let store: ImageStore;
let writer: ImageWriter;
let jar: CookieJar;
let http: HttpClient;
let fetcher: ImageFetcher;

const url = (host: string, path: string) => `http://${host}:${port}${path}`;

beforeEach(async () => {
	routes = {};
	seen = [];
	server = createServer((req, res) => {
		seen.push({ at: `${req.headers.host} ${req.url}`, headers: req.headers });
		const reply = routes[(req.url ?? "").split("?")[0] ?? ""] ?? { status: 404 };
		if (reply === "hang") return;
		if (reply === "endless") {
			// 不带 Content-Length、不肯停的流(开头是 png 的文件头)。
			res.writeHead(200, { "content-type": "image/png" });
			res.write(Buffer.from(PNG));
			const chunk = Buffer.alloc(256 * 1024, 7);
			const timer = setInterval(() => res.write(chunk), 1);
			res.on("close", () => clearInterval(timer));
			return;
		}
		for (const [name, value] of Object.entries(reply.headers ?? {})) res.setHeader(name, value);
		res.statusCode = reply.status ?? 200;
		res.end(reply.body ? Buffer.from(reply.body) : undefined);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	port = (server.address() as AddressInfo).port;

	dir = await mkdtemp(join(tmpdir(), "bn-image-fetcher-"));
	store = createImageStore({ dir: join(dir, "images") });
	writer = store.register({ name: "测试", listRefs: async () => [] });
	jar = new CookieJar();
	http = new HttpClient({
		jar,
		identity: {
			userAgent: "identity-ua/1.0",
			secChUa: '"Fixture";v="1"',
			secChUaMobile: "?0",
			secChUaPlatform: '"Fixture"',
		},
		headers: { "X-Client-Default": "always" },
		// 两个假名字都落在回环假服务上:名字不同就是不同的源。
		lookup: async (hostname) => {
			if (hostname === "img.test" || hostname === "cdn.test") return ["127.0.0.1"];
			throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: "ENOTFOUND" });
		},
	});
	fetcher = createImageFetcher({ http, images: writer, addressCheck: loopbackAllowed });
});

afterEach(async () => {
	await http.dispose();
	server.closeAllConnections();
	await new Promise<void>((resolve) => server.close(() => resolve()));
	await rm(dir, { recursive: true, force: true });
});

/** 图库里这个引用的字节。 */
async function stored(ref: string): Promise<Uint8Array> {
	const found = await store.read(ref);
	if (!found) throw new Error(`图库里没有 ${ref}`);
	return Uint8Array.from(found.bytes);
}

describe("fetchImage — 抓到了", () => {
	it.each([
		["png", PNG],
		["jpg", JPEG],
		["webp", WEBP],
		["gif", gif(4, 4)],
	] as const)(
		"%s:存进图库,回的引用就是内容摘要 + 嗅探出的扩展名,字节读得回",
		async (ext, bytes) => {
			// 对端说它是什么不算数:扩展名按内容嗅探。
			routes["/a"] = { headers: { "content-type": "text/plain" }, body: bytes };
			const result = await fetcher.fetchImage(url("img.test", "/a"));
			expect(result).toEqual({ ok: true, ref: imageRefOf(bytes) });
			if (!result.ok) return;
			expect(result.ref.endsWith(`.${ext}`)).toBe(true);
			expect(await stored(result.ref)).toEqual(bytes);
		},
	);

	it("同一张图抓两次(地址不同也一样):同一个引用,盘上一份", async () => {
		routes["/a"] = { body: PNG };
		routes["/b"] = { body: PNG };
		const first = await fetcher.fetchImage(url("img.test", "/a"));
		const second = await fetcher.fetchImage(url("cdn.test", "/b"));
		expect(first.ok && second.ok && first.ref === second.ref).toBe(true);
		expect(await store.usage()).toHaveLength(1);
	});

	it("正好 8MB 的图:收", async () => {
		const bytes = png(10, 10, 2, IMAGE_MAX_BYTES);
		routes["/big"] = { body: bytes };
		const result = await fetcher.fetchImage(url("img.test", "/big"));
		expect(result).toEqual({ ok: true, ref: imageRefOf(bytes) });
	});

	it("跟着重定向走到图", async () => {
		routes["/from"] = { status: 302, headers: { location: "/a" } };
		routes["/a"] = { body: PNG };
		const result = await fetcher.fetchImage(url("img.test", "/from"));
		expect(result).toEqual({ ok: true, ref: imageRefOf(PNG) });
	});
});

describe("fetchImage — 调用方的头与 cookie", () => {
	it("调用方的头带到对端;客户端自己的默认头、罐里的 Cookie 照带", async () => {
		routes["/a"] = { body: PNG };
		jar.setFromSetCookie("SESS=1; Path=/", new URL(url("img.test", "/")));
		await fetcher.fetchImage(url("img.test", "/a"), {
			headers: { Referer: "https://origin.test/", "X-Sign": "abc" },
		});
		expect(seen[0]?.headers).toMatchObject({
			referer: "https://origin.test/",
			"x-sign": "abc",
			"x-client-default": "always",
			cookie: "SESS=1",
		});
	});

	it("同源的重定向:调用方的头每一跳都带", async () => {
		routes["/from"] = { status: 302, headers: { location: "/a" } };
		routes["/a"] = { body: PNG };
		await fetcher.fetchImage(url("img.test", "/from"), { headers: { Referer: "https://o.test/" } });
		expect(seen.map((request) => request.headers.referer)).toEqual([
			"https://o.test/",
			"https://o.test/",
		]);
	});

	it("跳到别的源:调用方这次传的头不带过去,客户端的默认头与按目标现取的 Cookie 不动", async () => {
		routes["/from"] = { status: 302, headers: { location: url("cdn.test", "/a") } };
		routes["/a"] = { body: PNG };
		jar.setFromSetCookie("CDN=9; Path=/", new URL(url("cdn.test", "/")));
		const result = await fetcher.fetchImage(url("img.test", "/from"), {
			headers: { Referer: "https://origin.test/", "X-Sign": "abc" },
		});
		expect(result.ok).toBe(true);
		expect(seen.map((request) => request.at)).toEqual([
			`img.test:${port} /from`,
			`cdn.test:${port} /a`,
		]);
		expect(seen[0]?.headers).toMatchObject({ referer: "https://origin.test/", "x-sign": "abc" });
		expect(seen[1]?.headers).not.toHaveProperty("referer");
		expect(seen[1]?.headers).not.toHaveProperty("x-sign");
		expect(seen[1]?.headers).toMatchObject({ "x-client-default": "always", cookie: "CDN=9" });
	});

	it("图床回的 Set-Cookie 不进集成的罐(重定向那一跳的也不进)", async () => {
		routes["/from"] = { status: 302, headers: { location: "/a", "set-cookie": "hop=1; Path=/" } };
		routes["/a"] = { headers: { "set-cookie": "track=1; Path=/" }, body: PNG };
		const result = await fetcher.fetchImage(url("img.test", "/from"));
		expect(result.ok).toBe(true);
		expect(jar.cookieHeaderFor(new URL(url("img.test", "/")))).toBe("");
	});
});

describe("fetchImage — 失败码", () => {
	/** 非 2xx 的一律把状态码写进 message。 */
	it.each([
		[401, "unauthorized"],
		[403, "unauthorized"],
		[404, "not_found"],
		[410, "not_found"],
		[429, "rate_limited"],
		[400, "invalid"],
		[418, "invalid"],
		[500, "unavailable"],
		[503, "unavailable"],
	] as const)("对端回 %i → %s,状态码写在 message 里;体是图也不存", async (status, code) => {
		routes["/x"] = { status, body: PNG };
		const result = await fetcher.fetchImage(url("img.test", "/x?token=secret"));
		expect(result).toMatchObject({ ok: false, code });
		if (result.ok) return;
		expect(result.message).toContain(String(status));
		// 地址里的 query 可能是凭据,不进 message。
		expect(result.message).not.toContain("secret");
		expect(await store.usage()).toEqual([]);
	});

	it("跟满 5 跳还是重定向 → unavailable", async () => {
		routes["/loop"] = { status: 302, headers: { location: "/loop" } };
		const result = await fetcher.fetchImage(url("img.test", "/loop"));
		expect(result).toMatchObject({ ok: false, code: "unavailable" });
		// 第一次请求 + 5 跳。
		expect(seen).toHaveLength(6);
	});

	it("3xx 却没给 Location → unavailable,状态码写在 message 里", async () => {
		routes["/x"] = { status: 302 };
		const result = await fetcher.fetchImage(url("img.test", "/x"));
		expect(result).toMatchObject({ ok: false, code: "unavailable" });
		if (!result.ok) expect(result.message).toContain("302");
	});

	it.each([
		["HTML", new TextEncoder().encode("<html><body>404</body></html>")],
		["SVG", new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>')],
		["空的", new Uint8Array()],
	])("2xx 但不是图(%s)→ invalid", async (_name, body) => {
		routes["/x"] = { headers: { "content-type": "image/png" }, body };
		const result = await fetcher.fetchImage(url("img.test", "/x?token=secret"));
		expect(result).toMatchObject({ ok: false, code: "invalid" });
		// 这一层自己先认一遍(图库也会拒):话里说得清是哪个地址,query 不带。
		if (!result.ok) expect(result.message).toContain(`http://img.test:${port}/x`);
		if (!result.ok) expect(result.message).not.toContain("secret");
		expect(await store.usage()).toEqual([]);
	});

	it("超过 8MB(多一个字节)→ invalid", async () => {
		routes["/big"] = { body: png(10, 10, 3, IMAGE_MAX_BYTES + 1) };
		const result = await fetcher.fetchImage(url("img.test", "/big"));
		expect(result).toMatchObject({ ok: false, code: "invalid" });
		expect(await store.usage()).toEqual([]);
	});

	it("不带长度、不肯停的流:读过 8MB 就掐断回 invalid,不等到超时、不整个读进内存", async () => {
		routes["/endless"] = "endless";
		const result = await fetcher.fetchImage(url("img.test", "/endless"));
		expect(result).toMatchObject({ ok: false, code: "invalid" });
	});

	it("内网地址 → invalid:默认的判定下回环假服务就是内网,一个请求都没发", async () => {
		routes["/a"] = { body: PNG };
		const strict = createImageFetcher({ http, images: writer });
		for (const target of [url("img.test", "/a"), url("127.0.0.1", "/a")]) {
			expect(await strict.fetchImage(target), target).toMatchObject({ ok: false, code: "invalid" });
		}
		expect(seen).toEqual([]);
	});

	it("重定向到内网地址 → invalid", async () => {
		routes["/from"] = { status: 302, headers: { location: "http://169.254.169.254/latest" } };
		const result = await fetcher.fetchImage(url("img.test", "/from"));
		expect(result).toMatchObject({ ok: false, code: "invalid" });
	});

	it.each(["ftp://img.test/a.png", "file:///etc/passwd", "不是地址"])(
		"不是 http(s) 的地址(%s)→ invalid",
		async (target) => {
			expect(await fetcher.fetchImage(target)).toMatchObject({ ok: false, code: "invalid" });
		},
	);

	it("超时 → timeout", async () => {
		routes["/hang"] = "hang";
		const quick = createImageFetcher({
			http,
			images: writer,
			addressCheck: loopbackAllowed,
			timeoutMs: 80,
		});
		expect(await quick.fetchImage(url("img.test", "/hang"))).toMatchObject({
			ok: false,
			code: "timeout",
		});
	});

	it("连不上(名字解析不出来)→ unavailable", async () => {
		const result = await fetcher.fetchImage(url("nowhere.test", "/a"));
		expect(result).toMatchObject({ ok: false, code: "unavailable" });
	});

	it("连不上(端口没人听)→ unavailable", async () => {
		const closed = createServer();
		await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
		const deadPort = (closed.address() as AddressInfo).port;
		await new Promise<void>((resolve) => closed.close(() => resolve()));
		const result = await fetcher.fetchImage(`http://img.test:${deadPort}/a`);
		expect(result).toMatchObject({ ok: false, code: "unavailable" });
	});

	it("调用方中止 → 与请求客户端同一个码(indeterminate),不抛", async () => {
		routes["/hang"] = "hang";
		const controller = new AbortController();
		const pending = fetcher.fetchImage(url("img.test", "/hang"), { signal: controller.signal });
		setTimeout(() => controller.abort(), 30);
		expect(await pending).toMatchObject({ ok: false, code: "indeterminate" });
	});

	it("磁盘写失败 → unavailable(图库自己回的),不抛", async () => {
		routes["/a"] = { body: PNG };
		const blocked = join(dir, "挡路");
		await writeFile(blocked, "x");
		const broken = createImageStore({ dir: blocked }).register({
			name: "测试",
			listRefs: async () => [],
		});
		const failing = createImageFetcher({ http, images: broken, addressCheck: loopbackAllowed });
		const result = await failing.fetchImage(url("img.test", "/a"));
		expect(result).toMatchObject({ ok: false, code: "unavailable" });
	});
});

describe("storeImage", () => {
	it.each([
		["png", PNG],
		["jpg", JPEG],
		["webp", WEBP],
		["gif", gif(4, 4)],
	] as const)("%s:存进图库,回引用,字节读得回", async (_ext, bytes) => {
		const result = await fetcher.storeImage(bytes);
		expect(result).toEqual({ ok: true, ref: imageRefOf(bytes) });
		if (result.ok) expect(await stored(result.ref)).toEqual(bytes);
	});

	it("同一份字节存两次:同一个引用,盘上一份", async () => {
		const first = await fetcher.storeImage(PNG);
		const second = await fetcher.storeImage(PNG);
		expect(first).toEqual(second);
		expect(await store.usage()).toHaveLength(1);
	});

	it("与 fetchImage 抓来的同一张图是同一个引用", async () => {
		routes["/a"] = { body: PNG };
		expect(await fetcher.storeImage(PNG)).toEqual(await fetcher.fetchImage(url("img.test", "/a")));
	});

	it.each([
		["不是图", new TextEncoder().encode("<svg/>")],
		["空的", new Uint8Array()],
		["超过 8MB", png(10, 10, 4, IMAGE_MAX_BYTES + 1)],
	])("%s → invalid,不写盘", async (_name, bytes) => {
		expect(await fetcher.storeImage(bytes)).toMatchObject({ ok: false, code: "invalid" });
		expect(await store.usage()).toEqual([]);
	});

	it("正好 8MB:收", async () => {
		expect((await fetcher.storeImage(png(10, 10, 5, IMAGE_MAX_BYTES))).ok).toBe(true);
	});

	it("磁盘写失败 → unavailable,不抛", async () => {
		const blocked = join(dir, "挡路");
		await writeFile(blocked, "x");
		const broken = createImageStore({ dir: blocked }).register({
			name: "测试",
			listRefs: async () => [],
		});
		const failing = createImageFetcher({ http, images: broken });
		expect(await failing.storeImage(PNG)).toMatchObject({ ok: false, code: "unavailable" });
	});

	it("调用方已经中止:不写盘,回 indeterminate(与 fetchImage 被中止同一个码)", async () => {
		const result = await fetcher.storeImage(PNG, { signal: AbortSignal.abort() });
		expect(result).toMatchObject({ ok: false, code: "indeterminate" });
		expect(await store.usage()).toEqual([]);
	});
});
