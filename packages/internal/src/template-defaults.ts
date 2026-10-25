/**
 * 「默认文案有更新」的亮灯判定 —— 纯数据进出。
 *
 * 文字模板设置里只存主人改过的(ADR-0037 决策 10),没存的读时跟当前语言的出厂走,所以这套提示只对
 * **存着的那几条**有意义:账本 `templatesSeen`(路径 → 指纹)记的是主人改那一条的那一刻**简体**出厂原文的指纹,
 * 之后简体出厂文案变了(指纹对不上)才亮灯。简体原文当「这一版默认」的版本号 —— 换语言、以后补上别的
 * 语言的译文,都不会让它亮。
 *
 * 纯函数模块,必须保持**零 import、零副作用**:它经
 * `@bilibili-notify/internal/template-defaults` 子路径直供浏览器端运行时消费,
 * 不能把 zod 或任何 schema 模块拽进前端 bundle(同 `patch.ts`)。
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
 * 出厂文字(`templateDefaultsFor` 交出的形状):八条文字按键,`membership` 是会员体系默认那一句(不分体系)。
 * 这里按结构取,不 import 那边的类型 —— 本模块零 import。
 */
type FactoryTexts = Record<string, unknown>;

/** 设置里存着的文字模板(`defaults.templates`):只有主人改过的格在;会员文案按体系。 */
type StoredTexts = Record<string, unknown>;

/** 会员体系默认那一句的账本路径:`membership.<体系>.default.template`。 */
const MEMBERSHIP_PATH = /^membership\.(.+)\.default\.template$/;

const membershipPath = (programId: string): string => `membership.${programId}.default.template`;

function has(obj: Record<string, unknown>, key: string): boolean {
	return Object.hasOwn(obj, key);
}

/** 顺着点路径取出**存着的**那条文字;没存(或那处不是字符串)返回 undefined。 */
export function storedTemplateAt(stored: StoredTexts, path: string): string | undefined {
	const m = MEMBERSHIP_PATH.exec(path);
	if (m) {
		const programs = stored.membership;
		if (!isPlainObject(programs) || !has(programs, m[1] as string)) return undefined;
		const entry = programs[m[1] as string];
		const def = isPlainObject(entry) ? entry.default : undefined;
		const text = isPlainObject(def) ? def.template : undefined;
		return typeof text === "string" ? text : undefined;
	}
	const v = has(stored, path) ? stored[path] : undefined;
	return typeof v === "string" ? v : undefined;
}

/**
 * 顺着点路径取出那条**出厂**文字。会员体系默认那一句不分体系,每个体系的路径取同一句。
 * 出厂里没有的路径(词云停用词这类不是文字的格)返回 undefined。
 */
export function factoryTemplateAt(factory: FactoryTexts, path: string): string | undefined {
	if (MEMBERSHIP_PATH.test(path)) {
		return typeof factory.membership === "string" ? factory.membership : undefined;
	}
	if (path === "membership") return undefined;
	const v = has(factory, path) ? factory[path] : undefined;
	return typeof v === "string" ? v : undefined;
}

/**
 * 存着的、又是出厂有对应文字的那些路径。遍历的是**出厂**的键而不是手写一张清单 —— 往出厂文案加新条时自动纳入;
 * 出厂里没有的(词云停用词、图片地址)自然出局。
 */
function storedTextPaths(stored: StoredTexts, factory: FactoryTexts): string[] {
	const out: string[] = [];
	for (const key of Object.keys(factory)) {
		if (key === "membership") {
			const programs = stored.membership;
			if (typeof factory.membership !== "string" || !isPlainObject(programs)) continue;
			for (const id of Object.keys(programs)) {
				if (storedTemplateAt(stored, membershipPath(id)) !== undefined)
					out.push(membershipPath(id));
			}
		} else if (storedTemplateAt(stored, key) !== undefined) {
			out.push(key);
		}
	}
	return out;
}

/**
 * 哪些字段该亮「默认文案有更新」的灯。
 *
 * 四个条件都成立才亮:
 * 1. **他存了这一条** —— 没存的跟着当前语言的出厂走(ADR-0037 决策 10),没有「旧值」可比,不算待更新
 * 2. **存着的字不是现在的简体出厂** —— 已经一字不差了,「换成新的」等于什么都没变
 * 3. **账本里有这一条** —— 记过的才知道他改的时候简体默认长什么样;没记的(老盘、迁移来的)不打扰
 * 4. **记的指纹 ≠ 现在简体出厂原文的指纹** —— 一样就是这一版他见过了,闭嘴,否则手写过文案的用户会被永久打扰
 *
 * @param factory 必须是**简体**出厂文字(`templateDefaultsFor(DEFAULT_LOCALE)`),不是当前语言的。
 */
export function pendingTemplateUpdates(
	stored: StoredTexts,
	factory: FactoryTexts,
	seen: Record<string, string>,
): string[] {
	return storedTextPaths(stored, factory).filter((path) => {
		const def = factoryTemplateAt(factory, path);
		return (
			def !== undefined &&
			storedTemplateAt(stored, path) !== def &&
			has(seen, path) &&
			seen[path] !== templateFingerprint(def)
		);
	});
}

/**
 * 账本跟着「存没存」走:一条从没存变成存了(主人第一次改它),记下此刻**简体**出厂原文的指纹;
 * 从存着变成没存(恢复默认、用新默认、编辑到与默认一字不差),把账本里这一条拿掉。其余不动 ——
 * 存着改成另一句不碰账本(旧指纹留着,提示才能继续问)。
 *
 * 面板在每次改草稿后拿「改前 / 改后」两份文字模板过一遍,于是改了又改回来、没保存就离开,账本都不留脏条目。
 * 没有变化时原样返回入参(同一个引用);有变化返回新对象,不改入参。
 */
export function syncTemplatesSeen(
	prev: StoredTexts,
	next: StoredTexts,
	seen: Record<string, string>,
	factory: FactoryTexts,
): Record<string, string> {
	const before = new Set(storedTextPaths(prev, factory));
	const after = new Set(storedTextPaths(next, factory));
	let out: Record<string, string> | undefined;
	for (const path of after) {
		if (before.has(path)) continue;
		const def = factoryTemplateAt(factory, path);
		if (def === undefined) continue;
		out ??= { ...seen };
		out[path] = templateFingerprint(def);
	}
	for (const path of before) {
		if (after.has(path) || !has(seen, path)) continue;
		out ??= { ...seen };
		delete out[path];
	}
	return out ?? seen;
}
