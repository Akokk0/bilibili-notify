import { describe, expect, it } from "vite-plus/test";
import { OFFLINE_STATUS } from "../../../services/api";
import { errorTextOf } from "../../../services/error-text";
import { previewErrorHint, previewErrorTitle, serverErrors } from "../preview-error";

describe("预览失败的标题", () => {
	it("断线单独成一档 —— 不能和「渲染失败」混为一谈", () => {
		// 服务端那边可能渲染得好好的,只是响应没送到,说「渲染失败」等于把人往错方向引。
		expect(previewErrorTitle({ status: OFFLINE_STATUS })).toBe("连接中断");
	});

	it("按码挑:没配浏览器(not_configured)是「puppeteer 未配置」,与状态码无关", () => {
		expect(previewErrorTitle({ status: 409, code: "not_configured" })).toBe("puppeteer 未配置");
		// 200 + 失败那一支造出来的错也一样 —— 认的是码,不是 HTTP 状态。
		expect(previewErrorTitle({ status: 200, code: "not_configured" })).toBe("puppeteer 未配置");
	});

	it("引擎还没就绪(unavailable)不是「未配置」:同样是 503 从前会被认成未配置", () => {
		expect(previewErrorTitle({ status: 503, code: "unavailable" })).toBe("渲染失败");
	});

	it("其余错误落回「渲染失败」", () => {
		expect(previewErrorTitle({ status: 200, code: "unavailable" })).toBe("渲染失败");
		expect(previewErrorTitle({ status: 400, code: "invalid" })).toBe("渲染失败");
		expect(previewErrorTitle({ status: 500 })).toBe("渲染失败");
	});

	it("状态码缺席(不是 ApiError 的错误)不会被当成断线", () => {
		// OFFLINE_STATUS 是 0,而 `undefined === 0` 为 false —— 这一条钉的就是别改成
		// `!status` 之类的松判断,那样任何没带状态码的错误都会谎报「连接中断」。
		expect(previewErrorTitle({})).toBe("渲染失败");
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

describe("服务端拒收的逐条原因", () => {
	it("有 issues → 逐条列它们", () => {
		const err = Object.assign(new Error("这版草稿没通过检查（共 2 条）"), {
			issues: [{ message: "块 id 重了:notice" }, { message: "css 洗完是空的" }],
		});
		expect(serverErrors(err)).toEqual(["块 id 重了:notice", "css 洗完是空的"]);
	});

	it("一句话的失败没有 issues → 退回 message,至少还有一句话", () => {
		expect(serverErrors(new Error("皮肤 id 只准小写字母、数字、连字符"))).toEqual([
			"皮肤 id 只准小写字母、数字、连字符",
		]);
	});

	it("没有错 → 空", () => {
		expect(serverErrors(null)).toEqual([]);
	});

	it("与 errorTextOf 读的是同一份 issues:两处摆出来的原因对得上", () => {
		const err = Object.assign(new Error("概括"), {
			issues: [{ message: "甲" }, { message: "乙" }],
		});
		expect(errorTextOf(err)).toBe(`概括：${serverErrors(err).join("；")}`);
	});
});
