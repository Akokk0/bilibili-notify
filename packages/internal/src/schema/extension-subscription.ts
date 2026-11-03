import { z } from "zod";
import { packageText } from "../texts";

/**
 * 新建订阅时解析门交回来的头像 data URL(ADR-0019 决策 49 / 52)。
 *
 * 来源的新候选已经改成图库引用;这里只留新建订阅请求里的 data URL 头像,仍然封顶并按内容核格式。
 */

/**
 * 头像 data URL 整段的上限(字数)。128 KiB 的 base64 约合 96 KB 的图,一张 720×720 的 jpeg / webp
 * 绰绰有余;二十个候选顶格也就 2.5 MiB 一次。
 */
export const SUBSCRIPTION_AVATAR_MAX_CHARS = 128 * 1024;

/**
 * 头像只收**位图**的 base64 data URL(png / jpeg / webp)。**不收 SVG**(决策 49):建成订阅之后头像
 * 存成文件、从同源地址取,同源的 SVG 被直接打开时会跑脚本 —— 这一点与拓展交的图标
 * (`EXTENSION_IMAGE_DATA_URL_RE`,只在 `<img>` 里画)不一样。
 *
 * ⚠️ 不带 `g`:几处共用这一个对象,带 `g` 的话 `test()` 会在两次调用之间记着 `lastIndex`。
 */
export const SUBSCRIPTION_AVATAR_DATA_URL_RE =
	/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/;

/** 新建订阅请求里的一张 data URL 头像;来源候选与上报头像现在都走图库引用,不再经过这里。 */
export const SubscriptionAvatarSchema = z
	.string()
	.max(SUBSCRIPTION_AVATAR_MAX_CHARS, {
		error: () =>
			packageText("internal.schema.extension-subscription.1", {
				value0: SUBSCRIPTION_AVATAR_MAX_CHARS / 1024,
			}),
	})
	.regex(SUBSCRIPTION_AVATAR_DATA_URL_RE, {
		error: () => packageText("internal.schema.extension-subscription.2"),
	});
