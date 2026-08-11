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
