import { pathToFileURL } from "node:url";

function trustedRun(run, repository, sha, currentRunId) {
	if (
		run.head_sha !== sha ||
		run.repository?.full_name !== repository ||
		run.head_repository?.full_name !== repository ||
		String(run.id) === currentRunId ||
		!Number.isSafeInteger(run.id) ||
		!Number.isSafeInteger(run.run_attempt)
	)
		return false;
	switch (run.path) {
		case ".github/workflows/ci.yml":
			return run.event === "push" && run.head_branch === "dev";
		case ".github/workflows/npm-release.yml":
			if (run.event === "push") return /^v\d/.test(run.head_branch);
			break;
		case ".github/workflows/extension-release.yml":
			if (run.event === "push") return run.head_branch?.startsWith("extension/");
			break;
		case ".github/workflows/tooling-release.yml":
			break;
		default:
			return false;
	}
	return run.event === "workflow_dispatch" && run.head_branch === "dev";
}

// 只认可本次 attempt 真正跑过全部分片的汇总。发布步骤可能仍在签名或上传。
export async function findPassedGate({ repository, sha, currentRunId, apiUrl, token }) {
	if (!/^[0-9a-f]{40}$/.test(sha)) return;
	async function* pages(path, key, query = {}) {
		for (let page = 1; ; page++) {
			const params = new URLSearchParams({ ...query, per_page: "100", page: String(page) });
			const response = await fetch(`${apiUrl}/repos/${repository}/actions/${path}?${params}`, {
				headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}` },
				redirect: "error",
				signal: AbortSignal.timeout(15_000),
			});
			if (!response.ok) throw new Error(`Actions API returned HTTP ${response.status}`);
			const entries = (await response.json())[key];
			yield* entries;
			if (entries.length < 100) return;
		}
	}
	for await (const run of pages("runs", "workflow_runs", { head_sha: sha })) {
		if (!trustedRun(run, repository, sha, currentRunId)) continue;
		for await (const job of pages(`runs/${run.id}/attempts/${run.run_attempt}/jobs`, "jobs")) {
			if (
				job.name === "gate / gate" &&
				job.status === "completed" &&
				job.conclusion === "success" &&
				job.steps?.some(
					(step) => step.name === "Require every test shard" && step.conclusion === "success",
				)
			)
				return run.id;
		}
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const {
		GITHUB_REPOSITORY: repository,
		GITHUB_RUN_ID: currentRunId,
		GITHUB_API_URL: apiUrl,
		GH_TOKEN: token,
	} = process.env;
	try {
		const id = await findPassedGate({
			repository,
			sha: process.argv[2],
			currentRunId,
			apiUrl,
			token,
		});
		if (id) console.error(`Reusing verified gate from Actions run ${id}.`);
		console.log(`passed=${Boolean(id)}`);
	} catch (error) {
		console.error(`Gate lookup unavailable. Running verification. ${error.message}`);
		console.log("passed=false");
	}
}
