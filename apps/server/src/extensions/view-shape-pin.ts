/**
 * 视图契约的两份声明**双向严格相等**地钉在这里(ADR-0019 决策 39)。
 *
 * 一份是 `@bilibili-notify/internal` 的 zod(宿主拿它校验),一份是 `@bilibili-notify/extension/wire`
 * 的手写镜像(拓展照它写、面板照它画 —— 那个入口不许 import zod)。宿主是唯一同时看得见两边的地方。
 *
 * 🔴 **不许退回单向赋值**(`const view: ExtensionView = parsed.data` 那种):它只证明 zod 那份能
 * 赋给 wire 那份,漏得过「wire 那边多一个可选键」—— 拓展照着 wire 写了那一格,宿主校验一过就是
 * 「多出来的键」,整块不画,而类型、测试、构建全绿。
 *
 * 只有类型,没有运行时的东西,不进 bundle;`tsc --noEmit` 查的就是它。
 */

import type {
	ExtensionBlock,
	ExtensionButton,
	ExtensionItemView,
	ExtensionTableCell,
	ExtensionView,
} from "@bilibili-notify/extension";
import type {
	ExtensionBlockSchema,
	ExtensionButtonSchema,
	ExtensionItemViewSchema,
	ExtensionTableCellSchema,
	ExtensionViewSchema,
} from "@bilibili-notify/internal";
import type { z } from "zod";

/**
 * 严格相等:两个泛型函数类型只在 A 与 B **一模一样**时才互相可赋 —— 多一个可选键、少一个
 * `readonly` 都算不同。结构赋值(`A extends B`)做不到这一点。
 */
type Equals<A, B> =
	(<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

/** 不相等时这里报 `Type 'false' does not satisfy the constraint 'true'`。 */
type Pinned<T extends true> = T;

export type ViewPinned = Pinned<Equals<z.infer<typeof ExtensionViewSchema>, ExtensionView>>;
export type BlockPinned = Pinned<Equals<z.infer<typeof ExtensionBlockSchema>, ExtensionBlock>>;
export type ButtonPinned = Pinned<Equals<z.infer<typeof ExtensionButtonSchema>, ExtensionButton>>;
export type CellPinned = Pinned<
	Equals<z.infer<typeof ExtensionTableCellSchema>, ExtensionTableCell>
>;
export type ItemPinned = Pinned<Equals<z.infer<typeof ExtensionItemViewSchema>, ExtensionItemView>>;
