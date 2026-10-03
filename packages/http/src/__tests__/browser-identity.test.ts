/**
 * 浏览器身份 —— 生成与「只升不降」。
 *
 * 背景:旧默认头是拼接怪(UA 自称 Firefox 115、sec-ch-ua 却自称 Chrome 139,
 * 而真实 Firefox 根本不发 sec-ch-ua),且全网实例共享同一冻结 UA。现改为启动时
 * 生成一次自洽的 Chrome 身份:UA 与 sec-ch-ua 版本互相咬合、平台一致,
 * **单实例内稳定不变**(逐请求随机跳变是机器人特征,绝不可做)。
 */

import { describe, expect, it } from "vite-plus/test";
import {
	type BrowserIdentity,
	CHROME_MAJOR_MAX,
	CHROME_MAJOR_MIN,
	generateBrowserIdentity,
	upgradeBrowserIdentity,
} from "../browser-identity";

/** 造一份指定大版本的身份(形状同 generateBrowserIdentity 的产物)。 */
function identityOfMajor(major: number): BrowserIdentity {
	return {
		userAgent: `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`,
		secChUa: `"Not;A=Brand";v="99", "Google Chrome";v="${major}", "Chromium";v="${major}"`,
		secChUaMobile: "?0",
		secChUaPlatform: '"Linux"',
	};
}

describe("generateBrowserIdentity — 自洽的 Chrome 身份", () => {
	it("UA 是 Linux Chrome 形状,且大版本落在维护区间内", () => {
		const id = generateBrowserIdentity();
		const m =
			/^Mozilla\/5\.0 \(X11; Linux x86_64\) AppleWebKit\/537\.36 \(KHTML, like Gecko\) Chrome\/(\d+)\.0\.0\.0 Safari\/537\.36$/.exec(
				id.userAgent,
			);
		expect(m).not.toBeNull();
		const major = Number(m?.[1]);
		expect(major).toBeGreaterThanOrEqual(CHROME_MAJOR_MIN);
		expect(major).toBeLessThanOrEqual(CHROME_MAJOR_MAX);
	});

	it("sec-ch-ua 与 UA 的 Chrome 大版本互相咬合,平台一致为 Linux", () => {
		const id = generateBrowserIdentity();
		const major = /Chrome\/(\d+)\./.exec(id.userAgent)?.[1];
		expect(id.secChUa).toContain(`"Google Chrome";v="${major}"`);
		expect(id.secChUa).toContain(`"Chromium";v="${major}"`);
		expect(id.secChUaMobile).toBe("?0");
		expect(id.secChUaPlatform).toBe('"Linux"');
	});

	it("注入随机源可确定性生成(0 → 区间下界,~1 → 区间上界)", () => {
		const low = generateBrowserIdentity(() => 0);
		const high = generateBrowserIdentity(() => 0.999999);
		expect(low.userAgent).toContain(`Chrome/${CHROME_MAJOR_MIN}.`);
		expect(high.userAgent).toContain(`Chrome/${CHROME_MAJOR_MAX}.`);
	});
});

describe("upgradeBrowserIdentity — 按版本区间只升不降", () => {
	it("存着的大版本低于区间下限 → 换一份新的(落在区间内,UA 与 sec-ch-ua 仍咬合)", () => {
		const stale = identityOfMajor(CHROME_MAJOR_MIN - 1);
		const next = upgradeBrowserIdentity(stale);
		const major = Number(/Chrome\/(\d+)\./.exec(next.userAgent)?.[1]);
		expect(major).toBeGreaterThanOrEqual(CHROME_MAJOR_MIN);
		expect(major).toBeLessThanOrEqual(CHROME_MAJOR_MAX);
		expect(next.secChUa).toContain(`"Google Chrome";v="${major}"`);
		expect(next).not.toEqual(stale);
	});

	it("换新用注入的随机源(可确定性测)", () => {
		const next = upgradeBrowserIdentity(identityOfMajor(100), () => 0);
		expect(next.userAgent).toContain(`Chrome/${CHROME_MAJOR_MIN}.`);
	});

	it("恰好在区间下限、或区间内 → 原样回(同一个对象,不重新生成)", () => {
		const atMin = identityOfMajor(CHROME_MAJOR_MIN);
		expect(upgradeBrowserIdentity(atMin)).toBe(atMin);
		const inside = identityOfMajor(CHROME_MAJOR_MAX);
		expect(upgradeBrowserIdentity(inside)).toBe(inside);
	});

	it("存着的比区间上限还新 → 不降,原样回", () => {
		const newer = identityOfMajor(CHROME_MAJOR_MAX + 5);
		expect(upgradeBrowserIdentity(newer)).toBe(newer);
	});

	it("UA 里读不出 Chrome 大版本(存坏了、不是 Chrome)→ 当作低于下限,换新的", () => {
		const broken: BrowserIdentity = { ...identityOfMajor(CHROME_MAJOR_MAX), userAgent: "curl/8.0" };
		const next = upgradeBrowserIdentity(broken);
		expect(next.userAgent).toMatch(/Chrome\/\d+\./);
	});
});
