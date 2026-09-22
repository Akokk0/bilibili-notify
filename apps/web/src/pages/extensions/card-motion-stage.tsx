/**
 * 拓展页上演动画的那一处 —— 照 `card-motion.ts` 那一格画:装完的传送、更新完的换装。
 *
 * 谁放进来的都一样(装拓展那个 hook、devtools 的「播放 × 动画」),演完只收自己那一段。
 */

import { useEffect } from "react";
import { useCardMotionStore } from "./card-motion";
import { InstallFlight } from "./install-flight";
import { UpdateFlight } from "./update-flight";

export function CardMotionStage() {
	const motion = useCardMotionStore((state) => state.motion);
	const clear = useCardMotionStore((state) => state.clear);
	const done = () => {
		if (motion) clear(motion);
	};
	/*
	 * 页面被拆(切走)时,那一格里**当时那一段**跟着收掉。两段动画演到一半被拆都不说演完了,
	 * 而那一格是模块级的、页面拆了它还在:不收的话回到拓展页就从头再演一遍 —— 换装的结果
	 * 早就落定了,演出来的是一段假的「蓄 → 落」。拆的那一刻去读,而不是用这一帧画的那段:
	 * 刚放进来、还没来得及画的那一段也在「当时」里。
	 */
	useEffect(
		() => () => {
			const current = useCardMotionStore.getState().motion;
			if (current) clear(current);
		},
		[clear],
	);
	return (
		<>
			<InstallFlight flight={motion?.kind === "install" ? motion : null} onDone={done} />
			<UpdateFlight motion={motion?.kind === "update" ? motion : null} onDone={done} />
		</>
	);
}
