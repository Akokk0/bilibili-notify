import { type Failure, fail, type Issue } from "@bilibili-notify/internal";
import { isMaskedCell } from "@bilibili-notify/internal/patch";
import { t as serverText } from "../i18n/index.js";

/**
 * 写入接口收到的体里有没有下发时的密钥遮挡(`{ masked }`)—— 有就是 400,issues 指到那一格。
 *
 * 遮挡**只许读、不许写回**:面板把它原样交回来的话,真密钥会被盖成一个对象(或一串点)。写回规矩全仓
 * 一条:不带这一格 = 保留已存的;要换交新的明文;要清空交空串(必填的格)或 `null`(可选的格)。
 *
 * 认形状不认格子:只有一个字符串键 `masked` 的普通对象。库里没有别的数据长这样(`git grep` 过)。
 */
export function maskedCellsFailure(body: unknown): Failure | undefined {
	const issues: Issue[] = [];
	collect(body, [], issues);
	if (issues.length === 0) return undefined;
	return fail("invalid", serverText("service.routes.masked-cells.text.1"), { issues });
}

function collect(value: unknown, path: (string | number)[], out: Issue[]): void {
	if (isMaskedCell(value)) {
		out.push({ path, message: serverText("service.routes.masked-cells.text.2") });
		return;
	}
	if (Array.isArray(value)) {
		for (const [i, item] of value.entries()) collect(item, [...path, i], out);
		return;
	}
	if (typeof value === "object" && value !== null) {
		for (const [key, child] of Object.entries(value)) collect(child, [...path, key], out);
	}
}
