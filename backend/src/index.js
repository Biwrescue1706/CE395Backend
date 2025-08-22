// src/index.js
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const axios = require("axios");
const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc");
const timezone = require("dayjs/plugin/timezone");
const { PrismaClient } = require("@prisma/client");
const OpenAI = require("openai");

// ----- Init libs -----
dayjs.extend(utc);
dayjs.extend(timezone);

const app = express();
const prisma = new PrismaClient();

const PORT = Number(process.env.PORT) || 10000;
const NODE_ENV = process.env.NODE_ENV || "development";
const LINE_ACCESS_TOKEN = process.env.LINE_ACCESS_TOKEN || "";

// OpenAI client
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY ?? "" });

app.use(cors());
app.use(express.json()); // body-parser ไม่จำเป็น

// ===== In-memory sensor cache =====
let lastSensorData = null; // { light, temp, humidity }

// ===== Utils =====
function cleanAIResponse(text) {
  return String(text)
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<[^>]+>/g, "")
    .trim();
}

function getLightStatus(light) {
  if (light > 50000) return "แดดจ้า ☀️";
  if (light > 10000) return "กลางแจ้ง มีเมฆ หรือแดดอ่อน 🌤";
  if (light > 5000) return "ฟ้าครึ้ม 🌥";
  if (light > 1000) return "ห้องที่มีแสงธรรมชาติ 🌈";
  if (light > 500) return "ออฟฟิศ หรือร้านค้า 💡";
  if (light > 100) return "ห้องนั่งเล่น ไฟบ้าน 🌙";
  if (light > 10) return "ไฟสลัว 🌑";
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
async function askOpenAI(prompt) {
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
async function replyToUserAndDelete(id, replyToken, message) {
  try {
    const text =
      message.length > 4000 ? message.slice(0, 4000) + "\n...(ตัดข้อความ)" : message;
    if (!LINE_ACCESS_TOKEN) throw new Error("LINE_ACCESS_TOKEN is missing");

    await axios.post(
      "https://api.line.me/v2/bot/message/reply",
      { replyToken, messages: [{ type: "text", text }] },
      { headers: { Authorization: `Bearer ${LINE_ACCESS_TOKEN}`, "Content-Type": "application/json" } }
    );
    await prisma.pendingReply.delete({ where: { id } });
    console.log("✅ ส่งข้อความกลับ LINE แล้ว");
  } catch (err) {
    console.error("❌ LINE reply error:", err?.response?.data || err?.message);
  }
}

// ===== Webhook =====
app.post("/webhook", async (req, res) => {
  const events = req.body?.events || [];

  for (const event of events) {
    const userId = event?.source?.userId;
    const replyToken = event?.replyToken;
    const messageType = event?.message?.type ?? "text";
    const text = (event?.message?.text || "").trim();

    if (!userId || !replyToken) continue;
    const uid = userId;
    const token = replyToken;

    const existingUser = await prisma.user.findUnique({ where: { userId: uid } });
    if (!existingUser) await prisma.user.create({ data: { userId: uid } });

    const exists = await prisma.pendingReply.findUnique({ where: { replyToken: token } });
    if (exists) continue;

    const created = await prisma.pendingReply.create({
      data: { replyToken: token, userId: uid, messageType, text },
    });

    if (!lastSensorData) {
      await replyToUserAndDelete(created.id, token, "❌ ยังไม่มีข้อมูลจากเซ็นเซอร์");
      continue;
    }

    const { light, temp, humidity } = lastSensorData;
    const replyPieces = [
      "📊 สภาพอากาศล่าสุด :",
      `💡 ค่าแสง: ${light} lux (${getLightStatus(light)})`,
      `🌡️ อุณหภูมิ: ${temp} °C (${getTempStatus(temp)})`,
      `💧 ความชื้น: ${humidity} % (${getHumidityStatus(humidity)})`,
    ];

    if (messageType === "text") {
      const ai = await answerWithSensorAI(text, light, temp, humidity);
      replyPieces.push(`🤖 AI: ${cleanAIResponse(ai)}`);
    }

    await replyToUserAndDelete(created.id, token, replyPieces.join("\n"));
  }

  res.sendStatus(200);
});

// ===== Sensor Data =====
app.post("/sensor-data", (req, res) => {
  const { light, temp, humidity } = req.body || {};
  if ([light, temp, humidity].every((v) => v !== undefined)) {
    lastSensorData = {
      light: Number(light),
      temp: Number(temp),
      humidity: Number(humidity),
    };
    return res.json({ message: "✅ รับข้อมูลแล้ว" });
  }
  return res.status(400).json({ message: "❌ ข้อมูลไม่ครบ" });
});

// ===== Latest Sensor =====
app.get("/latest", (req, res) => {
  if (!lastSensorData) return res.status(404).json({ message: "❌ ไม่มีข้อมูลเซ็นเซอร์" });
  return res.json(lastSensorData);
});

// ===== Generic OpenAI endpoint =====
app.post("/ask", async (req, res) => {
  try {
    const { prompt } = req.body || {};
    if (!prompt) return res.status(400).json({ error: "missing prompt" });
    const answer = await askOpenAI(prompt);
    return res.json({ answer });
  } catch (err) {
    console.error("OpenAI error:", err?.response?.data || err?.message);
    return res.status(500).json({ error: "OpenAI request failed" });
  }
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
app.get("/healthz", (req, res) => res.status(200).send("ok"));

// ===== Root route (ส่งครั้งเดียว)
app.get("/", async (req, res) => {
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
process.on("SIGTERM", async () => { await prisma.$disconnect(); server.close(); });
process.on("SIGINT", async () => { await prisma.$disconnect(); server.close(); });
