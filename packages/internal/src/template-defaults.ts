/**
 * 「默认文案有更新」的亮灯判定 —— 纯数据进出。
 *
 * 纯函数模块,必须保持**零 import、零副作用**:它经
 * `@bilibili-notify/internal/template-defaults` 子路径直供浏览器端运行时消费,
 * 不能把 zod 或任何 schema 模块拽进前端 bundle(同 `constants.ts` / `patch.ts`)。
 */

/**
 * 一段文案的内容指纹。FNV-1a 32 位,转 36 进制取短串。
 *
 * **不是安全用途**,只要「内容变了指纹跟着变」就够 —— 它唯一的活是回答
 * 「用户见过的那一版默认,和现在这一版是不是同一份」。
 */
export function templateFingerprint(text: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i += 1) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(36);
}

function isPlainObject(x: unknown): x is Record<string, unknown> {
	if (x === null || typeof x !== "object" || Array.isArray(x)) return false;
	const proto = Object.getPrototypeOf(x);
	return proto === Object.prototype || proto === null;
}

/**
 * 递归走遍 `defaults` 里的所有**字符串叶子**,路径用点连(`guardBuy.captain.template`)。
 *
 * 遍历的是 defaults 本身而不是手写一张字段清单 —— 往 `DEFAULT_TEMPLATES` 加新文案时
 * 自动纳入,不需要谁记得来这儿补一行(那正是旧迁移表栽过的跟头)。非字符串叶子
 * (`guardBuy.enable` 这种 boolean)自动跳过。
 */
function eachStringLeaf(
	defaults: Record<string, unknown>,
	prefix: string,
	visit: (path: string, value: string) => void,
): void {
	for (const k of Object.keys(defaults)) {
		const path = prefix ? `${prefix}.${k}` : k;
		const def = defaults[k];
		if (typeof def === "string") visit(path, def);
		else if (isPlainObject(def)) eachStringLeaf(def, path, visit);
	}
}

/**
 * 顺着点路径取出那条默认文案。界面要拿它两处用:摆给主人看的预览,以及他点
 * 「用新默认」时真正写进去的值。路径不存在(或那处不是字符串)返回 undefined。
 */
export function templateDefaultAt(
	defaults: Record<string, unknown>,
	path: string,
): string | undefined {
	const v = atPath(defaults, path);
	return typeof v === "string" ? v : undefined;
}

/** 顺着点路径取值;中途遇到非对象就当没有。 */
function atPath(root: unknown, path: string): unknown {
	let cur: unknown = root;
	for (const seg of path.split(".")) {
		if (!isPlainObject(cur)) return undefined;
		cur = cur[seg];
	}
	return cur;
}

/**
 * 哪些字段该亮「默认文案有更新」的灯。
 *
 * 两个条件都成立才亮:
 * 1. **这一版默认他没见过** —— 见过就闭嘴,否则手写过文案的用户会被永久打扰
 * 2. **他的值确实和当前默认不一样** —— 一样的话没什么可更新的
 */
export function pendingTemplateUpdates(
	current: Record<string, unknown>,
	defaults: Record<string, unknown>,
	seen: Record<string, string>,
): string[] {
	const out: string[] = [];
	eachStringLeaf(defaults, "", (path, def) => {
		if (atPath(current, path) !== def && seen[path] !== templateFingerprint(def)) out.push(path);
	});
	return out;
}

/**
 * 每条文案当前默认的指纹,按点路径列全。
 *
 * 用在两处:全新安装一次填满 `seen`(新用户不该看见「有更新」),以及用户处理完
 * 某条提示后把那条的指纹记下(「用新默认」和「保持我的」都记,区别只在值改不改)。
 */
export function allTemplateFingerprints(defaults: Record<string, unknown>): Record<string, string> {
	const out: Record<string, string> = {};
	eachStringLeaf(defaults, "", (path, def) => {
		out[path] = templateFingerprint(def);
	});
	return out;
}
