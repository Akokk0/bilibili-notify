import { z } from "zod";

/**
 * 私聊指令的可配置项(独立端专有)。
 *
 * 三个字段各自解决一件事:
 *
 * - `enabled` —— 总开关。关掉之后整条入站链路**只剩确认流**:审批的 y/n 还得认,
 *   否则关一下指令,手里那份等审批的周报就再也批不掉了。
 * - `prefix` —— 主人可改。允许为空(退化成整句精确匹配),但不允许纯空白 ——
 *   那是个看不见的前缀,他自己都敲不出来。注意 `"bn "` 这种带尾空格的是**合法**的,
 *   所以判定不能简单地 trim 完比空。
 * - `aliases` —— 每条指令的别名,键是指令主名。**键在 = 整份替换**(填 `[]` 就是
 *   一个别名都不要),键不在 = 用内置的那几个。区分这两者是必要的:否则「我不想要
 *   任何别名」和「我没动过」在盘上长得一样。
 */
export const CommandConfigSchema = z.object({
	enabled: z.boolean().default(true),
	prefix: z
		.string()
		// 纯空白的前缀等于一个敲不出来的前缀。空串是合法的(见上),所以这里放行 ""。
		.refine((s) => s === "" || s.trim() !== "", { message: "前缀不能是纯空白" })
		// dispatcher 匹配前会先把入站文本 trim 两头 —— 以空白**开头**的前缀
		// (" /")永远匹配不上,和纯空白同一种「敲不出来」;尾空格(`bn `)照旧合法。
		.refine((s) => s === s.trimStart(), { message: "前缀不能以空白开头" })
		.default("/"),
	aliases: z
		.record(
			z.string(),
			// 别名两头的空白永远匹配不上(入站文本会被 trim),留着只会让主人以为
			// 自己配好了却怎么敲都不响。空字符串同理。
			z.array(z.string().refine((s) => s.trim() === s && s.length > 0, "别名不能为空或带首尾空格")),
		)
		.default({}),
});
export type CommandConfig = z.infer<typeof CommandConfigSchema>;

export const DEFAULT_COMMAND_CONFIG: CommandConfig = {
	enabled: true,
	prefix: "/",
	aliases: {},
};
