/**
 * 浏览器身份生成 —— 取代冻结的默认 UA。
 *
 * 旧默认头是历史拼接怪:UA 自称 Firefox 115、sec-ch-ua 却自称 Chrome 139,
 * 而真实 Firefox 根本不发 sec-ch-ua;且全网实例共享同一冻结 UA,极易被按
 * 指纹归为一族。现在每个 BilibiliAPI 实例启动时生成一次自洽的 Linux Chrome
 * 身份:UA 与 sec-ch-ua 的大版本互相咬合、平台与 sec-ch-ua-platform 一致。
 *
 * 硬约束:**单实例内身份必须稳定**(BilibiliAPI 持有一份,client 重建时复用)
 * —— 同一 cookie 会话在不同 UA 间跳变是典型机器人特征,逐请求/逐重建随机
 * 反而招风控。用户配置的 `app.userAgent` 仍优先于生成值。
 *
 * 版本区间随维护窗口手动前移(发版时校一眼当前 Chrome stable 即可)。
 */

export const CHROME_MAJOR_MIN = 136;
export const CHROME_MAJOR_MAX = 141;

export interface BrowserIdentity {
	userAgent: string;
	secChUa: string;
	secChUaMobile: string;
	secChUaPlatform: string;
}

export function generateBrowserIdentity(random: () => number = Math.random): BrowserIdentity {
	const span = CHROME_MAJOR_MAX - CHROME_MAJOR_MIN + 1;
	const major = CHROME_MAJOR_MIN + Math.min(span - 1, Math.floor(random() * span));
	return {
		userAgent: `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`,
		secChUa: `"Not;A=Brand";v="99", "Google Chrome";v="${major}", "Chromium";v="${major}"`,
		secChUaMobile: "?0",
		secChUaPlatform: '"Linux"',
	};
}
