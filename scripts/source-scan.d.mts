import type ts from "typescript";

/** 守卫写判据用的 `ts`(`ts.isXxx`、`ts.SyntaxKind`):经这里拿,消费方的包不用各自声明 `typescript`。 */
export { default as ts } from "typescript";

/** 一份解析过的源码。 */
export interface Source {
	/** 调用方给的路径(仓库相对或绝对),报告里直接用。 */
	path: string;
	text: string;
	ast: ts.SourceFile;
}

export interface ImportRef {
	specifier: string;
	/** `import type` / `export type`,或具名列表每一项都带 `type`:编译后擦除。 */
	typeOnly: boolean;
	/**
	 * `import` 带绑定的 import 声明;`side-effect` 是 `import "x"`;`export` 是 `export … from`;
	 * `dynamic` 是字面量参数的 `import("x")`(含类型位置的);`require` 是 `require("x")`
	 * 与 `import x = require("x")`。
	 */
	kind: "import" | "side-effect" | "export" | "dynamic" | "require";
	/** 引用所在语句(或调用)起点的行号,从 1 起。 */
	line: number;
}

export interface Hit {
	node: ts.Node;
	/** 节点起点(不含前导注释)的行号,从 1 起。 */
	line: number;
	/** 节点源码的第一行。 */
	text: string;
}

export interface ListSourcesOptions {
	/** 含测试(`__tests__/` 目录与 `*.test.*` / `*.spec.*`)。默认不含。 */
	tests?: boolean;
	/** 换掉仓库根,给测试在临时目录里造样例用。 */
	root?: string;
}

/** 列出 roots(仓库根的相对路径)下的源码文件:仓库相对 posix 路径,排好序。根不存在就抛错。 */
export function listSources(roots: string[], options?: ListSourcesOptions): string[];

/** 解析一份源码。不给 text 时读盘并按路径缓存;给了就不读盘、不进缓存(写样例用)。 */
export function parseSource(path: string, text?: string): Source;

/** 一份源码里所有 import 类引用,按出现顺序。 */
export function importsOf(source: Source): ImportRef[];

/** 深度优先(先父后子)找出 `match` 为真的节点,嵌套的命中都收。 */
export function findNodes(source: Source, match: (node: ts.Node) => boolean): Hit[];
