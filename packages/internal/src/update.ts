/**
 * 更新镜像前缀的校验规则 —— 落盘 schema、服务端探针与面板共用同一份判断。
 *
 * 零依赖:只许 `import type`,值级 import 只能指向零依赖名单里的同伴。
 * 面板与 contract 经 `@bilibili-notify/internal/update` 取值。
 */

/**
 * 一条加速前缀长得合不合法:`https://` 开头、后面真有个主机名。空串(直连)不走这里,
 * 由调用方各自判。
 *
 * 三处要判得一模一样:落盘的 schema(`UpdateSettingsSchema.mirrors`,最终说了算的那道
 * 门)、服务端守 `POST /api/system/update/mirrors/probe` 的那道(这是一个让服务端去连任意主机
 * 的入口)、面板决定自定义那一格能不能选的那道。各写一份正则的话,用户会遇到「测得通、
 * 存不进去」—— 所以正则只有这一条,契约包从这里转出去给面板与路由。
 */
export const MIRROR_PREFIX_RE = /^https:\/\/[^\s/]+/;

export function isMirrorPrefix(value: string): boolean {
	return MIRROR_PREFIX_RE.test(value);
}
