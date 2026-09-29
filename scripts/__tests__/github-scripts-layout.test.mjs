import { describe, expect, it } from "vite-plus/test";
import {
	actionsUsedIn,
	auditGithubScripts,
	loadGithubScriptsModel,
	scriptRefsInScript,
	scriptRefsInYaml,
} from "../github-scripts-layout.mjs";
import { repoRoot } from "../vite-alias.mjs";

/**
 * 见 github-scripts-layout.mjs 顶部:`.github/scripts/` 里每个脚本住哪个目录、有没有人在用,
 * 由这里守着。判定逻辑先用合成数据红绿跑透,再对真实仓库跑一发。
 */

const wf = (name) => ({ kind: "workflow", name });
const action = (name) => ({ kind: "action", name });
const script = (name) => ({ kind: "script", name });
const edge = (from, to) => ({ from, to });

/** 一份干净的小仓库:两个 workflow、一个只有 image 用的 composite action、一个 shared 脚本。 */
function cleanModel() {
	return {
		scripts: [
			"shared/read-version.sh",
			"shared/publish.sh",
			"image-release/smoke.sh",
			"image-release/digest.sh",
			"update-payload/pack.sh",
			"update-payload/publish-all.sh",
		],
		workflows: ["image-release", "update-payload"],
		actionUsers: { "build-image": ["image-release"] },
		edges: [
			edge(wf("image-release"), "shared/read-version.sh"),
			edge(action("build-image"), "image-release/smoke.sh"),
			edge(action("build-image"), "image-release/digest.sh"),
			edge(action("build-image"), "shared/read-version.sh"),
			edge(wf("update-payload"), "update-payload/pack.sh"),
			edge(wf("update-payload"), "update-payload/publish-all.sh"),
			edge(script("update-payload/publish-all.sh"), "shared/publish.sh"),
		],
	};
}

describe("引用是怎么认出来的", () => {
	it("workflow / action:带目录的 .github/scripts 路径,bash 与 ./ 两种写法都认", () => {
		const yml = [
			"      - run: bash .github/scripts/extension-release/pack-extension.sh",
			"        run: ./.github/scripts/desktop-release/collect-windows.ps1",
			"        run: bash .github/scripts/shared/read-standalone-version.sh",
		].join("\n");
		expect(scriptRefsInYaml(yml)).toEqual([
			"extension-release/pack-extension.sh",
			"desktop-release/collect-windows.ps1",
			"shared/read-standalone-version.sh",
		]);
	});

	it("整行注释里的路径不算引用(脚本头上的本地用法、workflow 里的说明)", () => {
		const yml = [
			"  # 脚本本体在 .github/scripts/shared/read-standalone-version.sh。",
			"        run: bash .github/scripts/shared/a.sh",
		].join("\n");
		expect(scriptRefsInYaml(yml)).toEqual(["shared/a.sh"]);
	});

	it("uses: ./.github/actions/<name> 认出用了哪个 composite action", () => {
		const yml = [
			"        uses: ./.github/actions/build-push-image-digest",
			"        uses: actions/checkout@v4",
			"        # uses: ./.github/actions/commented-out",
			"        uses: ./.github/actions/create-manifest-for-variant",
		].join("\n");
		expect(actionsUsedIn(yml)).toEqual(["build-push-image-digest", "create-manifest-for-variant"]);
	});

	it("脚本里的 $script_dir/…:按调用者所在目录解析,跨目录的 ../ 也算", () => {
		const text = [
			'exec bash "$script_dir/../shared/publish-rolling-asset.sh"',
			`source "$\{script_dir}/lib.sh"`,
		].join("\n");
		expect(scriptRefsInScript("extension-release/publish-marketplace.sh", text)).toEqual([
			"shared/publish-rolling-asset.sh",
			"extension-release/lib.sh",
		]);
	});

	// 这条是设计上最容易掉的坑:几乎每个脚本头上都有一行「bash .github/scripts/<自己>」,
	// 报错串里也常带自己的名字。
	it("usage 注释与报错串里的名字不产生引用", () => {
		const text = [
			"# 本地这样跑:",
			"#   bash .github/scripts/image-release/smoke.sh",
			"# shellcheck source=.github/scripts/shared/lib.sh",
			'echo "::error::smoke.sh must run inside a git worktree"',
		].join("\n");
		expect(scriptRefsInScript("image-release/smoke.sh", text)).toEqual([]);
	});

	it("脚本里直接写 .github/scripts 字面量的调用也认", () => {
		expect(
			scriptRefsInScript("shared/a.sh", 'bash "$GITHUB_WORKSPACE/.github/scripts/shared/b.sh"'),
		).toEqual(["shared/b.sh"]);
	});
});

describe("auditGithubScripts", () => {
	it("干净的布局 → 没问题", () => {
		expect(auditGithubScripts(cleanModel())).toEqual([]);
	});

	describe("没有孤儿", () => {
		it("没人引用的脚本 → 点名", () => {
			const m = cleanModel();
			m.scripts.push("shared/forgotten.sh");
			const problems = auditGithubScripts(m);
			expect(problems).toHaveLength(1);
			expect(problems[0]).toContain("shared/forgotten.sh");
			expect(problems[0]).toContain("孤儿");
		});

		// 与上面 `usage 注释…不产生引用` 是一对:那条钉提取,这条钉判定 —— 就算提取漏了、
		// 让自指的边溜进来,孤儿照样得被点出来。
		it("只有自己引用自己 → 仍是孤儿", () => {
			const m = cleanModel();
			m.scripts.push("shared/self.sh");
			m.edges.push(edge(script("shared/self.sh"), "shared/self.sh"));
			expect(auditGithubScripts(m).join("\n")).toContain("shared/self.sh: 没有任何");
		});

		it("只被另一个孤儿引用 → 两个都点名(判的是从 workflow 能否走到)", () => {
			const m = cleanModel();
			m.scripts.push("shared/dead-a.sh", "shared/dead-b.sh");
			m.edges.push(
				edge(script("shared/dead-a.sh"), "shared/dead-b.sh"),
				edge(script("shared/dead-b.sh"), "shared/dead-a.sh"),
			);
			const problems = auditGithubScripts(m);
			expect(problems).toHaveLength(2);
			expect(problems.join("\n")).toContain("shared/dead-a.sh");
			expect(problems.join("\n")).toContain("shared/dead-b.sh");
		});

		it("被别的脚本引用、而那个脚本自己被 workflow 用着 → 不是孤儿", () => {
			// clean 里的 shared/publish.sh 只有 update-payload/publish-all.sh 调它。
			expect(auditGithubScripts(cleanModel())).toEqual([]);
		});
	});

	describe("归类对", () => {
		it("workflow 引用别的 workflow 的目录 → 点名", () => {
			const m = cleanModel();
			m.edges.push(edge(wf("update-payload"), "image-release/smoke.sh"));
			const problems = auditGithubScripts(m);
			expect(problems).toHaveLength(1);
			expect(problems[0]).toContain("workflow update-payload");
			expect(problems[0]).toContain("image-release/smoke.sh");
		});

		it("workflow 引用 shared 和自己的目录 → 没问题", () => {
			const m = cleanModel();
			m.edges.push(edge(wf("image-release"), "image-release/smoke.sh"));
			m.edges.push(edge(wf("update-payload"), "shared/read-version.sh"));
			expect(auditGithubScripts(m)).toEqual([]);
		});

		it("composite action 引用了没用它的 workflow 的目录 → 点名,并列出谁用了它", () => {
			const m = cleanModel();
			m.edges.push(edge(action("build-image"), "update-payload/pack.sh"));
			const problems = auditGithubScripts(m);
			expect(problems).toHaveLength(1);
			expect(problems[0]).toContain("composite action build-image");
			expect(problems[0]).toContain("image-release");
		});

		it("composite action 被两个 workflow 用 → 两边的目录都能引用", () => {
			const m = cleanModel();
			m.actionUsers["build-image"] = ["image-release", "update-payload"];
			m.edges.push(edge(action("build-image"), "update-payload/pack.sh"));
			expect(auditGithubScripts(m)).toEqual([]);
		});

		it("shared 里的脚本调用某个 workflow 目录里的脚本 → 点名", () => {
			const m = cleanModel();
			m.edges.push(edge(script("shared/publish.sh"), "update-payload/pack.sh"));
			const problems = auditGithubScripts(m);
			expect(problems).toHaveLength(1);
			expect(problems[0]).toContain("shared/publish.sh");
			expect(problems[0]).toContain("update-payload/pack.sh");
			// shared 专属的那句,不是「同目录或 shared」那句通用的。
			expect(problems[0]).toContain("shared/ 的脚本不许依赖某个 workflow 目录");
		});

		it("一个 workflow 目录里的脚本调用另一个 workflow 目录里的 → 点名", () => {
			const m = cleanModel();
			m.edges.push(edge(script("update-payload/pack.sh"), "image-release/smoke.sh"));
			const problems = auditGithubScripts(m);
			expect(problems).toHaveLength(1);
			expect(problems[0]).toContain("update-payload/pack.sh");
		});

		it("workflow 目录里的脚本调用 shared 和同目录的 → 没问题", () => {
			const m = cleanModel();
			m.edges.push(edge(script("update-payload/publish-all.sh"), "update-payload/pack.sh"));
			m.edges.push(edge(script("update-payload/pack.sh"), "shared/read-version.sh"));
			expect(auditGithubScripts(m)).toEqual([]);
		});
	});

	describe("目录本身", () => {
		it("平铺在 .github/scripts/ 下的脚本 → 点名", () => {
			const m = cleanModel();
			m.scripts.push("flat.sh");
			m.edges.push(edge(wf("image-release"), "flat.sh"));
			expect(auditGithubScripts(m).join("\n")).toContain("flat.sh: 脚本要放进");
		});

		it("目录不是任何 workflow 的名字 → 点名", () => {
			const m = cleanModel();
			m.scripts.push("no-such-workflow/x.sh");
			const text = auditGithubScripts(m).join("\n");
			expect(text).toContain("no-such-workflow/x.sh: 目录 no-such-workflow");
		});

		it("嵌套两层 → 点名", () => {
			const m = cleanModel();
			m.scripts.push("shared/deeper/x.sh");
			expect(auditGithubScripts(m).join("\n")).toContain("shared/deeper/x.sh: 脚本要放进");
		});
	});

	describe("引用得到", () => {
		it("workflow 引用了不存在的脚本 → 点名(挪目录后路径手滑的样子)", () => {
			const m = cleanModel();
			m.edges.push(edge(wf("image-release"), "image-release/typo.sh"));
			const problems = auditGithubScripts(m);
			expect(problems).toHaveLength(1);
			expect(problems[0]).toBe("workflow image-release 引用了不存在的脚本 image-release/typo.sh");
		});

		it("脚本的 $script_dir 解析出来指向不存在的文件 → 点名(../shared/ 写歪了)", () => {
			const m = cleanModel();
			m.edges.push(
				edge(script("update-payload/publish-all.sh"), "update-payload/shared/publish.sh"),
			);
			const problems = auditGithubScripts(m);
			expect(problems).toHaveLength(1);
			expect(problems[0]).toContain("update-payload/shared/publish.sh");
		});
	});

	it("一次报全,不是遇到第一个就收工", () => {
		const m = cleanModel();
		m.scripts.push("shared/forgotten.sh", "flat.sh");
		m.edges.push(edge(wf("update-payload"), "image-release/smoke.sh"));
		m.edges.push(edge(wf("update-payload"), "gone.sh"));
		expect(auditGithubScripts(m).length).toBeGreaterThanOrEqual(4);
	});
});

describe("真实仓库", () => {
	const model = loadGithubScriptsModel(repoRoot());

	// 提取器要是悄悄瞎了(写法一变、正则不认),下面那条会因为「没有边」而空转成绿。
	it("确实扫到了 workflow 与 composite action 对脚本的引用", () => {
		expect(model.scripts.length).toBeGreaterThan(0);
		for (const kind of ["workflow", "action"]) {
			expect(model.edges.some((e) => e.from.kind === kind)).toBe(true);
		}
		// 每个 composite action 都有 workflow 在用(否则它引用的脚本谁的目录都对不上)。
		for (const [name, users] of Object.entries(model.actionUsers)) {
			expect(users.length, `composite action ${name} 没有 workflow 用它`).toBeGreaterThan(0);
		}
	});

	it("脚本目录归属对:没有孤儿、workflow / action / 脚本只用自己那份与 shared", () => {
		expect(auditGithubScripts(model)).toEqual([]);
	});
});
