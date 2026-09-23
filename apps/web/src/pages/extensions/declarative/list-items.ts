import type {
	ExtensionListField,
	ExtensionScalarField,
	ExtensionSettingsResponse,
} from "@bilibili-notify/contract";
import { LIST_ITEM_ID_KEY } from "@bilibili-notify/internal/constants";
import { ApiError } from "../../../services/api";
import { reasonOf } from "../shared";
import { safeImage } from "./image";

/**
 * 声明式列表(ADR-0019 决策 21 / 29)读项、认格的那几件 —— 纯函数,不碰 React。
 *
 * 列表住在拓展设置的 `<key>` 那一格(`GET /api/ext/:id/settings` 的 `values`),形状归清单定,但存着的
 * 那份**可能不照清单长**(手改过的配置、面板比服务端旧的那几秒),所以这一层读得防着点:认不出的项
 * 跳过,认得出的项原样留着所有键。密钥格下发时只有服务端算好的头尾(`{ masked }`,决策 35)。
 *
 * 读那份设置、拆写入失败的 400 / 409 这几件设置表单也要,也住这里(`settingsValuesOf` /
 * `settingsIssuesOf` / `isConflict`)—— 两处各写一份的话,同一份设置在两处读出两种样子。
 */

/**
 * 列表的一项 —— 下发的**原样**对象(密钥格是遮挡)。只读:写的时候按 id 说「改哪一项的哪几格」
 * (`update` / `remove`),不把它整个写回去 —— 项里 BN 不认识的键(拓展自己放的)因此碰都碰不到。
 */
export type ListItem = Readonly<Record<string, unknown>> & { readonly id: string };

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 一个拓展存着的那份设置(`GET /api/ext/:id/settings` 的 `values`)。宿主不认识它的形状,原样交来 ——
 * 不是对象的(还没读到、回应长歪了)当它是空的。设置表单与列表那一节都从这里读。
 */
export function settingsValuesOf(
	data: ExtensionSettingsResponse | undefined,
): Record<string, unknown> {
	const values = data?.values;
	return isRecord(values) ? values : {};
}

/**
 * 设置里那份列表。认不出身份的项(不是对象 / 没有 id / id 重了)**跳过** —— 视图按 id 把积木
 * 挂到项上、写按 id 找那一项,没有 id 的项在这一页上够不着也改不了。
 */
export function itemsOf(settings: Readonly<Record<string, unknown>>, key: string): ListItem[] {
	const raw = settings[key];
	if (!Array.isArray(raw)) return [];
	const seen = new Set<string>();
	const items: ListItem[] = [];
	for (const entry of raw) {
		if (!isRecord(entry)) continue;
		const id = entry[LIST_ITEM_ID_KEY];
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
 * 这一项在弹窗里填得了的那几格。新建:除了「停用 / 启用」那一格(新建的一律按清单默认值,那颗钮
 * 在卡上)。编辑(决策 37)再去掉密钥 / 生成的那几格 —— 存下之后浏览器只有头尾(决策 38),要换
 * 走「重新生成」;`id` 本来就不是一格(BN 生成、不许改,决策 29)。
 */
export function dialogFieldsOf(
	field: ExtensionListField,
	mode: "new" | "edit",
): ExtensionScalarField[] {
	return field.fields.filter(
		(sub) => sub.key !== field.toggle && (mode === "new" || !isSecretSub(sub)),
	);
}

/** 密钥 / 生成的那种格:下发时只有头尾,卡上与弹窗里都另有画法。 */
export function isSecretSub(sub: ExtensionScalarField): boolean {
	return sub.type === "string" && (sub.secret === true || sub.generate === true);
}

// ── 写不进去的时候 ───────────────────────────────────────────────────────────

/**
 * 版本号对不上(409)时那一句。面板已经重读了一遍(`useSettingsWrite`),要主人做的只是看一眼
 * 现在的样子再按一次 —— 服务端原话「重新读一遍再改」是说给不会自己重读的调用方听的。
 */
export const CONFLICT_TEXT = "设置在你打开之后被改过了 —— 已经重新读了一遍,看一眼现在的样子再改";

/** 这一发是不是撞上了版本号(`409 revision_conflict`,别的标签页刚写过一笔)。 */
export function isConflict(err: unknown): boolean {
	return err instanceof ApiError && err.status === 409;
}

/**
 * 校验不过那份 400 里的一条。`path` 从**这个拓展的设置**那一层往下数,列表项按 id 点名
 * (`["links", "<id>", "name"]`);`op` 是第几步惹出来的(拓展自己跨格的规矩对不上某一步时没有)。
 */
export interface SettingsIssue {
	op: number | undefined;
	path: readonly (string | number)[];
	message: string;
	/** 不点名某一格时怎么说:照路径 + 那句话。 */
	text: string;
}

/**
 * 服务端校验不过时回 400 `{ error: "validation_failed", issues }`。设置表单与列表那一节**共用这一份
 * 拆法**:哪一条算「我这一格的」、落不到某一格时怎么说,两边各拆一份的话迟早说成两种话。
 *
 * 不是那份 400 的交 `null` —— 那种失败的原话(`reasonOf`)就是该说的。
 */
export function settingsIssuesOf(err: unknown): SettingsIssue[] | null {
	if (!(err instanceof ApiError)) return null;
	const { body } = err;
	if (!isRecord(body) || body.error !== "validation_failed" || !Array.isArray(body.issues)) {
		return null;
	}
	return body.issues.map((issue: unknown) => {
		const bag = isRecord(issue) ? issue : {};
		const path = Array.isArray(bag.path)
			? (bag.path as unknown[]).filter(
					(segment): segment is string | number =>
						typeof segment === "string" || typeof segment === "number",
				)
			: [];
		const message = typeof bag.message === "string" ? bag.message : "不合规矩";
		const where = path.join(".");
		return {
			op: typeof bag.op === "number" ? bag.op : undefined,
			path,
			message,
			text: where ? `${where}:${message}` : message,
		};
	});
}

/**
 * 写不进去的那句话(不分给哪一格的时候):409 说「被改过了」;校验不过的一条条照路径说;
 * 别的失败原话照搬。**失败的原因不许吞** —— 「保存失败」四个字等于让人对着黑盒按第二下。
 */
export function writeReasonOf(err: unknown): string {
	if (isConflict(err)) return CONFLICT_TEXT;
	const issues = settingsIssuesOf(err);
	if (!issues || issues.length === 0) return reasonOf(err);
	return issues.map((issue) => issue.text).join(";");
}

/**
 * 列表那一节写不进去的那句话。落在这一格列表上的,按 id 说成「「家里那台」的 名字:这一格必填」
 * (找不到那一项 —— 刚新建的、已经被删的 —— 说「这条接入」);落在别处的(拓展自己跨格的规矩)
 * 照路径说。409 与别的失败同 `writeReasonOf`。
 */
export function writeFailureOf(
	err: unknown,
	field: ExtensionListField,
	items: readonly ListItem[],
): string {
	const issues = settingsIssuesOf(err);
	if (!issues || issues.length === 0) return writeReasonOf(err);
	return issues.map((issue) => issueText(issue, field, items)).join(";");
}

function issueText(
	issue: SettingsIssue,
	field: ExtensionListField,
	items: readonly ListItem[],
): string {
	const [key, id, subKey] = issue.path;
	if (key !== field.key) return issue.text;
	const { message } = issue;
	if (typeof id !== "string") return `${field.label}:${message}`;
	const item = items.find((candidate) => candidate.id === id);
	const title = item ? titleOf(field, item) : "";
	const which = title ? `「${title}」` : `这条${itemLabelOf(field)}`;
	const sub = typeof subKey === "string" ? subFieldOf(field, subKey) : undefined;
	return sub ? `${which}的 ${sub.label}:${message}` : `${which}:${message}`;
}

/**
 * 弹窗(新建 / 编辑)那一发的 400 拆成两半:落得到弹窗里某一格的放那一格底下,落不到的整条说出来。
 * 弹窗那一发只有一步,所以 `["<列表>", <哪一项>, <哪一格>]` 里的那一格就是弹窗里的那一格 ——
 * 新建那一项的 id 是服务端现生成的,面板不认识,不按它判。
 */
export function dialogIssuesOf(
	err: unknown,
	field: ExtensionListField,
	keys: ReadonlySet<string>,
	items: readonly ListItem[],
): { byField: Record<string, string>; rest: string[] } | null {
	const issues = settingsIssuesOf(err);
	if (!issues || issues.length === 0) return null;
	const out: { byField: Record<string, string>; rest: string[] } = { byField: {}, rest: [] };
	for (const issue of issues) {
		const [key, , subKey] = issue.path;
		if (key === field.key && typeof subKey === "string" && keys.has(subKey)) {
			// 同一格有好几句的,留第一句。
			if (!Object.hasOwn(out.byField, subKey)) out.byField[subKey] = issue.message;
			continue;
		}
		out.rest.push(issueText(issue, field, items));
	}
	return out;
}

/** 「把这 N 样填到对面去」的 N —— `newItemCopy` 封顶 8 样。 */
const COUNT_WORDS = ["零", "一", "两", "三", "四", "五", "六", "七", "八"];

export function countWordOf(n: number): string {
	return COUNT_WORDS[n] ?? String(n);
}
