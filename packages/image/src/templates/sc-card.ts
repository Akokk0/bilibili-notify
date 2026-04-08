import { CSS_AVATAR, CSS_FROSTED_CARD, cssGradientBg, cssReset } from "../styles";

export type SCCardParams = {
	font: string;
	senderFace: string;
	senderName: string;
	masterName: string;
	masterAvatarUrl?: string;
	text: string;
	price: number;
	duration: string;
	bgColor: readonly [string, string];
};

export function buildSCCardHtml(p: SCCardParams): string {
	const escapedText = p.text
		?.trim()
		?.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/\n/g, "<br>");

	return /* html */ `
        <!DOCTYPE html>
        <html>
        <head>
            <title>醒目留言通知</title>
            <style>
                ${cssReset(p.font)}

                html {
                    width: 280px;
                    height: auto;
                }

                .background {
                    display: flex;
                    justify-content: center;
                    align-items: center;
                    width: 280px;
                    height: auto;
                    ${cssGradientBg(p.bgColor[0], p.bgColor[1], "15px 0")}
                }

                .card {
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    width: 260px;
                    height: auto;
                    padding: 20px 15px;
                    ${CSS_FROSTED_CARD}
                }

                .price-section {
                    text-align: center;
                    margin-bottom: 15px;
                }

                .price-amount {
                    font-size: 36px;
                    font-weight: bold;
                    background: linear-gradient(135deg, ${p.bgColor[0]}, ${p.bgColor[1]});
                    -webkit-background-clip: text;
                    -webkit-text-fill-color: transparent;
                    background-clip: text;
                }

                .duration-badge {
                    display: inline-flex;
                    align-items: center;
                    gap: 4px;
                    margin-top: 5px;
                    padding: 4px 10px;
                    background-color: ${p.bgColor[0]};
                    border-radius: 12px;
                    color: white;
                    font-size: 12px;
                    font-weight: bold;
                    border: solid 2px white;
                }

                .divider {
                    width: 100%;
                    height: 1px;
                    background: linear-gradient(to right, transparent, ${p.bgColor[0]}, transparent);
                    margin: 12px 0;
                }

                .avatar-section {
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    gap: 8px;
                    margin-bottom: 12px;
                }

                .avatar {
                    width: 70px;
                    height: 70px;
                    overflow: hidden;
                    ${CSS_AVATAR}
                }

                .avatar img {
                    width: 100%;
                    height: 100%;
                    border-radius: 50%;
                }

                .name-badge {
                    padding: 5px 14px;
                    background-color: ${p.bgColor[0]};
                    border-radius: 15px;
                    color: white;
                    font-weight: bold;
                    font-size: 14px;
                    border: solid 2px white;
                }

                .target-info {
                    display: flex;
                    align-items: center;
                    gap: 5px;
                    font-size: 12px;
                    color: #666;
                }

                .target-info span:first-child {
                    margin-right: 3px;
                }

                .target-group {
                    display: flex;
                    align-items: center;
                    gap: 2px;
                }

                .target-avatar {
                    width: 18px;
                    height: 18px;
                    border-radius: 50%;
                    background: url("${p.masterAvatarUrl || ""}") no-repeat center;
                    background-size: cover;
                    border: 1px solid rgba(0, 0, 0, 0.1);
                }

                .content-section {
                    width: 100%;
                    text-align: center;
                }

                .content {
                    padding: 10px 12px;
                    background-color: rgba(255, 255, 255, 0.5);
                    border-radius: 8px;
                }

                .content-text {
                    font-size: 13px;
                    color: #333;
                    line-height: 1.6;
                    word-wrap: break-word;
                    white-space: pre-wrap;
                }

                .empty-text {
                    font-size: 13px;
                    color: #999;
                    font-style: italic;
                }
            </style>
        </head>
        <body>
            <div class="background">
                <div class="card">
                    <div class="price-section">
                        <div class="price-amount">¥${p.price}</div>
                        <div class="duration-badge">
                            <span>⏱</span>
                            <span>${p.duration}</span>
                        </div>
                    </div>
                    <div class="divider"></div>
                    <div class="avatar-section">
                        <div class="avatar">
                            <img src="${p.senderFace}" alt="发送者头像">
                        </div>
                        <div class="name-badge">${p.senderName}</div>
                        <div class="target-info">
                            <span>SC to</span>
                            <div class="target-group">
                                ${p.masterAvatarUrl ? '<div class="target-avatar"></div>' : ""}
                                <span>${p.masterName}</span>
                            </div>
                        </div>
                    </div>
                    ${
											escapedText
												? `
                    <div class="content-section">
                        <div class="content">
                            <div class="content-text">${escapedText}</div>
                        </div>
                    </div>
                    `
												: ""
										}
                </div>
            </div>
        </body>
        </html>
    `;
}
