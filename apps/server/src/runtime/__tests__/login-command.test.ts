/**
 * `/login` —— 在手机上重新扫码登录 B 站。
 *
 * 三条硬约束(方案里已经论证过,这里只负责钉住):
 *
 * 1. **二维码只发私聊。**发进群等于公开征集「谁来当我的 B 站账号」。这条由
 *    `sendToMaster` 的强制私聊保证(onebot adapter 拿不到 userId 时直接报错,不会
 *    回落到群),指令层要保证的是:**发不出去必须说出来**。
 * 2. 风险主要不是泄漏而是**污染** —— 攻击者若能触发扫码并抢先扫,系统就跑在他的
 *    账号上。触发权由分发器的鉴权门挡住,这里不重复。
 * 3. **码 180 秒过期**,所以只能主人敲的那一刻现生成。绝不做「检测到失效就自动推
 *    一个码」—— 他两小时后看手机拿到的是废码,反而以为系统坏了。
 */

import { describe, expect, it, vi } from "vite-plus/test";
import { createLoginCommand, type LoginSnapshotView } from "../login-command.js";

/** 一个 1×1 PNG 的 data URL,用来验「发出去的是字节不是那串文本」。 */
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const QR_DATA_URL = `data:image/png;base64,${PNG_BYTES.toString("base64")}`;

const QR_READY: LoginSnapshotView = { status: 2, msg: "", data: QR_DATA_URL };

function setup(after: LoginSnapshotView = QR_READY, opts: { sendOk?: boolean } = {}) {
	const replies: string[] = [];
	const sent: Buffer[] = [];
	const begin = vi.fn(async () => {});
	const spec = createLoginCommand({
		begin,
		snapshot: () => after,
		sendQr: async (buf) => {
			sent.push(buf);
			return opts.sendOk ?? true;
		},
		reply: async (t) => {
			replies.push(t);
		},
		logger: { debug() {}, info() {}, warn() {}, error() {} },
	});
	return { spec, replies, sent, begin, fire: () => spec.run({} as never) };
}

describe("login 指令", () => {
	it("主名英文,中文走别名", () => {
		const { spec } = setup();
		expect(spec.name).toBe("login");
		expect(spec.aliases).toContain("扫码");
		expect(spec.aliases).toContain("登录");
	});

	it("敲了才生成 —— 码只有 180 秒,不能预先备好", async () => {
		const { begin, fire } = setup();
		await fire();
		expect(begin).toHaveBeenCalledTimes(1);
	});

	it("拿到码就发出去", async () => {
		const { sent, fire } = setup();
		await fire();
		expect(sent).toHaveLength(1);
	});

	// 发 data URL 那串文本的话,主人收到的是一坨看不懂的字符,而不是一张能扫的码。
	it("发的是解码后的图片字节,不是那串 data URL 文本", async () => {
		const { sent, fire } = setup();
		await fire();
		expect(sent[0]?.equals(PNG_BYTES)).toBe(true);
	});

	// 过期了却不知道过期,只会以为「扫了没反应」。
	it("提一句有效期", async () => {
		const { replies, fire } = setup();
		await fire();
		expect(replies.join("\n")).toContain("180");
	});

	// 二维码发不出去 = 主人盯着手机等一个永远不来的码。必须换条路告诉他。
	it("图发不出去 → 明确说出来", async () => {
		const { replies, fire } = setup(QR_READY, { sendOk: false });
		await fire();
		expect(replies.at(-1)).toContain("发不出去");
	});

	it("压根没生成出码 → 把失败原因转给主人,不发图", async () => {
		const { replies, sent, fire } = setup({ status: 7, msg: "获取二维码失败，请重试" });
		await fire();
		expect(sent).toHaveLength(0);
		expect(replies.at(-1)).toContain("获取二维码失败");
	});

	// 快照的 data 是 any,形状变了不该把指令链路带塌 —— 它还担着审批的 y/n。
	it("data 不是 data URL → 不发图、不抛错", async () => {
		const { replies, sent, fire } = setup({ status: 2, msg: "", data: { unexpected: true } });
		await expect(fire()).resolves.toBeUndefined();
		expect(sent).toHaveLength(0);
		expect(replies.at(-1)).toBeDefined();
	});

	it("data 是空串 → 同样当没拿到码", async () => {
		const { sent, fire } = setup({ status: 2, msg: "", data: "" });
		await fire();
		expect(sent).toHaveLength(0);
	});
});
