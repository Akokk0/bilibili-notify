/**
 * `--name value` / `--name=value` 两种写法都认的极简参数读取。
 *
 * 发版链上那三个脚本(打载荷、签清单、生成密钥)各抄过一份逐字节相同的实现。它们由
 * workflow 调用,参数拼错时的行为很要紧 —— 所以这份实现只有一处,`requireArg` 拼错
 * 就抛;可选参数拼错仍然静默走默认值,这是**刻意**的,别顺手改成抛:`--notes` 这类
 * 参数在 workflow 里是条件拼上去的,不给和给空是同一件事。
 */

/** @param {string} name @param {string} [fallback] @param {readonly string[]} [argv] */
export function readArg(name, fallback, argv = process.argv) {
	const i = argv.indexOf(`--${name}`);
	if (i !== -1 && argv[i + 1]) return argv[i + 1];
	const inline = argv.find((a) => a.startsWith(`--${name}=`));
	if (inline) return inline.slice(name.length + 3);
	return fallback;
}

/** 缺了就抛 —— 少一个必填参数会签出一份带 `undefined` 的清单,那比失败糟得多。 */
export function requireArg(name, argv = process.argv) {
	const value = readArg(name, undefined, argv);
	if (!value) throw new Error(`缺参数 --${name}`);
	return value;
}
