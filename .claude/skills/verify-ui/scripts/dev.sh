#!/usr/bin/env bash
# verify-ui 的确定性小活:看端口、等就绪、收摊。只认本仓(不含 .claude/worktrees/)起的进程。
#   dev.sh status        三个端口谁占着、各探针结果
#   dev.sh wait [web|desktop]   等就绪(默认 web = 后端 8787 + 面板 5173)
#   dev.sh stop          停掉本仓的 dev:apps runner 与残留的 dev 监听进程,确认端口空
set -u

REPO="$(cd "$(dirname "$0")/../../../.." && pwd)"
PORTS=(8787 5173 1421)

cwd_of() { lsof -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p'; }

ours() { # 进程 cwd 在本仓里、且不在 worktree 里
	local c
	c="$(cwd_of "$1")"
	[[ "$c" == "$REPO" || "$c" == "$REPO"/* ]] && [[ "$c" != "$REPO/.claude/worktrees"* ]]
}

holders() { lsof -nP -t -iTCP:"$1" -sTCP:LISTEN 2>/dev/null; }

code() { curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$1"; }

status() {
	for port in "${PORTS[@]}"; do
		local pids
		pids="$(holders "$port")"
		if [[ -z "$pids" ]]; then
			echo "port $port: free"
			continue
		fi
		for p in $pids; do
			local tag="foreign"
			ours "$p" && tag="this-repo"
			echo "port $port: pid $p ($tag) cwd=$(cwd_of "$p")"
		done
	done
	echo "health(127.0.0.1:8787)=$(code http://127.0.0.1:8787/api/health)"
	echo "web(localhost:5173)=$(code http://localhost:5173/)"
	echo "session=$(curl -s --max-time 3 http://localhost:5173/api/session)"
	echo "devtools(/api/dev)=$(code http://localhost:5173/api/dev)"
	echo "launcher(localhost:1421)=$(code http://localhost:1421/)"
}

wait_url() { # url, 秒数
	curl -s -o /dev/null --retry "$2" --retry-connrefused --retry-delay 1 --max-time 5 "$1" &&
		[[ "$(code "$1")" != "000" ]]
}

wait_ready() {
	case "${1:-web}" in
	web)
		wait_url http://127.0.0.1:8787/api/health 60 || { echo "后端 8787 没起来"; return 1; }
		# Vite 只监听 [::1],用 127.0.0.1 探会一直 000
		wait_url http://localhost:5173/ 60 || { echo "面板 5173 没起来"; return 1; }
		echo "ready: session=$(curl -s http://localhost:5173/api/session) /api/dev=$(code http://localhost:5173/api/dev)"
		;;
	desktop)
		wait_url http://localhost:1421/ 60 || { echo "启动页 1421 没起来"; return 1; }
		echo "ready: launcher 1421"
		;;
	*) echo "未知目标 $1"; return 2 ;;
	esac
}

wait_free() { # 等本仓进程让出给定端口,最多 $1 秒:wait_free <秒> <端口...>
	local deadline=$((SECONDS + $1)) busy p port
	shift
	while ((SECONDS < deadline)); do
		busy=0
		for port in "$@"; do
			for p in $(holders "$port"); do ours "$p" && busy=1; done
		done
		((busy == 0)) && return 0
		sleep 1
	done
	return 1
}

stop() {
	# 1) runner 收 SIGINT 会把各进程组优雅停掉(宽限 10 秒),别直接杀它:子进程组是 detached 的,会成孤儿
	local signaled=0
	for p in $(pgrep -f "scripts/dev-apps.mjs"); do
		ours "$p" && kill -INT "$p" 2>/dev/null && echo "SIGINT runner $p" && signaled=1
	done
	((signaled)) && wait_free 15 8787 5173
	# 2) 还占着端口的本仓进程(runner 被硬杀留下的孤儿、单独起的 vite)按进程组 SIGTERM
	for port in "${PORTS[@]}"; do
		for p in $(holders "$port"); do
			if ours "$p"; then
				local g
				g="$(ps -o pgid= -p "$p" | tr -d ' ')"
				kill -TERM -"$g" 2>/dev/null && echo "SIGTERM group $g (port $port)"
			fi
		done
	done
	wait_free 12 "${PORTS[@]}"
	status
}

case "${1:-status}" in
status) status ;;
wait) wait_ready "${2:-web}" ;;
stop) stop ;;
*) echo "用法: dev.sh status | wait [web|desktop] | stop"; exit 2 ;;
esac
