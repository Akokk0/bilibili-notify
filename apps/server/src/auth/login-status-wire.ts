import type { BiliLoginStatus } from "@bilibili-notify/api";
import {
	BiliLoginStatus as WireLoginStatus,
	type BiliLoginStatusValue as WireLoginStatusValue,
} from "@bilibili-notify/contract";

/**
 * 把契约里的登录状态取值表(面板读的那份)与服务端实际发出去的 `BiliLoginStatus` enum 钉在一起,
 * 两个方向都在编译期检查,运行时什么都不做:
 * - 契约的键集与值必须是 enum 的成员(契约多写、写错名或值落到 enum 之外,红);
 * - enum 发出去的每个值必须落在契约的值域里(enum 新增成员或改值而契约没跟,红)。
 * (数值 enum 的成员**互换**仍测不出 —— TS 只校验值在成员值集内。)
 */
export const wireLoginStatusIsEnumMembers = WireLoginStatus satisfies Record<
	keyof typeof BiliLoginStatus,
	BiliLoginStatus
>;

/** 为 `true` 才编译得过:`never` 装不下 `true`。 */
export const enumValuesAreInWire: BiliLoginStatus extends WireLoginStatusValue ? true : never =
	true;
