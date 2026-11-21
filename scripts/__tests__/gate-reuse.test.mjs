import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { afterEach, expect, it, vi } from "vite-plus/test";

const { parse } = createRequire(new URL("../../apps/server/package.json", import.meta.url))("yaml");
const workflow = (name) =>
	parse(readFileSync(new URL(`../../.github/workflows/${name}.yml`, import.meta.url), "utf8"));
const repo = "owner/bilibili-notify";
const sha = "a".repeat(40);
const options = {
	repository: repo,
	sha,
	currentRunId: "24",
	apiUrl: "https://api.github.test",
	token: "fixture",
};
const ci = {
	id: 21,
	run_attempt: 2,
	path: ".github/workflows/ci.yml",
	event: "push",
	head_branch: "dev",
	head_sha: sha,
	repository: { full_name: repo },
	head_repository: { full_name: repo },
};
const passed = {
	name: "gate / gate",
	status: "completed",
	conclusion: "success",
	steps: [{ name: "Require every test shard", conclusion: "success" }],
};

afterEach(() => vi.unstubAllGlobals());

async function lookup(runs, jobs, extra = {}) {
	const paths = [];
	vi.stubGlobal("fetch", async (url, init) => {
		const path = new URL(url);
		expect(init.headers.Authorization).toBe("Bearer fixture");
		expect(path.pathname.startsWith(`/repos/${repo}/actions/`)).toBe(true);
		paths.push(path.pathname);
		if (path.pathname.endsWith("/actions/runs")) {
			expect(path.searchParams.get("head_sha")).toBe(sha);
			return Response.json({ workflow_runs: runs });
		}
		expect(path.pathname).toBe(`/repos/${repo}/actions/runs/21/attempts/2/jobs`);
		return Response.json({ jobs });
	});
	const { findPassedGate } = await import("../find-passed-gate.mjs");
	return { id: await findPassedGate({ ...options, ...extra }), calls: paths.length };
}

it("同一提交的发版与 dev CI 在 GitHub 队列里等同一轮门禁，PR 独立验证", () => {
	const gate = workflow("gate");
	expect(gate.concurrency.queue).toBe("max");
	expect(workflow("extension-release").concurrency.queue).toBe("max");
	expect(gate.jobs.test.if).toBe("needs.lookup.outputs.passed != 'true'");
	expect(gate.jobs.gate.steps.find((step) => step.name === "Require every test shard").if).toBe(
		gate.jobs.test.if,
	);
	expect(gate.concurrency.group).toContain("github.sha");
	expect(gate.concurrency.group).toContain("pull_request");
	for (const name of ["ci", "npm-release", "tooling-release", "extension-release"]) {
		expect(workflow(name).jobs.gate.uses).toBe("./.github/workflows/gate.yml");
		expect(workflow(name).jobs.gate.permissions.actions).toBe("read");
	}
});

it("已完成的真实门禁可复用，即使后续发行作业仍在运行", async () => {
	for (const run of [
		ci,
		{
			...ci,
			path: ".github/workflows/npm-release.yml",
			head_branch: "v1.0.0",
			status: "in_progress",
		},
		{ ...ci, path: ".github/workflows/tooling-release.yml", event: "workflow_dispatch" },
		{
			...ci,
			path: ".github/workflows/extension-release.yml",
			head_branch: "extension/bridge@1.0.0",
		},
	]) {
		expect(await lookup([run], [passed])).toEqual({ id: 21, calls: 2 });
	}
});

it("失败、取消、跳过、尚未完成和只复用过的汇总都需要实际跑门禁", async () => {
	for (const job of [
		{ ...passed, conclusion: "failure" },
		{ ...passed, conclusion: "cancelled" },
		{ ...passed, status: "in_progress" },
		{ ...passed, name: "other / gate" },
		{ ...passed, steps: [{ name: "Require every test shard", conclusion: "skipped" }] },
	]) {
		expect((await lookup([ci], [job])).id).toBeUndefined();
	}
});

it("只信当前 SHA、本仓、允许的工作流和触发来源，排除自身", async () => {
	const inputs = [
		{ id: 24 },
		{ event: "pull_request" },
		{ head_branch: "topic" },
		{ head_sha: "b".repeat(40) },
		{ path: ".github/workflows/example.yml" },
		{ head_repository: { full_name: "fork/bn" } },
		{ repository: { full_name: "fork/bn" } },
		{ path: ".github/workflows/tooling-release.yml", event: "push" },
	];
	expect(
		await lookup(
			inputs.map((patch) => ({ ...ci, ...patch })),
			[passed],
		),
	).toEqual({ id: undefined, calls: 1 });
});
