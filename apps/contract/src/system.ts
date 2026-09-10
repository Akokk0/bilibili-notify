/**
 * 系统级动作。现在只有一件:**重启服务端**。
 *
 * 重启 = 优雅停机 + 退 0,等**外面那位**把它拉起来(与应用更新走的是同一条路)。所以
 * 「能不能重启」问的其实是「外面有没有那位」—— 面板据此决定给不给按钮。给了却没人拉,
 * 用户按下去就是把 BN 关了,而界面上只会显示连不上。
 *
 * ⛔ **不做成一颗常驻按钮**:重启是某个动作的后果,只在刚做完需要它的那件事之后就地提示
 * 一次。所以这份判据**跟着那件事的回话走**,没有只读口。
 */

/** 谁把退出的服务端拉起来 —— 答案决定了按钮出不出,以及旁边那句话怎么写。 */
export type RestartAbility =
	| {
			can: true;
			/**
			 * - `desktop` —— 桌面外壳:它盯着 sidecar,见退出码 0 就重新拉起,一定回得来。
			 * - `container` —— 容器的 `restart:` 策略。**没配的话没人拉**,所以文案要提这一句。
			 */
			how: "desktop" | "container";
	  }
	| {
			can: false;
			/**
			 * - `source-run` —— tsx 直跑的开发版:`tsx watch` 只在文件变了才重来,自己退了就是退了。
			 * - `unsupervised` —— 直接 `node lib/index.mjs`:退了没人管。
			 */
			reason: "source-run" | "unsupervised";
	  };

/** `POST /api/system/restart` 的回话。**先回话再关自己**,否则用户看到的是网络错误。 */
export interface RestartResponse {
	restarting: true;
	/** 要换掉的那个进程的启动时刻(与 `/api/health` 同一个值)—— 它变了才算真的重启完。 */
	startedAt: string;
	/** 现在跑的版本。重启后 `boot.mjs` 会重新选版,面板拿它当「该回到哪一版」的期望。 */
	version: string;
}
