/** @jsxImportSource vue */
import type { GuardLevel } from "blive-message-listener";

export type GuardCardProps = {
	captainImgUrl: string;
	guardLevel: GuardLevel;
	uname: string;
	face: string;
	isAdmin: number;
	masterAvatarUrl: string;
	masterName: string;
	bgColor: [string, string];
};

const GUARD_DESC: Record<GuardLevel, (uname: string, masterName: string) => string> = {
	0: () => "",
	1: (uname, masterName) => `"${uname}"上任\n"${masterName}"大航海舰队总督！`,
	2: (uname, masterName) => `"${uname}"就任\n"${masterName}"大航海舰队提督！`,
	3: (uname, masterName) => `"${uname}号"加入\n"${masterName}"大航海舰队！`,
};

export function GuardCard(p: GuardCardProps) {
	const desc = GUARD_DESC[p.guardLevel]?.(p.uname, p.masterName) ?? "";

	return (
		<div
			class="flex justify-center items-center w-[430px] h-[220px]"
			style={{ background: `linear-gradient(to right bottom, ${p.bgColor[0]}, ${p.bgColor[1]})` }}
		>
			<div class="flex justify-between items-center w-[410px] h-[200px] rounded-[10px] shadow-[0_4px_8px_0_rgba(0,0,0,0.2)] bg-white/75 backdrop-blur-[10px]">
				{/* 左侧信息区 */}
				<div class="flex-1 h-full flex flex-col justify-between py-[10px] pl-[10px]">
					{/* 用户信息 */}
					<div class="flex gap-[10px]">
						{/* 头像 */}
						<div class="w-[90px] h-[90px] overflow-hidden rounded-full shrink-0">
							<img class="w-full h-full rounded-full object-cover" src={p.face} alt="用户头像" />
						</div>

						{/* 名称徽章 */}
						<div class="flex flex-col items-start gap-[7px] mt-[10px]">
							<div
								class="flex items-center h-[30px] rounded-[25px] px-[10px] overflow-hidden"
								style={{ backgroundColor: p.bgColor[0] }}
							>
								<span class="max-w-[100px] truncate font-bold text-[12px] text-white">
									{p.uname}
								</span>
							</div>

							<div
								class="flex gap-[5px] items-center h-[25px] rounded-[25px] overflow-hidden"
								style={{ backgroundColor: p.bgColor[0] }}
							>
								<div
									class="w-[25px] h-[25px] rounded-full bg-cover bg-center shrink-0"
									style={{ backgroundImage: `url("${p.masterAvatarUrl}")` }}
								/>
								<span class="max-w-[85px] truncate text-white text-[10px] font-bold mr-[5px]">
									{p.isAdmin ? "房管" : p.masterName}
								</span>
							</div>
						</div>
					</div>

					{/* 描述文字 */}
					<div
						class="mb-[10px] text-[16px] font-bold italic whitespace-pre-line"
						style={{ color: p.bgColor[0] }}
					>
						{desc}
					</div>
				</div>

				{/* 舰长图片 */}
				<div
					class="w-[175px] h-[175px] bg-cover bg-center shrink-0"
					style={{ backgroundImage: `url("${p.captainImgUrl}")` }}
				/>
			</div>
		</div>
	);
}
