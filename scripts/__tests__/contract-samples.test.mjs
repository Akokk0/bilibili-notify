import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, extname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";

/**
 * 文档样板与源码 region 逐字对齐。
 *
 * - 文档里单独一行写 `<!-- sample: <仓库相对路径>#<名字> -->`，后面只隔空行接
 *   一个 ` ```ts ` 围栏代码块。
 * - 源码里用 `// #region sample: <名字>` 与 `// #endregion sample: <名字>` 包住摘出的那一段。
 * - 名字只能写 `[a-z][a-z0-9-]*`。两边都去掉公共前导缩进和首尾空行后必须逐字相等。
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** 被扫的文档只有这一张表；以后开新文档就往这里加一行。 */
const SCANNED_DOCUMENTS = ["docs/1.0/extension-contract.md"];

const SOURCE_GROUPS = ["extensions", "packages", "apps"];
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
const SKIPPED_DIRS = new Set(["node_modules", "dist", ".claude"]);

const DOCUMENT_MARKER = /^<!-- sample: ([^#\s]+)#([a-z][a-z0-9-]*) -->$/;
const REGION_START = /^\s*\/\/ #region sample: ([a-z][a-z0-9-]*)\s*$/;
const REGION_END = /^\s*\/\/ #endregion sample: ([a-z][a-z0-9-]*)\s*$/;

const issue = (kind, message, details = {}) => ({ kind, message, ...details });

/**
 * 按行首共同前缀去掉缩进，再去掉首尾空行。空行本来就没有可比的缩进，统一压成空串；
 * 缩进可能是空格、tab 或两者的混合，公共部分必须是逐字相同的前缀。
 */
function normalizeSampleText(text) {
	const lines = text.split(/\r\n|\n|\r/);
	const nonBlank = lines.filter((line) => line.trim() !== "");
	let indent = nonBlank[0]?.match(/^[\t ]*/)?.[0] ?? "";
	for (const line of nonBlank.slice(1)) {
		const own = line.match(/^[\t ]*/)?.[0] ?? "";
		let shared = 0;
		while (shared < indent.length && shared < own.length && indent[shared] === own[shared]) {
			shared += 1;
		}
		indent = indent.slice(0, shared);
		if (indent === "") break;
	}

	const dedented = lines.map((line) =>
		line.trim() === "" ? "" : line.startsWith(indent) ? line.slice(indent.length) : line,
	);
	let first = 0;
	while (first < dedented.length && dedented[first] === "") first += 1;
	let last = dedented.length;
	while (last > first && dedented[last - 1] === "") last -= 1;
	return dedented.slice(first, last);
}

/**
 * 一份源码里的 sample region。纯文本解析足够：记号本身就要求独占一行且是固定注释。
 * 同一名字出现多对、只有 start、只有 end、end 在 start 前面都算坏。
 */
function parseRegions(source) {
	const lines = source.text.split(/\r\n|\n|\r/);
	const names = new Map();
	const issues = [];
	const entryFor = (name) => {
		let entry = names.get(name);
		if (!entry) {
			entry = { starts: [], ends: [] };
			names.set(name, entry);
		}
		return entry;
	};

	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		const trimmed = line.trimStart();
		if (trimmed.startsWith("//") && line.includes("#region sample:")) {
			const match = REGION_START.exec(line);
			if (!match) {
				issues.push(
					issue(
						"invalid-region-marker",
						`${source.path}:${index + 1}: region 记号不合法；名字只能写 [a-z][a-z0-9-]*`,
						{ source: source.path, sourceLine: index + 1 },
					),
				);
				continue;
			}
			entryFor(match[1]).starts.push(index);
			continue;
		}
		if (trimmed.startsWith("//") && line.includes("#endregion sample:")) {
			const match = REGION_END.exec(line);
			if (!match) {
				issues.push(
					issue(
						"invalid-region-marker",
						`${source.path}:${index + 1}: end region 记号不合法；名字只能写 [a-z][a-z0-9-]*`,
						{ source: source.path, sourceLine: index + 1 },
					),
				);
				continue;
			}
			entryFor(match[1]).ends.push(index);
		}
	}

	for (const [name, entry] of names) {
		const firstLine = Math.min(...entry.starts, ...entry.ends) + 1;
		if (entry.starts.length > 1 || entry.ends.length > 1) {
			issues.push(
				issue(
					"duplicate-region",
					`${source.path}:${firstLine}: region "${name}" 必须恰好一对，实际有 ${entry.starts.length} 个 start、${entry.ends.length} 个 end`,
					{ source: source.path, sourceLine: firstLine, name },
				),
			);
		}
		if (entry.starts.length > entry.ends.length) {
			const line = entry.starts[entry.ends.length] ?? entry.starts[0];
			issues.push(
				issue(
					"unmatched-region-start",
					`${source.path}:${line + 1}: region "${name}" 缺 #endregion sample: ${name}`,
					{ source: source.path, sourceLine: line + 1, name },
				),
			);
		} else if (entry.ends.length > entry.starts.length) {
			const line = entry.ends[entry.starts.length] ?? entry.ends[0];
			issues.push(
				issue(
					"unmatched-region-end",
					`${source.path}:${line + 1}: region "${name}" 缺 #region sample: ${name}`,
					{ source: source.path, sourceLine: line + 1, name },
				),
			);
		} else if (entry.starts.length === 1 && entry.ends[0] < entry.starts[0]) {
			issues.push(
				issue(
					"unmatched-region-start",
					`${source.path}:${entry.starts[0] + 1}: region "${name}" 的 end 在 start 前面`,
					{ source: source.path, sourceLine: entry.starts[0] + 1, name },
				),
			);
		}
	}

	return { lines, names, issues };
}

/** 文档记号到源码路径的规范化。只收仓库相对、POSIX 写法的路径。 */
function normalizeRepoPath(path) {
	if (path.startsWith("/") || path.includes("\\")) return undefined;
	const normalized = posix.normalize(path).replace(/^\.\//, "");
	if (normalized === ".." || normalized.startsWith("../") || normalized === ".") return undefined;
	if (normalized.split("/").some((segment) => SKIPPED_DIRS.has(segment))) return undefined;
	return normalized;
}

/** 记号后面只许空行，然后必须是一个带结束围栏的 `ts` 代码块。 */
function codeBlockAfter(lines, markerIndex, document) {
	let opening = markerIndex + 1;
	while (opening < lines.length && lines[opening].trim() === "") opening += 1;
	if (opening >= lines.length || lines[opening].trim() !== "```ts") {
		return {
			error: issue(
				"missing-code-block",
				`${document.path}:${markerIndex + 1}: sample 记号后必须紧跟一个 \`\`\`ts 代码块`,
				{ document: document.path, documentLine: markerIndex + 1 },
			),
		};
	}

	for (let closing = opening + 1; closing < lines.length; closing += 1) {
		if (lines[closing].trim() === "```") {
			return { text: lines.slice(opening + 1, closing).join("\n") };
		}
	}
	return {
		error: issue(
			"missing-code-block",
			`${document.path}:${markerIndex + 1}: sample 代码块没有结束围栏`,
			{ document: document.path, documentLine: markerIndex + 1 },
		),
	};
}

/**
 * 判据本体不碰文件系统，文档和源码都由调用方交进来，便于用内联字符串锁住每条规则。
 * `sources` 同时表示“文件存在且内容可读”；文档点到的路径不在里面就算文件不存在。
 */
function auditContractSamples({ documents, sources }) {
	const sourceMap = new Map(sources.map((source) => [normalizeRepoPath(source.path), source]));
	const parsedSources = new Map();
	const issues = [];

	for (const source of sources) {
		const parsed = parseRegions(source);
		parsedSources.set(source.path, parsed);
		issues.push(...parsed.issues);
	}

	const referenced = new Set();
	for (const document of documents) {
		const lines = document.text.split(/\r\n|\n|\r/);
		for (let index = 0; index < lines.length; index += 1) {
			const line = lines[index].trim();
			if (!line.startsWith("<!-- sample:")) continue;
			const match = DOCUMENT_MARKER.exec(line);
			if (!match) {
				issues.push(
					issue(
						"invalid-document-marker",
						`${document.path}:${index + 1}: sample 记号不合法；应为 <!-- sample: <仓库相对路径>#<名字> -->`,
						{ document: document.path, documentLine: index + 1 },
					),
				);
				continue;
			}

			const [, rawPath, name] = match;
			const sourcePath = normalizeRepoPath(rawPath);
			if (!sourcePath) {
				issues.push(
					issue(
						"invalid-sample-path",
						`${document.path}:${index + 1}: sample 路径必须是仓库内不含 node_modules、dist、.claude 的相对路径`,
						{ document: document.path, documentLine: index + 1, source: rawPath, name },
					),
				);
				continue;
			}
			referenced.add(`${sourcePath}#${name}`);

			const block = codeBlockAfter(lines, index, document);
			if (block.error) issues.push(block.error);

			const source = sourceMap.get(sourcePath);
			if (!source) {
				issues.push(
					issue(
						"missing-sample-file",
						`${document.path}:${index + 1}: sample 指向的文件不存在：${sourcePath}`,
						{ document: document.path, documentLine: index + 1, source: sourcePath, name },
					),
				);
				continue;
			}

			const parsed = parsedSources.get(source.path);
			const region = parsed.names.get(name);
			if (
				region?.starts.length !== 1 ||
				region.ends.length !== 1 ||
				region.ends[0] < region.starts[0]
			) {
				issues.push(
					issue(
						"missing-region",
						`${document.path}:${index + 1}: ${sourcePath} 里没有恰好一对 region "${name}"`,
						{ document: document.path, documentLine: index + 1, source: sourcePath, name },
					),
				);
				continue;
			}
			if (!block.text) continue;

			const expected = normalizeSampleText(
				parsed.lines.slice(region.starts[0] + 1, region.ends[0]).join("\n"),
			);
			const actual = normalizeSampleText(block.text);
			const length = Math.max(expected.length, actual.length);
			let firstDifferent = -1;
			for (let line = 0; line < length; line += 1) {
				if (expected[line] !== actual[line]) {
					firstDifferent = line;
					break;
				}
			}
			if (firstDifferent !== -1) {
				const expectedLine = expected[firstDifferent] ?? "";
				const actualLine = actual[firstDifferent] ?? "";
				issues.push(
					issue(
						"sample-mismatch",
						`${document.path}:${index + 1}: ${sourcePath}#${name} 第 ${firstDifferent + 1} 行不同\n期望：${JSON.stringify(expectedLine)}\n实际：${JSON.stringify(actualLine)}`,
						{
							document: document.path,
							documentLine: index + 1,
							source: sourcePath,
							name,
							codeLine: firstDifferent + 1,
							expected: expectedLine,
							actual: actualLine,
						},
					),
				);
			}
		}
	}

	for (const source of [...sources].sort((a, b) => a.path.localeCompare(b.path))) {
		const parsed = parsedSources.get(source.path);
		for (const [name, region] of parsed.names) {
			if (region.starts.length > 0 && !referenced.has(`${source.path}#${name}`)) {
				issues.push(
					issue(
						"orphan-region",
						`${source.path}:${region.starts[0] + 1}: region "${name}" 没有被任何被扫文档引用`,
						{ source: source.path, sourceLine: region.starts[0] + 1, name },
					),
				);
			}
		}
	}

	return issues;
}

/** 列出 `extensions|packages|apps/<id>/src` 下的源码文件，仓库相对 POSIX 路径。 */
function listSourceFiles(root = REPO_ROOT) {
	const found = [];
	const walk = (relativeDir) => {
		const entries = readdirSync(join(root, relativeDir), { withFileTypes: true }).sort((a, b) =>
			a.name.localeCompare(b.name),
		);
		for (const entry of entries) {
			const relativePath = `${relativeDir}/${entry.name}`;
			if (entry.isDirectory()) {
				if (!SKIPPED_DIRS.has(entry.name)) walk(relativePath);
			} else if (entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name))) {
				found.push(relativePath);
			}
		}
	};

	for (const group of SOURCE_GROUPS) {
		const groupDir = join(root, group);
		if (!existsSync(groupDir)) continue;
		for (const entry of readdirSync(groupDir, { withFileTypes: true }).sort((a, b) =>
			a.name.localeCompare(b.name),
		)) {
			if (!entry.isDirectory()) continue;
			const sourceDir = `${group}/${entry.name}/src`;
			if (existsSync(join(root, sourceDir))) walk(sourceDir);
		}
	}
	return found.sort();
}

/** 读真仓库：点名文档，加上所有被扫目录里的源码。 */
function readRepo() {
	return {
		documents: SCANNED_DOCUMENTS.map((path) => ({
			path,
			text: readFileSync(join(REPO_ROOT, path), "utf8"),
		})),
		sources: listSourceFiles().map((path) => ({
			path,
			text: readFileSync(join(REPO_ROOT, path), "utf8"),
		})),
	};
}

const marker = "<!-- sample: extensions/example/src/adapter.ts#maintain -->";
const sourcePath = "extensions/example/src/adapter.ts";
const sourceText = [
	"// #region sample: maintain",
	'await socket.send("original");',
	"// #endregion sample: maintain",
].join("\n");

function audit(documentText, sources = [{ path: sourcePath, text: sourceText }]) {
	return auditContractSamples({
		documents: [{ path: "docs/contract.md", text: documentText }],
		sources,
	});
}

describe("文档样板判据", () => {
	it("相同片段通过", () => {
		const documentText = [marker, "", "```ts", 'await socket.send("original");', "```"].join("\n");
		expect(audit(documentText)).toEqual([]);
	});

	it("两边缩进不同，但去掉行首公共前缀后相同也通过", () => {
		const indentedSource = [
			"function open() {",
			"\t// #region sample: maintain",
			'\tawait socket.send("original");',
			"\t// #endregion sample: maintain",
			"}",
		].join("\n");
		const documentText = [marker, "", "```ts", '      await socket.send("original");', "```"].join(
			"\n",
		);
		expect(audit(documentText, [{ path: sourcePath, text: indentedSource }])).toEqual([]);
	});

	it("差一个字就红，并报出第一处不同的行", () => {
		const documentText = [marker, "", "```ts", 'await socket.send("changed");', "```"].join("\n");
		const issues = audit(documentText);

		expect(issues).toEqual([
			expect.objectContaining({
				kind: "sample-mismatch",
				documentLine: 1,
				source: sourcePath,
			}),
		]);
		expect(issues[0].message).toContain('期望："await socket.send(\\"original\\");"');
		expect(issues[0].message).toContain('实际："await socket.send(\\"changed\\");"');
	});

	it("记号后没跟代码块红", () => {
		const issues = audit([marker, "", "普通段落"].join("\n"));
		expect(issues).toEqual([
			expect.objectContaining({ kind: "missing-code-block", documentLine: 1 }),
		]);
	});

	it("路径不存在红", () => {
		const documentText = [marker, "", "```ts", 'await socket.send("original");', "```"].join("\n");
		const issues = audit(documentText, []);
		expect(issues).toEqual([
			expect.objectContaining({
				kind: "missing-sample-file",
				source: sourcePath,
				documentLine: 1,
			}),
		]);
	});
});

describe("源码 region 判据", () => {
	it("region 缺 end 红", () => {
		const incompleteSource = ["// #region sample: maintain", 'await socket.send("original");'].join(
			"\n",
		);
		const issues = audit("", [{ path: sourcePath, text: incompleteSource }]);
		expect(issues).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: "unmatched-region-start",
					source: sourcePath,
					sourceLine: 1,
				}),
			]),
		);
	});

	it("同名 region 两对红", () => {
		const duplicatedSource = [sourceText, "", sourceText].join("\n");
		const issues = audit("", [{ path: sourcePath, text: duplicatedSource }]);
		expect(issues).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: "duplicate-region",
					source: sourcePath,
					name: "maintain",
				}),
			]),
		);
	});

	it("文档没引用的 region 红", () => {
		const issues = audit("", [{ path: sourcePath, text: sourceText }]);
		expect(issues).toEqual([
			expect.objectContaining({
				kind: "orphan-region",
				source: sourcePath,
				sourceLine: 1,
				name: "maintain",
			}),
		]);
	});
});

describe("仓里的文档样板与源码 region", () => {
	it("零违例（不开张数不为零这条棘轮）", () => {
		expect(auditContractSamples(readRepo())).toEqual([]);
	});
});
