import type { BACookie } from "./types";

/**
 * 轻量 cookie jar —— 取代 tough-cookie(RFC 6265 精简实现)。
 *
 * 本仓只需伺候 *.bilibili.com 一族域名,不做 public-suffix 校验等完整 RFC 面;
 * 但持久化格式与 tough-cookie `serializeSync().cookies` 双向兼容(BACookie:
 * expires 为 ISO 串或 "Infinity"、domain 无前导点)—— 用户盘上加密存储的
 * cookiesJson 必须原样可读写,否则升级即全员掉登录。
 */

interface StoredCookie {
	key: string;
	value: string;
	/** epoch ms;undefined = 不过期(tough-cookie 的 "Infinity" 语义)。 */
	expiresMs?: number;
	/** 无前导点。host-only cookie 存放请求 host。 */
	domain: string;
	path: string;
	secure: boolean;
	httpOnly: boolean;
	sameSite?: string;
	/** Set-Cookie 无 Domain 属性 → 仅回发给完全相同的 host。 */
	hostOnly: boolean;
}

function stripDot(domain: string): string {
	return domain.startsWith(".") ? domain.slice(1) : domain;
}

/** RFC 6265 §5.1.3 domain-match:精确相等,或 host 以 ".domain" 结尾(按段对齐)。 */
function domainMatch(host: string, domain: string): boolean {
	return host === domain || host.endsWith(`.${domain}`);
}

/** RFC 6265 §5.1.4 path-match(前缀且段对齐)。 */
function pathMatch(requestPath: string, cookiePath: string): boolean {
	if (requestPath === cookiePath) return true;
	if (!requestPath.startsWith(cookiePath)) return false;
	return cookiePath.endsWith("/") || requestPath[cookiePath.length] === "/";
}

/** RFC 6265 §5.1.4 default-path:取请求路径的目录部分。 */
function defaultPath(url: URL): string {
	const p = url.pathname;
	if (!p.startsWith("/") || p === "/") return "/";
	const idx = p.lastIndexOf("/");
	return idx === 0 ? "/" : p.slice(0, idx);
}

export class BiliCookieJar {
	private cookies: StoredCookie[] = [];

	/** 从持久化 BACookie 数组载入(tough-cookie 序列化形状;容忍多余字段)。 */
	load(cookies: BACookie[]): void {
		for (const c of cookies) {
			if (!c.key) continue;
			this.put({
				key: c.key,
				value: c.value ?? "",
				expiresMs: parseExpires(c.expires),
				domain: stripDot(c.domain ?? ""),
				path: c.path ?? "/",
				secure: c.secure ?? false,
				httpOnly: c.httpOnly ?? false,
				sameSite: c.sameSite,
				// 持久化数据缺 hostOnly 时按域 cookie 处理(loadCookies 旧行为:
				// 显式传 domain 经 tough-cookie setCookie → hostOnly=false)。
				hostOnly: false,
			});
		}
	}

	/** 序列化为 BACookie 数组(过期项剔除;expires 输出 ISO 或 "Infinity")。 */
	serialize(): BACookie[] {
		const now = Date.now();
		return this.cookies
			.filter((c) => c.expiresMs === undefined || c.expiresMs > now)
			.map((c) => ({
				key: c.key,
				value: c.value,
				expires: c.expiresMs === undefined ? "Infinity" : new Date(c.expiresMs).toISOString(),
				domain: c.domain,
				path: c.path,
				secure: c.secure,
				httpOnly: c.httpOnly,
				sameSite: c.sameSite,
			}));
	}

	/**
	 * 摄取一行 Set-Cookie(或等价的手工 cookie 串)。Domain 缺省 → host-only;
	 * Max-Age 优先于 Expires;Max-Age<=0 / 过去的 Expires → 删除同位 cookie。
	 */
	setFromSetCookie(line: string, requestUrl: URL | string): void {
		const url = typeof requestUrl === "string" ? new URL(requestUrl) : requestUrl;
		const [pair, ...attrs] = line.split(";");
		const eq = pair.indexOf("=");
		if (eq <= 0) return;
		const key = pair.slice(0, eq).trim();
		const value = pair.slice(eq + 1).trim();
		if (!key) return;

		let domain: string | undefined;
		let path: string | undefined;
		let secure = false;
		let httpOnly = false;
		let sameSite: string | undefined;
		let maxAge: number | undefined;
		let expires: number | undefined;
		for (const raw of attrs) {
			const [an, ...avParts] = raw.split("=");
			const name = an.trim().toLowerCase();
			const av = avParts.join("=").trim();
			if (name === "domain" && av) domain = stripDot(av.toLowerCase());
			else if (name === "path" && av.startsWith("/")) path = av;
			else if (name === "secure") secure = true;
			else if (name === "httponly") httpOnly = true;
			else if (name === "samesite") sameSite = av.toLowerCase();
			else if (name === "max-age" && /^-?\d+$/.test(av)) maxAge = Number(av);
			else if (name === "expires") {
				const t = Date.parse(av);
				if (!Number.isNaN(t)) expires = t;
			}
		}

		const host = url.hostname.toLowerCase();
		// 域 cookie 只接受与请求 host 匹配的 Domain(防跨域投毒;同 tough-cookie)。
		if (domain && !domainMatch(host, domain)) return;

		const expiresMs = maxAge !== undefined ? Date.now() + maxAge * 1000 : expires;
		const cookie: StoredCookie = {
			key,
			value,
			expiresMs,
			domain: domain ?? host,
			path: path ?? defaultPath(url),
			secure,
			httpOnly,
			sameSite,
			hostOnly: domain === undefined,
		};
		if (expiresMs !== undefined && expiresMs <= Date.now()) {
			// 立即过期 = 删除指令(Max-Age=0 / 过去的 Expires)。
			this.cookies = this.cookies.filter((c) => !samePlace(c, cookie));
			return;
		}
		this.put(cookie);
	}

	/** 生成对该 URL 外发的 Cookie 头(不匹配则空串)。 */
	cookieHeaderFor(url: URL | string): string {
		const u = typeof url === "string" ? new URL(url) : url;
		const host = u.hostname.toLowerCase();
		const isHttps = u.protocol === "https:";
		const reqPath = u.pathname || "/";
		const now = Date.now();
		return this.cookies
			.filter(
				(c) =>
					(c.expiresMs === undefined || c.expiresMs > now) &&
					(c.hostOnly ? host === c.domain : domainMatch(host, c.domain)) &&
					pathMatch(reqPath, c.path) &&
					(!c.secure || isHttps),
			)
			.sort((a, b) => b.path.length - a.path.length)
			.map((c) => `${c.key}=${c.value}`)
			.join("; ");
	}

	/** 按 key 取第一个未过期值(bili_jct / CSRF 查找)。 */
	getValue(key: string): string | undefined {
		const now = Date.now();
		return this.cookies.find(
			(c) => c.key === key && (c.expiresMs === undefined || c.expiresMs > now),
		)?.value;
	}

	private put(cookie: StoredCookie): void {
		const idx = this.cookies.findIndex((c) => samePlace(c, cookie));
		if (idx >= 0) this.cookies[idx] = cookie;
		else this.cookies.push(cookie);
	}
}

function samePlace(a: StoredCookie, b: StoredCookie): boolean {
	return a.key === b.key && a.domain === b.domain && a.path === b.path;
}

function parseExpires(expires?: string): number | undefined {
	if (!expires || expires === "Infinity") return undefined;
	const t = Date.parse(expires);
	return Number.isNaN(t) ? undefined : t;
}
