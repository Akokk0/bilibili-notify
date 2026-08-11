/**
 * 指令参数 —— 签名声明与入参解析。
 *
 * 签名借 koishi 端的写法,跨端认知一致;但**只写参数部分**,不含指令名 —— 指令名与
 * 别名都在注册表里,而别名是主人可配的,让它再出现在签名里就得两处同步。
 */

/** 参数类型。刻意只有这几个,不做 flag/option(`-c` 那种)—— 首批指令用不上。 */
export type ParamType = "string" | "number" | "duration" | "text";

export interface ParamSpec {
	name: string;
	type: ParamType;
	/** `<必填>` 为 true,`[可选]` 为 false。 */
	required: boolean;
}

const TYPES: readonly string[] = ["string", "number", "duration", "text"];

// 两个分支各自配对,`<名:类型]` 这种错配的括号不会被认。
const TOKEN = /<([^:>\]]+):([^>\]]+)>|\[([^:>\]]+):([^>\]]+)\]/g;

/** 把签名字符串拆成参数声明。顺序即声明顺序。 */
export function parseSignature(signature: string): ParamSpec[] {
	const specs: ParamSpec[] = [];
	for (const m of signature.matchAll(TOKEN)) {
		const [, reqName, reqType, optName, optType] = m;
		const name = reqName ?? optName;
		const type = reqType ?? optType;
		if (!name || !type) continue;
		// 签名是代码里写死的,不是用户输入 —— 写错类型是 bug,在注册那一刻就该炸,
		// 而不是等主人某天真敲了这条指令才发现参数根本没被校验。
		if (!TYPES.includes(type)) {
			throw new Error(
				`指令签名「${signature}」里的参数类型「${type}」不认识,只支持 ${TYPES.join(" / ")}`,
			);
		}
		// text 吞掉剩余全部文本,排在它后面的参数永远拿不到值 —— 同样是签名写错。
		const previous = specs[specs.length - 1];
		if (previous?.type === "text") {
			throw new Error(`指令签名「${signature}」把参数放在了 text 之后,text 只能是最后一个`);
		}
		specs.push({ name, type: type as ParamType, required: reqName !== undefined });
	}
	return specs;
}

/** 解析出来的参数值。`text` 与 `string` 是字符串,`number` 与 `duration` 是数字。 */
export type ParamValue = string | number;

export type ParseResult =
	| { ok: true; values: Record<string, ParamValue> }
	/** `message` 是直接发给主人的人话,不是给日志看的。 */
	| { ok: false; message: string };

/**
 * 时长单位 → 毫秒。中英文都收 —— 主人是在手机上敲这些字的。
 *
 * 顺序在正则里有意义:长的必须排前面,否则「分钟」会被「分」先吃掉半截,
 * 「ms」会被「m」吃掉。下面的 DURATION 直接用这个表的键拼 alternation。
 */
const DURATION_UNITS: readonly (readonly [string, number])[] = [
	["小时", 3600_000],
	["分钟", 60_000],
	["ms", 1],
	["秒", 1000],
	["分", 60_000],
	["时", 3600_000],
	["天", 86400_000],
	["日", 86400_000],
	["s", 1000],
	["m", 60_000],
	["h", 3600_000],
	["d", 86400_000],
];

const DURATION = new RegExp(
	`^(\\d+(?:\\.\\d+)?)\\s*(${DURATION_UNITS.map(([u]) => u).join("|")})$`,
);

/**
 * 把一个 token 转成该类型的值。转不动返回 null —— 交给调用方拼报错。
 *
 * **范围校验不在这里**(比如「天数不能是 0」)。那是各指令自己的业务规则,写进这里
 * 就得为每条指令开一个口子;parser 只负责「格式对不对」。
 */
function coerce(spec: ParamSpec, token: string): ParamValue | null {
	switch (spec.type) {
		case "number": {
			if (!/^-?\d+$/.test(token)) return null;
			return Number(token);
		}
		case "duration": {
			const m = DURATION.exec(token);
			if (!m) return null;
			const [, amount, unit] = m;
			if (!amount || !unit) return null;
			const factor = DURATION_UNITS.find(([u]) => u === unit)?.[1];
			if (factor === undefined) return null;
			return Math.round(Number(amount) * factor);
		}
		default:
			return token;
	}
}

/** 报错时告诉主人这个位置该填什么。 */
function describe(type: ParamType): string {
	switch (type) {
		case "number":
			return "要填一个整数";
		case "duration":
			return "要填一段时长，比如 3h、30分钟、1天";
		default:
			return "格式不对";
	}
}

/** 从 `pos` 读到下一个空白为止。 */
function readToken(text: string, pos: number): string {
	let end = pos;
	while (end < text.length && !/\s/.test(text[end] as string)) end++;
	return text.slice(pos, end);
}

/**
 * 按签名解析主人敲进来的参数。
 *
 * 解析失败**不进 handler** —— parse 与 execute 分离,handler 拿到的永远是已校验的值。
 */
export function parseArgs(specs: readonly ParamSpec[], input: string): ParseResult {
	const text = input.trim();
	const values: Record<string, ParamValue> = {};
	// 用游标而不是 split:`text` 要拿到**原始**的剩余文本,split 会把中间的连续空白
	// 压成一个,「前面   后面」就还原不回来了。
	let pos = 0;
	for (const spec of specs) {
		while (pos < text.length && /\s/.test(text[pos] as string)) pos++;
		if (pos >= text.length) {
			// 可选参数缺席是正常的:不塞进 values,handler 那边就是 undefined。
			if (!spec.required) continue;
			return { ok: false, message: `缺少参数「${spec.name}」` };
		}
		// text 吞掉剩余全部(含空白)。parseSignature 保证了它只能是最后一个。
		const token = spec.type === "text" ? text.slice(pos) : readToken(text, pos);
		pos += token.length;
		const value = coerce(spec, token);
		if (value === null) {
			return { ok: false, message: `参数「${spec.name}」看不懂:${describe(spec.type)}` };
		}
		values[spec.name] = value;
	}
	// 多余的内容不能静默丢掉 —— 主人会以为它生效了。
	// (最后一个参数是 text 时不会走到这儿:它已经吞完了。)
	if (text.slice(pos).trim()) {
		return {
			ok: false,
			message: specs.length ? `参数给多了，这条指令只要 ${specs.length} 个` : "这条指令不需要参数",
		};
	}
	return { ok: true, values };
}
