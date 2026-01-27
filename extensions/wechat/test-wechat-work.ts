/**
 * 企业微信 API 快速测试
 * 运行: npx tsx test-wechat-work.ts
 * 
 * 使用前请设置环境变量:
 *   export WECHAT_CORP_ID=your_corp_id
 *   export WECHAT_AGENT_ID=your_agent_id
 *   export WECHAT_SECRET=your_secret
 */

const CORP_ID = process.env.WECHAT_CORP_ID || "YOUR_CORP_ID";
const AGENT_ID = process.env.WECHAT_AGENT_ID || "YOUR_AGENT_ID";
const SECRET = process.env.WECHAT_SECRET || "YOUR_SECRET";

if (CORP_ID === "YOUR_CORP_ID" || SECRET === "YOUR_SECRET") {
  console.error("Error: Please set WECHAT_CORP_ID, WECHAT_AGENT_ID, and WECHAT_SECRET environment variables");
  process.exit(1);
}

const API_BASE = "https://qyapi.weixin.qq.com/cgi-bin";

async function getAccessToken(): Promise<string> {
  const url = `${API_BASE}/gettoken?corpid=${CORP_ID}&corpsecret=${SECRET}`;
  console.log("Getting access token...");

  const response = await fetch(url);
  const data = (await response.json()) as {
    errcode?: number;
    errmsg?: string;
    access_token?: string;
    expires_in?: number;
  };

  console.log("Response:", JSON.stringify(data, null, 2));

  if (data.errcode && data.errcode !== 0) {
    throw new Error(`Error: ${data.errmsg} (code: ${data.errcode})`);
  }

  return data.access_token!;
}

async function sendMessage(token: string, toUser: string, content: string) {
  const url = `${API_BASE}/message/send?access_token=${token}`;

  const body = {
    touser: toUser,
    msgtype: "text",
    agentid: Number.parseInt(AGENT_ID, 10),
    text: { content },
  };

  console.log(`\nSending message to ${toUser}...`);
  console.log("Body:", JSON.stringify(body, null, 2));

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const data = (await response.json()) as {
    errcode?: number;
    errmsg?: string;
    msgid?: string;
  };

  console.log("Response:", JSON.stringify(data, null, 2));
  return data;
}

async function main() {
  try {
    const token = await getAccessToken();
    console.log("\n✅ Access token obtained successfully!\n");

    // Test sending a message
    const testUser = process.argv[2] || "HuangXiaoMing";
    const testMessage = process.argv[3] || "Hello from test script!";

    await sendMessage(token, testUser, testMessage);
    console.log("\n✅ Message sent successfully!");
  } catch (error) {
    console.error("\n❌ Error:", error);
    process.exit(1);
  }
}

main();
