import type { ExtensionListField, ExtensionScalarField } from "@bilibili-notify/contract";
import { reasonOf } from "../shared";
import { safeImage } from "./image";

/**
 * 声明式列表(ADR-0019 决策 21 / 29)读项、认格的那几件 —— 纯函数,不碰 React。
 *
 * 列表住在 `globals.extensions.<id>.settings.<key>`,形状归清单定,但存着的那份**可能不照清单长**
 * (手改过的配置、面板比服务端旧的那几秒),所以这一层读得防着点:认不出的项跳过,认得出的
 * 项**原样**留着所有键。
 */

/** 项里保留给 BN 的键 —— 项的身份,由 BN 生成、藏起来、不许改(决策 29)。 */
export const LIST_ITEM_ID = "id";

/**
 * 列表的一项 —— 存着的**原样**对象。
 *
 * 🔴 **键一个都不许丢**:写回是整份换掉的(数组在补丁里整个替换),项里 BN 不认识的键(拓展
 * 自己放的、清单下一版才声明的)少带一个就是抹掉一个,而两边都不会报错。改哪一格就在原样
 * 上盖哪一格。
 */
export type ListItem = Readonly<Record<string, unknown>> & { readonly id: string };

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 设置里那份列表。认不出身份的项(不是对象 / 没有 id / id 重了)**跳过** —— 视图按 id 把积木
 * 挂到项上、写回按 id 找那一项,没有 id 的项在这一页上够不着也改不了;服务端对它也只会回
 * 「列表项要有 id / id 重复了」,留着的话这一格从此一发都写不进去,而屏幕上看不出是哪条。
 * 与今天手写的桥页同一个取舍:写回时它们随之消失。
 */
export function itemsOf(settings: unknown, key: string): ListItem[] {
	const raw = isRecord(settings) ? settings[key] : undefined;
	if (!Array.isArray(raw)) return [];
	const seen = new Set<string>();
	const items: ListItem[] = [];
	for (const entry of raw) {
		if (!isRecord(entry)) continue;
		const id = entry[LIST_ITEM_ID];
		if (typeof id !== "string" || id === "" || seen.has(id)) continue;
		seen.add(id);
		items.push(entry as ListItem);
	}
	return items;
}

/** 一项叫什么(「接入」)—— 不给就用整格的名字。 */
export function itemLabelOf(field: ExtensionListField): string {
	return field.itemLabel ?? field.label;
}

/** 项里的一格声明。 */
export function subFieldOf(
	field: ExtensionListField,
	key: string | undefined,
): ExtensionScalarField | undefined {
	return key === undefined ? undefined : field.fields.find((sub) => sub.key === key);
}

/** 卡的标题:清单指的那一格(必填的 string)。 */
export function titleOf(
	field: ExtensionListField,
	item: Readonly<Record<string, unknown>>,
): string {
	const value = item[field.title];
	return typeof value === "string" ? value : "";
}

/**
 * 「停用 / 启用」那一格没存时算什么:清单里的默认值,默认值也没有就算开着 —— 与新建时补上的
 * 那一格同一个答案,不然新建出来的项一刷新就换了个样子。
 */
export function toggleDefaultOf(field: ExtensionListField): boolean {
	const toggle = subFieldOf(field, field.toggle);
	return toggle?.type === "boolean" ? (toggle.default ?? true) : true;
}

/** 这一项是不是停用着。没声明 `toggle` 的列表没有「停用」这回事。 */
export function isPaused(field: ExtensionListField, item: ListItem): boolean {
	if (field.toggle === undefined) return false;
	const value = item[field.toggle];
	return typeof value === "boolean" ? !value : !toggleDefaultOf(field);
}

/**
 * 卡左上那枚方块(决策 29 的 `mark`):那格枚举选中的值 + 那个选项的图。图过一道 `safeImage`
 * —— 不是图片 data URL 的当它没有,退回两个字母。
 */
export function markOf(
	field: ExtensionListField,
	item: ListItem,
): { value: string; image: string | undefined } | undefined {
	const choice = subFieldOf(field, field.mark);
	if (choice?.type !== "enum") return undefined;
	const raw = item[choice.key];
	const value = typeof raw === "string" && raw !== "" ? raw : choice.default;
	if (!value) return undefined;
	const option = choice.options.find((candidate) => candidate.value === value);
	return { value, image: safeImage(option?.icon) };
}

/** 卡正文里一格一行的那几格 —— 标题、方块、停用 / 启用各有自己的位置,不再重复画一遍。 */
export function rowFieldsOf(field: ExtensionListField): ExtensionScalarField[] {
	const placed = new Set([field.title, field.mark, field.toggle]);
	return field.fields.filter((sub) => !placed.has(sub.key));
}

/**
 * 别的格在卡上怎么念:存着的值,没存的按清单默认值(拓展那份 zod 读到的就是它),都没有是一道
 * 横线。枚举念选项的名字,不念存着的那个词。
 */
export function plainValueOf(sub: ExtensionScalarField, raw: unknown): string {
	switch (sub.type) {
		case "string": {
			const value = typeof raw === "string" ? raw : (sub.default ?? "");
			return value === "" ? "—" : value;
		}
		case "number": {
			const value = typeof raw === "number" ? raw : sub.default;
			if (value === undefined) return "—";
			return sub.unit ? `${value} ${sub.unit}` : String(value);
		}
		case "boolean":
			return (typeof raw === "boolean" ? raw : (sub.default ?? false)) ? "是" : "否";
		case "enum": {
			const value = typeof raw === "string" ? raw : sub.default;
			if (value === undefined) return "—";
			return sub.options.find((option) => option.value === value)?.label ?? value;
		}
	}
}

/**
 * 「改设置」的按钮(决策 22)要改的那几格,只留**这一项声明过的**。
 *
 * 🔴 `id` 是 BN 的(决策 29):视图按它把积木挂到项上,改了它这一项就换了身份 —— 挂在它上面
 * 的连接、视图、确认框全部对不上号。清单不许声明叫 `id` 的格,所以「只认声明过的」顺手把它
 * 挡在外面;没声明的键也不归一颗按钮管。
 */
export function declaredPatchOf(
	field: ExtensionListField,
	set: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
	const declared = new Set(field.fields.map((sub) => sub.key));
	return Object.fromEntries(Object.entries(set).filter(([key]) => declared.has(key)));
}

/**
 * 写回失败的那句话。服务端照清单校验不过时回 400 `{ error: "validation_failed", issues }`,每条
 * `issue.path` 是 `["extensions", <id>, "settings", <key>, <第几项>, <哪一格>]` —— 落在这一格
 * 列表上的,说成「「家里那台」的 名字:这一格必填」;落在别处的(同一份设置里别的格也照清单
 * 校验,它们不合规矩一样拦下这一发)照路径说。别的失败原话照搬。
 *
 * `sent` 是**这一发**发出去的名单(不是屏幕上现在那份):第几项要按它数。
 */
export function writeFailureOf(
	err: unknown,
	extensionId: string,
	field: ExtensionListField,
	sent: readonly ListItem[] | undefined,
): string {
	const body = (err as { body?: unknown } | null)?.body;
	if (!isRecord(body) || body.error !== "validation_failed" || !Array.isArray(body.issues)) {
		return reasonOf(err);
	}
	const lines = body.issues.map((issue) => issueText(issue, extensionId, field, sent));
	return lines.length > 0 ? lines.join(";") : reasonOf(err);
}

function issueText(
	issue: unknown,
	extensionId: string,
	field: ExtensionListField,
	sent: readonly ListItem[] | undefined,
): string {
	const bag = isRecord(issue) ? issue : {};
	const path = Array.isArray(bag.path) ? (bag.path as unknown[]) : [];
	const message = typeof bag.message === "string" ? bag.message : "不合规矩";
	const [scope, id, slot, key, index, subKey] = path;
	const mine = scope === "extensions" && id === extensionId && slot === "settings";
	if (mine && key === field.key) {
		if (typeof index !== "number") return `${field.label}:${message}`;
		const item = sent?.[index];
		const title = item ? titleOf(field, item) : "";
		const which = title ? `「${title}」` : `第 ${index + 1} 条${itemLabelOf(field)}`;
		const sub = typeof subKey === "string" ? subFieldOf(field, subKey) : undefined;
		return sub ? `${which}的 ${sub.label}:${message}` : `${which}:${message}`;
	}
	const where = (mine ? path.slice(3) : path).join(".");
	return where ? `${where}:${message}` : message;
}

/** 「把这 N 样填到对面去」的 N —— `newItemCopy` 封顶 8 样。 */
const COUNT_WORDS = ["零", "一", "两", "三", "四", "五", "六", "七", "八"];

export function countWordOf(n: number): string {
	return COUNT_WORDS[n] ?? String(n);
}
