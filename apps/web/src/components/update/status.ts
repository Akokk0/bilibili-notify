import type { UpdateStatusDTO } from "@bilibili-notify/contract";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../services/api";

/**
 * 应用内更新状态在前端的三个消费点(系统页那一节、概览的系统状态卡、打开面板那次
 * 自动检查)共用的那几样:查询键、锚点、以及「有没有新版」「这一阶段怎么说」这两个
 * 判断。判断只写一处 —— 概览说「有新版」而系统页说「已是最新」就是两处各判一遍的
 * 下场。
 */

export const UPDATE_QUERY_KEY = ["update"] as const;

/** 系统页里更新卡片的锚点。概览的「去更新」与右下角通知卡都跳到这。 */
export const UPDATE_SECTION_HASH = "#update";
export const UPDATE_SECTION_PATH = `/system${UPDATE_SECTION_HASH}`;

/**
 * 只在「正在下载」时轮询。别的阶段状态只会因为用户自己按了什么而变(那些路径都会写缓存),
 * 下载是唯一在后台自己往前走的 —— 打开面板那次自动检查开着自动下载时,用户走到系统页
 * 看见「正在下载」,没人刷新的话它就永远停在那儿,两个按钮都不出现。
 */
export function updateRefetchInterval(status: UpdateStatusDTO | undefined): number | false {
	return status?.state.phase === "downloading" ? 2_000 : false;
}

export function useUpdateStatus() {
	return useQuery({
		queryKey: UPDATE_QUERY_KEY,
		queryFn: () => api.get<UpdateStatusDTO>("/api/update"),
		refetchInterval: (query) => updateRefetchInterval(query.state.data),
	});
}

/**
 * 有一版比现在新时给出它的版本号,否则 null。「新」包括还没下、正在下、下好了、
 * 以及要重拉镜像才能换的 —— 最后一种也得让人知道有这么一版。回退目标比现在旧,
 * 不算。
 */
export function newerVersionOf(status: UpdateStatusDTO): string | null {
	const s = status.state;
	switch (s.phase) {
		case "available":
		case "downloading":
		case "ready":
		case "needs-image-pull":
			return s.target;
		default:
			return null;
	}
}

export function phaseLabel(status: UpdateStatusDTO): string {
	switch (status.state.phase) {
		case "disabled":
			return status.state.reason === "dev-build" ? "开发版,不检查更新" : "本构建未启用";
		case "idle":
			return "还没查过";
		case "up-to-date":
			return "已是最新";
		case "available":
			return `有新版 ${status.state.target}`;
		case "downloading":
			return `正在下载 ${status.state.target}`;
		case "ready":
			return `${status.state.target} 已就绪`;
		case "needs-image-pull":
			return `${status.state.target} 需要新镜像`;
		case "rolled-back":
			return `已排队回退到 ${status.state.target}`;
		case "error":
			return "这次没成";
	}
}
