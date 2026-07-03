/**
 * BiliCookieJar 契约 —— 取代 tough-cookie 的自研轻量 jar。
 *
 * 兼容性硬约束:用户盘上加密持久化的 cookiesJson 是 tough-cookie
 * `serializeSync().cookies` 的形状(BACookie:key/value/expires(ISO|"Infinity")/
 * domain(无前导点)/path/secure/httpOnly/sameSite)。本 jar 的 load/serialize
 * 必须与该形状双向兼容,否则升级即全员掉登录。
 *
 * 行为面(RFC 6265 精简,只需伺候 *.bilibili.com 场景):
 * - Set-Cookie 摄取:Domain 缺省 → host-only;Max-Age 优先于 Expires;
 *   Max-Age<=0 / 过去的 Expires → 删除同名 cookie
 * - 匹配:domain 后缀匹配(域 cookie)/精确匹配(host-only),path 前缀匹配,
 *   Secure cookie 仅 https 外发,过期不外发
 * - 同 (domain,path,key) 覆盖旧值
 */

import { describe, expect, it } from "vite-plus/test";
import { BiliCookieJar } from "../cookie-jar";

const WWW = new URL("https://www.bilibili.com/");
const API = new URL("https://api.bilibili.com/x/web-interface/nav");
const PASSPORT = new URL("https://passport.bilibili.com/x/passport-login/web/cookie/info");

describe("BiliCookieJar — tough-cookie 序列化格式双向兼容", () => {
	it("load 旧格式(tough-cookie serializeSync 形状)后按域匹配外发", () => {
		const jar = new BiliCookieJar();
		jar.load([
			{
				key: "SESSDATA",
				value: "sess_v",
				expires: "2099-01-01T00:00:00.000Z",
				domain: "bilibili.com",
				path: "/",
				secure: true,
				httpOnly: true,
				sameSite: "lax",
			},
			{ key: "bili_jct", value: "jct_v", expires: "Infinity", domain: "bilibili.com", path: "/" },
		]);
		const header = jar.cookieHeaderFor(API);
		expect(header).toContain("SESSDATA=sess_v");
		expect(header).toContain("bili_jct=jct_v");
	});

	it("serialize 输出 BACookie 形状:expires 为 ISO 或 Infinity,round-trip 稳定", () => {
		const jar = new BiliCookieJar();
		const input = [
			{
				key: "SESSDATA",
				value: "sess_v",
				expires: "2099-01-01T00:00:00.000Z",
				domain: "bilibili.com",
				path: "/",
				secure: true,
				httpOnly: true,
				sameSite: "lax",
			},
			{ key: "bili_jct", value: "jct_v", expires: "Infinity", domain: "bilibili.com", path: "/" },
		];
		jar.load(input);
		const out = jar.serialize();
		const sess = out.find((c) => c.key === "SESSDATA");
		expect(sess?.value).toBe("sess_v");
		expect(sess?.expires).toBe("2099-01-01T00:00:00.000Z");
		expect(sess?.domain).toBe("bilibili.com");
		expect(sess?.secure).toBe(true);
		expect(sess?.httpOnly).toBe(true);
		const jct = out.find((c) => c.key === "bili_jct");
		expect(jct?.expires).toBe("Infinity");
		// round-trip:load(serialize()) 后行为不变
		const jar2 = new BiliCookieJar();
		jar2.load(out);
		expect(jar2.cookieHeaderFor(API)).toBe(jar.cookieHeaderFor(API));
	});

	it("load 容忍多余字段(tough-cookie 会带 creation/lastAccessed/hostOnly 等)", () => {
		const jar = new BiliCookieJar();
		jar.load([
			{
				key: "SESSDATA",
				value: "v",
				domain: "bilibili.com",
				path: "/",
				creation: "2026-01-01T00:00:00.000Z",
				lastAccessed: "2026-01-01T00:00:00.000Z",
				hostOnly: false,
			} as never,
		]);
		expect(jar.cookieHeaderFor(WWW)).toBe("SESSDATA=v");
	});
});

describe("BiliCookieJar — Set-Cookie 摄取", () => {
	it("摄取带 Domain 的 Set-Cookie → 域 cookie,子域共享", () => {
		const jar = new BiliCookieJar();
		jar.setFromSetCookie("SESSDATA=new_sess; Path=/; Domain=.bilibili.com; Secure", PASSPORT);
		expect(jar.cookieHeaderFor(API)).toContain("SESSDATA=new_sess");
		expect(jar.cookieHeaderFor(WWW)).toContain("SESSDATA=new_sess");
	});

	it("无 Domain 属性 → host-only,只回发给同一 host", () => {
		const jar = new BiliCookieJar();
		jar.setFromSetCookie("token=t1; Path=/", PASSPORT);
		expect(jar.cookieHeaderFor(PASSPORT)).toContain("token=t1");
		expect(jar.cookieHeaderFor(API)).toBe("");
	});

	it("Max-Age=0 删除同名 cookie(B 站登出/轮换旧 cookie 的方式)", () => {
		const jar = new BiliCookieJar();
		jar.setFromSetCookie("SESSDATA=old; Path=/; Domain=.bilibili.com", PASSPORT);
		expect(jar.cookieHeaderFor(API)).toContain("SESSDATA=old");
		jar.setFromSetCookie("SESSDATA=deleted; Path=/; Domain=.bilibili.com; Max-Age=0", PASSPORT);
		expect(jar.cookieHeaderFor(API)).not.toContain("SESSDATA");
	});

	it("过去的 Expires 同样删除;Max-Age 优先于 Expires", () => {
		const jar = new BiliCookieJar();
		jar.setFromSetCookie(
			"a=1; Path=/; Domain=.bilibili.com; Expires=Thu, 01 Jan 1970 00:00:00 GMT",
			PASSPORT,
		);
		expect(jar.cookieHeaderFor(API)).toBe("");
		// Max-Age 未来 + Expires 过去 → Max-Age 赢,cookie 存活
		jar.setFromSetCookie(
			"b=2; Path=/; Domain=.bilibili.com; Max-Age=3600; Expires=Thu, 01 Jan 1970 00:00:00 GMT",
			PASSPORT,
		);
		expect(jar.cookieHeaderFor(API)).toBe("b=2");
	});

	it("同 (domain,path,key) 覆盖旧值", () => {
		const jar = new BiliCookieJar();
		jar.setFromSetCookie("bili_jct=v1; Path=/; Domain=.bilibili.com", PASSPORT);
		jar.setFromSetCookie("bili_jct=v2; Path=/; Domain=.bilibili.com", PASSPORT);
		expect(jar.cookieHeaderFor(API)).toBe("bili_jct=v2");
		expect(jar.serialize().filter((c) => c.key === "bili_jct")).toHaveLength(1);
	});
});

describe("BiliCookieJar — 匹配语义", () => {
	it("Secure cookie 不外发给 http URL", () => {
		const jar = new BiliCookieJar();
		jar.setFromSetCookie("SESSDATA=s; Path=/; Domain=.bilibili.com; Secure", PASSPORT);
		expect(jar.cookieHeaderFor(new URL("http://api.bilibili.com/"))).toBe("");
		expect(jar.cookieHeaderFor(API)).toBe("SESSDATA=s");
	});

	it("过期 cookie 不外发也不再序列化", () => {
		const jar = new BiliCookieJar();
		jar.load([
			{
				key: "gone",
				value: "x",
				expires: "2000-01-01T00:00:00.000Z",
				domain: "bilibili.com",
				path: "/",
			},
		]);
		expect(jar.cookieHeaderFor(API)).toBe("");
		expect(jar.serialize()).toHaveLength(0);
	});

	it("path 前缀匹配:/x 的 cookie 不发给 /y", () => {
		const jar = new BiliCookieJar();
		jar.setFromSetCookie("scoped=1; Path=/x; Domain=.bilibili.com", PASSPORT);
		expect(jar.cookieHeaderFor(new URL("https://api.bilibili.com/x/sub"))).toBe("scoped=1");
		expect(jar.cookieHeaderFor(new URL("https://api.bilibili.com/y"))).toBe("");
	});

	it("无关域绝不外发(域后缀必须按段对齐,evil-bilibili.com 不匹配)", () => {
		const jar = new BiliCookieJar();
		jar.setFromSetCookie("SESSDATA=s; Path=/; Domain=.bilibili.com", PASSPORT);
		expect(jar.cookieHeaderFor(new URL("https://evil-bilibili.com/"))).toBe("");
		expect(jar.cookieHeaderFor(new URL("https://bilibili.com.evil.com/"))).toBe("");
	});

	it("getValue 按 key 查值(bili_jct/CSRF 场景)", () => {
		const jar = new BiliCookieJar();
		jar.setFromSetCookie("bili_jct=csrf_v; Path=/; Domain=.bilibili.com", PASSPORT);
		expect(jar.getValue("bili_jct")).toBe("csrf_v");
		expect(jar.getValue("missing")).toBeUndefined();
	});
});
