/**
 * 清单里那枚图标 —— **加载时**过白名单(ADR-0012 决策 20)。
 *
 * 判据是「整枚要么放行、要么丢掉」而不是「把坏的部分剪掉」:剪剩下的那半张图既不好看
 * 也说不清是什么,而灰方章至少诚实。ADR 那句「失败退回灰方章」说的就是这件事。
 */

import { describe, expect, it } from "vite-plus/test";
import { safeExtensionIcon } from "../manifest-icon.js";

const PLAIN = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 18v-4a8 8 0 0 1 16 0v4"/><rect x="2" y="18" width="4" height="3" rx="1"/></svg>`;

describe("safeExtensionIcon", () => {
	it("一枚正常的描边图标原样放行", () => {
		expect(safeExtensionIcon(PLAIN)).toBe(PLAIN);
	});

	it("没有图标就是没有 —— 不是空字符串", () => {
		expect(safeExtensionIcon(undefined)).toBeUndefined();
		expect(safeExtensionIcon("   ")).toBeUndefined();
	});

	it("渐变那一套(defs / linearGradient / stop + url(#) 引用)放行", () => {
		const gradient = `<svg viewBox="0 0 24 24"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fb7299"/></linearGradient></defs><circle cx="12" cy="12" r="9" fill="url(#g)"/></svg>`;
		expect(safeExtensionIcon(gradient)).toBe(gradient);
	});

	it("夹带 <script> 的整枚丢掉", () => {
		expect(
			safeExtensionIcon(`<svg viewBox="0 0 24 24"><script>fetch("/api/globals")</script></svg>`),
		).toBeUndefined();
	});

	it("事件属性(onload / onclick)整枚丢掉 —— 白名单是**名单**,不是黑名单", () => {
		expect(
			safeExtensionIcon(`<svg viewBox="0 0 24 24" onload="alert(1)"><path d="M0 0"/></svg>`),
		).toBeUndefined();
	});

	/** 外链会在主人打开面板的那一刻替对家点名一次;`use`/`image` 是它最短的路。 */
	it("往外拿东西的元素与属性(image / use / href)整枚丢掉", () => {
		expect(
			safeExtensionIcon(
				`<svg viewBox="0 0 24 24"><image href="https://evil.example/x.png"/></svg>`,
			),
		).toBeUndefined();
		expect(
			safeExtensionIcon(
				`<svg viewBox="0 0 24 24"><use xlink:href="https://evil.example/s#i"/></svg>`,
			),
		).toBeUndefined();
	});

	it("url() 只认自己文档里的 #引用,外部地址整枚丢掉", () => {
		expect(
			safeExtensionIcon(
				`<svg viewBox="0 0 24 24"><rect fill="url(https://evil.example/x)"/></svg>`,
			),
		).toBeUndefined();
	});

	/** `style` 不在名单里:它是一整门语言,白名单管不住它里头写什么。 */
	it("style 属性与 <style> 元素都不在名单里", () => {
		expect(
			safeExtensionIcon(`<svg viewBox="0 0 24 24"><path style="color:red" d="M0 0"/></svg>`),
		).toBeUndefined();
		expect(
			safeExtensionIcon(`<svg viewBox="0 0 24 24"><style>*{fill:red}</style></svg>`),
		).toBeUndefined();
	});

	/** 注释 / CDATA 是「扫标签」这种写法的经典缝:两套解析器对同一段字节看法不同。 */
	it("注释与 CDATA 一律丢掉,不去猜里头是什么", () => {
		expect(
			safeExtensionIcon(
				`<svg viewBox="0 0 24 24"><!-- <script>x</script> --><path d="M0 0"/></svg>`,
			),
		).toBeUndefined();
	});

	it("根不是 <svg> 的整枚丢掉 —— 它要进的是图标槽,不是任意一段 HTML", () => {
		expect(safeExtensionIcon(`<div onclick="alert(1)">x</div>`)).toBeUndefined();
		expect(
			safeExtensionIcon(`<svg viewBox="0 0 24 24"></svg><img src=x onerror=alert(1)>`),
		).toBeUndefined();
	});

	it("标签之外的裸尖括号也算数 —— 扫不干净就别放行", () => {
		expect(safeExtensionIcon(`<svg viewBox="0 0 24 24">a < b</svg>`)).toBeUndefined();
	});
});
