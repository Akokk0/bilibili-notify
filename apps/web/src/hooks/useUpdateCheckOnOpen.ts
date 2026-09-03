import type { UpdateStatusDTO } from "@bilibili-notify/contract";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import {
	newerVersionOf,
	phaseLabel,
	UPDATE_QUERY_KEY,
	UPDATE_SECTION_PATH,
} from "../components/update/status";
import { api } from "../services/api";
import { type NoticeView, useToastStore } from "../store/notifications";

/**
 * 打开面板就查一次更新 —— 不定时、不轮询,就这一次(每次页面加载)。
 *
 * 查到有新版就往右下角发一张通知卡,按钮直接跳到系统页的更新卡片;概览的系统状态卡
 * 也会从同一份缓存里读到它。没新版就什么都不说。
 *
 * 两种情况**不查**:
 * - 功能关着(没内置公钥)。服务端本来也不会碰网络,这里省的是那一次请求。
 * - 排队了回退。回退是用户拍过板的事;自动检查在开着自动下载时会装新版、顺手拔钉子
 *   —— 等于用户开一次面板,自己按的回退就被悄悄撤销了。重启之前不替他做主;他手动按
 *   「检查更新」另说,那是明确要往前走。
 */
export async function checkUpdateOnOpen(
	qc: QueryClient,
	notify: (notice: NoticeView) => void,
): Promise<void> {
	// 走 fetchQuery 而不是裸 api.get:概览页挂着同一个 key 的 useQuery,两边同时开
	// 只会各打一次请求 —— react-query 只能对它自己发起的那些去重。顺带把缓存填好。
	const before = await qc.fetchQuery({
		queryKey: UPDATE_QUERY_KEY,
		queryFn: () => api.get<UpdateStatusDTO>("/api/update"),
	});
	// 钉子看**盘上的**(pinnedVersion),不只看内存态(rolled-back):回退靠重启生效,
	// 重启之后 phase 已经是 idle,钉子却还在 —— 这时自动查会装新版、顺手拔钉子,
	// 用户按的回退活不过一次开面板。
	if (before.state.phase === "disabled" || before.state.phase === "rolled-back") return;
	if (before.pinnedVersion !== null) return;

	const after = await api.post<UpdateStatusDTO>("/api/update/check", {});
	qc.setQueryData(UPDATE_QUERY_KEY, after);

	const target = newerVersionOf(after);
	if (target === null) return;
	notify({
		id: `update:${target}`,
		title: phaseLabel(after),
		body: noticeBody(after),
		action: { label: "去更新", to: UPDATE_SECTION_PATH },
	});
}

function noticeBody(status: UpdateStatusDTO): string {
	switch (status.state.phase) {
		case "ready":
			return "已经下好了,到系统页按一下重启就换。";
		case "needs-image-pull":
			return "这一版要重新拉镜像 / 下安装包,在线换不了。";
		default:
			return "到系统页下载;什么时候重启换版本由你按。";
	}
}

export function useUpdateCheckOnOpen(): void {
	const qc = useQueryClient();
	const notify = useToastStore((s) => s.notify);
	// StrictMode 会把 effect 挂两遍;网络只能打一次。
	const fired = useRef(false);
	useEffect(() => {
		if (fired.current) return;
		fired.current = true;
		void checkUpdateOnOpen(qc, notify).catch(() => {
			// 后端不通时壳层自有错误态;更新这件事等下次打开面板再说。
		});
	}, [qc, notify]);
}
