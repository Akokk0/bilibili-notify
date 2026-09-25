import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import { createGitHubApi, handleEvent } from "./issue-needs-info.mjs";

const DAY = 24 * 60 * 60 * 1000;
const T0 = new Date("2026-09-20T00:00:00Z");
const at = (ms) => new Date(T0.getTime() + ms).toISOString();

/**
 * 内存里的假仓库,实现 handleEvent 用到的那几个 api 方法,形状照 GitHub REST 的返回。
 * 断言只看 issue 最后停在什么状态(标签 / 开关 / 评论),不看调了哪些方法。
 */
function fakeRepo(seed) {
	const issues = new Map(
		seed.map((i) => [
			i.number,
			{
				state: "open",
				state_reason: null,
				closed_by: null,
				labels: [],
				comments: [],
				events: [],
				...i,
			},
		]),
	);
	const get = (n) => issues.get(n);
	const toRest = (i) => ({
		number: i.number,
		user: i.user,
		state: i.state,
		state_reason: i.state_reason,
		closed_by: i.closed_by,
		labels: i.labels.map((name) => ({ name })),
		...(i.pull_request ? { pull_request: i.pull_request } : {}),
	});
	const api = {
		async getIssue(n) {
			return toRest(get(n));
		},
		async listOpenIssuesWithLabel(label) {
			return [...issues.values()]
				.filter((i) => i.state === "open" && i.labels.includes(label))
				.map(toRest);
		},
		async listEvents(n) {
			return get(n).events;
		},
		async listComments(n, { since }) {
			// 照真 API:`since` 按 updated_at 过滤,打标签之前写、之后改过的评论也会回来。
			return get(n).comments.filter((c) => (c.updated_at ?? c.created_at) >= since);
		},
		async comment(n, body) {
			get(n).comments.push({
				user: { login: "github-actions[bot]", type: "Bot" },
				body,
				created_at: "now",
			});
		},
		async addLabels(n, labels) {
			const i = get(n);
			for (const l of labels) if (!i.labels.includes(l)) i.labels.push(l);
		},
		async removeLabel(n, label) {
			const i = get(n);
			i.labels = i.labels.filter((l) => l !== label);
		},
		async update(n, patch) {
			const i = get(n);
			Object.assign(i, patch);
			if (patch.state === "closed") i.closed_by = { login: "github-actions[bot]" };
			if (patch.state === "open") {
				i.state_reason = null;
				i.closed_by = null;
			}
		},
	};
	return { api, issue: get };
}

const reporter = { login: "reporter", type: "User" };
const maintainer = { login: "Akokk0", type: "User" };

describe("打上 needs-info", () => {
	it("@报告人 说明要补信息、3 天不回会先关,并摘掉别的流转标签", async () => {
		const repo = fakeRepo([
			{ number: 7, user: reporter, labels: ["needs-triage", "needs-info", "bug"] },
		]);
		await handleEvent({
			eventName: "issues",
			payload: {
				action: "labeled",
				label: { name: "needs-info" },
				issue: await repo.api.getIssue(7),
			},
			api: repo.api,
			now: T0,
		});
		const issue = repo.issue(7);
		expect(issue.comments).toHaveLength(1);
		expect(issue.comments[0].body).toContain("@reporter");
		expect(issue.comments[0].body).toContain("3 天");
		// 流转标签恒有且只有一个;类型 / 模块标签不动。
		expect(issue.labels.sort()).toEqual(["bug", "needs-info"]);
	});

	it("关着的 issue 打上它不留言", async () => {
		const repo = fakeRepo([{ number: 7, user: reporter, labels: ["needs-info"], state: "closed" }]);
		await handleEvent({
			eventName: "issues",
			payload: {
				action: "labeled",
				label: { name: "needs-info" },
				issue: await repo.api.getIssue(7),
			},
			api: repo.api,
			now: T0,
		});
		expect(repo.issue(7).comments).toHaveLength(0);
	});

	it("打的是别的标签就什么都不做", async () => {
		const repo = fakeRepo([{ number: 7, user: reporter, labels: ["needs-triage", "bug"] }]);
		await handleEvent({
			eventName: "issues",
			payload: { action: "labeled", label: { name: "bug" }, issue: await repo.api.getIssue(7) },
			api: repo.api,
			now: T0,
		});
		expect(repo.issue(7).comments).toHaveLength(0);
		expect(repo.issue(7).labels).toEqual(["needs-triage", "bug"]);
	});
});

async function commentBy(repo, n, user) {
	const c = { user, body: "…", created_at: at(DAY) };
	repo.issue(n).comments.push(c);
	await handleEvent({
		eventName: "issue_comment",
		payload: { action: "created", comment: c, issue: await repo.api.getIssue(n) },
		api: repo.api,
		now: new Date(at(DAY)),
	});
}

describe("有人回复", () => {
	it("报告人回复 → 停表:needs-info 换回 needs-triage,回到维护者的待办", async () => {
		const repo = fakeRepo([{ number: 7, user: reporter, labels: ["needs-info", "bug"] }]);
		await commentBy(repo, 7, reporter);
		expect(repo.issue(7).labels.sort()).toEqual(["bug", "needs-triage"]);
		expect(repo.issue(7).state).toBe("open");
	});

	it("维护者追问不算 —— 表照走", async () => {
		const repo = fakeRepo([{ number: 7, user: reporter, labels: ["needs-info"] }]);
		await commentBy(repo, 7, maintainer);
		expect(repo.issue(7).labels).toEqual(["needs-info"]);
	});

	it("没挂 needs-info 的 issue,报告人回复不动标签", async () => {
		const repo = fakeRepo([{ number: 7, user: reporter, labels: ["ready-for-agent"] }]);
		await commentBy(repo, 7, reporter);
		expect(repo.issue(7).labels).toEqual(["ready-for-agent"]);
	});

	it("PR 下的评论不管", async () => {
		const repo = fakeRepo([
			{ number: 7, user: reporter, labels: ["needs-info"], pull_request: {} },
		]);
		await commentBy(repo, 7, reporter);
		expect(repo.issue(7).labels).toEqual(["needs-info"]);
	});

	it("被自动关掉后报告人回复 → 重开并回到 needs-triage", async () => {
		// 别人关掉的 issue 报告人自己重开不了,不补这一步,「补上信息留言即可」就是空话。
		const repo = fakeRepo([
			{
				number: 7,
				user: reporter,
				labels: ["needs-info"],
				state: "closed",
				state_reason: "not_planned",
				closed_by: { login: "github-actions[bot]" },
			},
		]);
		await commentBy(repo, 7, reporter);
		expect(repo.issue(7).state).toBe("open");
		expect(repo.issue(7).labels).toEqual(["needs-triage"]);
	});

	it("维护者亲手关的(哪怕同样是「不计划处理」),报告人回复不重开", async () => {
		const repo = fakeRepo([
			{
				number: 7,
				user: reporter,
				labels: ["needs-info"],
				state: "closed",
				state_reason: "not_planned",
				closed_by: { login: "Akokk0" },
			},
		]);
		await commentBy(repo, 7, reporter);
		expect(repo.issue(7).state).toBe("closed");
		expect(repo.issue(7).labels).toEqual(["needs-info"]);
	});
});

const labeled = (ms) => ({ event: "labeled", label: { name: "needs-info" }, created_at: at(ms) });

async function sweep(repo, nowMs) {
	await handleEvent({
		eventName: "schedule",
		payload: {},
		api: repo.api,
		now: new Date(at(nowMs)),
	});
}

describe("每天清扫一次", () => {
	it("挂满 3 天、报告人没回 → 留一句说明,按「不计划处理」关闭,标签留着", async () => {
		const repo = fakeRepo([
			{ number: 7, user: reporter, labels: ["needs-info"], events: [labeled(0)] },
		]);
		await sweep(repo, 3 * DAY + 1);
		const issue = repo.issue(7);
		expect(issue.state).toBe("closed");
		expect(issue.state_reason).toBe("not_planned");
		expect(issue.comments.at(-1).body).toContain("重新打开");
		// needs-info 留着:它说的是实话,也是「这是自动关的」的判据之一。
		expect(issue.labels).toEqual(["needs-info"]);
	});

	it("不满 3 天不关", async () => {
		const repo = fakeRepo([
			{ number: 7, user: reporter, labels: ["needs-info"], events: [labeled(0)] },
		]);
		await sweep(repo, 3 * DAY - 1);
		expect(repo.issue(7).state).toBe("open");
		expect(repo.issue(7).comments).toHaveLength(0);
	});

	it("按最近一次打上标签计时", async () => {
		const events = [
			labeled(-10 * DAY),
			{ event: "unlabeled", label: { name: "needs-info" }, created_at: at(-9 * DAY) },
			labeled(-DAY),
		];
		const repo = fakeRepo([{ number: 7, user: reporter, labels: ["needs-info"], events }]);
		await sweep(repo, 0);
		expect(repo.issue(7).state).toBe("open");
	});

	it("维护者打标签之后的追问不算回复,照样关", async () => {
		const repo = fakeRepo([
			{
				number: 7,
				user: reporter,
				labels: ["needs-info"],
				events: [labeled(0)],
				comments: [{ user: maintainer, body: "还需要日志", created_at: at(DAY) }],
			},
		]);
		await sweep(repo, 4 * DAY);
		expect(repo.issue(7).state).toBe("closed");
	});

	it("报告人其实回过(那次事件没跑成)→ 补一次停表,不关", async () => {
		const repo = fakeRepo([
			{
				number: 7,
				user: reporter,
				labels: ["needs-info"],
				events: [labeled(0)],
				comments: [
					{ user: reporter, body: "打标签之前说的", created_at: at(-DAY) },
					{ user: reporter, body: "日志在这", created_at: at(DAY) },
				],
			},
		]);
		await sweep(repo, 4 * DAY);
		expect(repo.issue(7).state).toBe("open");
		expect(repo.issue(7).labels).toEqual(["needs-triage"]);
	});

	it("打标签之前的回复不算(哪怕之后编辑过)", async () => {
		const repo = fakeRepo([
			{
				number: 7,
				user: reporter,
				labels: ["needs-info"],
				events: [labeled(0)],
				comments: [
					{ user: reporter, body: "打标签之前说的", created_at: at(-DAY), updated_at: at(DAY) },
				],
			},
		]);
		await sweep(repo, 4 * DAY);
		expect(repo.issue(7).state).toBe("closed");
	});

	it("PR 不管;查不到打标签时间的不关", async () => {
		const repo = fakeRepo([
			{ number: 7, user: reporter, labels: ["needs-info"], events: [labeled(0)], pull_request: {} },
			{ number: 8, user: reporter, labels: ["needs-info"], events: [] },
		]);
		await sweep(repo, 10 * DAY);
		expect(repo.issue(7).state).toBe("open");
		expect(repo.issue(8).state).toBe("open");
	});

	it("workflow_dispatch 也走清扫", async () => {
		const repo = fakeRepo([
			{ number: 7, user: reporter, labels: ["needs-info"], events: [labeled(0)] },
		]);
		await handleEvent({
			eventName: "workflow_dispatch",
			payload: {},
			api: repo.api,
			now: new Date(at(4 * DAY)),
		});
		expect(repo.issue(7).state).toBe("closed");
	});
});

/** 记下每个请求、按 URL 回话的假 fetch。 */
function fakeFetch(routes) {
	const calls = [];
	const fetch = async (url, init = {}) => {
		calls.push({ url, method: init.method ?? "GET", headers: init.headers, body: init.body });
		const route = routes.find(([match]) => url.includes(match));
		const [, status, body] = route ?? ["", 200, []];
		return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
	};
	return { fetch, calls };
}

describe("createGitHubApi", () => {
	const page = (n, size) => Array.from({ length: size }, (_, i) => ({ number: n * 1000 + i }));

	it("分页读到短页为止,带上 token 与 API 版本", async () => {
		const { fetch, calls } = fakeFetch([
			// 带上 `&`:`per_page=100` 本身就含 `page=1`。
			["&page=1", 200, page(1, 100)],
			["&page=2", 200, page(2, 3)],
		]);
		const api = createGitHubApi({ token: "t0k", repo: "o/r", fetch });
		const issues = await api.listOpenIssuesWithLabel("needs-info");
		expect(issues).toHaveLength(103);
		expect(calls).toHaveLength(2);
		expect(calls[0].url).toContain(
			"/repos/o/r/issues?state=open&labels=needs-info&per_page=100&page=1",
		);
		expect(calls[0].headers.Authorization).toBe("Bearer t0k");
		expect(calls[0].headers["X-GitHub-Api-Version"]).toBeTruthy();
	});

	it("摘一个已经不在的标签(404)不算失败", async () => {
		const { fetch } = fakeFetch([["/labels/", 404, { message: "Label does not exist" }]]);
		const api = createGitHubApi({ token: "t", repo: "o/r", fetch });
		await expect(api.removeLabel(7, "needs-triage")).resolves.toBeUndefined();
	});

	it("别的失败带着状态码和响应正文抛出来", async () => {
		const { fetch } = fakeFetch([
			["/comments", 403, { message: "Resource not accessible by integration" }],
		]);
		const api = createGitHubApi({ token: "t", repo: "o/r", fetch });
		await expect(api.comment(7, "hi")).rejects.toThrow(
			/403.*Resource not accessible by integration/,
		);
	});

	it("写操作发对方法和正文", async () => {
		const { fetch, calls } = fakeFetch([["/issues/7", 200, {}]]);
		const api = createGitHubApi({ token: "t", repo: "o/r", fetch });
		await api.update(7, { state: "closed", state_reason: "not_planned" });
		expect(calls[0].method).toBe("PATCH");
		expect(JSON.parse(calls[0].body)).toEqual({ state: "closed", state_reason: "not_planned" });
	});
});

/**
 * 接线:workflow 里跑的是 `node scripts/issue-needs-info.mjs`,事件从 Actions 注入的环境变量
 * 来。起一个本地假 GitHub(`GITHUB_API_URL` 指过去),整条链真跑一遍 —— 不碰外网。
 */
describe("命令行入口", () => {
	const SCRIPT = fileURLToPath(new URL("./issue-needs-info.mjs", import.meta.url));

	async function runScript({ eventName, payload, status = 200 }) {
		const requests = [];
		const server = createServer((req, res) => {
			let body = "";
			req.on("data", (c) => {
				body += c;
			});
			req.on("end", () => {
				requests.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
				res.writeHead(status, { "content-type": "application/json" });
				res.end(status === 200 ? "{}" : '{"message":"boom"}');
			});
		});
		await new Promise((r) => server.listen(0, "127.0.0.1", r));
		const dir = await mkdtemp(join(tmpdir(), "needs-info-"));
		const eventPath = join(dir, "event.json");
		await writeFile(eventPath, JSON.stringify(payload));
		const env = {
			...process.env,
			GITHUB_API_URL: `http://127.0.0.1:${server.address().port}`,
			GITHUB_EVENT_NAME: eventName,
			GITHUB_EVENT_PATH: eventPath,
			GITHUB_REPOSITORY: "o/r",
			GITHUB_TOKEN: "t0k",
		};
		const child = spawn(process.execPath, [SCRIPT], { env });
		let stderr = "";
		child.stderr.on("data", (c) => {
			stderr += c;
		});
		const code = await new Promise((r) => child.on("close", r));
		server.close();
		return { code, requests, stderr };
	}

	const labeledPayload = {
		action: "labeled",
		label: { name: "needs-info" },
		issue: {
			number: 7,
			state: "open",
			user: { login: "reporter" },
			labels: [{ name: "needs-info" }],
		},
	};

	it("从事件文件读 payload,带着 token 调到 GITHUB_API_URL", async () => {
		const { code, requests } = await runScript({ eventName: "issues", payload: labeledPayload });
		expect(code).toBe(0);
		const post = requests.find((r) => r.method === "POST");
		expect(post.url).toBe("/repos/o/r/issues/7/comments");
		expect(post.auth).toBe("Bearer t0k");
		expect(JSON.parse(post.body).body).toContain("@reporter");
	});

	it("GitHub 回错时以非零退出,原因进日志", async () => {
		const { code, stderr } = await runScript({
			eventName: "issues",
			payload: labeledPayload,
			status: 500,
		});
		expect(code).not.toBe(0);
		expect(stderr).toContain("500");
	});
});
