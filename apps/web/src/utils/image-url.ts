import type { ImageRef } from "@bilibili-notify/internal";

/**
 * 图库里一张图的显示地址(ADR-0022 决策 9、ADR-0036 决策 5):图库的同源读口 `GET /api/images/<ref>`。
 * 聊天附件、订阅头像、历史配图与历史行的头像快照都只存引用,显示都走这一个 —— 别各自去拼地址。
 */
export function imageUrl(ref: ImageRef): string {
	return `/api/images/${encodeURIComponent(ref)}`;
}
