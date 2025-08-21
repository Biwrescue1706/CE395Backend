import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY, // ตั้งใน Render > Environment
});

export async function askOpenAI(prompt: string) {
  if (!process.env.OPENAI_API_KEY) {
    return "❌ OPENAI_API_KEY ไม่ได้ตั้งค่าในสภาพแวดล้อม";
  }
  const resp = await openai.responses.create({
    model: "gpt-4o-mini",
    input: prompt,
    store: false,
  });
  // @ts-ignore (helper field จาก SDK)
  return resp.output_text ?? "ไม่มีข้อความตอบกลับจากโมเดล";
}
