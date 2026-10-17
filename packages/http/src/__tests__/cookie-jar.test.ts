/**
 * CookieJar 契约 —— 取代 tough-cookie 的自研轻量罐。
 *
 * 兼容性硬约束:用户盘上加密持久化的 cookiesJson 是 tough-cookie
 * `serializeSync().cookies` 的形状(Cookie:key/value/expires(ISO|"Infinity")/
 * domain(无前导点)/path/secure/httpOnly/sameSite)。本罐的 load/serialize
 * 必须与该形状双向兼容,否则升级即全员掉登录。
 *
 * 行为面(RFC 6265 的子集):
 * - Set-Cookie 摄取:Domain 缺省 → host-only;Max-Age 优先于 Expires;
 *   Max-Age<=0 / 过去的 Expires → 删除同名 cookie;Domain 是公共后缀时等于请求主机当 host-only、
 *   否则丢弃;Domain 必须匹配请求主机,否则丢弃
 * - 匹配:domain 后缀匹配(域 cookie)/精确匹配(host-only),path 前缀匹配,
 *   Secure cookie 仅 https 外发,过期不外发;IP 主机只认原样,不做后缀匹配
 * - 同 (domain,path,key) 覆盖旧值
 * - load / clear 原地整罐换掉;内容变了通知订阅者
 */

import { describe, expect, it } from "vite-plus/test";
import { CookieJar } from "../cookie-jar";

const WWW = new URL("https://www.bilibili.com/");
const API = new URL("https://api.bilibili.com/x/web-interface/nav");
const PASSPORT = new URL("https://passport.bilibili.com/x/passport-login/web/cookie/info");

describe("CookieJar — tough-cookie 序列化格式双向兼容", () => {
	it("load 旧格式(tough-cookie serializeSync 形状)后按域匹配外发", () => {
		const jar = new CookieJar();
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

	it("serialize 输出 Cookie 形状:expires 为 ISO 或 Infinity,round-trip 稳定", () => {
		const jar = new CookieJar();
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
		const jar2 = new CookieJar();
		jar2.load(out);
		expect(jar2.cookieHeaderFor(API)).toBe(jar.cookieHeaderFor(API));
	});

	it("load 容忍多余字段(tough-cookie 会带 creation/lastAccessed/hostOnly 等)", () => {
		const jar = new CookieJar();
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

describe("CookieJar — Set-Cookie 摄取", () => {
	it("摄取带 Domain 的 Set-Cookie → 域 cookie,子域共享", () => {
		const jar = new CookieJar();
		jar.setFromSetCookie("SESSDATA=new_sess; Path=/; Domain=.bilibili.com; Secure", PASSPORT);
		expect(jar.cookieHeaderFor(API)).toContain("SESSDATA=new_sess");
		expect(jar.cookieHeaderFor(WWW)).toContain("SESSDATA=new_sess");
	});

	it("无 Domain 属性 → host-only,只回发给同一 host", () => {
		const jar = new CookieJar();
		jar.setFromSetCookie("token=t1; Path=/", PASSPORT);
		expect(jar.cookieHeaderFor(PASSPORT)).toContain("token=t1");
		expect(jar.cookieHeaderFor(API)).toBe("");
	});

	it("Max-Age=0 删除同名 cookie(B 站登出/轮换旧 cookie 的方式)", () => {
		const jar = new CookieJar();
		jar.setFromSetCookie("SESSDATA=old; Path=/; Domain=.bilibili.com", PASSPORT);
		expect(jar.cookieHeaderFor(API)).toContain("SESSDATA=old");
		jar.setFromSetCookie("SESSDATA=deleted; Path=/; Domain=.bilibili.com; Max-Age=0", PASSPORT);
		expect(jar.cookieHeaderFor(API)).not.toContain("SESSDATA");
	});

	it("过去的 Expires 同样删除;Max-Age 优先于 Expires", () => {
		const jar = new CookieJar();
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
		const jar = new CookieJar();
		jar.setFromSetCookie("bili_jct=v1; Path=/; Domain=.bilibili.com", PASSPORT);
		jar.setFromSetCookie("bili_jct=v2; Path=/; Domain=.bilibili.com", PASSPORT);
		expect(jar.cookieHeaderFor(API)).toBe("bili_jct=v2");
		expect(jar.serialize().filter((c) => c.key === "bili_jct")).toHaveLength(1);
	});
});

describe("CookieJar — 匹配语义", () => {
	it("Secure cookie 不外发给 http URL", () => {
		const jar = new CookieJar();
		jar.setFromSetCookie("SESSDATA=s; Path=/; Domain=.bilibili.com; Secure", PASSPORT);
		expect(jar.cookieHeaderFor(new URL("http://api.bilibili.com/"))).toBe("");
		expect(jar.cookieHeaderFor(API)).toBe("SESSDATA=s");
	});

	it("过期 cookie 不外发也不再序列化", () => {
		const jar = new CookieJar();
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
		const jar = new CookieJar();
		jar.setFromSetCookie("scoped=1; Path=/x; Domain=.bilibili.com", PASSPORT);
		expect(jar.cookieHeaderFor(new URL("https://api.bilibili.com/x/sub"))).toBe("scoped=1");
		expect(jar.cookieHeaderFor(new URL("https://api.bilibili.com/y"))).toBe("");
	});

	it("无关域绝不外发(域后缀必须按段对齐,evil-bilibili.com 不匹配)", () => {
		const jar = new CookieJar();
		jar.setFromSetCookie("SESSDATA=s; Path=/; Domain=.bilibili.com", PASSPORT);
		expect(jar.cookieHeaderFor(new URL("https://evil-bilibili.com/"))).toBe("");
		expect(jar.cookieHeaderFor(new URL("https://bilibili.com.evil.com/"))).toBe("");
	});

	it("getValue 按 key 查值(bili_jct/CSRF 场景)", () => {
		const jar = new CookieJar();
		jar.setFromSetCookie("bili_jct=csrf_v; Path=/; Domain=.bilibili.com", PASSPORT);
		expect(jar.getValue("bili_jct")).toBe("csrf_v");
		expect(jar.getValue("missing")).toBeUndefined();
	});
});

describe("CookieJar — load / clear 原地整罐换掉", () => {
	it("load 换掉整罐:上一批的 cookie 一条都不残留", () => {
		const jar = new CookieJar();
		jar.load([{ key: "SESSDATA", value: "old_sess", domain: "bilibili.com", path: "/" }]);
		jar.load([{ key: "bili_jct", value: "new_jct", domain: "bilibili.com", path: "/" }]);
		expect(jar.cookieHeaderFor(API)).toBe("bili_jct=new_jct");
		expect(jar.getValue("SESSDATA")).toBeUndefined();
		expect(jar.serialize().map((c) => c.key)).toEqual(["bili_jct"]);
	});

	it("同一次 load 里同 (domain,path,key) 后者覆盖前者(补 buvid3 靠这条)", () => {
		const jar = new CookieJar();
		jar.load([
			{ key: "buvid3", value: "real", domain: "bilibili.com", path: "/" },
			{ key: "buvid3", value: "dummy", domain: "bilibili.com", path: "/" },
		]);
		expect(jar.getValue("buvid3")).toBe("dummy");
		expect(jar.serialize()).toHaveLength(1);
	});

	it("clear 清空整罐,罐子还是同一个、之后照常收 cookie", () => {
		const jar = new CookieJar();
		jar.load([{ key: "SESSDATA", value: "v", domain: "bilibili.com", path: "/" }]);
		jar.clear();
		expect(jar.cookieHeaderFor(API)).toBe("");
		expect(jar.serialize()).toEqual([]);
		jar.setFromSetCookie("a=1; Path=/; Domain=.bilibili.com", PASSPORT);
		expect(jar.cookieHeaderFor(API)).toBe("a=1");
	});

	it("epoch:每次 load / clear 加一(空罐上的 clear 也算),摄取不动它", () => {
		const jar = new CookieJar();
		const start = jar.epoch;
		jar.setFromSetCookie("a=1; Path=/; Domain=.bilibili.com", PASSPORT);
		expect(jar.epoch).toBe(start);
		jar.load([]);
		expect(jar.epoch).toBe(start + 1);
		jar.clear();
		jar.clear();
		expect(jar.epoch).toBe(start + 3);
	});
});

describe("CookieJar — 「变了」的通知口", () => {
	function watch(jar: CookieJar) {
		const seen: string[] = [];
		const off = jar.onChange(() => seen.push(jar.cookieHeaderFor(API)));
		return { seen, off };
	}

	it("收到新 cookie 通知一次,通知时罐子已是新内容", () => {
		const jar = new CookieJar();
		const { seen } = watch(jar);
		jar.setFromSetCookie("a=1; Path=/; Domain=.bilibili.com", PASSPORT);
		expect(seen).toEqual(["a=1"]);
	});

	it("同样的 Set-Cookie 再收一遍内容没变,不通知;值变了才通知", () => {
		const jar = new CookieJar();
		jar.setFromSetCookie("a=1; Path=/; Domain=.bilibili.com", PASSPORT);
		const { seen } = watch(jar);
		jar.setFromSetCookie("a=1; Path=/; Domain=.bilibili.com", PASSPORT);
		expect(seen).toEqual([]);
		jar.setFromSetCookie("a=2; Path=/; Domain=.bilibili.com", PASSPORT);
		expect(seen).toEqual(["a=2"]);
	});

	it("删除指令删掉了东西才通知;没东西可删不通知", () => {
		const jar = new CookieJar();
		jar.setFromSetCookie("a=1; Path=/; Domain=.bilibili.com", PASSPORT);
		const { seen } = watch(jar);
		jar.setFromSetCookie("zzz=; Path=/; Domain=.bilibili.com; Max-Age=0", PASSPORT);
		expect(seen).toEqual([]);
		jar.setFromSetCookie("a=; Path=/; Domain=.bilibili.com; Max-Age=0", PASSPORT);
		expect(seen).toEqual([""]);
	});

	it("被丢弃的 Set-Cookie(Domain 不匹配)不通知", () => {
		const jar = new CookieJar();
		const { seen } = watch(jar);
		jar.setFromSetCookie("a=1; Path=/; Domain=evil.example", PASSPORT);
		expect(seen).toEqual([]);
	});

	it("load / clear 通知;空罐上的 clear 与 load([]) 没变,不通知", () => {
		const jar = new CookieJar();
		const { seen } = watch(jar);
		jar.clear();
		jar.load([]);
		expect(seen).toEqual([]);
		jar.load([{ key: "a", value: "1", domain: "bilibili.com", path: "/" }]);
		expect(seen).toEqual(["a=1"]);
		jar.clear();
		expect(seen).toEqual(["a=1", ""]);
	});

	it("返回的取消函数停掉订阅;多个订阅者互不影响", () => {
		const jar = new CookieJar();
		const first = watch(jar);
		const second = watch(jar);
		jar.setFromSetCookie("a=1; Path=/; Domain=.bilibili.com", PASSPORT);
		first.off();
		jar.setFromSetCookie("a=2; Path=/; Domain=.bilibili.com", PASSPORT);
		expect(first.seen).toEqual(["a=1"]);
		expect(second.seen).toEqual(["a=1", "a=2"]);
	});
});

describe("CookieJar — IP 主机只认原样(RFC 6265 §5.1.3)", () => {
	const IP = new URL("http://10.0.0.1/");

	it("摄取:Domain 是请求 IP 的后缀(0.0.1)不算匹配,丢弃", () => {
		const jar = new CookieJar();
		jar.setFromSetCookie("a=1; Path=/; Domain=0.0.1", IP);
		expect(jar.serialize()).toEqual([]);
		expect(jar.cookieHeaderFor(IP)).toBe("");
	});

	it("摄取:Domain 与请求 IP 一字不差才收,而且只回给那个 IP", () => {
		const jar = new CookieJar();
		jar.setFromSetCookie("a=1; Path=/; Domain=10.0.0.1", IP);
		expect(jar.cookieHeaderFor(IP)).toBe("a=1");
		expect(jar.cookieHeaderFor(new URL("http://110.0.0.1/"))).toBe("");
		expect(jar.cookieHeaderFor(new URL("http://10.0.0.2/"))).toBe("");
	});

	it("外发:盘上载进来的 IP 域 cookie(hostOnly 一律当域 cookie)也只回给原样的 IP", () => {
		const jar = new CookieJar();
		jar.load([{ key: "a", value: "1", domain: "0.0.1", path: "/" }]);
		expect(jar.cookieHeaderFor(IP)).toBe("");
		jar.load([{ key: "a", value: "1", domain: "10.0.0.1", path: "/" }]);
		expect(jar.cookieHeaderFor(IP)).toBe("a=1");
		expect(jar.cookieHeaderFor(new URL("http://110.0.0.1/"))).toBe("");
	});

	it("没有 Domain 的 host-only cookie 照旧只回给同一个 IP", () => {
		const jar = new CookieJar();
		jar.setFromSetCookie("a=1; Path=/", IP);
		expect(jar.cookieHeaderFor(IP)).toBe("a=1");
		expect(jar.cookieHeaderFor(new URL("http://10.0.0.2/"))).toBe("");
	});

	it("IPv6 字面量同理:原样才算,不做后缀匹配", () => {
		const jar = new CookieJar();
		const v6 = new URL("http://[2001:db8::1]/");
		jar.setFromSetCookie("a=1; Path=/", v6);
		expect(jar.cookieHeaderFor(v6)).toBe("a=1");
		expect(jar.cookieHeaderFor(new URL("http://[2001:db8::2]/"))).toBe("");
		jar.setFromSetCookie("b=2; Path=/; Domain=[2001:db8::1]", v6);
		expect(jar.cookieHeaderFor(v6)).toBe("a=1; b=2");
		expect(jar.cookieHeaderFor(new URL("http://[2001:db8::2]/"))).toBe("");
	});

	it("域名主机的后缀匹配不受影响", () => {
		const jar = new CookieJar();
		jar.setFromSetCookie("a=1; Path=/; Domain=.example.com", new URL("https://www.example.com/"));
		expect(jar.cookieHeaderFor(new URL("https://api.example.com/"))).toBe("a=1");
	});
});

describe("CookieJar — Set-Cookie 的 Domain 必须匹配请求主机,不匹配就丢", () => {
	it("无关域:来自 passport.bilibili.com 的 Domain=other.example 被丢弃,罐里什么都没有", () => {
		const jar = new CookieJar();
		jar.setFromSetCookie("SESSDATA=planted; Path=/; Domain=.other.example", PASSPORT);
		expect(jar.serialize()).toEqual([]);
		expect(jar.cookieHeaderFor(new URL("https://www.other.example/"))).toBe("");
	});

	it("兄弟子域:www.bilibili.com 不能给 api.bilibili.com 种 host 级 cookie(Domain=api.bilibili.com 被丢)", () => {
		const jar = new CookieJar();
		jar.setFromSetCookie("a=1; Path=/; Domain=api.bilibili.com", WWW);
		expect(jar.serialize()).toEqual([]);
	});

	it("父域是匹配的:www 可以种 Domain=bilibili.com", () => {
		const jar = new CookieJar();
		jar.setFromSetCookie("a=1; Path=/; Domain=bilibili.com", WWW);
		expect(jar.cookieHeaderFor(API)).toBe("a=1");
	});
});

describe("CookieJar — Domain 是公共后缀(RFC 6265 §5.3 第 5 步)", () => {
	it.each([
		["com", "https://www.bilibili.com/"],
		["com.cn", "https://www.example.com.cn/"],
		["co.uk", "https://shop.example.co.uk/"],
	])("Domain=%s 且请求主机在其下:整条丢,同后缀下的别的站也收不到", (suffix, requestUrl) => {
		const jar = new CookieJar();
		jar.setFromSetCookie(`planted=1; Path=/; Domain=${suffix}`, requestUrl);

		expect(jar.serialize()).toEqual([]);
		expect(jar.cookieHeaderFor(new URL(`https://victim.${suffix}/`))).toBe("");
	});

	it("带前导点、大小写不同的 Domain 一样拒", () => {
		const jar = new CookieJar();
		jar.setFromSetCookie("planted=1; Path=/; Domain=.CO.UK", "https://shop.example.co.uk/");
		expect(jar.serialize()).toEqual([]);
	});

	it("Domain 等于请求主机、又是公共后缀:当 host-only 收,不外发给子域", () => {
		const jar = new CookieJar();
		jar.setFromSetCookie("own=1; Path=/; Domain=co.uk", "https://co.uk/");

		expect(jar.serialize()).toEqual([expect.objectContaining({ key: "own", domain: "co.uk" })]);
		expect(jar.cookieHeaderFor(new URL("https://co.uk/"))).toBe("own=1");
		expect(jar.cookieHeaderFor(new URL("https://shop.example.co.uk/"))).toBe("");
	});

	it("私有段也算公共后缀:github.io 下的用户站种不进 Domain=github.io", () => {
		const jar = new CookieJar();
		jar.setFromSetCookie("planted=1; Path=/; Domain=github.io", "https://alice.github.io/");
		expect(jar.serialize()).toEqual([]);
	});

	it("Domain=bilibili.com 照收(B 站的登录态不受影响),子域能拿到", () => {
		const jar = new CookieJar();
		jar.setFromSetCookie("SESSDATA=s; Path=/; Domain=.bilibili.com", PASSPORT);
		expect(jar.cookieHeaderFor(API)).toBe("SESSDATA=s");
	});

	it("Domain 是自家的私有段注册域(alice.github.io)照收", () => {
		const jar = new CookieJar();
		jar.setFromSetCookie("a=1; Path=/; Domain=alice.github.io", "https://www.alice.github.io/");
		expect(jar.cookieHeaderFor(new URL("https://www.alice.github.io/"))).toBe("a=1");
	});

	it("IP 主机不查公共后缀:Domain 等于该 IP 照旧当 host-only", () => {
		const jar = new CookieJar();
		jar.setFromSetCookie("a=1; Path=/; Domain=127.0.0.1", "http://127.0.0.1:8080/");
		expect(jar.cookieHeaderFor(new URL("http://127.0.0.1:8080/"))).toBe("a=1");
	});
});

describe("CookieJar — 盘上 cookiesJson 原样可读写", () => {
	// 今天 serialize() 的输出形状(字段顺序也是它的):key / value / expires / domain / path /
	// secure / httpOnly / sameSite。值都是占位。
	const ON_DISK = JSON.stringify([
		{
			key: "SESSDATA",
			value: "fixture_sessdata%2Cfixture",
			expires: "2099-01-01T00:00:00.000Z",
			domain: "bilibili.com",
			path: "/",
			secure: true,
			httpOnly: true,
			sameSite: "lax",
		},
		{
			key: "bili_jct",
			value: "fixture_jct",
			expires: "2099-01-01T00:00:00.000Z",
			domain: "bilibili.com",
			path: "/",
			secure: false,
			httpOnly: false,
		},
		{
			key: "DedeUserID",
			value: "10001",
			expires: "Infinity",
			domain: "bilibili.com",
			path: "/",
			secure: false,
			httpOnly: false,
		},
		{
			key: "buvid3",
			value: "some_non_empty_value",
			expires: "Infinity",
			domain: "bilibili.com",
			path: "/x",
			secure: false,
			httpOnly: false,
		},
	]);

	it("今天的 cookiesJson:load 再 serialize,逐字节一致", () => {
		const jar = new CookieJar();
		jar.load(JSON.parse(ON_DISK));
		expect(JSON.stringify(jar.serialize())).toBe(ON_DISK);
	});

	it("tough-cookie 年代带多余字段的老文件:读得进来,写出去是今天的形状,值一格不丢", () => {
		const legacy = [
			{
				key: "SESSDATA",
				value: "fixture_sessdata%2Cfixture",
				expires: "2099-01-01T00:00:00.000Z",
				domain: "bilibili.com",
				path: "/",
				secure: true,
				httpOnly: true,
				hostOnly: false,
				sameSite: "lax",
				creation: "2026-01-01T00:00:00.000Z",
				lastAccessed: "2026-01-02T00:00:00.000Z",
			},
		];
		const jar = new CookieJar();
		jar.load(legacy);
		expect(jar.serialize()).toEqual([
			{
				key: "SESSDATA",
				value: "fixture_sessdata%2Cfixture",
				expires: "2099-01-01T00:00:00.000Z",
				domain: "bilibili.com",
				path: "/",
				secure: true,
				httpOnly: true,
				sameSite: "lax",
			},
		]);
	});
});
