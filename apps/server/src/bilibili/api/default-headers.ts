import type { BrowserIdentity } from "@bilibili-notify/http";

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
