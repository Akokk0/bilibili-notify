/**
 * `login [来源]` —— 在手机上重新扫码登录某个来源。
 *
 * 三条硬约束(方案里已经论证过,这里只负责钉住):
 *
 * 1. **二维码只发私聊。**发进群等于公开征集「谁来当我的账号」。这条由
 *    「主人目标只许指向私聊」保证(保存时拒收、`notifyMaster` 发送时复检,不会落到群),
 *    指令层要保证的是:**发不出去必须说出来**。
 * 2. 风险主要不是泄漏而是**污染** —— 攻击者若能触发扫码并抢先扫,系统就跑在他的
 *    账号上。触发权由分发器的鉴权门挡住,这里不重复。
 * 3. **码 180 秒过期**,所以只能主人敲的那一刻现生成。绝不做「检测到失效就自动推
 *    一个码」—— 他两小时后看手机拿到的是废码,反而以为系统坏了。
 *
 * 来源从登记表现读:零个 / 一个 / 多个、带词与不带词各回什么,下面逐种钉死。
 */

import {
	type AuthState,
	fail,
	type NotificationPayload,
	ok,
	type Result,
} from "@bilibili-notify/internal";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { i18n } from "../../i18n/index.js";
import type { SourceLoginView } from "../../subscriptions/registry.js";
import { createLoginCommand } from "../login-command.js";

/** 一个 1×1 PNG 的 data URL,用来验「发出去的是字节不是那串文本」。 */
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const QR_DATA_URL = `data:image/png;base64,${PNG_BYTES.toString("base64")}`;

const QR_READY: AuthState = {
	status: "awaiting-scan",
	qr: { dataUrl: QR_DATA_URL, expiresAt: "2026-10-11T00:03:00.000Z" },
};

/** 一个带登录口的假来源;`beginLogin` 是 spy,看得出发起扫码调的是谁。 */
function loginSource(
	sourceKey: string,
	label: string,
	after: AuthState = QR_READY,
	beginResult?: Result,
): SourceLoginView & { beginLogin: ReturnType<typeof vi.fn> } {
	const beginLogin = vi.fn(async (): Promise<Result> => beginResult ?? ok());
	return {
		sourceKey,
		label,
		beginLogin,
		auth: {
			beginLogin,
			logout: async () => ok(),
			state: () => after,
			onChange: () => ({ dispose() {} }),
		},
	};
}

const BILI = () => loginSource("bilibili", "B 站");
const ACME = () => loginSource("acme.inprocess", "对拍源");
beforeEach(() => i18n.set({ locale: "zh-CN", voice: "maid" }));

function setup(sources: SourceLoginView[], opts: { sendOk?: boolean } = {}) {
	const replies: string[] = [];
	const sent: Buffer[] = [];
	const spec = createLoginCommand({
		sources: () => sources,
		logger: { debug() {}, info() {}, warn() {}, error() {} },
	});
	// 二维码经 `ctx.reply` 发图:图的字节进 sent,文字进 replies;sendOk=false 模拟图没送到。
	const ctx = {
		reply: async (payload: string | NotificationPayload) => {
			if (typeof payload === "string") replies.push(payload);
			else if (payload.kind === "image") {
				sent.push(payload.image.buffer);
				if (opts.sendOk === false) return fail("unavailable", "测试里没送到");
			}
			return ok({ latencyMs: 0 });
		},
	};
	return {
		spec,
		replies,
		sent,
		fire: (word?: string) => spec.run(word === undefined ? {} : { source: word }, ctx),
	};
}

describe("login 指令", () => {
	it.each([
		[
			"en",
			"No QR code was received. Try again later.",
			"The QR code could not be sent. Scan it in the console instead.",
			'Scan this code to sign in to "Original 原文" within 180 seconds. Run the command again if it expires.',
		],
		[
			"ja",
			"QRコードを取得できませんでした。時間をおいて再試行してください。",
			"QRコードを送信できませんでした。管理画面で読み取ってください。",
			"180秒以内にこのコードを読み取り、「Original 原文」にログインしてください。期限が切れたら、コマンドを再実行してください。",
		],
		[
			"zh-TW",
			"未取得 QR Code，請稍後再試。",
			"無法傳送 QR Code，請改到控制台掃碼。",
			"請在 180 秒內掃描此碼登入「Original 原文」，過期後請重新執行指令。",
		],
	] as const)(
		"%s localizes QR outcomes while retaining decoded bytes, source names and original diagnostics",
		async (locale, noQr, notSent, scanned) => {
			i18n.set({ locale, voice: "plain" });
			const success = setup([loginSource("alpha", "Original 原文")]);
			expect(await success.fire()).toEqual(ok());
			expect(success.sent).toEqual([PNG_BYTES]);
			expect(success.replies).toEqual([scanned]);
			expect(
				await setup([loginSource("alpha", "Original 原文")], { sendOk: false }).fire(),
			).toEqual(fail("unavailable", notSent));
			expect(
				await setup([loginSource("alpha", "Original 原文", { status: "logged-out" })]).fire(),
			).toEqual(fail("unavailable", noQr));
			expect(
				await setup([
					loginSource("alpha", "Original 原文", {
						status: "error",
						message: "Original auth diagnostic 原文",
					}),
				]).fire(),
			).toEqual(fail("unavailable", "Original auth diagnostic 原文"));
		},
	);

	it.each([
		[
			"en",
			{
				empty: "No source currently supports sign-in.",
				unknown: 'No source named "missing". Available sources: Original 原文（alpha）',
				ambiguous:
					'Several sources are named "Original 原文". Use a source key: Original 原文（alpha）、Original 原文（beta）',
				pick: "Multiple sources support sign-in:\n- Original 原文（alpha）\n- Original 原文（beta）\nEnter login followed by the source name or key, for example: login alpha",
			},
		],
		[
			"ja",
			{
				empty: "現在、ログインに対応する配信元はありません。",
				unknown:
					"「missing」という配信元はありません。ログイン可能な配信元：Original 原文（alpha）",
				ambiguous:
					"「Original 原文」という配信元が複数あります。キーで指定してください：Original 原文（alpha）、Original 原文（beta）",
				pick: "ログイン可能な配信元が複数あります：\n- Original 原文（alpha）\n- Original 原文（beta）\nloginの後に配信元の名前かキーを指定してください。例：login alpha",
			},
		],
		[
			"zh-TW",
			{
				empty: "目前沒有可登入的來源。",
				unknown: "找不到名為「missing」的來源。可登入的來源：Original 原文（alpha）",
				ambiguous:
					"有多個來源名為「Original 原文」，請改用來源鍵：Original 原文（alpha）、Original 原文（beta）",
				pick: "有多個來源可登入：\n- Original 原文（alpha）\n- Original 原文（beta）\n請在 login 後加上來源名稱或鍵，例如：login alpha",
			},
		],
	] as const)(
		"%s translates source selection without changing keys, names or starting an ambiguous login",
		async (locale, text) => {
			const first = loginSource("alpha", "Original 原文");
			const second = loginSource("beta", "Original 原文");
			const none = setup([]);
			const single = setup([first]);
			const multiple = setup([first, second]);
			i18n.set({ locale, voice: "plain" });
			expect(await none.fire()).toEqual(fail("not_found", text.empty));
			expect(await single.fire("missing")).toEqual(fail("not_found", text.unknown));
			expect(await multiple.fire("Original 原文")).toEqual(fail("invalid", text.ambiguous));
			expect(await multiple.fire()).toEqual(ok());
			expect(multiple.replies).toEqual([text.pick]);
			expect(first.beginLogin).not.toHaveBeenCalled();
			expect(second.beginLogin).not.toHaveBeenCalled();
			expect(multiple.sent).toEqual([]);
		},
	);

	it("主名英文,中文走别名,来源是一个可选参数", () => {
		const { spec } = setup([BILI()]);
		expect(spec.name).toBe("login");
		expect(spec.aliases).toContain("扫码");
		expect(spec.aliases).toContain("登录");
		expect(spec.signature).toBe("[source:text]");
		expect(spec.parameterLabels).toEqual({ source: "来源" });
	});

	describe("挑来源", () => {
		it("一个带登录的来源都没有 → not_found,话说清「现在没有能登录的来源」", async () => {
			const { replies, sent, fire } = setup([]);
			expect(await fire()).toEqual(fail("not_found", "现在没有能登录的来源～"));
			expect(await fire("bilibili")).toEqual(fail("not_found", "现在没有能登录的来源～"));
			expect(sent).toHaveLength(0);
			expect(replies).toEqual([]);
		});

		it("不带参数、恰好一个 → 直接对它发起扫码,发那张码", async () => {
			const bili = BILI();
			const { sent, fire } = setup([bili]);
			expect(await fire()).toEqual(ok());
			expect(bili.beginLogin).toHaveBeenCalledTimes(1);
			expect(sent).toHaveLength(1);
		});

		// 验红:把「多个 → 列出来」改成直接扫第一个,这条红(begin 被叫了、回话里没有清单)。
		it("不带参数、不止一个 → 正常回答而不是失败:列出来(名字加键)并说怎么挑,谁也不扫", async () => {
			const bili = BILI();
			const acme = ACME();
			const { replies, sent, fire } = setup([bili, acme]);
			expect(await fire()).toEqual(ok());
			expect(replies).toEqual([
				"有好几个来源可以登录：\n- B 站（bilibili）\n- 对拍源（acme.inprocess）\n想扫哪一个，就在 login 后面跟上它的名字或键，比如「login bilibili」～",
			]);
			expect(bili.beginLogin).not.toHaveBeenCalled();
			expect(acme.beginLogin).not.toHaveBeenCalled();
			expect(sent).toHaveLength(0);
		});

		it("带键 → 扫那一个", async () => {
			const bili = BILI();
			const acme = ACME();
			const { fire } = setup([bili, acme]);
			expect(await fire("acme.inprocess")).toEqual(ok());
			expect(acme.beginLogin).toHaveBeenCalledTimes(1);
			expect(bili.beginLogin).not.toHaveBeenCalled();
		});

		it("带给人看的名字,大小写与前后空白从宽", async () => {
			const bili = BILI();
			const acme = ACME();
			const { fire } = setup([bili, acme]);
			expect(await fire("b 站")).toEqual(ok());
			expect(bili.beginLogin).toHaveBeenCalledTimes(1);
			expect(await fire("  ACME.InProcess ")).toEqual(ok());
			expect(acme.beginLogin).toHaveBeenCalledTimes(1);
		});

		it("只有一个来源时带了词也要对得上:对不上是失败,不扫", async () => {
			const bili = BILI();
			const { fire } = setup([bili]);
			expect(await fire("douyin")).toEqual(
				fail("not_found", "没有叫「douyin」的来源～能登录的有：B 站（bilibili）"),
			);
			expect(bili.beginLogin).not.toHaveBeenCalled();
		});

		it("带了对不上的词 → not_found,话里把能挑的列出来,谁也不扫", async () => {
			const bili = BILI();
			const acme = ACME();
			const { fire } = setup([bili, acme]);
			expect(await fire("douyin")).toEqual(
				fail(
					"not_found",
					"没有叫「douyin」的来源～能登录的有：B 站（bilibili）、对拍源（acme.inprocess）",
				),
			);
			expect(bili.beginLogin).not.toHaveBeenCalled();
			expect(acme.beginLogin).not.toHaveBeenCalled();
		});

		// 键比名字先认:一个来源的键恰好是另一个来源的名字时,敲出来的字指的是那个键。
		it("名字与另一个来源的键撞了 → 认键", async () => {
			const first = loginSource("alpha", "beta");
			const second = loginSource("beta", "乙");
			const { fire } = setup([first, second]);
			expect(await fire("beta")).toEqual(ok());
			expect(second.beginLogin).toHaveBeenCalledTimes(1);
			expect(first.beginLogin).not.toHaveBeenCalled();
		});

		it("两个来源叫同一个名字、又不是键 → invalid,让主人改用键,谁也不扫", async () => {
			const first = loginSource("one", "同名");
			const second = loginSource("two", "同名");
			const { fire } = setup([first, second]);
			expect(await fire("同名")).toEqual(
				fail("invalid", "有好几个来源都叫「同名」，请改用键：同名（one）、同名（two）"),
			);
			expect(first.beginLogin).not.toHaveBeenCalled();
			expect(second.beginLogin).not.toHaveBeenCalled();
		});

		it("来源现读:名单变了,同一条指令下一次就认新的", async () => {
			const roster: SourceLoginView[] = [BILI()];
			const spec = createLoginCommand({
				sources: () => roster,
				logger: { debug() {}, info() {}, warn() {}, error() {} },
			});
			const replies: string[] = [];
			const ctx = {
				reply: async (p: string | NotificationPayload) => {
					if (typeof p === "string") replies.push(p);
					return ok({ latencyMs: 0 });
				},
			};
			roster.push(ACME());
			await spec.run({}, ctx);
			expect(replies[0]).toContain("有好几个来源可以登录");
		});
	});

	describe("发起之后", () => {
		it("发的是解码后的图片字节,不是那串 data URL 文本", async () => {
			const { sent, fire } = setup([BILI()]);
			await fire();
			expect(sent[0]?.equals(PNG_BYTES)).toBe(true);
		});

		// 过期了却不知道过期,只会以为「扫了没反应」。来源名字填进办成的回话里。
		it("办成了的回话带来源名字与有效期", async () => {
			const { replies, fire } = setup([BILI()]);
			await fire();
			expect(replies).toEqual(["扫这张码登录「B 站」就行，180 秒内有效，过期了再敲一次～"]);
		});

		it("挑的是别的来源,回话里填的就是它的名字", async () => {
			const { replies, fire } = setup([BILI(), ACME()]);
			await fire("对拍源");
			expect(replies).toEqual(["扫这张码登录「对拍源」就行，180 秒内有效，过期了再敲一次～"]);
		});

		// 二维码发不出去 = 主人盯着手机等一个永远不来的码。必须换条路告诉他。
		it("图发不出去 → 明确说出来", async () => {
			const { replies, fire } = setup([BILI()], { sendOk: false });
			// 失败改成返回结果,由分发器统一说(整句见 command-failure-texts.test.ts)。
			expect(await fire()).toMatchObject({ ok: false, message: "二维码发不出去，去控制台扫吧～" });
			expect(replies).toEqual([]);
		});

		it("压根没生成出码 → 把失败原因转给主人,不发图", async () => {
			const { replies, sent, fire } = setup([
				loginSource("bilibili", "B 站", { status: "error", message: "获取二维码失败，请重试" }),
			]);
			expect(await fire()).toMatchObject({ ok: false, message: "获取二维码失败，请重试" });
			expect(sent).toHaveLength(0);
			expect(replies).toEqual([]);
		});

		// 取码失败时快照可能还是上一次的「已登录」之类,读它回话会骗人;失败的话以结果里的为准。
		it("发起就失败了 → 把结果里的话转给主人,不读快照、不发图", async () => {
			const { replies, sent, fire } = setup([
				loginSource(
					"bilibili",
					"B 站",
					{ status: "logged-in", loggedInAt: "2026-10-11T00:00:00.000Z" },
					fail("unavailable", "获取二维码失败，请重试"),
				),
			]);
			expect(await fire()).toMatchObject({
				ok: false,
				code: "unavailable",
				message: "获取二维码失败，请重试",
			});
			expect(sent).toHaveLength(0);
			expect(replies).toEqual([]);
		});

		it("不是等待扫码状态(此刻没有码) → 不发图、不抛错,有 message 的话转给主人", async () => {
			const { replies, sent, fire } = setup([
				loginSource("bilibili", "B 站", {
					status: "confirming",
					message: "已扫码，请在手机上确认",
				}),
			]);
			// 已扫码、等确认不是失败,是正常的状态回答:自己回话、返回 ok。
			await expect(fire()).resolves.toMatchObject({ ok: true });
			expect(sent).toHaveLength(0);
			expect(replies.at(-1)).toBe("已扫码，请在手机上确认");
		});

		// 状态里的串形状变了不该把指令链路带塌 —— 它还担着审批的 y/n。
		it("dataUrl 不是 data URL → 不发图、不抛错", async () => {
			const { sent, fire } = setup([
				loginSource("bilibili", "B 站", {
					status: "awaiting-scan",
					qr: { dataUrl: "not a data url", expiresAt: "t" },
				}),
			]);
			await expect(fire()).resolves.toMatchObject({
				ok: false,
				message: "没拿到二维码，稍后再试试～",
			});
			expect(sent).toHaveLength(0);
		});

		it("dataUrl 是空串 → 同样当没拿到码", async () => {
			const { sent, fire } = setup([
				loginSource("bilibili", "B 站", {
					status: "awaiting-scan",
					qr: { dataUrl: "", expiresAt: "t" },
				}),
			]);
			await fire();
			expect(sent).toHaveLength(0);
		});
	});
});
