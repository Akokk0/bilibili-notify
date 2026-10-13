/**
 * `/login [来源]` —— 在手机上重新扫码登录某个来源。
 *
 * 「带登录的来源」是登记表里带 `auth` 的来源,现读:只有一个就直接扫它,有好几个就列出来让主人
 * 挑(跟上来源的键或名字);二维码取自那个来源的 `auth.state()`,经 `reply` 发图。
 *
 * ## 为什么这条必须是**手动**的
 *
 * 二维码 180 秒过期(B 站如此,别的来源也按这个口径叮嘱)。所以绝不能做成「检测到登录失效就自动推一个码」—— 主人两
 * 小时后看手机,拿到的是一张废码,反而以为系统坏了。必须他敲下这条指令的那一刻才生成。
 *
 * > 对照:备份该**自动**(怕你忘),扫码必须**手动**(码会过期)。
 * > 该自动还是该指令,不取决于重要性,取决于产物有没有时效。
 *
 * ## 二维码只发私聊
 *
 * 发进群等于公开征集「谁来当我的 B 站账号」。这条由分发器保证:指令只处理私聊消息,
 * `ctx.reply` 回的就是来的那个私聊,**不会**落到群。指令层要保证的是另一半:
 * **发不出去必须说出来**。不然主人就盯着手机等一个永远不来的码。
 *
 * 真正的风险也不是泄漏而是**污染** —— 攻击者若能触发扫码并抢先扫,系统就跑在他的
 * 账号上。触发权由分发器的鉴权门挡着,这里不重复。
 */

import { Buffer } from "node:buffer";
import { fail, type Logger, ok, type Result } from "@bilibili-notify/internal";
import type { SourceLoginView } from "../subscriptions/registry.js";
import { type CommandDef, command } from "./command-dispatcher.js";
import { COMMAND_TEXTS } from "./command-texts.js";

export interface LoginCommandOptions {
	/**
	 * 带登录口的来源,**现读**(来源可以来去,不快照)。发起成功后码就在那个来源 `auth.state()` 的
	 * `awaiting-scan` 的 `qr.dataUrl` 里。
	 */
	sources: () => readonly SourceLoginView[];
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

/** 「名字（键）」的清单写法:主人既能认名字也能抄键。 */
function describeSource(source: SourceLoginView): string {
	return `${source.label}（${source.sourceKey}）`;
}

/**
 * 主人敲的词对到哪个来源。键先于名字认(一个来源的名字恰是另一个的键时,敲出来的字指的是那个键),
 * 都不分大小写、不计前后空白。名字同名的几个来源没法从词里分出来,让主人改用键。
 */
function pickSource(
	sources: readonly SourceLoginView[],
	word: string,
): Result<{ source: SourceLoginView }> {
	const typed = word.trim();
	const wanted = typed.toLowerCase();
	const byKey = sources.find((s) => s.sourceKey.toLowerCase() === wanted);
	if (byKey) return ok({ source: byKey });
	const byLabel = sources.filter((s) => s.label.toLowerCase() === wanted);
	const [first] = byLabel;
	if (byLabel.length === 1 && first) return ok({ source: first });
	if (byLabel.length > 1) {
		const options = byLabel.map(describeSource).join("、");
		return fail("invalid", COMMAND_TEXTS.login.ambiguousSource(typed, options));
	}
	const options = sources.map(describeSource).join("、");
	return fail("not_found", COMMAND_TEXTS.login.unknownSource(typed, options));
}

export function createLoginCommand(opts: LoginCommandOptions): CommandDef {
	return command({
		name: "login",
		aliases: ["扫码", "登录"],
		signature: "[source:text|来源]",
		description: "重新扫码登录（有好几个来源时跟上来源的名字或键）",
		details: `二维码只发这条私聊，${QR_TTL_SECONDS} 秒内有效，过期就再敲一次。`,
		run: async (values, { reply }) => {
			const sources = opts.sources();
			const [first, ...others] = sources;
			if (!first) return fail("not_found", COMMAND_TEXTS.login.noSources);
			let source = first;
			if (values.source !== undefined) {
				const picked = pickSource(sources, values.source);
				if (!picked.ok) return picked;
				source = picked.source;
			} else if (others.length > 0) {
				// 不止一个来源又没说挑哪个:列出来让主人挑,是正常的回答、不是办不成。
				const lines = sources.map((s) => `- ${describeSource(s)}`).join("\n");
				await reply(COMMAND_TEXTS.loginReplies.pickOne(lines, first.sourceKey));
				return ok();
			}
			const { auth, label } = source;
			const begun = await auth.beginLogin();
			if (!begun.ok) {
				// 发起就失败了:快照可能还是上一次的内容(比如「已登录」),读它回话会骗人,以结果里的话为准。
				opts.logger.warn(
					`[command] 扫码发起失败(${source.sourceKey}): ${begun.code} ${begun.message}`,
				);
				return fail(begun.code, begun.message);
			}
			const state = auth.state();
			const png = state.status === "awaiting-scan" ? decodeDataUrl(state.qr.dataUrl) : undefined;
			if (!png) {
				opts.logger.warn(`[command] 扫码没拿到二维码: status=${state.status}`);
				// 状态自带的那句话已经是人话(「获取二维码失败，请重试」),照转即可 ——
				// 在这儿再写一份就是第二份会跟它跑偏的文案。
				const hint =
					state.status === "error" || state.status === "expired" || state.status === "confirming"
						? state.message
						: undefined;
				// 「已扫码,请在手机上确认」不是没办成,是正常的状态回答:自己回话。
				if (state.status === "confirming" && hint) {
					await reply(hint);
					return ok();
				}
				return fail("unavailable", hint || COMMAND_TEXTS.login.noQr);
			}
			// LoginFlow 的 renderQr 走 qrcode 包的 toDataURL,产物恒为 PNG。
			const sent = await reply({ kind: "image", image: { buffer: png, mime: "image/png" } });
			if (!sent.ok) return fail("unavailable", COMMAND_TEXTS.login.qrNotSent);
			await reply(COMMAND_TEXTS.loginReplies.scanned(label, QR_TTL_SECONDS));
			return ok();
		},
	});
}
