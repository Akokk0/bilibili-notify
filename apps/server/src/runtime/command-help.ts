/**
 * 帮助渲染 —— 注册表是可序列化的声明,帮助就几乎是白拿的,而且**永不过期**
 * (手写的帮助必然与实现脱节)。
 *
 * 每一处示例都用**当前**前缀现场拼。主人可以改前缀,改完第一个会看的就是帮助;
 * 硬编码 `/静音 3h` 的话,他把前缀改成 `bn ` 之后帮助里每个例子都是错的。
 */

/** 渲染帮助只需要这几个字段 —— 不依赖 handler,所以纯函数好测。 */
export interface HelpEntry {
	name: string;
	signature?: string;
	description?: string;
}

/**
 * @param topic 指定则只给这一条的详情,否则列出全部。
 */
export function renderHelp(commands: readonly HelpEntry[], prefix: string, topic?: string): string {
	if (topic) {
		const hit = commands.find((c) => c.name === topic);
		// 找不到时别给一份空白帮助 —— 主人会以为这条指令存在只是没写说明。
		if (!hit) return `没有「${topic}」这条指令，敲 ${prefix}帮助 看看有哪些。`;
		const usage = `${prefix}${hit.name}${hit.signature ? ` ${hit.signature}` : ""}`;
		return hit.description ? `${usage}\n${hit.description}` : usage;
	}

	const lines = commands.map((c) => {
		const usage = `${prefix}${c.name}${c.signature ? ` ${c.signature}` : ""}`;
		return c.description ? `${usage} —— ${c.description}` : usage;
	});
	return ["可以敲这些：", ...lines].join("\n");
}
