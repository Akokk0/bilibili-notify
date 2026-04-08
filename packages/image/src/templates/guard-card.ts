import { GuardLevel } from "blive-message-listener";
import { CSS_AVATAR, CSS_FROSTED_CARD, cssGradientBg, cssReset } from "../styles";

export type GuardCardParams = {
	font: string;
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
	[GuardLevel.None]: () => "",
	[GuardLevel.Jianzhang]: (uname, masterName) => `"${uname}号"加入<br/>"${masterName}"大航海舰队！`,
	[GuardLevel.Tidu]: (uname, masterName) => `"${uname}"就任<br/>"${masterName}"大航海舰队提督！`,
	[GuardLevel.Zongdu]: (uname, masterName) => `"${uname}"上任<br/>"${masterName}"大航海舰队总督！`,
};

export function buildGuardCardHtml(p: GuardCardParams): string {
	const desc = GUARD_DESC[p.guardLevel]?.(p.uname, p.masterName) ?? "";

	return /* html */ `
        <!DOCTYPE html>
        <html>
        <head>
            <title>上舰通知</title>
            <style>
                ${cssReset(p.font)}

                html {
                    width: 430px;
                    height: auto;
                }

                .background {
                    display: flex;
                    justify-content: center;
                    align-items: center;
                    width: 430px;
                    height: 220px;
                    ${cssGradientBg(p.bgColor[0], p.bgColor[1], "0")}
                }

                .card {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    width: 410px;
                    height: 200px;
                    padding: 0;
                    ${CSS_FROSTED_CARD}
                }

                .info {
                    flex: 1;
                    height: 100%;
                    display: flex;
                    flex-direction: column;
                    justify-content: space-between;
                    padding: 10px 0 10px 10px;
                }

                .user {
                    display: flex;
                    gap: 10px;
                }

                .avatar {
                    height: 90px;
                    width: 90px;
                    overflow: hidden;
                    ${CSS_AVATAR}
                }

                .avatar img {
                    width: 100%;
                    height: 100%;
                    border-radius: 50%;
                }

                .user-info {
                    display: flex;
                    flex-direction: column;
                    align-items: flex-start;
                    gap: 7px;
                    margin-top: 10px;
                }

                .name-badge {
                    display: flex;
                    align-items: center;
                    height: 30px;
                    background-color: ${p.bgColor[0]};
                    border-radius: 25px;
                    color: white;
                    padding: 0 10px;
                    border: solid 2px white;
                    overflow: hidden;
                }

                .name-badge span {
                    max-width: 100px;
                    white-space: nowrap;
                    text-overflow: ellipsis;
                    overflow: hidden;
                    font-weight: bold;
                    font-size: 12px;
                }

                .accompany {
                    display: flex;
                    gap: 5px;
                    align-items: center;
                    height: 25px;
                    background-color: ${p.bgColor[0]};
                    border-radius: 25px;
                    border: solid 2px white;
                    overflow: hidden;
                }

                .master-avatar {
                    width: 25px;
                    height: 25px;
                    border-radius: 50%;
                    background: url("${p.masterAvatarUrl}") no-repeat center;
                    background-size: cover;
                }

                .accompany span {
                    max-width: 85px;
                    white-space: nowrap;
                    text-overflow: ellipsis;
                    overflow: hidden;
                    color: white;
                    font-size: 10px;
                    font-weight: bold;
                    margin-right: 5px;
                }

                .desc {
                    margin-bottom: 10px;
                    font-size: 16px;
                    font-weight: bold;
                    font-style: italic;
                    color: #333;
                }

                .captain {
                    width: 175px;
                    height: 175px;
                    background: url("${p.captainImgUrl}") no-repeat center;
                    background-size: cover;
                }
            </style>
        </head>
        <body>
            <div class="background">
                <div class="card">
                    <div class="info">
                        <div class="user">
                            <div class="avatar">
                                <img src="${p.face}" alt="用户头像">
                            </div>
                            <div class="user-info">
                                <div class="name-badge">
                                    <span>${p.uname}</span>
                                </div>
                                <div class="accompany">
                                    <div class="master-avatar"></div>
                                    <span>${p.isAdmin ? "房管" : p.masterName}</span>
                                </div>
                            </div>
                        </div>
                        <div class="desc">${desc}</div>
                    </div>
                    <div class="captain"></div>
                </div>
            </div>
        </body>
        </html>
    `;
}
