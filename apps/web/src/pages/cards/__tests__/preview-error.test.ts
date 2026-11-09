import { beforeEach, describe, expect, it } from "vite-plus/test";
import { i18n } from "../../../i18n";
import { OFFLINE_STATUS } from "../../../services/api";
import { errorTextOf } from "../../../services/error-text";
import { previewErrorHint, previewErrorTitle, serverErrors } from "../preview-error";

beforeEach(() => i18n.set({ locale: "zh-CN", voice: "plain" }));

describe("预览失败的标题", () => {
	it.each([
		[
			"en",
			"Connection lost",
			"Rendering browser not configured",
			"Rendering failed",
			"Card rendering can take time. If you use a reverse proxy, set its read timeout above 120 seconds. The server may also have restarted, for example after running out of memory.",
		],
		[
			"ja",
			"接続が切れました",
			"描画用ブラウザーが未設定です",
			"描画に失敗しました",
			"カードの描画には時間がかかる場合があります。リバースプロキシを使用している場合は、読み取りタイムアウトを120秒より長くしてください。メモリー不足などでサーバーが再起動した可能性もあります。",
		],
		[
			"zh-TW",
			"連線中斷",
			"尚未設定繪製用瀏覽器",
			"繪製失敗",
			"卡片繪製可能較久。若透過反向代理存取，請將讀取逾時設為超過 120 秒；也可能是伺服器剛重新啟動，例如記憶體不足。",
		],
	] as const)(
		"%s distinguishes transport, configuration and rendering errors while preserving diagnostics",
		(locale, offline, unconfigured, failed, hint) => {
			i18n.set({ locale, voice: "plain" });
			expect(previewErrorTitle({ status: OFFLINE_STATUS })).toBe(offline);
			expect(previewErrorTitle({ status: 409, code: "not_configured" })).toBe(unconfigured);
			expect(previewErrorTitle({ status: 503, code: "unavailable" })).toBe(failed);
			expect(previewErrorTitle(undefined)).toBe(failed);
			expect(previewErrorHint(OFFLINE_STATUS)).toBe(hint);
			expect(previewErrorHint(503)).toBeNull();
			expect(
				serverErrors(
					Object.assign(new Error("Original diagnostic 原文"), {
						issues: [{ message: "Original issue 原文" }],
					}),
				),
			).toEqual(["Original issue 原文"]);
		},
	);
	it("断线单独成一档 —— 不能和「渲染失败」混为一谈", () => {
		// 服务端那边可能渲染得好好的,只是响应没送到,说「渲染失败」等于把人往错方向引。
		expect(previewErrorTitle({ status: OFFLINE_STATUS })).toBe("连接中断");
	});

	it("按码挑:没配浏览器(not_configured)是「尚未配置渲染浏览器」,与状态码无关", () => {
		expect(previewErrorTitle({ status: 409, code: "not_configured" })).toBe("尚未配置渲染浏览器");
		// 200 + 失败那一支造出来的错也一样 —— 认的是码,不是 HTTP 状态。
		expect(previewErrorTitle({ status: 200, code: "not_configured" })).toBe("尚未配置渲染浏览器");
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

it.each([
	[
		"ja",
		"ご主人様、接続が途切れました。",
		"ご主人様、描画用ブラウザーがまだ設定されていませんよ。",
		"ご主人様、今回の描画は失敗しました。",
		"ご主人様、カードの描画には時間がかかることがあります。リバースプロキシー経由なら、読み取りタイムアウトを120秒より長くしてくださいね。メモリー不足などでサーバーが再起動した可能性もあります。",
	],
	[
		"zh-TW",
		"主人，連線中斷了。",
		"主人，還沒設定繪製用瀏覽器喔。",
		"主人，這次繪製失敗了。",
		"主人，卡片繪製可能比較久喔。若透過反向代理存取，請把讀取逾時設為超過 120 秒；也可能是伺服器剛重新啟動，例如記憶體不足時被系統停止。",
	],
] as const)(
	"%s 女仆预览错误按码分类，只在断线时给网络排查提示",
	(locale, offline, unconfigured, failed, hint) => {
		i18n.set({ locale, voice: "maid" });
		expect(previewErrorTitle({ status: OFFLINE_STATUS })).toBe(offline);
		expect(previewErrorTitle({ status: 409, code: "not_configured" })).toBe(unconfigured);
		expect(previewErrorTitle({ status: 503, code: "unavailable" })).toBe(failed);
		expect(previewErrorTitle(undefined)).toBe(failed);
		expect(previewErrorHint(OFFLINE_STATUS)).toBe(hint);
		expect(previewErrorHint(503)).toBeNull();
		expect(
			serverErrors(
				Object.assign(new Error("Original diagnostic 原文"), {
					issues: [{ message: "Original issue 原文" }],
				}),
			),
		).toEqual(["Original issue 原文"]);
	},
);
