import { readFile } from "node:fs/promises";

const workflowPath = ".github/workflows/npm-release.yml";
const macJobName = "Desktop / Build mac-arm64";
const allocationError =
	"The job was not acquired by Runner of type hosted even after multiple attempts";

function eligibleRun(run, repo) {
	if (
		!Number.isSafeInteger(run?.id) ||
		run.id <= 0 ||
		run.path !== workflowPath ||
		run.repository?.full_name !== repo ||
		run.head_repository?.full_name !== repo ||
		run.status !== "completed" ||
		run.conclusion !== "failure" ||
		run.run_attempt !== 1
	) {
		return false;
	}
	return (
		(run.event === "push" && /^v\d+\./.test(run.head_branch)) ||
		(run.event === "workflow_dispatch" && run.head_branch === "dev")
	);
}

function unassignedMacJob({ jobs, total_count: totalCount }) {
	if (!Array.isArray(jobs) || jobs.length !== totalCount) return undefined;
	const failed = jobs.filter((job) => !["success", "skipped"].includes(job.conclusion));
	const [job] = failed;
	if (
		failed.length === 1 &&
		job.name === macJobName &&
		job.status === "completed" &&
		["failure", "cancelled"].includes(job.conclusion) &&
		[0, null].includes(job.runner_id) &&
		["", null].includes(job.runner_name) &&
		job.steps?.length === 0 &&
		Number.isSafeInteger(job.id) &&
		job.id > 0
	) {
		return job;
	}
}

async function main({
	GITHUB_EVENT_PATH: eventPath,
	GITHUB_REPOSITORY: repo,
	GITHUB_API_URL: apiRoot,
	GITHUB_TOKEN: token,
}) {
	const { action, workflow_run: run } = JSON.parse(await readFile(eventPath, "utf8"));
	if (action !== "completed" || !eligibleRun(run, repo)) return;
	if (!apiRoot || !token) throw new Error("GitHub API URL and token are required.");

	async function request(path, method = "GET") {
		const response = await fetch(`${apiRoot.replace(/\/$/, "")}/repos/${repo}/${path}`, {
			method,
			headers: {
				Accept: "application/vnd.github+json",
				Authorization: `Bearer ${token}`,
				"X-GitHub-Api-Version": "2022-11-28",
			},
			redirect: "error",
			signal: AbortSignal.timeout(15_000),
		});
		if (!response.ok) throw new Error(`${method} ${path} returned HTTP ${response.status}.`);
		return response;
	}

	const runPath = `actions/runs/${run.id}`;
	const jobs = await (await request(`${runPath}/attempts/1/jobs?per_page=100`)).json();
	const job = unassignedMacJob(jobs);
	if (!job) return;

	// 从 API 的检查链接提取数字 ID。请求仍使用当前仓库的 API 地址。
	const checkId = job.check_run_url?.match(/\/check-runs\/([1-9]\d*)$/)?.[1];
	if (!checkId) return;
	const annotations = await (
		await request(`check-runs/${checkId}/annotations?per_page=100`)
	).json();
	if (
		!annotations.some(
			(annotation) =>
				annotation.annotation_level === "failure" && annotation.message === allocationError,
		)
	)
		return;

	// 在写入前重新确认，避免重复事件或已经发起的手动重试再次排队。
	const current = await (await request(runPath)).json();
	if (!eligibleRun(current, repo) || current.id !== run.id || current.head_sha !== run.head_sha) {
		return;
	}
	const response = await request(`actions/jobs/${job.id}/rerun`, "POST");
	if (response.status !== 201)
		throw new Error(`Unexpected rerun response HTTP ${response.status}.`);
	console.log(`Requested one rerun of macOS job ${job.id} for release run ${run.id}.`);
}

await main(process.env);
