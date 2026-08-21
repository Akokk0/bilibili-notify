/**
 * 不随皮肤换装的固定品牌色。
 *
 * 会随皮肤走的语义色一律是 `--color-bn-*` token(见 `packages/ui/src/theme.css`),
 * **不许**在这里出现 —— 放进来就等于把它挡在皮肤外面。
 */

/**
 * 「女仆 AI」的深紫。AI 相关件(右下角胶囊、三条 hero 圆章、锐评卡)的固定品牌色,
 * 刻意不进 `@theme` —— 那些是随皮肤换装的,这抹紫不是。正主是 `styles.css` 的
 * `--bn-ai-purple`,这里只是给 JS 侧一个引用它的名字。
 *
 * 此前 JS 侧有六处写死 `#6c5ce7`,styles.css 那条注释还记着原因:「GlassPanel 的
 * `accent` 要拼 `${accent}1f` 造 alpha,只收十六进制字面量」。那个约束早就没了 ——
 * 玻璃件的 accent 现在走 `color-mix()`,hex 与 `var()` 都收(见 glass.tsx 的注释)。
 */
export const AI_PURPLE = "var(--bn-ai-purple)";
