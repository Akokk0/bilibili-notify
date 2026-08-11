/**
 * 帮助渲染 —— 注册表是可序列化的声明,帮助就几乎是白拿的,而且**永不过期**
 * (手写的帮助必然与实现脱节)。
 *
 * ## 印给主人的不是签名
 *
 * 签名 `<duration:duration|时长>` 是**写给解析器**的:参数名要进代码(`values.duration`)、
 * 类型要驱动校验。三段里有两段跟主人无关 —— 他要知道的只是「这儿填一个时长」。所以
 * 用法一律现渲染成 `<时长>`,再配一个能照抄的例子。
 *
 * ## 每一处都用**当前**前缀现场拼
 *
 * 主人可以改前缀,改完第一个会看的就是帮助;硬编码 `/静音 3h` 的话,他把前缀改成
 * `bn ` 之后帮助里每个例子都是错的。别名同理 —— 列出他已经改掉的那些,等于教他敲
 * 一批没反应的词。
 */

import { parseSignature } from "./command-params.js";

/** 渲染帮助只需要这几个字段 —— 不依赖 handler,所以纯函数好测。 */
export interface HelpEntry {
	name: string;
	aliases?: readonly string[];
	signature?: string;
	description?: string;
	details?: string;
	/**
	 * 一个能照抄的例子,**只写参数部分**(如 `3h`)—— 指令名与前缀由这里现场拼。
	 * 连前缀一起写死的话,主人改完前缀,例子就成了错的。
	 */
	example?: string;
}

/**
 * 把签名渲染成人看的用法:`<duration:duration|时长>` → `<时长>`。
 *
 * 面板的指令卡片也用它 —— 两处各写一份的话,同一条指令会在网页和私聊里印出不同的
 * 用法,而主人没法判断哪个才对。
 *
 * 尖括号 / 方括号保留 —— 必填和可选得看得出区别。没写显示名就退回参数名,总比
 * 印一段类型声明强。
 */
export function renderUsage(signature: string | undefined): string {
	if (!signature) return "";
	const params = parseSignature(signature);
	if (params.length === 0) return "";
	return params
		.map((p) => (p.required ? `<${p.label ?? p.name}>` : `[${p.label ?? p.name}]`))
		.join(" ");
}

function usageOf(entry: HelpEntry, prefix: string): string {
	const params = renderUsage(entry.signature);
	return `${prefix}${entry.name}${params ? ` ${params}` : ""}`;
}

function exampleOf(entry: HelpEntry, prefix: string): string | null {
	return entry.example ? `${prefix}${entry.name} ${entry.example}` : null;
}

/**
 * @param topic 指定则只给这一条的详情,否则列出全部。
 */
export function renderHelp(commands: readonly HelpEntry[], prefix: string, topic?: string): string {
	if (topic) {
		// 大小写与两头空白都不算数:手机输入法会把 `/help mute` 自动首字母大写成
		// `/help Mute`,而主人看屏幕上那行字和帮助里印的一模一样,不知道差在哪。
		const key = topic.trim().toLowerCase();
		const hit = commands.find(
			(c) => c.name.toLowerCase() === key || c.aliases?.some((a) => a.toLowerCase() === key),
		);
		// 找不到时别给一份空白帮助 —— 主人会以为这条指令存在只是没写说明。
		// 这里指路用**主名**:别名是主人可配的,写死中文那个,他改完就指向一个不存在的名字。
		if (!hit) return `没有「${topic}」这条指令，敲 ${prefix}help 看看有哪些。`;
		const example = exampleOf(hit, prefix);
		return [
			usageOf(hit, prefix),
			hit.description,
			example ? `例：${example}` : null,
			hit.aliases?.length ? `别名：${hit.aliases.join("、")}` : null,
			hit.details,
		]
			.filter(Boolean)
			.join("\n");
	}

	const lines = commands.flatMap((c) => {
		const head = c.description ? `${usageOf(c, prefix)} —— ${c.description}` : usageOf(c, prefix);
		// 第二行放「照抄用的例子」与别名。挤在一行里那行会长到手机上要折三折;
		// 主名是英文,别名不列出来主人就不知道能敲中文。
		const example = exampleOf(c, prefix);
		const notes = [
			example ? `例：${example}` : null,
			c.aliases?.length ? `别名：${c.aliases.join("、")}` : null,
		]
			.filter(Boolean)
			.join("　");
		return notes ? [head, `　${notes}`] : [head];
	});
	return ["可以敲这些：", ...lines].join("\n");
}
