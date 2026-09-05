import type { UpdateStatusDTO } from "@bilibili-notify/contract";
import { useEffect, useRef } from "react";
import {
	noticeBody,
	UPDATE_SECTION_PATH,
	useUpdateStatus,
	withNotes,
} from "../components/update/status";
import { type NoticeView, useToastStore } from "../store/notifications";

/**
 * 后台下载收尾时,把右下角那张「正在下载」换成「已就绪」或「下载失败」。
 *
 * 打开面板那次自动检查(`useUpdateCheckOnOpen`)开着自动下载时只把下载**发起**就回,卡上
 * 写的是「正在下载」;真正的收尾要靠 `useUpdateStatus` 的 2 秒轮询看到。这个钩子挂在壳层,
 * 人在哪一页都订阅着那份查询,轮询不会因为离开系统页而停。
 *
 * 看到状态从 `downloading` 变走,就用**同一个 id** 再发一张:卡还在就是原地换字;用户已经
 * 关掉了,就再弹一张 —— 主人要的「下完再提醒」。其余迁移一律不出声:检查更新、回退这些
 * 都是用户自己按的,他正看着。
 */
export function transitionNotice(
	before: UpdateStatusDTO,
	after: UpdateStatusDTO,
): NoticeView | null {
	if (before.state.phase !== "downloading") return null;
	const { target, notes } = before.state;
	const action = { label: "去更新", to: UPDATE_SECTION_PATH };
	if (after.state.phase === "ready" && after.state.target === target) {
		return { id: `update:${target}`, title: `${target} 已就绪`, body: noticeBody(after), action };
	}
	// `error` 不带版本号,用上一拍记着的。「正在下 0.9.1,报回来的却是盘上早就就绪的 0.9.0」
	// 同样是 0.9.1 没下下来 —— 服务端把盘上的事实压在失败结论上面(见 service 的
	// reportedState),面板只能从版本号对不上看出来。
	if (after.state.phase === "error" || after.state.phase === "ready") {
		return {
			id: `update:${target}`,
			title: `${target} 下载失败`,
			body: withNotes(notes, "没下下来,到系统页看看是哪一步没成。"),
			action,
		};
	}
	return null;
}

export function useUpdateTransitionNotice(): void {
	const { data } = useUpdateStatus();
	const notify = useToastStore((s) => s.notify);
	const previous = useRef<UpdateStatusDTO | undefined>(undefined);
	useEffect(() => {
		const before = previous.current;
		previous.current = data;
		if (before === undefined || data === undefined) return;
		const notice = transitionNotice(before, data);
		if (notice !== null) notify(notice);
	}, [data, notify]);
}
