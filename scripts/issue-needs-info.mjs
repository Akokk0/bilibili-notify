import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * issue-needs-info —— `needs-info` 流转标签的自动化,由 .github/workflows/issue-needs-info.yml 调用。
 *
 * 流转标签(needs-triage / needs-info / ready-for-agent / ready-for-human / wontfix)每条 issue
 * 恒有且只有一个,词表见 docs/agents/triage-labels.md。`needs-info` 是「在等报告人」那一档:
 *
 * - 维护者打上它 → @报告人 说明要补信息、3 天不回会先关;顺手摘掉别的流转标签。
 * - 报告人回复 → 停表:换回 needs-triage,回到维护者的待办。维护者追问不算回复。
 * - 每天清扫一次:最近一次打上它已满 3 天、其间报告人没回的,留一句说明后按「不计划处理」
 *   关闭,needs-info 留着。
 * - 这样被关掉之后报告人又回复 → 重开并换回 needs-triage(别人关的 issue 报告人自己重开不了)。
 *
 * 不用「维护者一回复就计时」:回一句「收到，下个版本修」也会开始倒数,机器分不清是在追问还是
 * 在答应,标签才把「在等报告人」这个意图说清楚。
 *
 * 读写 GitHub 全走注入的 `api`(真实实现见 {@link createGitHubApi}),测试换成内存里的假仓库。
 */

export const NEEDS_INFO = "needs-info";
export const NEEDS_TRIAGE = "needs-triage";
const STATUS_LABELS = [NEEDS_TRIAGE, NEEDS_INFO, "ready-for-agent", "ready-for-human", "wontfix"];
const GRACE_DAYS = 3;
const DAY_MS = 24 * 60 * 60 * 1000;
/** workflow 用 GITHUB_TOKEN 写的东西都记在这个账号名下。 */
const BOT_LOGIN = "github-actions[bot]";

const labelNames = (issue) => issue.labels.map((l) => l.name);

function askMessage(author) {
	return `@${author} 这条 issue 需要你补充一些信息才能继续处理，请直接在这里回复。${GRACE_DAYS} 天内没有回复的话会先自动关闭；关闭之后补上信息再留言，会自动重新打开。`;
}

async function onLabeled({ payload, api }) {
	if (payload.label?.name !== NEEDS_INFO) return;
	const { issue } = payload;
	if (issue.state !== "open") return;
	for (const label of labelNames(issue)) {
		if (label !== NEEDS_INFO && STATUS_LABELS.includes(label))
			await api.removeLabel(issue.number, label);
	}
	await api.comment(issue.number, askMessage(issue.user.login));
}

/** 停表:needs-info 换回 needs-triage,issue 回到维护者的待办。 */
async function resume(api, number) {
	await api.removeLabel(number, NEEDS_INFO);
	await api.addLabels(number, [NEEDS_TRIAGE]);
}

async function onComment({ payload, api }) {
	const { comment } = payload;
	if (payload.issue.pull_request) return;
	// 只认报告人:维护者追问是在等他,不是他回了。
	if (comment.user.login !== payload.issue.user.login) return;
	// 事件里的 issue 不带 closed_by,判「是不是自动关的」得现取一份。
	const issue = await api.getIssue(payload.issue.number);
	if (!labelNames(issue).includes(NEEDS_INFO)) return;
	if (issue.state === "open") return resume(api, issue.number);
	// 只重开我们自己关掉的:别人关掉的 issue 报告人重开不了,自动关时那句「补上信息留言
	// 会重新打开」要兑现;维护者亲手关的不碰。
	if (issue.state_reason === "not_planned" && issue.closed_by?.login === BOT_LOGIN) {
		await api.update(issue.number, { state: "open" });
		await resume(api, issue.number);
	}
}

const CLOSE_MESSAGE = `${GRACE_DAYS} 天内没有收到补充信息，先关闭这条 issue。补上信息后直接在这里留言，会自动重新打开。`;

/** 最近一次打上 needs-info 的时刻;查不到返回 null。 */
function lastLabeledAt(events) {
	const times = events
		.filter((e) => e.event === "labeled" && e.label?.name === NEEDS_INFO)
		.map((e) => Date.parse(e.created_at));
	return times.length > 0 ? Math.max(...times) : null;
}

async function sweep({ api, now }) {
	for (const issue of await api.listOpenIssuesWithLabel(NEEDS_INFO)) {
		if (issue.pull_request) continue;
		const labeledAt = lastLabeledAt(await api.listEvents(issue.number));
		// 查不到什么时候打的就不关:宁可多挂一天,不误关。
		if (labeledAt === null) continue;
		const author = issue.user.login;
		const comments = await api.listComments(issue.number, {
			since: new Date(labeledAt).toISOString(),
		});
		// 报告人回过而标签还在,说明那次评论事件没跑成 —— 补一次停表,别把回了话的人关掉。
		if (comments.some((c) => c.user.login === author && Date.parse(c.created_at) > labeledAt)) {
			await resume(api, issue.number);
			continue;
		}
		if (now.getTime() - labeledAt < GRACE_DAYS * DAY_MS) continue;
		await api.comment(issue.number, CLOSE_MESSAGE);
		await api.update(issue.number, { state: "closed", state_reason: "not_planned" });
	}
}

/**
 * 按 GitHub 事件分派:打标签、评论两种事件即时处理,定时 / 手动触发走清扫。
 * `now` 可注入,供测试固定时间。
 */
export async function handleEvent({ eventName, payload, api, now = new Date() }) {
	if (eventName === "issues" && payload.action === "labeled") return onLabeled({ payload, api });
	if (eventName === "issue_comment" && payload.action === "created")
		return onComment({ payload, api });
	if (eventName === "schedule" || eventName === "workflow_dispatch") return sweep({ api, now });
}

/**
 * GitHub REST 的最小客户端,方法与 {@link handleEvent} 用到的一一对应。`apiRoot` 取 Actions 注入的
 * `GITHUB_API_URL`(测试借它指向本地假服务);`fetch` 可注入供测试。
 * 失败一律带着状态码和响应正文抛出(workflow 日志里要看得出为什么);只有摘一个已经不在的
 * 标签(404)算成功 —— 那正是想要的结果。
 */
export function createGitHubApi({
	token,
	repo,
	apiRoot = "https://api.github.com",
	fetch = globalThis.fetch,
}) {
	const headers = {
		Accept: "application/vnd.github+json",
		Authorization: `Bearer ${token}`,
		"X-GitHub-Api-Version": "2022-11-28",
	};
	async function request(method, path, body, { allow404 = false } = {}) {
		const res = await fetch(`${apiRoot}/repos/${repo}${path}`, {
			method,
			headers,
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
		if (allow404 && res.status === 404) return undefined;
		const text = await res.text();
		if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text}`);
		return text ? JSON.parse(text) : undefined;
	}
	async function paginate(path) {
		const sep = path.includes("?") ? "&" : "?";
		const all = [];
		for (let page = 1; ; page++) {
			const batch = await request("GET", `${path}${sep}per_page=100&page=${page}`);
			all.push(...batch);
			if (batch.length < 100) return all;
		}
	}
	return {
		getIssue: (n) => request("GET", `/issues/${n}`),
		listOpenIssuesWithLabel: (label) =>
			paginate(`/issues?state=open&labels=${encodeURIComponent(label)}`),
		listEvents: (n) => paginate(`/issues/${n}/events`),
		listComments: (n, { since }) =>
			paginate(`/issues/${n}/comments?since=${encodeURIComponent(since)}`),
		comment: async (n, body) => {
			await request("POST", `/issues/${n}/comments`, { body });
		},
		addLabels: async (n, labels) => {
			await request("POST", `/issues/${n}/labels`, { labels });
		},
		removeLabel: async (n, label) => {
			await request("DELETE", `/issues/${n}/labels/${encodeURIComponent(label)}`, undefined, {
				allow404: true,
			});
		},
		update: async (n, patch) => {
			await request("PATCH", `/issues/${n}`, patch);
		},
	};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const { GITHUB_API_URL, GITHUB_EVENT_NAME, GITHUB_EVENT_PATH, GITHUB_REPOSITORY, GITHUB_TOKEN } =
		process.env;
	const payload = GITHUB_EVENT_PATH ? JSON.parse(await readFile(GITHUB_EVENT_PATH, "utf8")) : {};
	const api = createGitHubApi({
		token: GITHUB_TOKEN,
		repo: GITHUB_REPOSITORY,
		apiRoot: GITHUB_API_URL,
	});
	await handleEvent({ eventName: GITHUB_EVENT_NAME, payload, api });
}
