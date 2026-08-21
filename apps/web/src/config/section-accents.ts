/**
 * 分区装饰色 —— 玻璃卡角光(`GlassBox` / `CollapseBlock` 的 `accent`)与变量提示条
 * 用的那几抹色。
 *
 * **刻意不跟皮肤**,同 {@link ./push-kinds.ts 的 PUSH_TONE}:它们承担的是「这一屏是
 * 讲哪件事的」——「动态文案是淡紫、上舰是橙、诊断是灰」。皮肤把强调色统一重上色
 * 之后,Rules 那一长列分区会全部塌成同一个颜色,一眼分辨的能力就没了。会跟皮肤走的
 * 语义色一律是 `--color-bn-*` token(见 `packages/ui/src/theme.css`),**不许**在这里
 * 出现 —— 放进来就等于把它挡在皮肤外面。同 `config/colors.ts` 那条。
 *
 * 由来:同一抹色此前散在 21 个调用点上写字面量,没有任何东西拦下一次写歪;而写成
 * 字面量的话,`color-token-conformance` 那条「颜色属性不许写同值 hex」的守卫也没法
 * 区分「刻意固定」与「忘了用 token」—— 走这张表就是明确宣称前者。
 *
 * ── 与推送家族色的关系 ────────────────────────────────────────────────────
 *
 * 叫 accent 不叫 tone 是有讲究的:本仓库里 **tone 特指推送家族色**(`PUSH_TONE`),
 * 那张表守着「一处出处」的规矩,`push-kinds.test.ts` 拦 config/ 下出现第二张同名
 * 物件。这里装的是**分区装饰色**,与 kind 无关,所以换个词以免两者被当成一回事。
 */

import { PUSH_TONE } from "./push-kinds";

export const SECTION_ACCENT = {
	/** 动态文案 / 消息版式那一族(全局与 per-UP 覆盖、版式编辑器、变量提示)。 */
	message: "#9b6dff",
	/**
	 * 上舰分区。**直接引用推送家族色,不另抄一份** —— 这一屏讲的就是上舰,和列表 /
	 * 时间轴 / toast 里那个橙是同一件事。抄成字面量的话两处会各自漂,而那正是
	 * `PUSH_TONE` 当年成表的原因。
	 */
	guard: PUSH_TONE.guard,
	/**
	 * 人格 · persona 与特别关注弹幕。两族**共用**这一抹暖黄 —— 不是同一件事,只是
	 * 设计上都取了「这一档偏个性化」的暖调。要拆就两族各配一色,别只改一处。
	 *
	 * **和 `PUSH_TONE.sc` 恰好同值,但不是同一件事,不许改成引用它。** 特别关注弹幕
	 * 自己的推送色是绿的(`push-kinds.ts` 里 `special-danmaku` = `#10B981`),人格更
	 * 和 SC 毫无关系。哪天 SC 那抹黄要调,这里**不**跟着动。
	 */
	persona: "#fdcb6e",
	/** 能力开关那一族:预览推送、联网搜索、图片理解。 */
	capability: "#00b894",
	/** 系统事务那一族:私聊指令、备份与恢复。 */
	system: "#8b5cf6",
	/** 诊断 / 日志详略 —— 刻意最不显眼的一档。 */
	diagnostic: "#94a3b8",
} as const;

export type SectionAccent = (typeof SECTION_ACCENT)[keyof typeof SECTION_ACCENT];

/**
 * 从任意强调色现算一档「压得住底色的标题字」。
 *
 * 往 `--color-bn-text-primary` 里兑,**不是往黑里兑**:亮色主题下正文色近黑,兑出来
 * 是深一档的同色相;暗色主题下正文色近白,兑出来是浅一档 —— 一条式子两套主题都成立。
 *
 * 收编前这是**手调死的第二个字面量**(`#FB7299` 配 `#b8425d`、`#00AEEC` 配 `#076e94`
 * …共 7 处),有两个毛病:① 强调色一旦跟皮肤走(粉 / 蓝 / 紫那几档现在正是如此),
 * 标题字还钉在原处,换肤后当场脱节;② 那些手调值全是**深色**,暗色主题下压在同样深
 * 的底上几乎看不见 —— `#946800` 那档尤其。
 */
export function sectionTitleColor(accent: string): string {
	return `color-mix(in srgb, ${accent} 70%, var(--color-bn-text-primary))`;
}
