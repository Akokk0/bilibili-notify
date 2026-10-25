/**
 * 图库引用形状 —— `<sha256>.<ext>` 的扩展名和校验正则。
 *
 * 零依赖:只许 `import type`,值级 import 只能指向零依赖名单里的同伴。
 * 不开子路径,只从根入口转。
 */

// ---- 图库引用(ADR-0022 决策 9)--------------------------------------------------------

/**
 * 图库引用:图库 `images/` 里的文件名 `<sha256>.<ext>`,扩展名按嗅探(png / jpg / gif / webp,JPEG 一律
 * 叫 jpg)。作品图、直播封面、头像、历史快照、聊天附件共用;引用自己就说明了格式,不另存 mime(ADR-0022
 * 决策 9 下 10-03 的 🔗)。
 */
export type ImageRef = string;

/**
 * 图库引用里认的扩展名(嗅探得出的格式,JPEG 一律叫 jpg)。图库(`apps/server/src/images/image-store.ts`)的格式表
 * 用 `satisfies` 钉着与它一致:多一种、少一种都编译不过。
 */
export const IMAGE_REF_EXTENSIONS = ["png", "jpg", "gif", "webp"] as const;

/**
 * 图库引用的形状:64 位小写 hex 的内容摘要 + 认得的扩展名。形状只此一份 —— 图库的 `isValidImageRef`、
 * 历史行与重推原件的 schema 都用它;零依赖,面板也能用。
 */
export const IMAGE_REF_PATTERN = new RegExp(
	`^[0-9a-f]{64}\\.(?:${IMAGE_REF_EXTENSIONS.join("|")})$`,
);
