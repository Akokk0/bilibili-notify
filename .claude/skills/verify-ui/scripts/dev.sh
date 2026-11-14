#!/usr/bin/env bash
# verify-ui 的确定性小活:看端口、等就绪、收摊。只认本仓(不含 .claude/worktrees/)起的进程。
#   dev.sh status        三个端口谁占着、各探针结果
#   dev.sh wait [web|desktop] [秒数]   等 2xx 就绪(每个探针默认最多 60 秒)
#   dev.sh stop          停掉本仓的 dev:apps runner 与残留的 dev 监听进程,确认端口空
set -u

REPO="$(cd "$(dirname "$0")/../../../.." && pwd)"
PORTS=(8787 5173 1421)

cwd_of() {
	local output lsof_exit cwd
	output="$(lsof -a -p "$1" -d cwd -Fn 2>&1)"
	lsof_exit=$?
	cwd="$(printf '%s\n' "$output" | sed -n 's/^n//p')"
	if ((lsof_exit == 0)) && [[ -n "$cwd" ]]; then
		printf '%s\n' "$cwd"
		return 0
	fi
	printf 'pid %s: cwd probe failed (lsof exit %s): %s\n' "$1" "$lsof_exit" "$output" >&2
	return 2
}

is_repo_cwd() {
	[[ "$1" == "$REPO" || "$1" == "$REPO"/* ]] && [[ "$1" != "$REPO/.claude/worktrees"* ]]
}

ours() { # 进程 cwd 在本仓里、且不在 worktree 里
	local c
	c="$(cwd_of "$1")" || return 2
	is_repo_cwd "$c"
}

probe_pids() { # 说明, 查询命令及参数；lsof / pgrep 无匹配均为退出 1 且无输出
	local label="$1" output probe_exit pid_lines='^[0-9]+([[:space:]][0-9]+)*$'
	shift
	output="$("$@" 2>&1)"
	probe_exit=$?
	# 带诊断、缺工具或部分结果均不能证明没有进程。
	((probe_exit == 1)) && [[ -z "$output" ]] && return 0
	if ((probe_exit == 0)) && [[ "$output" =~ $pid_lines ]]; then
		printf '%s\n' "$output"
		return 0
	fi
	printf '%s: probe failed (%s exit %s): %s\n' "$label" "$1" "$probe_exit" "$output" >&2
	return 2
}

holders() { probe_pids "port $1" lsof -nP -t -iTCP:"$1" -sTCP:LISTEN; }

code() { curl -s -o /dev/null -w '%{http_code}' --max-time "${2:-3}" "$1"; }

status() {
	local failed=0
	for port in "${PORTS[@]}"; do
		local pids
		if ! pids="$(holders "$port")"; then
			echo "port $port: unknown"
			failed=1
			continue
		fi
		if [[ -z "$pids" ]]; then
			echo "port $port: free"
			continue
		fi
		for p in $pids; do
			local tag="foreign" cwd
			if ! cwd="$(cwd_of "$p")"; then
				echo "port $port: pid $p (unknown)"
				failed=1
				continue
			fi
			is_repo_cwd "$cwd" && tag="this-repo"
			echo "port $port: pid $p ($tag) cwd=$cwd"
		done
	done
	echo "health(127.0.0.1:8787)=$(code http://127.0.0.1:8787/api/health)"
	echo "web(localhost:5173)=$(code http://localhost:5173/)"
	echo "session=$(curl -s --max-time 3 http://localhost:5173/api/session)"
	echo "devtools(/api/dev)=$(code http://localhost:5173/api/dev)"
	echo "launcher(localhost:1421)=$(code http://localhost:1421/)"
	return "$failed"
}

wait_url() { # url, 秒数
	local deadline=$((SECONDS + $2)) remaining request_timeout http_code=000 curl_exit=0
	while ((SECONDS < deadline)); do
		remaining=$((deadline - SECONDS))
		request_timeout=$remaining
		((request_timeout > 5)) && request_timeout=5
		http_code="$(code "$1" "$request_timeout")"
		curl_exit=$?
		((curl_exit == 0)) && [[ "$http_code" == 2[0-9][0-9] ]] && return 0
		((SECONDS >= deadline || curl_exit == 127)) && break
		sleep 1
	done
	printf '等待超时: %s (HTTP %s, curl exit %s)\n' "$1" "$http_code" "$curl_exit" >&2
	return 1
}

wait_ready() {
	local timeout_sec="${2:-60}"
	[[ "$timeout_sec" =~ ^[1-9][0-9]*$ ]] || { echo "等待秒数须为正整数" >&2; return 2; }
	case "${1:-web}" in
	web)
		wait_url http://127.0.0.1:8787/api/health "$timeout_sec" || { echo "后端 8787 没起来"; return 1; }
		# Vite 只监听 [::1],用 127.0.0.1 探会一直 000
		wait_url http://localhost:5173/ "$timeout_sec" || { echo "面板 5173 没起来"; return 1; }
		echo "ready: session=$(curl -s --max-time 3 http://localhost:5173/api/session) /api/dev=$(code http://localhost:5173/api/dev)"
		;;
	desktop)
		wait_url http://localhost:1421/ "$timeout_sec" || { echo "启动页 1421 没起来"; return 1; }
		echo "ready: launcher 1421"
		;;
	*) echo "未知目标 $1"; return 2 ;;
	esac
}

wait_free() { # 等本仓进程让出给定端口,最多 $1 秒:wait_free <秒> <端口...>
	local deadline=$((SECONDS + $1)) busy p port pids probe_exit
	shift
	while ((SECONDS < deadline)); do
		busy=0
		for port in "$@"; do
			pids="$(holders "$port")" || return 2
			for p in $pids; do
				ours "$p"
				probe_exit=$?
				((probe_exit == 2)) && return 2
				((probe_exit == 0)) && busy=1
			done
		done
		((busy == 0)) && return 0
		sleep 1
	done
	return 1
}

stop() {
	local pids failed=0 probe_exit
	# 探测不可用时先退出，不能把空结果当成「可收尾」后继续发信号。
	for port in "${PORTS[@]}"; do
		pids="$(holders "$port")" || return 1
		for p in $pids; do
			ours "$p"
			(( $? == 2 )) && return 1
		done
	done
	# 1) runner 收 SIGINT 会把各进程组优雅停掉(宽限 10 秒),别直接杀它:子进程组是 detached 的,会成孤儿
	local signaled=0
	pids="$(probe_pids 'dev runner' pgrep -f 'scripts/dev-apps.mjs')" || return 1
	for p in $pids; do
		ours "$p"
		probe_exit=$?
		((probe_exit == 2)) && return 1
		((probe_exit == 0)) && kill -INT "$p" 2>/dev/null && echo "SIGINT runner $p" && signaled=1
	done
	if ((signaled)); then
		wait_free 15 8787 5173
		probe_exit=$?
		((probe_exit == 2)) && return 1
	fi
	# 2) 还占着端口的本仓进程(runner 被硬杀留下的孤儿、单独起的 vite)按进程组 SIGTERM
	for port in "${PORTS[@]}"; do
		pids="$(holders "$port")" || return 1
		for p in $pids; do
			ours "$p"
			probe_exit=$?
			((probe_exit == 2)) && return 1
			if ((probe_exit == 0)); then
				local g
				g="$(ps -o pgid= -p "$p" | tr -d ' ')"
				kill -TERM -"$g" 2>/dev/null && echo "SIGTERM group $g (port $port)"
			fi
		done
	done
	wait_free 12 "${PORTS[@]}" || { echo "未能确认本仓开发进程已停止" >&2; failed=1; }
	status || failed=1
	return "$failed"
}

case "${1:-status}" in
status) status ;;
wait) wait_ready "${2:-web}" "${3:-60}" ;;
stop) stop ;;
*) echo "用法: dev.sh status | wait [web|desktop] [秒数] | stop"; exit 2 ;;
esac
