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
axios.defaults.timeout = 15000; // ✅ fixed (defaults)

const app = express();
const prisma = new PrismaClient();
const PORT = Number(process.env.PORT) || 10000;
const NODE_ENV = process.env.NODE_ENV || "development";
const LINE_ACCESS_TOKEN = process.env.LINE_ACCESS_TOKEN || "";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || "" });

// ===== Rate-limit & cache config =====
const { setTimeout: delay } = require("node:timers/promises");
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const OPENAI_RPM = Number(process.env.OPENAI_RPM || 2);            // ต่ำกว่าลิมิตจริงกันพลาด
const OPENAI_MAX_RETRIES = Number(process.env.OPENAI_MAX_RETRIES || 3);
const ENABLE_AUTO_REPORT = process.env.ENABLE_AUTO_REPORT === "true";

let chain = Promise.resolve();                                      // serialize ทีละคำขอ
let lastCall = 0;
const minGapMs = Math.ceil(60000 / Math.max(1, OPENAI_RPM));

// simple in-memory cache
const aiCache = new Map();                                          // key -> {t, val}
const CACHE_TTL_MS = Number(process.env.AI_CACHE_TTL_MS || 120000);
const cacheKey = (q, l, t, h) =>
  `${q}|${Math.round(l)}|${Math.round(t)}|${Math.round(h)}`;
const getCache = (k) => {
  const v = aiCache.get(k);
  if (!v) return null;
  if (Date.now() - v.t > CACHE_TTL_MS) {
    aiCache.delete(k);
    return null;
  }
  return v.val;
};
const setCache = (k, val) => aiCache.set(k, { t: Date.now(), val });

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

// ===== OpenAI low-level (kept) =====
async function askOpenAI(prompt) {
  if (!process.env.OPENAI_API_KEY) return "❌ ยังไม่ได้ตั้งค่า OPENAI_API_KEY";
  try {
    if (typeof openai.responses?.create === "function") {
      const resp = await openai.responses.create({
        model: OPENAI_MODEL,
        input: prompt,
        temperature: 0.2,
        store: false,
      });
      return resp.output_text ?? "ไม่มีข้อความตอบกลับ";
    }
    throw new Error("Responses API not available");
  } catch (e1) {
    try {
      if (typeof openai.chat?.completions?.create === "function") {
        const resp = await openai.chat.completions.create({
          model: OPENAI_MODEL,
          temperature: 0.2,
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

// ===== Rate-limit wrapper =====
function parseRetryAfterMs(err) {
  const h = err?.headers;
  if (!h) return null;
  const get = typeof h.get === "function" ? (k) => h.get(k) : (k) => h[k];
  const raw = get("retry-after-ms") || get("retry-after");
  if (!raw) return null;
  const s = String(raw).trim();
  if (s.endsWith("ms")) return Number(s.replace("ms", "")) || null;
  const sec = Number(s);
  return Number.isFinite(sec) ? sec * 1000 : null;
}

function safeAskOpenAI(prompt) {
  return (chain = chain.then(async () => {
    // spacing ตาม RPM
    const now = Date.now();
    const wait = Math.max(0, lastCall + minGapMs - now);
    if (wait > 0) await delay(wait);

    let attempt = 0;
    for (;;) {
      try {
        const out = await askOpenAI(prompt);
        lastCall = Date.now();
        return out;
      } catch (err) {
        if (err?.status !== 429 || attempt >= OPENAI_MAX_RETRIES) throw err;
        attempt++;
        const backoff =
          parseRetryAfterMs(err) ?? Math.min(30000, (2 ** attempt) * 1000 + Math.floor(Math.random() * 800));
        console.warn(`[OpenAI] 429 -> retry in ${backoff}ms (attempt ${attempt})`);
        await delay(backoff);
      }
    }
  }));
}

// ===== High-level helper =====
async function answerWithSensorAI(question, light, temp, humidity) {
  const prompt = `
ข้อมูลเซ็นเซอร์:
- ค่าแสง: ${light} lux
- อุณหภูมิ: ${temp} °C
- ความชื้น: ${humidity} %
คำถาม: "${question}"
โปรดตอบเป็นภาษาไทยแบบสั้น กระชับ ชัดเจน
  `.trim();

  const key = cacheKey(question, light, temp, humidity);
  const cached = getCache(key);
  if (cached) return cached;

  const out = await safeAskOpenAI(prompt);
  setCache(key, out);
  return out;
}

// ===== Express middlewares =====
app.use(cors());
app.use(express.json());

let lastSensorData = null;

// ===== LINE Reply =====
async function replyToUser(replyToken, message) {
  try {
    const trimmedMessage =
      message.length > 1000 ? message.slice(0, 1000) + "\n...(ตัดข้อความ)" : message;
    await axios.post(
      "https://api.line.me/v2/bot/message/reply",
      { replyToken, messages: [{ type: "text", text: trimmedMessage }] },
      { headers: { Authorization: `Bearer ${LINE_ACCESS_TOKEN}`, "Content-Type": "application/json" } }
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

  // ✅ ใช้ answerWithSensorAI (มีคิว/แคช)
  const aiText = await answerWithSensorAI(normalizedText, light, temp, humidity);
  const finalText = (aiText || "").trim();
  if (!finalText) {
    await replyToUser(replyToken, "❌ คำตอบจาก AI ว่างเปล่า ไม่สามารถส่งข้อความได้");
    await deletePendingReply(created.id);
    return;
  }

  const answer = `${normalizedText}?\n- คำตอบ จาก AI : ${cleanAIResponse(finalText)}`;

  await axios.post(
    "https://api.line.me/v2/bot/message/push",
    { to: userId, messages: [{ type: "text", text: answer }] },
    { headers: { Authorization: `Bearer ${LINE_ACCESS_TOKEN}`, "Content-Type": "application/json" } }
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
app.get("/latest", (_req, res) => {
  if (lastSensorData) res.json(lastSensorData);
  else res.status(404).json({ message: "❌ ไม่มีข้อมูลเซ็นเซอร์" });
});

app.post("/ask-ai", async (req, res) => {
  try {
    const { question, light: bLight, temp: bTemp, humidity: bHum } = req.body || {};
    if (!question || typeof question !== "string") {
      return res.status(400).json({ error: "❌ missing question" });
    }

    let light, temp, humidity;
    if ([bLight, bTemp, bHum].every((v) => typeof v === "number" && !Number.isNaN(v))) {
      light = bLight;
      temp = bTemp;
      humidity = bHum;
    } else if (lastSensorData) {
      ({ light, temp, humidity } = lastSensorData);
    } else {
      return res
        .status(400)
        .json({ error: "❌ ยังไม่มีข้อมูลเซ็นเซอร์ (ไม่พบทั้งใน body และ server)" });
    }

    // ยิง AI (มีคิว/แคช) ถ้าพังจะ fallback
    try {
      const ai = await answerWithSensorAI(question, light, temp, humidity);
      return res.json({ answer: cleanAIResponse(ai), meta: { source: "openai" } });
    } catch (aiErr) {
      console.error("OpenAI error:", aiErr?.response?.data || aiErr?.message || aiErr);
      const fallback =
        `สรุปจากค่าปัจจุบัน\n` +
        `• แสง: ${light} lux (${getLightStatus(light)})\n` +
        `• อุณหภูมิ: ${temp} °C (${getTempStatus(temp)})\n` +
        `• ความชื้น: ${humidity} % (${getHumidityStatus(humidity)})\n` +
        `คำแนะนำเบื้องต้น: หากอากาศร้อน/ชื้นมากให้ดื่มน้ำและพักในที่อากาศถ่ายเท`;
      return res.json({ answer: fallback, meta: { source: "fallback" } });
    }
  } catch (err) {
    console.error("ask-ai fatal:", err);
    return res.status(500).json({ error: "ask-ai failed", detail: String(err?.message || err) });
  }
});

// ===== Auto report (gated) =====
if (ENABLE_AUTO_REPORT) {
  setInterval(async () => {
    try {
      if (!lastSensorData) return;
      if (!LINE_ACCESS_TOKEN) return;

      const { light, temp, humidity } = lastSensorData;
      const now = dayjs().tz("Asia/Bangkok");
      const buddhistYear = now.year() + 543;

      const thaiDays = ["อาทิตย์", "จันทร์", "อังคาร", "พุธ", "พฤหัสบดี", "ศุกร์", "เสาร์"];
      const thaiMonths = [
        "มกราคม",
        "กุมภาพันธ์",
        "มีนาคม",
        "เมษายน",
        "พฤษภาคม",
        "มิถุนายน",
        "กรกฎาคม",
        "สิงหาคม",
        "กันยายน",
        "ตุลาคม",
        "พฤศจิกายน",
        "ธันวาคม",
      ];

      const thaiTime = `วัน${thaiDays[now.day()]} ที่ ${now.date()} ${thaiMonths[now.month()]} พ.ศ.${buddhistYear} เวลา ${now.format("HH:mm")} น.`;

      const aiAnswer = cleanAIResponse(
        await answerWithSensorAI("วิเคราะห์สภาพอากาศขณะนี้", light, temp, humidity)
      );

      const message = `📡 รายงานอัตโนมัติ :
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
  }, Math.max(5 * 60 * 1000, minGapMs)); // อย่างน้อยต้องไม่ถี่กว่า minGapMs
}

// ===== Health & Root =====
app.get("/healthz", (_req, res) =>
  res.status(200).send("✅ สวัสดีครับ ตอนนี้ระบบ backend กำลังทำงานอยู่ครับ ")
);

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
process.on("SIGTERM", async () => {
  try {
    await prisma.$disconnect();
  } finally {
    server.close();
  }
});
process.on("SIGINT", async () => {
  try {
    await prisma.$disconnect();
  } finally {
    server.close();
  }
});
