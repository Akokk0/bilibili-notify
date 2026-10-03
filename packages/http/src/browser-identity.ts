/**
 * 浏览器身份:UA 与 `sec-ch-ua` 那一套,一起生成、永远配套。
 *
 * 旧默认头是历史拼接怪:UA 自称 Firefox 115、sec-ch-ua 却自称 Chrome 139,而真实 Firefox
 * 根本不发 sec-ch-ua;且全网实例共享同一冻结 UA,极易被按指纹归为一族。现在每个集成生成一份
 * 自洽的 Linux Chrome 身份:UA 与 sec-ch-ua 的大版本互相咬合、平台与 sec-ch-ua-platform 一致。
 *
 * 硬约束:**一个集成的身份必须稳定** —— 同一 cookie 会话在不同 UA 间跳变是典型机器人特征,
 * 逐请求 / 逐重建随机反而招风控。所以这里只有两个纯函数:{@link generateBrowserIdentity}
 * 生成一份,{@link upgradeBrowserIdentity} 在版本区间前挪之后把存着的旧身份换新、其余原样不动
 * (只升不降)。存在哪里、什么时候调,归调用方(`HttpClient` 只收现成的身份)。
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

/**
 * 存着的身份大版本低于区间下限(或读不出大版本)就换一份新的,否则原样回(同一个对象)。
 * 只升不降:区间之内、比区间上限还新的都不动 —— 身份稳定比版本新更要紧。
 */
export function upgradeBrowserIdentity(
	stored: BrowserIdentity,
	random: () => number = Math.random,
): BrowserIdentity {
	const major = /Chrome\/(\d+)\./.exec(stored.userAgent)?.[1];
	if (major !== undefined && Number(major) >= CHROME_MAJOR_MIN) return stored;
	return generateBrowserIdentity(random);
}
