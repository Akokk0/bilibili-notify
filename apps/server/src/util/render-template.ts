import { interpolate } from "@bilibili-notify/internal";

/**
 * 套模板,再把盘上文案里字面的 `\n`(反斜杠加 n)展开成真换行 —— 服务端几处主人可改的文案都这么出字。
 * 出图器的会员宣告语不展开 `\n`(行为不同),所以这个口只留在服务端。
 */
export function renderTemplate(template: string, vars: Record<string, string>): string {
	return interpolate(template, vars).replaceAll("\\n", "\n");
}
