import { describe, expect, it } from "vite-plus/test";
import { OFFLINE_STATUS } from "../../../services/api";
import { previewErrorHint, previewErrorTitle } from "../preview-error";

describe("预览失败的标题", () => {
	it("断线单独成一档 —— 不能和「渲染失败」混为一谈", () => {
		// 服务端那边可能渲染得好好的,只是响应没送到,说「渲染失败」等于把人往错方向引。
		expect(previewErrorTitle(OFFLINE_STATUS)).toBe("连接中断");
	});

	it("认得出 puppeteer 未配置与暂未支持", () => {
		expect(previewErrorTitle(503)).toBe("puppeteer 未配置");
		expect(previewErrorTitle(501)).toBe("kind 暂未支持");
	});

	it("其余 HTTP 错误落回「渲染失败」", () => {
		expect(previewErrorTitle(500)).toBe("渲染失败");
		expect(previewErrorTitle(400)).toBe("渲染失败");
	});

	it("状态码缺席(不是 ApiError 的错误)不会被当成断线", () => {
		// OFFLINE_STATUS 是 0,而 `undefined === 0` 为 false —— 这一条钉的就是别改成
		// `!status` 之类的松判断,那样任何没带状态码的错误都会谎报「连接中断」。
		expect(previewErrorTitle(undefined)).toBe("渲染失败");
	});
});

describe("预览失败的排查提示", () => {
	it("只在断线时出现,并指向超时与内存两个方向", () => {
		const hint = previewErrorHint(OFFLINE_STATUS);
		expect(hint).toMatch(/反向代理/);
		expect(hint).toMatch(/内存/);
	});

	it("服务端明确报错时不出现 —— 那时该看服务端那句话,不是猜网络", () => {
		expect(previewErrorHint(500)).toBeNull();
		expect(previewErrorHint(503)).toBeNull();
		expect(previewErrorHint(undefined)).toBeNull();
	});
});
