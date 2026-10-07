/**
 * 文案占位符改写(㉓d):把盘上文案里旧的变量名改成新的。花括号写法(`{uname}`)与 koishi 时代的 `-key` 老写法(`-uname`)
 * 一并改写成新名字的花括号写法(`{viewer}`)。吃一份模板与一张「旧键 → 新键」的表,是个纯函数:㉓d 只对上舰文案用
 * (`{uname}` → `{viewer}`、`{mname}` → `{name}`、`{guard}` → `{tier}`),3b 迁其余 6 条直播文案时直接调它,不再另写。
 *
 * **匹配规矩和运行时认旧写法的规矩一致**(`apps/server/src/bilibili/live/template-renderer.ts` 的 `applyTemplate`),改写前后推出去的
 * 字才一样:每个键认两种写法;**不看词边界**(`abc-uname` 里的 `-uname` 照样算,`-unamex` 的前五个字母也算);键按长度降序进
 * alternation,最长的先匹配(`-follower_change` 不会被 `-follower` 吃掉前半);单遍替换,换进去的字不再被扫一遍。
 * 字面的 `\n` 不碰:展开成换行是运行时的事。表里没有的变量、别的文字原样。
 *
 * 一个提醒:新名字可能撞上盘上本来就有的、旧表里没有的写法。上舰文案里 0.x 不认 `{name}`(原样印出来),改写之后
 * `{name}` 是主播名 —— 那一小撮手写过 `{name}` 的文案,推出去的字从字面的 `{name}` 变成主播名。
 */

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function rewritePlaceholders(
	template: string,
	renames: Readonly<Record<string, string>>,
): string {
	const olds = Object.keys(renames).sort((a, b) => b.length - a.length);
	if (olds.length === 0) return template;
	// 每个旧键两种写法:`{key}` 与 `-key`;最长的键排在前面。
	const alternatives = olds.flatMap((key) => [
		`\\{${escapeRegExp(key)}\\}`,
		`-${escapeRegExp(key)}`,
	]);
	const pattern = new RegExp(alternatives.join("|"), "g");
	return template.replace(pattern, (match) => {
		const old = match.charCodeAt(0) === 123 /* '{' */ ? match.slice(1, -1) : match.slice(1);
		return `{${renames[old]}}`;
	});
}
