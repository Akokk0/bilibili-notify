/**
 * 女仆技能库的 REST 门面 + query key。
 *
 * 一份清单两处用:聊天的斜杠菜单(只读)与 AI 页的技能编辑器(增删改)。共用
 * 同一个 key,编辑器改完一条,输入框里的菜单立刻跟着变 —— 各拉各的话,主人会
 * 遇到「改完名字,斜杠菜单里还是旧的」这种要刷新才好的怪事。
 */

import type {
	MaidSkillDTO,
	MaidSkillsListResponse,
	MaidSkillWriteRequest,
} from "@bilibili-notify/contract";
import { api } from "./api";

export type { MaidSkillDTO, MaidSkillProblemDTO } from "@bilibili-notify/contract";

export const maidSkillsQueryKey = ["maid-skills"] as const;

export function listMaidSkills(): Promise<MaidSkillsListResponse> {
	return api.get<MaidSkillsListResponse>("/api/maid-skills");
}

export function createMaidSkill(skill: MaidSkillWriteRequest): Promise<{ ok: true }> {
	return api.post<{ ok: true }>("/api/maid-skills", skill);
}

export function updateMaidSkill(name: string, skill: MaidSkillWriteRequest): Promise<{ ok: true }> {
	return api.put<{ ok: true }>(`/api/maid-skills/${encodeURIComponent(name)}`, skill);
}

export function deleteMaidSkill(name: string): Promise<{ ok: true }> {
	return api.delete<{ ok: true }>(`/api/maid-skills/${encodeURIComponent(name)}`);
}

/** 只给聊天菜单用的那份 —— 拉不到就当没有技能,别让斜杠菜单把整个聊天拖垮。 */
export async function listMaidSkillsSafe(): Promise<MaidSkillDTO[]> {
	try {
		const res = await listMaidSkills();
		// 形状也验一下:回来的东西不是数组时给个空表,别把 undefined 当清单交出去 ——
		// 那会一路漂到 `matchSkills` 里炸在 `.filter` 上。
		return Array.isArray(res?.list) ? res.list : [];
	} catch {
		return [];
	}
}
