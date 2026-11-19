import "dotenv/config";
import express from "express";

const { BOT_TOKEN, GEMINI_API_KEY, GEMINI_MODEL, PORT = 3000 } = process.env;

const SYSTEM_PROMPT = `Ikaw ay assistant ng Sample Resort. Sagutin ang tanong ng bisita nang magalang sa Tagalog o English, depende sa wika ng bisita.

Impormasyon:
- Check-in: 2:00 PM
- Check-out: 12:00 NN
- Presyo ng kwarto: ₱2,500 kada gabi
- Lokasyon: Sample address
- Contact: 09XX XXX XXXX

Sagutin lang batay sa impormasyon sa itaas. Kung wala ang sagot, sabihin na makipag-ugnayan sa staff.`;

const FALLBACK = "Pasensya na, may problema sa ngayon. Subukan ulit mamaya.";

const app = express();
app.use(express.json());

async function askGemini(userText) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": GEMINI_API_KEY,
        },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
          contents: [{ role: "user", parts: [{ text: userText }] }],
        }),
      });

      if (res.ok) {
        const data = await res.json();
        return data.candidates?.[0]?.content?.parts?.[0]?.text || FALLBACK;
      }

      console.error(`Gemini error ${res.status}:`, await res.text());
      if (![429, 500, 503].includes(res.status)) break; // hindi na ulitin kung ibang error
    } catch (err) {
      console.error("Gemini fetch failed:", err.message);
    }
    await new Promise((r) => setTimeout(r, 2000 * attempt));
  }
  return FALLBACK;
}

async function sendTelegram(chatId, text) {
  const res = await fetch(
    `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    },
  );
  if (!res.ok) console.error("Telegram error:", await res.text());
}

app.get("/", (req, res) => res.send("Resort bot is running"));
app.get("/healthz", (req, res) => res.json({ status: "ok" }));

app.post("/webhook", async (req, res) => {
  res.sendStatus(200); // sagutin agad ang Telegram

  const msg = req.body?.message;
  if (!msg?.text) return;

  if (msg.text === "/start") {
    await sendTelegram(
      msg.chat.id,
      "Kumusta! Ako ang assistant ng Sample Resort. Ano ang maitutulong ko?",
    );
    return;
  }

  const reply = await askGemini(msg.text);
  await sendTelegram(msg.chat.id, reply);
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
