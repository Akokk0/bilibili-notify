import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vite-plus/test";

const exec = promisify(execFile);
const { parse: parseYaml } = createRequire(
	new URL("../../apps/server/package.json", import.meta.url),
)("yaml");
const script = fileURLToPath(new URL("../retry-app-release.mjs", import.meta.url));
const repo = "owner/bilibili-notify";
const repoPath = `/repos/${repo}`;
const runPath = `${repoPath}/actions/runs/123`;
const jobsPath = `${runPath}/attempts/1/jobs?per_page=100`;
const annotationsPath = `${repoPath}/check-runs/789/annotations?per_page=100`;
const rerunPath = `${repoPath}/actions/jobs/456/rerun`;

const firstRun = {
	id: 123,
	path: ".github/workflows/npm-release.yml",
	event: "push",
	head_branch: "v1.0.0-alpha.4",
	head_sha: "1234567890abcdef1234567890abcdef12345678",
	repository: { full_name: repo },
	head_repository: { full_name: repo },
	status: "completed",
	conclusion: "failure",
	run_attempt: 1,
};
const unassignedJob = {
	id: 456,
	name: "Desktop / Build mac-arm64",
	status: "completed",
	conclusion: "cancelled",
	runner_id: 0,
	runner_name: "",
	steps: [],
	check_run_url: `https://api.github.com${repoPath}/check-runs/789`,
};
const runnerFailure = {
	annotation_level: "failure",
	message: "The job was not acquired by Runner of type hosted even after multiple attempts",
};

async function githubRequests({
	run = firstRun,
	current = run,
	jobs = [unassignedJob],
	annotations = [runnerFailure],
} = {}) {
	const requests = [];
	const replies = new Map([
		[`GET ${jobsPath}`, [200, { total_count: jobs.length, jobs }]],
		[`GET ${annotationsPath}`, [200, annotations]],
		[`GET ${runPath}`, [200, current]],
		[`POST ${rerunPath}`, [201, {}]],
	]);
	const server = createServer((request, response) => {
		const line = `${request.method} ${request.url}`;
		requests.push({ line, auth: request.headers.authorization });
		const [status, body] = replies.get(line) ?? [404, {}];
		response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
	});
	const directory = await mkdtemp(join(tmpdir(), "bn-retry-release-"));
	try {
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		const eventPath = join(directory, "event.json");
		await writeFile(eventPath, JSON.stringify({ action: "completed", workflow_run: run }));
		await exec(process.execPath, [script], {
			env: {
				...process.env,
				GITHUB_EVENT_PATH: eventPath,
				GITHUB_REPOSITORY: repo,
				GITHUB_API_URL: `http://127.0.0.1:${server.address().port}`,
				GITHUB_TOKEN: "fixture-token",
			},
			timeout: 5_000,
		});
		return requests;
	} finally {
		await new Promise((resolve) => server.close(resolve));
		await rm(directory, { recursive: true, force: true });
	}
}

it("首次 macOS 构建机分配失败只请求重跑该作业", async () => {
	const requests = await githubRequests();
	expect(requests).toEqual(
		[`GET ${jobsPath}`, `GET ${annotationsPath}`, `GET ${runPath}`, `POST ${rerunPath}`].map(
			(line) => ({ line, auth: "Bearer fixture-token" }),
		),
	);
});

it("dev 手动预检也可重跑未获构建机的 macOS 作业", async () => {
	const requests = await githubRequests({
		run: { ...firstRun, event: "workflow_dispatch", head_branch: "dev" },
	});
	expect(requests.at(-1)?.line).toBe(`POST ${rerunPath}`);
});

it("恢复工作流监听本体发行并从默认分支执行入口", async () => {
	const workflow = async (name) =>
		parseYaml(
			await readFile(new URL(`../../.github/workflows/${name}.yml`, import.meta.url), "utf8"),
		);
	const [release, desktop, retry] = await Promise.all([
		workflow("npm-release"),
		workflow("desktop-release"),
		workflow("retry-app-release"),
	]);
	expect(retry.on.workflow_run).toEqual({ workflows: [release.name], types: ["completed"] });
	expect(
		`${release.jobs.desktop.name} / ${desktop.jobs.build.name.replace(`\${{ matrix.id }}`, "mac-arm64")}`,
	).toBe(unassignedJob.name);
	expect(retry.jobs.retry.steps[0].with).toMatchObject({
		ref: `\${{ github.sha }}`,
		"persist-credentials": false,
	});
	expect(retry.jobs.retry.steps[1].run).toBe("node scripts/retry-app-release.mjs");
});

it.each([
	[
		"macOS 构建已经执行并失败",
		{
			jobs: [
				{
					...unassignedJob,
					conclusion: "failure",
					runner_id: 12,
					runner_name: "GitHub Actions",
					steps: [{ name: "Build desktop bundle", conclusion: "failure" }],
				},
			],
		},
	],
	["只有排队提示", { annotations: [{ ...runnerFailure, annotation_level: "notice" }] }],
	["发行门禁也失败", { jobs: [unassignedJob, { name: "gate / Test", conclusion: "failure" }] }],
	[
		"维护者已重跑",
		{ current: { ...firstRun, status: "in_progress", run_attempt: 2, conclusion: null } },
	],
])("%s 时不提交重跑请求", async (_name, fixture) => {
	expect((await githubRequests(fixture)).map(({ line }) => line)).not.toContain(
		`POST ${rerunPath}`,
	);
});

it.each([
	["第二次运行已失败", { run_attempt: 2 }],
	["整条发行被取消", { conclusion: "cancelled" }],
	["来源是其他仓库", { head_repository: { full_name: "fork/bilibili-notify" } }],
	["工作流路径不匹配", { path: ".github/workflows/other.yml" }],
])("%s 时跳过 API 调用", async (_name, patch) => {
	expect(await githubRequests({ run: { ...firstRun, ...patch } })).toEqual([]);
});
