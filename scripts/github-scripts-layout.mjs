import { readdirSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";

/**
 * `.github/scripts/` 的目录归属守卫:一个脚本住哪个目录,由「谁在用它」决定。
 *
 * - 只被一个 workflow 用的,住 `.github/scripts/<workflow 文件名去掉 .yml>/`。「被用」包括
 *   直接调用、经它的 composite action 调用、经同目录别的脚本调用。
 * - 被两个及以上 workflow 用的,住 `shared/`。
 *
 * 平铺的时候,一个脚本归谁、有没有人还在用它,只能靠 grep 猜;有一个从 6 月起就没人调的
 * `create-github-release.sh` 就这样躺了三个月没人发现(actionlint 只看 workflow 写了什么,
 * 不看脚本目录里多了什么)。分了目录之后这些才判得出来,判据都在下面的 `auditGithubScripts`。
 *
 * 怎么算「引用」(只看代码行,`#` 开头的整行注释不算):
 *
 * - workflow / composite action 里出现 `.github/scripts/<dir>/<file>`;
 * - 脚本里 `"$script_dir/<相对路径>"`(按调用者自己所在的目录解析),或同样的
 *   `.github/scripts/<dir>/<file>` 字面量。
 *
 * 注释不算,是因为几乎每个脚本头上都有一行「本地这样跑:bash .github/scripts/…自己」,
 * 报错串里也常带自己的名字 —— 算进去,每个脚本都「引用」了自己,孤儿就永远查不出来。
 * 所以「有人在用」按**从 workflow / action 出发能否走到**判,而不是「有没有任何入边」:
 * 自指的边、两个孤儿互相调用、被另一个孤儿调用,都不让它算「有人在用」,一并点名。
 *
 * 判定逻辑是纯函数,由 github-scripts-layout.test.mjs 先用合成数据红绿跑透,再对真实仓库
 * 跑一发;`loadGithubScriptsModel` 是唯一碰磁盘的一段。
 */

/** 被两个及以上 workflow 用的脚本住这个目录。 */
export const SHARED_DIR = "shared";

const SCRIPT_EXT = "(?:sh|ps1)";
/** `.github/scripts/` 后面跟的路径(相对 `.github/scripts/`)。 */
const REPO_PATH_REF = new RegExp(
	`\\.github/scripts/((?:[\\w.-]+/)*[\\w.-]+\\.${SCRIPT_EXT})(?![\\w.-])`,
	"g",
);
/** `"$script_dir/../shared/x.sh"` / `${script_dir}/x.sh` 里 `/` 后面的相对路径。 */
const SCRIPT_DIR_REF = new RegExp(
	`\\$\\{?script_dir\\}?/((?:(?:\\.\\.|[\\w.-]+)/)*[\\w.-]+\\.${SCRIPT_EXT})(?![\\w.-])`,
	"g",
);
/** `uses: ./.github/actions/<name>`。 */
const ACTION_USE = /uses:\s*\.\/\.github\/actions\/([\w.-]+)/g;

/** 去掉整行注释(yaml、bash、ps1 都是 `#`)。行内的 `#` 可能是 `${x#prefix}`,不动。 */
function codeOf(text) {
	return text
		.split("\n")
		.filter((line) => !line.trimStart().startsWith("#"))
		.join("\n");
}

const allMatches = (text, re) => [...codeOf(text).matchAll(re)].map((m) => m[1]);

/** workflow / composite action 的正文里引用了哪些脚本(路径相对 `.github/scripts/`)。 */
export function scriptRefsInYaml(text) {
	return allMatches(text, REPO_PATH_REF);
}

/** 正文里 `uses: ./.github/actions/<name>` 用了哪些 composite action。 */
export function actionsUsedIn(text) {
	return allMatches(text, ACTION_USE);
}

/**
 * 一个脚本里引用了哪些别的脚本(路径相对 `.github/scripts/`)。
 * `$script_dir/…` 按 `fromPath`(它自己相对 `.github/scripts/` 的路径)所在目录解析,
 * 所以挪了目录以后 `../shared/` 写错了会在这里露出来:解析出的路径不存在,下面判成悬空。
 */
export function scriptRefsInScript(fromPath, text) {
	const dir = posix.dirname(fromPath);
	return [
		...allMatches(text, SCRIPT_DIR_REF).map((rel) => posix.normalize(posix.join(dir, rel))),
		...allMatches(text, REPO_PATH_REF),
	];
}

const dirOf = (path) => (path.includes("/") ? path.split("/")[0] : null);
const KIND_LABEL = { workflow: "workflow", action: "composite action", script: "脚本" };
const label = ({ kind, name }) => `${KIND_LABEL[kind]} ${name}`;

/**
 * 判定一份「脚本 / 引用」是否满足目录归属。纯函数,不碰磁盘。
 *
 * @param model.scripts     `.github/scripts/` 下所有脚本,路径相对该目录(如 `shared/x.sh`)
 * @param model.workflows   所有 workflow 的名字(文件名去掉 .yml)
 * @param model.edges       `{ from: { kind: "workflow"|"action"|"script", name }, to }[]`,
 *                          `to` 是被引用脚本的路径(相对 `.github/scripts/`),不要求存在
 * @param model.actionUsers `{ [action 名]: 用了它的 workflow 名[] }`
 * @returns 人话描述的问题清单;空数组 = 通过
 */
export function auditGithubScripts({ scripts, workflows, edges, actionUsers }) {
	const problems = [];
	const known = new Set(scripts);
	const workflowNames = new Set(workflows);

	// 1. 每个脚本住在一层目录里,且目录是某个 workflow 的名字或 shared。
	for (const path of scripts) {
		const dir = dirOf(path);
		if (dir === null || path.split("/").length !== 2) {
			problems.push(
				`${path}: 脚本要放进 .github/scripts/<workflow 名>/ 或 ${SHARED_DIR}/(恰好一层目录)`,
			);
		} else if (dir !== SHARED_DIR && !workflowNames.has(dir)) {
			problems.push(`${path}: 目录 ${dir} 不是任何 workflow 的名字(也不是 ${SHARED_DIR})`);
		}
	}

	// 2. 引用的脚本必须真实存在 —— 挪目录后 `../shared/` 写歪、或 workflow 里路径手滑,
	//    只有跑到那一步才会炸。
	for (const { from, to } of edges) {
		if (!known.has(to)) problems.push(`${label(from)} 引用了不存在的脚本 ${to}`);
	}

	// 3. 没有孤儿:每个脚本都能从某个 workflow / composite action 出发走到。
	const reached = new Set();
	const queue = [];
	for (const { from, to } of edges) {
		if (from.kind !== "script" && known.has(to) && !reached.has(to)) {
			reached.add(to);
			queue.push(to);
		}
	}
	while (queue.length > 0) {
		const at = queue.shift();
		for (const { from, to } of edges) {
			if (from.kind === "script" && from.name === at && known.has(to) && !reached.has(to)) {
				reached.add(to);
				queue.push(to);
			}
		}
	}
	for (const path of scripts) {
		if (!reached.has(path)) {
			problems.push(
				`${path}: 没有任何 workflow / composite action 能走到它(孤儿:要么接上线,要么删掉)`,
			);
		}
	}

	// 4. 归类:能调谁,只看调用者住哪。
	for (const edge of edges) {
		const { from, to } = edge;
		const dir = dirOf(to);
		if (dir === null || !known.has(to)) continue; // 已在上面点过名
		if (dir === SHARED_DIR) continue; // 谁都能调 shared
		if (from.kind === "workflow" && dir !== from.name) {
			problems.push(
				`workflow ${from.name} 引用了 ${to}:它只能用自己的 ${from.name}/ 或 ${SHARED_DIR}/ 里的脚本`,
			);
		} else if (from.kind === "action") {
			const users = actionUsers[from.name] ?? [];
			if (!users.includes(dir)) {
				problems.push(
					`composite action ${from.name} 引用了 ${to}:它只能用 ${SHARED_DIR}/ 或用了它的 workflow(${users.join("、") || "没有 workflow 用它"})对应的目录`,
				);
			}
		} else if (from.kind === "script") {
			const fromDir = dirOf(from.name);
			if (fromDir === SHARED_DIR) {
				problems.push(
					`${from.name} 调用了 ${to}:${SHARED_DIR}/ 的脚本不许依赖某个 workflow 目录里的脚本(被多个 workflow 用的东西不能靠只属于一个的东西)`,
				);
			} else if (fromDir !== dir) {
				problems.push(`${from.name} 调用了 ${to}:脚本只能调自己目录或 ${SHARED_DIR}/ 里的`);
			}
		}
	}

	return problems;
}

function listFiles(dir) {
	const out = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...listFiles(path).map((f) => `${entry.name}/${f}`));
		else if (entry.isFile() && !entry.name.startsWith(".")) out.push(entry.name);
	}
	return out;
}

/**
 * 读真实仓库,凑出 `auditGithubScripts` 要的输入。扫磁盘而不是 `git ls-files`:
 * 刚建、还没 add 的孤儿脚本正是要抓的对象。
 */
export function loadGithubScriptsModel(root) {
	const gh = join(root, ".github");
	const scripts = listFiles(join(gh, "scripts")).sort();
	const nameOf = (file) => file.replace(/\.ya?ml$/, "");

	const workflowFiles = readdirSync(join(gh, "workflows")).filter((f) => /\.ya?ml$/.test(f));
	const workflows = workflowFiles.map(nameOf);
	const actions = readdirSync(join(gh, "actions"), { withFileTypes: true })
		.filter((e) => e.isDirectory())
		.map((e) => e.name);

	const edges = [];
	const actionUsers = Object.fromEntries(actions.map((a) => [a, []]));
	for (const file of workflowFiles) {
		const text = readFileSync(join(gh, "workflows", file), "utf8");
		const from = { kind: "workflow", name: nameOf(file) };
		for (const to of scriptRefsInYaml(text)) edges.push({ from, to });
		for (const action of actionsUsedIn(text)) {
			if (!actionUsers[action]) actionUsers[action] = [];
			if (!actionUsers[action].includes(from.name)) actionUsers[action].push(from.name);
		}
	}
	for (const action of actions) {
		const yml = readdirSync(join(gh, "actions", action)).find((f) => /^action\.ya?ml$/.test(f));
		if (!yml) continue;
		const text = readFileSync(join(gh, "actions", action, yml), "utf8");
		for (const to of scriptRefsInYaml(text))
			edges.push({ from: { kind: "action", name: action }, to });
	}
	for (const script of scripts) {
		const text = readFileSync(join(gh, "scripts", script), "utf8");
		for (const to of scriptRefsInScript(script, text)) {
			edges.push({ from: { kind: "script", name: script }, to });
		}
	}
	return { scripts, workflows, edges, actionUsers };
}
