import { Buffer } from "node:buffer";
import {
	fail,
	ok,
	type Result,
	SUBSCRIPTION_AVATAR_MAX_BYTES,
	SubscriptionAvatarSchema,
	sniffImageFormat,
} from "@bilibili-notify/internal";

/**
 * 拓展订阅的头像在存进图库之前过的两道关(ADR-0019 决策 49 / 62)。存进图库本身归图库(`images/image-store.ts`:
 * 按嗅探认格式、8MB 的线、按内容起名);头像自己的规矩留在这里,各守各的那一层:
 *
 * - 新建订阅时解析门候选带的位图 data URL({@link decodeSubscriptionAvatar}):`SubscriptionAvatarSchema` 封顶
 *   128 KiB、只收 png / jpeg / webp,**开头的魔数字节还得对得上它声明的类型**;
 * - 拓展「报资料更新」交的字节({@link checkSubscriptionAvatarBytes},决策 62):约 96 KiB 封顶,类型按文件头认。
 *
 * 两条都**不收 gif、不收 SVG**:图库收 gif,头像不收 —— 头像要在卡里和面板上按位图画,同源的 SVG 被直接打开时会跑脚本。
 * 认魔数只有一份(`sniffImageFormat`,上报校验也用它)。
 */

/** 头像收的三种位图(在图库收的四种里,去掉 gif)。 */
const AVATAR_FORMATS: readonly (string | undefined)[] = ["png", "jpeg", "webp"];

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

/**
 * 拓展报资料时交的头像字节(决策 62):类型按文件头认(不信谁说的),封顶与上报校验同一把尺子
 * (`SUBSCRIPTION_AVATAR_MAX_BYTES`)。上报那一道本已核过,这里再核一遍:存图这一道不靠调用方。
 */
export function checkSubscriptionAvatarBytes(bytes: Uint8Array): AvatarCheck {
	if (bytes.byteLength > SUBSCRIPTION_AVATAR_MAX_BYTES) {
		return fail("invalid", `头像超过 ${Math.floor(SUBSCRIPTION_AVATAR_MAX_BYTES / 1024)} KiB`);
	}
	if (!AVATAR_FORMATS.includes(sniffImageFormat(bytes))) {
		return fail("invalid", "头像只收 png / jpeg / webp(按文件头认),这张都不是");
	}
	return ok({ bytes: Buffer.from(bytes) });
}
