import { z } from "zod";
import { EXTENSION_SUBSCRIPTION_EXTERNAL_ID_MAX } from "./subscriptions";

/**
 * 订阅源拓展的解析门交回来的候选(ADR-0019 决策 11 / 52)—— 宿主**先核形状**再交给面板。
 *
 * 严格:多一个键就不合。不合规矩的整次按「形状不对」回(路由回 502),每一条都点名哪儿、为什么 ——
 * 吞掉原因的话,拓展作者只能对着一句「出错了」猜。
 *
 * 🔴 `@bilibili-notify/extension` 的 `wire.ts` 有一份手写镜像(`ExtensionSubscriptionCandidate`,拓展与
 * 面板认的是它),两份由宿主那头的类型断言**双向严格相等**地钉住
 * (`apps/server/src/extensions/subscription-shape-pin.ts`)。
 */

/** 一次最多交回几个候选(决策 52)。面板列给主人挑,二十个已经翻不过来了。 */
export const SUBSCRIPTION_CANDIDATES_MAX = 20;

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

/** 一张头像 —— 候选里交进来的、以后报资料时交进来的,同一把尺子。 */
export const SubscriptionAvatarSchema = z
	.string()
	.max(SUBSCRIPTION_AVATAR_MAX_CHARS, `头像不能超过 ${SUBSCRIPTION_AVATAR_MAX_CHARS / 1024} KiB`)
	.regex(
		SUBSCRIPTION_AVATAR_DATA_URL_RE,
		"头像只收 png / jpeg / webp 的 base64 data URL(不收 SVG,不收 http 地址)",
	);

/** 一个候选:`{ id, name, avatar?, fans? }`。 */
export const SubscriptionCandidateSchema = z.strictObject({
	id: z
		.string()
		.min(1, "id 不能是空串")
		.max(
			EXTENSION_SUBSCRIPTION_EXTERNAL_ID_MAX,
			`id 不能超过 ${EXTENSION_SUBSCRIPTION_EXTERNAL_ID_MAX} 字`,
		),
	name: z.string().min(1, "名字不能是空串").max(128, "名字不能超过 128 字"),
	avatar: SubscriptionAvatarSchema.optional(),
	fans: z.number().int("粉丝数要是整数").nonnegative("粉丝数不能是负的").optional(),
});

/**
 * 解析门一次交回来的那一串。**同一个 `id` 不许出现两次**:面板按 `id` 认候选,两条同 `id` 的
 * 挑哪一条都说不清。
 */
export const SubscriptionCandidatesSchema = z
	.array(SubscriptionCandidateSchema)
	.max(SUBSCRIPTION_CANDIDATES_MAX, `候选最多 ${SUBSCRIPTION_CANDIDATES_MAX} 条`)
	.superRefine((candidates, ctx) => {
		const seen = new Set<string>();
		candidates.forEach((candidate, i) => {
			if (seen.has(candidate.id)) {
				ctx.addIssue({
					code: "custom",
					path: [i, "id"],
					message: `id "${candidate.id}" 出现了两次`,
				});
			}
			seen.add(candidate.id);
		});
	})
	.readonly();
