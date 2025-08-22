// src/index.ts
import dotenv from "dotenv";
dotenv.config();

import express, { Request, Response } from "express";
import cors from "cors";
import bodyParser from "body-parser";
import axios from "axios";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import timezone from "dayjs/plugin/timezone";
import { PrismaClient } from "@prisma/client";
import OpenAI from "openai";

// ----- Init libs -----
dayjs.extend(utc);
dayjs.extend(timezone);

const app = express();
const prisma = new PrismaClient();

const PORT = Number(process.env.PORT) || 10000;
const NODE_ENV = process.env.NODE_ENV || "development";
const LINE_ACCESS_TOKEN = process.env.LINE_ACCESS_TOKEN || "";

// OpenAI client
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.use(cors());
app.use(bodyParser.json());

// ===== In-memory sensor cache =====
let lastSensorData: { light: number; temp: number; humidity: number } | null = null;

// ===== Utils =====
function cleanAIResponse(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<[^>]+>/g, "")
    .trim();
}

function getLightStatus(light: number): string {
  if (light > 50000) return "แดดจ้า ☀️";
  if (light > 10000) return "กลางแจ้ง มีเมฆ หรือแดดอ่อน 🌤";
  if (light > 5000) return "ฟ้าครึ้ม 🌥";
  if (light > 1000) return "ห้องที่มีแสงธรรมชาติ 🌈";
  if (light > 500) return "ออฟฟิศ หรือร้านค้า 💡";
  if (light > 100) return "ห้องนั่งเล่น ไฟบ้าน 🌙";
  if (light > 10) return "ไฟสลัว 🌑";
  return "มืดมากๆ 🕳️";
}

function getTempStatus(temp: number): string {
  if (temp > 35) return "อุณหภูมิร้อนมาก ⚠️";
  if (temp >= 30) return "อุณหภูมิร้อน 🔥";
  if (temp >= 25) return "อุณหภูมิอุ่นๆ 🌞";
  if (temp >= 20) return "อุณหภูมิพอดี 🌤";
  return "อุณหูมิเย็น ❄️";
}

function getHumidityStatus(humidity: number): string {
  if (humidity > 85) return "ชื้นมาก อากาศอึดอัด 🌧️";
  if (humidity > 70) return "อากาศชื้น เหนียวตัว 💦";
  if (humidity > 60) return "เริ่มชื้น 🌫️";
  if (humidity > 40) return "อากาศสบาย ✅";
  if (humidity > 30) return "ค่อนข้างแห้ง 💨";
  if (humidity > 20) return "แห้งมาก 🥵";
  return "อากาศแห้งมาก 🏜️";
}

// ===== AI Helpers =====
async function askOpenAI(prompt: string): Promise<string> {
  if (!process.env.OPENAI_API_KEY) {
    return "❌ ยังไม่ได้ตั้งค่า OPENAI_API_KEY";
  }
  const resp = await openai.responses.create({
    model: "gpt-4o-mini",
    input: prompt,
    store: false,
  });
  // @ts-ignore: SDK field
  return resp.output_text ?? "ไม่มีข้อความตอบกลับ";
}

async function answerWithSensorAI(
  question: string,
  light: number,
  temp: number,
  humidity: number
) {
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
async function replyToUserAndDelete(
  id: number,
  replyToken: string,
  message: string
) {
  try {
    const text =
      message.length > 4000
        ? message.slice(0, 4000) + "\n...(ตัดข้อความ)"
        : message;
    if (!LINE_ACCESS_TOKEN) throw new Error("LINE_ACCESS_TOKEN is missing");

    await axios.post(
      "https://api.line.me/v2/bot/message/reply",
      { replyToken, messages: [{ type: "text", text }] },
      {
        headers: {
          Authorization: `Bearer ${LINE_ACCESS_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );
    await prisma.pendingReply.delete({ where: { id } });
    console.log("✅ ส่งข้อความกลับ LINE แล้ว");
  } catch (err: any) {
    console.error("❌ LINE reply error:", err?.response?.data || err?.message);
  }
}

// ===== Webhook =====
app.post("/webhook", async (req: Request, res: Response) => {
  const events = (req.body?.events as any[]) || [];

  for (const event of events) {
    const userId = event?.source?.userId as string | undefined;
    const replyToken = event?.replyToken as string | undefined;
    const messageType = event?.message?.type as string | undefined;
    const text = ((event?.message?.text as string) || "").trim();

    // ถ้าไม่มี userId หรือ replyToken ข้าม
    if (!userId || !replyToken) continue;

    // ทำให้ TS ชัดว่าเป็น string แล้ว
    const uid = userId as string;
    const token = replyToken as string;

    // upsert user
    const existingUser = await prisma.user.findUnique({ where: { userId: uid } });
    if (!existingUser) await prisma.user.create({ data: { userId: uid } });

    // dedupe replyToken
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
    const lightStatus = getLightStatus(light);
    const tempStatus = getTempStatus(temp);
    const humidityStatus = getHumidityStatus(humidity);

    let replyText = `📊 สภาพอากาศล่าสุด :
💡 ค่าแสง: ${light} lux (${lightStatus})
🌡️ อุณหภูมิ: ${temp} °C (${tempStatus})
💧 ความชื้น: ${humidity} % (${humidityStatus})`;

    if (messageType === "text") {
      const ai = await answerWithSensorAI(text, light, temp, humidity);
      replyText += `\n🤖 AI: ${cleanAIResponse(ai)}`;
    }

    await replyToUserAndDelete(created.id, token, replyText);
  }

  res.sendStatus(200);
});

// ===== Sensor Data =====
app.post("/sensor-data", (req: Request, res: Response) => {
  const { light, temp, humidity } = req.body as {
    light?: number | string;
    temp?: number | string;
    humidity?: number | string;
  };

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
app.get("/latest", (req: Request, res: Response) => {
  if (!lastSensorData) {
    return res.status(404).json({ message: "❌ ไม่มีข้อมูลเซ็นเซอร์" });
  }
  return res.json(lastSensorData);
});

// ===== Generic OpenAI endpoint =====
app.post("/ask", async (req: Request, res: Response) => {
  try {
    const { prompt } = req.body as { prompt?: string };
    if (!prompt) {
      return res.status(400).json({ error: "missing prompt" });
    }
    const answer = await askOpenAI(prompt);
    return res.json({ answer });
  } catch (err: any) {
    console.error("OpenAI error:", err?.response?.data || err?.message);
    return res.status(500).json({ error: "OpenAI request failed" });
  }
});

// ===== Ask AI with sensor context =====
app.post("/ask-ai", async (req: Request, res: Response) => {
  try {
    if (!lastSensorData) {
      return res.status(400).json({ error: "❌ ยังไม่มีข้อมูลเซ็นเซอร์" });
    }
    const { question } = req.body as { question?: string };
    if (!question) {
      return res.status(400).json({ error: "❌ missing question" });
    }

    const { light, temp, humidity } = lastSensorData;
    const answer = await answerWithSensorAI(question, light, temp, humidity);
    return res.json({ answer: cleanAIResponse(answer) });
  } catch (err: any) {
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
    const thaiMonths = [
      "มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน",
      "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม",
    ];

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
app.get("/healthz", (req: Request, res: Response) => res.status(200).send("ok"));

// ===== Root route (ส่งครั้งเดียว)
app.get("/", async (req: Request, res: Response) => {
  let html = `✅ สวัสดีครับ ตอนนี้ระบบ backend กำลังทำงานอยู่ครับ. <br>`;

  try {
    const sensor = await axios.get("https://ce395backend.onrender.com/latest");
    const { light, temp, humidity } = sensor.data;

    const lightStatus = getLightStatus(light);
    const tempStatus = getTempStatus(temp);
    const humidityStatus = getHumidityStatus(humidity);

    html = `
      ✅ สวัสดีครับ ตอนนี้ระบบ backend กำลังทำงานอยู่ครับ. <br>
      💡 ค่าแสง: ${light} lux (${lightStatus}) <br>
      🌡️ อุณหภูมิ: ${temp} °C (${tempStatus}) <br>
      💧 ความชื้น: ${humidity} % (${humidityStatus})
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
  await prisma.$disconnect();
  server.close();
});
process.on("SIGINT", async () => {
  await prisma.$disconnect();
  server.close();
});
