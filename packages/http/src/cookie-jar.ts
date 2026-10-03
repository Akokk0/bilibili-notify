/**
 * 轻量 cookie 罐 —— 取代 tough-cookie。
 *
 * 实现 RFC 6265 的存取与匹配,够一个集成连它自己的几个站用:
 * - Set-Cookie 摄取:Domain 缺省 → host-only;Max-Age 优先于 Expires;立即过期 = 删除指令;
 *   Domain 必须能匹配请求主机,不匹配整条丢弃(§5.3 第 6 步)。
 * - 匹配:域 cookie 按段对齐的后缀匹配,host-only 精确匹配;path 前缀匹配;Secure 只发 https;
 *   过期的不发也不存盘。
 * - IP 主机只认原样(§5.1.3):不做后缀匹配,10.0.0.1 与 110.0.0.1 之间、IP 与它的任何「后缀」
 *   之间都不会串 cookie。
 *
 * 不做的(已知限制):
 * - **公共后缀**:`Set-Cookie: Domain=com` 这类不拒。漏判的后果是 cookie 在同一个罐子见过的几个
 *   站之间串 —— 每个集成一只罐子,串不到别的集成。等罐子开给拓展时再评估要不要引公共后缀表。
 * - SameSite 只存不执行(没有「第三方上下文」的概念);cookie 数量与体积不设上限。
 *
 * 存盘形状({@link Cookie})与 tough-cookie `serializeSync().cookies` 双向兼容:expires 为 ISO 串
 * 或 "Infinity"、domain 无前导点。盘上已有的 cookiesJson 必须原样可读写,否则升级即全员掉登录。
 *
 * 罐子是长期有效的同一个对象:换登录态用 {@link CookieJar.load} / {@link CookieJar.clear} 原地换,
 * 不重建罐子,也就不用重建持有它的客户端。内容变了经 {@link CookieJar.onChange} 通知。
 */

/**
 * 一条 cookie 的存盘形状 —— tough-cookie `serializeSync().cookies` 的子集:expires 为 ISO 串或
 * "Infinity"、domain 无前导点。字段全部可选(旧数据缺哪格都读得进来),读入时容忍多余字段。
 */
export interface Cookie {
	key: string;
	value: string;
	expires?: string;
	domain?: string;
	path?: string;
	secure?: boolean;
	httpOnly?: boolean;
	sameSite?: string;
}

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

const IPV4_LITERAL = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/** IP 字面量:IPv4 点分十进制,或 IPv6(`URL.hostname` 给带方括号的 `[::1]`)。 */
function isIpHost(host: string): boolean {
	return host.startsWith("[") || host.includes(":") || IPV4_LITERAL.test(host);
}

/**
 * RFC 6265 §5.1.3 domain-match:精确相等,或 host 以 ".domain" 结尾(按段对齐)。
 * 任何一边是 IP 字面量就只认精确相等 —— 后缀匹配只对域名有意义。
 */
function domainMatch(host: string, domain: string): boolean {
	if (host === domain) return true;
	if (isIpHost(host) || isIpHost(domain)) return false;
	return host.endsWith(`.${domain}`);
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

function samePlace(a: StoredCookie, b: StoredCookie): boolean {
	return a.key === b.key && a.domain === b.domain && a.path === b.path;
}

function sameContent(a: StoredCookie, b: StoredCookie): boolean {
	return (
		a.value === b.value &&
		a.expiresMs === b.expiresMs &&
		a.secure === b.secure &&
		a.httpOnly === b.httpOnly &&
		a.sameSite === b.sameSite &&
		a.hostOnly === b.hostOnly
	);
}

function parseExpires(expires?: string): number | undefined {
	if (!expires || expires === "Infinity") return undefined;
	const t = Date.parse(expires);
	return Number.isNaN(t) ? undefined : t;
}

/** 放进列表:同 (domain,path,key) 覆盖旧值。返回内容有没有变(新增或值不同)。 */
function putInto(list: StoredCookie[], cookie: StoredCookie): boolean {
	const idx = list.findIndex((c) => samePlace(c, cookie));
	if (idx < 0) {
		list.push(cookie);
		return true;
	}
	const changed = !sameContent(list[idx], cookie);
	list[idx] = cookie;
	return changed;
}

export class CookieJar {
	private cookies: StoredCookie[] = [];
	private swaps = 0;
	private readonly handlers = new Set<() => void>();

	/**
	 * 罐子被整个换掉(`load` / `clear`)的次数,只增不减。
	 *
	 * 给在途请求用:请求发出时记下它,回来时对不上,说明这只罐子在等待期间换了登录态,
	 * 这份响应属于上一个会话,它的 Set-Cookie 不该写进新罐子(`HttpClient` 就是这么做的)。
	 */
	get epoch(): number {
		return this.swaps;
	}

	/**
	 * 订阅「内容变了」。每次摄取到新的或改了值的 cookie、删除指令真删掉了东西、`load` / `clear`
	 * 换了内容之后同步调一次(调用时罐子已是新内容);内容没变(同样的 Set-Cookie 再来一遍、
	 * 空罐上的 `clear`)不通知。cookie 自然过期不算变。订阅者抛错会原样冒出来、盖过当次操作。
	 *
	 * @returns 取消订阅的函数
	 */
	onChange(handler: () => void): () => void {
		this.handlers.add(handler);
		return () => {
			this.handlers.delete(handler);
		};
	}

	/**
	 * 整罐换成这批 cookie:原有的一条不留(同一批里同 (domain,path,key) 后者覆盖前者)。
	 * 载入数据缺 hostOnly,一律按域 cookie 处理;容忍多余字段、跳过没有 key 的条目。
	 */
	load(cookies: Cookie[]): void {
		const next: StoredCookie[] = [];
		for (const c of cookies) {
			if (!c.key) continue;
			putInto(next, {
				key: c.key,
				value: c.value ?? "",
				expiresMs: parseExpires(c.expires),
				domain: stripDot(c.domain ?? ""),
				path: c.path ?? "/",
				secure: c.secure ?? false,
				httpOnly: c.httpOnly ?? false,
				sameSite: c.sameSite,
				hostOnly: false,
			});
		}
		this.replaceAll(next);
	}

	/** 清空整罐(登出)。罐子还是同一个,之后照常收 cookie。 */
	clear(): void {
		this.replaceAll([]);
	}

	/** 序列化为 Cookie 数组(过期项剔除;expires 输出 ISO 或 "Infinity")。 */
	serialize(): Cookie[] {
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
	 * Max-Age 优先于 Expires;Max-Age<=0 / 过去的 Expires → 删除同位 cookie;
	 * Domain 与请求主机不匹配 → 整条丢弃。
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
		// 域 cookie 只接受与请求 host 匹配的 Domain(防跨域投毒)。
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
			const kept = this.cookies.filter((c) => !samePlace(c, cookie));
			if (kept.length === this.cookies.length) return;
			this.cookies = kept;
			this.notify();
			return;
		}
		if (putInto(this.cookies, cookie)) this.notify();
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

	/** 按 key 取第一个未过期值(CSRF 之类的查找)。 */
	getValue(key: string): string | undefined {
		const now = Date.now();
		return this.cookies.find(
			(c) => c.key === key && (c.expiresMs === undefined || c.expiresMs > now),
		)?.value;
	}

	private replaceAll(next: StoredCookie[]): void {
		const wasEmpty = this.cookies.length === 0;
		this.cookies = next;
		this.swaps++;
		if (wasEmpty && next.length === 0) return;
		this.notify();
	}

	private notify(): void {
		for (const handler of [...this.handlers]) handler();
	}
}
