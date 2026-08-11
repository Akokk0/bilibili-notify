/**
 * `/login` —— 在手机上重新扫码登录 B 站。
 *
 * ## 为什么这条必须是**手动**的
 *
 * B 站二维码 180 秒过期。所以绝不能做成「检测到登录失效就自动推一个码」—— 主人两
 * 小时后看手机,拿到的是一张废码,反而以为系统坏了。必须他敲下这条指令的那一刻才生成。
 *
 * > 对照:备份该**自动**(怕你忘),扫码必须**手动**(码会过期)。
 * > 该自动还是该指令,不取决于重要性,取决于产物有没有时效。
 *
 * ## 二维码只发私聊
 *
 * 发进群等于公开征集「谁来当我的 B 站账号」。这条由 `sendToMaster` 的强制私聊保证
 * (onebot adapter 在拿不到 userId 时直接报错,**不会**回落到群),指令层要保证的是
 * 另一半:**发不出去必须说出来**。不然主人就盯着手机等一个永远不来的码。
 *
 * 真正的风险也不是泄漏而是**污染** —— 攻击者若能触发扫码并抢先扫,系统就跑在他的
 * 账号上。触发权由分发器的鉴权门挡着,这里不重复。
 */

import { Buffer } from "node:buffer";
import type { Logger } from "@bilibili-notify/internal";
import { type CommandSpec, command } from "./command-dispatcher.js";

/** LoginFlow 快照里我们用得上的那部分。`data` 是 any,形状不由我们做主。 */
export interface LoginSnapshotView {
	status: number;
	msg: string;
	data?: unknown;
}

export interface LoginCommandOptions {
	/** 现生成一张二维码并开始轮询。 */
	begin: () => Promise<void>;
	/** 读当前登录快照 —— 码就挂在它的 `data` 上。 */
	snapshot: () => LoginSnapshotView;
	/** 把码发到主人私聊。返回 false = 没送到。 */
	sendQr: (png: Buffer) => Promise<boolean>;
	reply: (text: string) => Promise<void>;
	logger: Logger;
}

/** B 站二维码的有效期。写死在文案里会和这里跑偏,所以只此一处。 */
const QR_TTL_SECONDS = 180;

/**
 * 从 `data:image/png;base64,…` 里取出字节。不是这个形状就返回 undefined ——
 * 快照的 `data` 是 any,形状变了不该把整条入站链路带塌(它还担着审批的 y/n)。
 */
function decodeDataUrl(data: unknown): Buffer | undefined {
	if (typeof data !== "string") return undefined;
	const m = /^data:image\/[a-z+]+;base64,(.+)$/i.exec(data);
	if (!m?.[1]) return undefined;
	try {
		const buf = Buffer.from(m[1], "base64");
		return buf.length > 0 ? buf : undefined;
	} catch {
		return undefined;
	}
}

export function createLoginCommand(opts: LoginCommandOptions): CommandSpec {
	return command({
		name: "login",
		aliases: ["扫码", "登录"],
		description: "重新扫码登录 B 站",
		details: `二维码只发这条私聊，${QR_TTL_SECONDS} 秒内有效，过期就再敲一次。`,
		run: async () => {
			await opts.begin();
			const snap = opts.snapshot();
			const png = decodeDataUrl(snap.data);
			if (!png) {
				// 快照那句 msg 已经是人话(「获取二维码失败，请重试」),照转即可 ——
				// 在这儿再写一份就是第二份会跟它跑偏的文案。
				opts.logger.warn(`[command] 扫码没拿到二维码: status=${snap.status} msg=${snap.msg}`);
				await opts.reply(snap.msg || "没拿到二维码，稍后再试试～");
				return;
			}
			const delivered = await opts.sendQr(png);
			if (!delivered) {
				await opts.reply("二维码发不出去，去控制台扫吧～");
				return;
			}
			await opts.reply(`扫这张码就行，${QR_TTL_SECONDS} 秒内有效，过期了再敲一次～`);
		},
	});
}
