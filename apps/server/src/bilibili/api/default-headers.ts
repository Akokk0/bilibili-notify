import {
	type BrowserIdentity,
	CookieJar,
	generateBrowserIdentity,
	HttpClient,
} from "@bilibili-notify/http";

/** 单跳超时:无 timeout 时一个挂起连接(对端不回 / 半开 TCP)会让该请求永不结束。 */
const REQUEST_TIMEOUT_MS = 20_000;

/**
 * B 站特有的默认头;通用包不带任何平台的默认值。
 * UA 与 sec-ch-ua 三件取自同一份生成身份,版本互相咬合(旧默认是 Firefox UA
 * 配 Chrome sec-ch-ua 的拼接怪)。**身份的头在这里按老位置写全**:HttpClient 对
 * 没写的才补、补在最后,写在这里线上头序与改造前逐字节一致(头序也是指纹的一部分,
 * bilibili-wire-headers.test.ts 钉着)。UA 排在最后不是笔误:改造前开机总会调一次
 * setUserAgent,旧 setHeader 先删再从末尾加回,生产上跑了几个月的就是这个顺序(10-03 主人定恢复)。
 */
export function defaultHeaders(identity: BrowserIdentity): Record<string, string> {
	return {
		// axios 时代由其默认值隐式外发,换 fetch 后需显式钉死(风控指纹对齐)。
		Accept: "application/json, text/plain, */*",
		Origin: "https://www.bilibili.com",
		Referer: "https://www.bilibili.com/",
		priority: "u=1, i",
		"sec-ch-ua": identity.secChUa,
		"sec-ch-ua-mobile": identity.secChUaMobile,
		"sec-ch-ua-platform": identity.secChUaPlatform,
		"sec-fetch-dest": "empty",
		"sec-fetch-mode": "cors",
		"sec-fetch-site": "same-site",
		"User-Agent": identity.userAgent,
		// 注:不设默认 Content-Type —— axios 对无 body 的 GET 会剥掉该头、
		// 表单 POST 又逐请求覆盖,旧线上流量从未真正发过 application/json。
	};
}

/**
 * 造 B 站这一路的请求底座:cookie 罐、浏览器身份、套了默认头的 `HttpClient`,交给 `Api`。
 *
 * 身份启动时生成一次、终身不变 —— 同一 cookie 会话在不同 UA 间跳变是机器人特征,身份漂移比版本旧更招风控。
 * **出站请求的 UA 只来自它**:HTTP 默认头、取 ticket、弹幕握手都读这一份,没有任何改 UA 的口子
 * (填了别的 UA 而 sec-ch-ua 仍是它的,拼出来是自相矛盾的指纹,ADR-0025 决策 7)。
 * 罐子与客户端都是**长期有效的同一个**:换号 / 登出 / -101 只调罐子的 `load()` / `clear()` 原地换内容。
 */
export function createBiliHttp(identity: BrowserIdentity = generateBrowserIdentity()): {
	jar: CookieJar;
	identity: BrowserIdentity;
	http: HttpClient;
} {
	const jar = new CookieJar();
	const http = new HttpClient({
		jar,
		identity,
		timeoutMs: REQUEST_TIMEOUT_MS,
		headers: defaultHeaders(identity),
	});
	return { jar, identity, http };
}
