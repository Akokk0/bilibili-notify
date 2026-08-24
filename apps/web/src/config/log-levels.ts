/**
 * 日志等级的**唯一色表**。
 *
 * 由来:同一份「level → 颜色」此前抄在三处 —— Logs 页顶栏的等级胶囊、设置里的
 * `LogLevelPicker`、Dashboard 的插件矩阵。抄多了就飘:`debug` 在 Logs 是灰蓝
 * `#94a3b8`、在另两处是品牌紫 `#a29bfe`;`warn` 是 `#f2a053` vs `#f59e0b`。
 * 同一条日志在三个界面上三种颜色,没有任何东西拦下一次再飘。这与
 * {@link ../config/push-kinds} 是同一个形状,那次已经解过一遍。
 *
 * 颜色**刻意不跟皮肤走**:严重度是产品语言(「错误是红的」),跟危险红同类。
 * 皮肤重上色会让 warn 和 error 撞成一个颜色,一眼分辨的能力就没了。而皮肤想顺着
 * 这几档描边是够得到的 —— 挂着 `chip-active` 的胶囊会把自己那档露成 `--bn-tint`。
 *
 * 归色口径:严重度越高越扎眼。`debug` 走中性灰蓝而不是品牌紫 —— 它是最低优先级,
 * 给它品牌色会让它比 `info` 还显眼,语义正好反了;何况 `#a29bfe` 已经被
 * `PUSH_TONE.derived` 与 `--color-bn-purple` 占着,再压一个语义就过载了。
 */

import type { LogLevel } from "@bilibili-notify/contract";

/**
 * **浅底上用的一档**(筛选胶囊、等级选择器、插件矩阵)。
 *
 * 2026-08-24 整体加深:主人在真机上说四档「分辨不出颜色来」。原来那批是照着
 * 深色控制台配的,搬到浅底上对比度只有 2.1~3.8:1 —— 当边框、当小字都糊。现在
 * 四档对白底都在 4.7:1 以上,而色相与归色口径原样(debug 仍是中性灰蓝)。
 *
 * 控制台那一侧**不跟着深**,见 {@link LOG_LEVEL_TONE_CONSOLE}。
 */
export const LOG_LEVEL_TONE: Record<LogLevel, string> = {
	debug: "#64748b",
	info: "#0369a1",
	warn: "#b45309",
	error: "#dc2626",
} as const;

/**
 * **深色控制台上用的一档** —— 同四档色相调亮，值就是 2026-08-24 加深之前的那批。
 *
 * 拆成两档而不是共用一张表:同一个色不可能在 `#ffffff` 和 `#0f1115` 上都好看。
 * 实测把浅底那批直接铺到控制台上,`debug` 从 7.37:1 掉到 3.97、`error` 从 5.02
 * 掉到 3.91 —— 那是拿一头换另一头,不是修好。控制台自己早就有一套专属 token
 * (`--color-bn-console-*`,里面的 danger 同样是**更亮**的一档),这里跟的是同一条路。
 */
export const LOG_LEVEL_TONE_CONSOLE: Record<LogLevel, string> = {
	debug: "#94a3b8",
	info: "#00AEEC",
	warn: "#f2a053",
	error: "#ef4444",
} as const;

/**
 * 徽章用的淡底 —— 从主色现调,不各存一份 `rgba(…, 0.1)` 副本。
 *
 * 走 `color-mix` 而不是 `${tone}1a` 十六进制后缀:后缀只对 6 位 hex 生效,
 * 哪天某档换成 3 位 hex 或 `var()` 就会静默变成一条废样式(推送历史的「全部」
 * 胶囊真栽过一次,`#666` + `1f` = 5 位,浏览器直接丢弃)。
 */
export function logLevelTint(level: LogLevel): string {
	return `color-mix(in srgb, ${LOG_LEVEL_TONE[level]} 10%, transparent)`;
}
