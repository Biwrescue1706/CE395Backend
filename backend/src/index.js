// @ts-nocheck
// src/index.js
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc");
const timezone = require("dayjs/plugin/timezone");
const { PrismaClient } = require("@prisma/client");
const axios = require("axios");
const OpenAI = require("openai");     

// ----- Init libs -----
dayjs.extend(utc);
dayjs.extend(timezone);
axios.default.timeout = 15000;

const app = express();
const prisma = new PrismaClient();
const PORT = Number(process.env.PORT) || 10000;
const NODE_ENV = process.env.NODE_ENV || "development";
const LINE_ACCESS_TOKEN = process.env.LINE_ACCESS_TOKEN || "";

// OpenAI client
// @ts-ignore
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || "" });

app.use(cors());
app.use(express.json());

// ===== In-memory sensor cache =====
let lastSensorData = null; // { light, temp, humidity }

// ===== Utils =====
function cleanAIResponse(text = "") {
  return String(text)
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<[^>]+>/g, "")
    .trim();
}

function getLightStatus(light) {
  if (light > 50000) return "สว่างจัดมาก ☀️";
  if (light > 10000) return "สว่างมาก🌤";
  if (light > 5000) return "สว่างปานกลาง 🌥";
  if (light > 1000) return "ค่อนข้างสว่าง 🌈";
  if (light > 500) return "แสงพอใช้";
  if (light > 100) return "แสงน้อย🌙";
  if (light > 10) return "มืดสลัว 🌑";
  return "มืดมากๆ 🕳️";
}

function getTempStatus(temp) {
  if (temp > 35) return "อุณหภูมิร้อนมาก ⚠️";
  if (temp >= 30) return "อุณหภูมิร้อน 🔥";
  if (temp >= 25) return "อุณหภูมิอุ่นๆ 🌞";
  if (temp >= 20) return "อุณหภูมิพอดี 🌤";
  return "อุณหูมิเย็น ❄️";
}

function getHumidityStatus(humidity) {
  if (humidity > 85) return "ชื้นมาก อากาศอึดอัด 🌧️";
  if (humidity > 70) return "อากาศชื้น เหนียวตัว 💦";
  if (humidity > 60) return "เริ่มชื้น 🌫️";
  if (humidity > 40) return "อากาศสบาย ✅";
  if (humidity > 30) return "ค่อนข้างแห้ง 💨";
  if (humidity > 20) return "แห้งมาก 🥵";
  return "อากาศแห้งมาก 🏜️";
}

// ===== AI Helpers =====
async function askOpenAI(prompt, light, temp, humidity) {
  if (!process.env.OPENAI_API_KEY) return "❌ ยังไม่ได้ตั้งค่า OPENAI_API_KEY";
  const resp = await openai.responses.create({
    model: "gpt-4o-mini",
    input: prompt,
    store: false,
  });
  return resp.output_text ?? "ไม่มีข้อความตอบกลับ";
}

async function answerWithSensorAI(question, light, temp, humidity) {
  const prompt = `
ข้อมูลเซ็นเซอร์:
- ค่าแสง: ${light} lux
- อุณหภูมิ: ${temp} °C
- ความชื้น: ${humidity} %
คำถาม: "${question}"
โปรดตอบเป็นภาษาไทยแบบสั้น กระชับ ชัดเจน
  `.trim();
  return askOpenAI(prompt);
}

// ===== LINE Reply =====
async function replyToUser(replyToken, message) {
  try {
    const trimmedMessage =
      message.length > 1000 ? message.slice(0, 1000) + "\n...(ตัดข้อความ)" : message;
    // @ts-ignore
    await axios.post(
      "https://api.line.me/v2/bot/message/reply",
      {
        replyToken,
        messages: [{ type: "text", text: trimmedMessage }],
      },
      {
        headers: {
          Authorization: `Bearer ${LINE_ACCESS_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );
  } catch (err) {
    console.error("❌ LINE reply error:", err?.response?.data || err?.message);
  }
}

async function deletePendingReply(id) {
  try {
    await prisma.pendingReply.delete({ where: { id } });
  } catch (err) {
    console.error("❌ ลบ PendingReply ไม่สำเร็จ:", err?.response?.data || err?.message);
  }
}

// ===== Webhook =====
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  const events = req.body.events || [];
  for (const event of events) {
    if (event?.type === "message" && event?.replyToken && event?.source?.userId) {
      processMessageEvent(event).catch(console.error);
    }
  }
});

async function processMessageEvent(event) {
  const userId = event?.source?.userId;
  const replyToken = event?.replyToken;
  const messageType = event?.message?.type || "unknown";
  const text = messageType === "text" ? event.message.text.trim() : "";

  const existingUser = await prisma.user.findUnique({ where: { userId } });
  if (!existingUser) await prisma.user.create({ data: { userId } });

  const exists = await prisma.pendingReply.findUnique({ where: { replyToken } });
  if (exists) return;

  const created = await prisma.pendingReply.create({
    data: { replyToken, userId, messageType, text: text || "(ไม่มีข้อความ)" },
  });

  if (!lastSensorData) {
    await replyToUser(replyToken, "❌ ยังไม่มีข้อมูลจากเซ็นเซอร์");
    await deletePendingReply(created.id);
    return;
  }

  const { light, temp, humidity } = lastSensorData;
  const lightStatus = getLightStatus(light);
  const tempStatus = getTempStatus(temp);
  const humidityStatus = getHumidityStatus(humidity);

  const shortMsg = `📊 สภาพอากาศล่าสุด :
- ค่าแสง: ${light} lux (${lightStatus})
- อุณหภูมิ: ${temp} °C (${tempStatus})
- ความชื้น: ${humidity} % (${humidityStatus})`;

  const presetQuestions = [
    "สภาพอากาศตอนนี้เป็นอย่างไร",
    "ตอนนี้ควรตากผ้าไหม",
    "ตอนนี้ควรพกร่มออกจากบ้านไหม",
    "ความเข้มของแสงตอนนี้เป็นอย่างไร",
    "ความชื้นตอนนี้เป็นอย่างไร",
  ];

  const normalizedText = text.replace(/\s+/g, " ").trim();
  if (!presetQuestions.includes(normalizedText)) {
    await replyToUser(replyToken, shortMsg);
    await deletePendingReply(created.id);
    return;
  }

  await replyToUser(replyToken, "⏳ กำลังถาม AI...");

  const aiText = await askOpenAI(normalizedText, light, temp, humidity);
  if (!aiText || aiText.trim() === "") {
    await replyToUser(replyToken, "❌ คำตอบจาก AI ว่างเปล่า ไม่สามารถส่งข้อความได้");
    await deletePendingReply(created.id);
    return;
  }

  const answer = `${normalizedText}?\n- คำตอบ จาก AI : ${aiText.trim()}`;

  await axios.post(
    "https://api.line.me/v2/bot/message/push",
    { to: userId, messages: [{ type: "text", text: answer }] },
    {
      headers: {
        Authorization: `Bearer ${LINE_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
    }
  );

  await deletePendingReply(created.id);
}

// ===== Sensor Data =====
app.post("/sensor-data", (req, res) => {
  const { light, temp, humidity } = req.body || {};
  if (light !== undefined && temp !== undefined && humidity !== undefined) {
    lastSensorData = { light, temp, humidity };
    res.json({ message: "✅ รับข้อมูลแล้ว" });
  } else {
    res.status(400).json({ message: "❌ ข้อมูลไม่ครบ" });
  }
});

// ===== Latest Sensor =====
app.get("/latest", (req, res) => {
  if (lastSensorData) res.json(lastSensorData);
  else res.status(404).json({ message: "❌ ไม่มีข้อมูลเซ็นเซอร์" });
});

// ===== Ask AI with sensor context =====
app.post("/ask-ai", async (req, res) => {
  try {
    if (!lastSensorData) return res.status(400).json({ error: "❌ ยังไม่มีข้อมูลเซ็นเซอร์" });
    const { question } = req.body || {};
    if (!question) return res.status(400).json({ error: "❌ missing question" });

    const { light, temp, humidity } = lastSensorData;
    const answer = await answerWithSensorAI(question, light, temp, humidity);
    return res.json({ answer: cleanAIResponse(answer) });
  } catch (err) {
    console.error("ask-ai error:", err?.response?.data || err?.message);
    return res.status(500).json({ error: "ask-ai failed" });
  }
});

// ===== Auto report every 5 min =====
setInterval(async () => {
  try {
    if (!lastSensorData) return;
    if (!LINE_ACCESS_TOKEN) return;

    const { light, temp, humidity } = lastSensorData;
    const now = dayjs().tz("Asia/Bangkok");
    const buddhistYear = now.year() + 543;

    const thaiDays = ["อาทิตย์", "จันทร์", "อังคาร", "พุธ", "พฤหัสบดี", "ศุกร์", "เสาร์"];
    const thaiMonths = ["มกราคม","กุมภาพันธ์","มีนาคม","เมษายน","พฤษภาคม","มิถุนายน","กรกฎาคม","สิงหาคม","กันยายน","ตุลาคม","พฤศจิกายน","ธันวาคม"];

    const thaiTime = `วัน${thaiDays[now.day()]} ที่ ${now.date()} ${thaiMonths[now.month()]} พ.ศ.${buddhistYear} เวลา ${now.format("HH:mm")} น.`;

    const aiAnswer = cleanAIResponse(
      await answerWithSensorAI("วิเคราะห์สภาพอากาศขณะนี้", light, temp, humidity)
    );

    const message = `📡 รายงานอัตโนมัติ ทุก 5 นาที :
🕒 เวลา : ${thaiTime}
💡 ค่าแสง : ${light} lux (${getLightStatus(light)})
🌡️ อุณหภูมิ : ${temp} °C (${getTempStatus(temp)})
💧 ความชื้น : ${humidity} % (${getHumidityStatus(humidity)})
🤖 AI : ${aiAnswer}`;

    const users = await prisma.user.findMany();
    for (const u of users) {
      await axios.post(
        "https://api.line.me/v2/bot/message/push",
        { to: u.userId, messages: [{ type: "text", text: message }] },
        { headers: { Authorization: `Bearer ${LINE_ACCESS_TOKEN}`, "Content-Type": "application/json" } }
      );
    }
    console.log(`✅ รายงานอัตโนมัติส่งแล้ว: ${thaiTime}`);
  } catch (e) {
    console.error("auto-report error:", e);
  }
}, 5 * 60 * 1000);

// ===== Health & Root =====
app.get("/healthz", (_req, res) => res.status(200).send("✅ สวัสดีครับ ตอนนี้ระบบ backend กำลังทำงานอยู่ครับ "));

// ===== Root route (ส่งครั้งเดียว)
app.get("/", async (_req, res) => {
  let html = `✅ สวัสดีครับ ตอนนี้ระบบ backend กำลังทำงานอยู่ครับ. <br>`;

  try {
    const sensor = await axios.get("https://ce395backend-1.onrender.com/latest");
    const { light, temp, humidity } = sensor.data;

    html = `
      ✅ สวัสดีครับ ตอนนี้ระบบ backend กำลังทำงานอยู่ครับ. <br>
      💡 ค่าแสง: ${light} lux (${getLightStatus(light)}) <br>
      🌡️ อุณหภูมิ: ${temp} °C (${getTempStatus(temp)}) <br>
      💧 ความชื้น: ${humidity} % (${getHumidityStatus(humidity)})
    `;
  } catch {
    if (lastSensorData) {
      html = `
        ✅ สวัสดีครับ ตอนนี้ระบบ backend กำลังทำงานอยู่ครับ. <br>
      `;
    }
  }

  return res.send(html);
});

// ===== Start & graceful shutdown =====
const server = app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT} (env: ${NODE_ENV})`);
});
process.on("SIGTERM", async () => { try { await prisma.$disconnect(); } finally { server.close(); } });
process.on("SIGINT", async () => { try { await prisma.$disconnect(); } finally { server.close(); } });
