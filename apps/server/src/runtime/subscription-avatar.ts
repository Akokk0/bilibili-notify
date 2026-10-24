import { Buffer } from "node:buffer";
import {
	fail,
	ok,
	type Result,
	SubscriptionAvatarSchema,
	sniffImageFormat,
} from "@bilibili-notify/internal";

/**
 * 新建订阅带的头像在存进图库之前过的一道关(ADR-0019 决策 49)。存进图库本身归图库(`images/image-store.ts`:
 * 按嗅探认格式、8MB 的线、按内容起名);头像自己的规矩留在这里,各守各的那一层:
 *
 * - 新建订阅时解析门候选带的位图 data URL({@link decodeSubscriptionAvatar}):`SubscriptionAvatarSchema` 封顶
 *   128 KiB、只收 png / jpeg / webp,**开头的魔数字节还得对得上它声明的类型**;
 * - 来源经 `ctx.reportProfile` 报的头像已经是图库引用,由来源先经 `ctx.storeImage` 存入图库。
 *
 * 这一道**不收 gif、不收 SVG**:图库收 gif,头像不收 —— 头像要在卡里和面板上按位图画,同源的 SVG 被直接打开时会跑脚本。
 * 认魔数只有一份(`sniffImageFormat`,上报校验也用它)。
 */

/** 过关回头像的字节,不过回点名原因的 `invalid`(路由原样交给面板)。 */
export type AvatarCheck = Result<{ bytes: Buffer }>;

/**
 * 把一张头像 data URL 解成字节,并核对魔数。不合规矩的回一句点名的原因(路由原样交给面板)。
 *
 * 新建订阅那条路在落盘**之前**先拿它核一遍 —— 不能等订阅建好了才发现头像不收。
 */
export function decodeSubscriptionAvatar(dataUrl: string): AvatarCheck {
	const parsed = SubscriptionAvatarSchema.safeParse(dataUrl);
	if (!parsed.success) {
		return fail("invalid", parsed.error.issues.map((i) => i.message).join(";"));
	}
	// 形状已由上面那条正则钉死:`data:image/<png|jpeg|webp>;base64,<…>`。
	const comma = dataUrl.indexOf(",");
	const declared = dataUrl.slice("data:image/".length, dataUrl.indexOf(";"));
	const bytes = Buffer.from(dataUrl.slice(comma + 1), "base64");
	if (sniffImageFormat(bytes) !== declared) {
		return fail("invalid", `头像声明是 image/${declared},内容却不是这种图`);
	}
	return ok({ bytes });
}
