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
axios.defaults.timeout = 15000;

const app = express();
const prisma = new PrismaClient();
const PORT = Number(process.env.PORT) || 10000;
const NODE_ENV = process.env.NODE_ENV || "development";
const LINE_ACCESS_TOKEN = process.env.LINE_ACCESS_TOKEN || "";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || "" });

app.use(cors());
app.use(express.json());

// ===== In-memory sensor cache =====
let lastSensorData = null;

// ===== Utils =====
function cleanAIResponse(text = "") {
  return String(text)
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<[^>]+>/g, "")
    .trim();
}

function getLightStatus(light) {
  if (light > 50000) return "สว่างจัดมาก ☀️";
  if (light > 10000) return "สว่างมาก 🌤";
  if (light > 5000) return "สว่างปานกลาง 🌥";
  if (light > 1000) return "ค่อนข้างสว่าง 🌈";
  if (light > 500) return "แสงพอใช้";
  if (light > 100) return "แสงน้อย 🌙";
  if (light > 10) return "มืดสลัว 🌑";
  return "มืดมาก 🕳️";
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
  try {
    if (typeof openai.responses?.create === "function") {
      const resp = await openai.responses.create({
        model: "gpt-4o-mini",
        input: prompt,
        store: false,
      });
      return resp.output_text ?? "ไม่มีข้อความตอบกลับ";
    }
    throw new Error("Responses API not available");
  } catch (e1) {
    try {
      if (typeof openai.chat?.completions?.create === "function") {
        const resp = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [{ role: "user", content: prompt }],
        });
        return resp.choices?.[0]?.message?.content ?? "ไม่มีข้อความตอบกลับ";
      }
      throw e1;
    } catch (e2) {
      throw e2;
    }
  }
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

  // ✅ แก้ตรงนี้ ใช้ answerWithSensorAI
  const aiText = await answerWithSensorAI(normalizedText, light, temp, humidity);

  if (!aiText || aiText.trim() === "") {
    await replyToUser(replyToken, "❌ คำตอบจาก AI ว่างเปล่า ไม่สามารถส่งข้อความได้");
    await deletePendingReply(created.id);
    return;
  }

  const answer = `${normalizedText}?\n- คำตอบ จาก AI : ${aiText.trim()}`;

  await axios.post(
    "https://api.line.me/v2/bot/message/push",
    {
      to: userId,
      messages: [{ type: "text", text: answer }],
    },
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

// ===== Ask AI (API) =====
app.post("/ask-ai", async (req, res) => {
  try {
    const { question, light: bLight, temp: bTemp, humidity: bHum } = req.body || {};
    if (!question || typeof question !== "string") {
      return res.status(400).json({ error: "❌ missing question" });
    }

    let light, temp, humidity;
    if ([bLight, bTemp, bHum].every(v => typeof v === "number" && !Number.isNaN(v))) {
      light = bLight; temp = bTemp; humidity = bHum;
    } else if (lastSensorData) {
      ({ light, temp, humidity } = lastSensorData);
    } else {
      return res.status(400).json({ error: "❌ ยังไม่มีข้อมูลเซ็นเซอร์" });
    }

    try {
      const ai = await answerWithSensorAI(question, light, temp, humidity);
      return res.json({ answer: cleanAIResponse(ai), meta: { source: "openai" } });
    } catch (aiErr) {
      return res.status(500).json("ผิดพลาดในการติต่อ AI");
    }
  } catch (err) {
    return res.status(500).json({ error: "ask-ai failed", detail: String(err?.message || err) });
  }
});

// ===== Health & Root =====
app.get("/healthz", (req, res) => res.status(200).send("✅ ตอนนี้ ระบบBackend กำลังทำงานอยู่ครับผม"));

app.get("/", async (req, res) => {
  let html = `✅ ตอนนี้ ระบบBackend กำลังทำงานอยู่ครับผม <br>`;
  try {
    const sensor = await axios.get("https://ce395backend-1.onrender.com/latest");
    const { light, temp, humidity } = sensor.data;
    html += `
      💡 ค่าแสง: ${light} lux (${getLightStatus(light)}) <br>
      🌡️ อุณหภูมิ: ${temp} °C (${getTempStatus(temp)}) <br>
      💧 ความชื้น: ${humidity} % (${getHumidityStatus(humidity)})
    `;
  } catch {
    if (lastSensorData) html += "ใช้ข้อมูลจาก cache แทน";
  }
  return res.send(html);
});

// ===== Start server =====
const server = app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT} (env: ${NODE_ENV})`);
});
process.on("SIGTERM", async () => { try { await prisma.$disconnect(); } finally { server.close(); } });
process.on("SIGINT", async () => { try { await prisma.$disconnect(); } finally { server.close(); } });
