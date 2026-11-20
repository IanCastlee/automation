import "dotenv/config";
import express from "express";

const {
  BOT_TOKEN,
  GEMINI_API_KEY,
  GEMINI_MODEL,
  APPS_SCRIPT_URL,
  APPS_SCRIPT_SECRET,
  OWNER_CHAT_ID,
  PORT = 3000,
} = process.env;

const FALLBACK = "Pasensya na, may problema sa ngayon. Subukan ulit mamaya.";
const MAX_HISTORY = 12;
const MAX_TOOL_STEPS = 5;
const MAX_BOOKINGS_PER_CHAT_PER_DAY = 10;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

for (const [k, v] of Object.entries({
  BOT_TOKEN,
  GEMINI_API_KEY,
  GEMINI_MODEL,
  APPS_SCRIPT_URL,
  APPS_SCRIPT_SECRET,
})) {
  if (!v) console.warn(`Kulang ang environment variable: ${k}`);
}

// ---------- Prompt ----------
function buildSystemPrompt() {
  const now = new Date();
  const today = now.toLocaleDateString("en-CA", { timeZone: "Asia/Manila" });
  const weekday = now.toLocaleDateString("en-US", {
    timeZone: "Asia/Manila",
    weekday: "long",
  });

  return `Ikaw ay assistant ng Sample Resort. Sagutin ang bisita nang magalang at maikli sa Tagalog o English, depende sa wika niya.

Ngayon ay ${today} (${weekday}), oras sa Pilipinas. Gamitin ito para intindihin ang "bukas", "sa Sabado", "next week", at iba pa.

Impormasyon (palitan ng totoong detalye ng resort):
- Check-in: 2:00 PM
- Check-out: 12:00 NN
- Presyo ng kwarto: ₱2,500 kada gabi
- Lokasyon: Sample address
- Contact: 09XX XXX XXXX

Mga panuntunan sa booking:
1. Kapag nagtanong tungkol sa bakante, gamitin ang tool na check_availability. Huwag manghula ng bakante. Kung hindi malinaw ang petsa, magtanong muna.
2. Ang check-out date ay ang araw ng pag-alis. Ang bilang ng gabi ay check-out minus check-in.
3. Para mag-book, kailangan ang pangalan, numero ng telepono, check-in, check-out, at bilang ng bisita. Itanong ang kulang, paisa-isa.
4. Bago gamitin ang create_booking, ulitin sa bisita ang lahat ng detalye at itanong kung tama. Gamitin lang ang create_booking pagkatapos nilang sumang-ayon.
5. Ang booking ay PENDING lang hanggang kumpirmahin ng staff. Huwag sabihing kumpirmado na. Huwag mangako ng diskwento, bayad, o deposito.
6. Kapag may error ang tool, humingi ng paumanhin at sabihing makipag-ugnayan sa staff.

Sagutin lang batay sa impormasyon sa itaas at sa resulta ng mga tool. Kung wala ang sagot, o may reklamo ang bisita, o hindi mo maisagawa ang hiling, sabihin nang magalang na ipapaalam mo ito sa staff, at ilagay ang eksaktong marker [STAFF] sa pinakadulo ng sagot. Huwag gamitin ang [STAFF] sa ibang pagkakataon.`;
}

// ---------- Mga tool para sa Gemini ----------
const TOOLS = [
  {
    functionDeclarations: [
      {
        name: "check_availability",
        description:
          "Tingnan kung may bakanteng kwarto sa pagitan ng dalawang petsa.",
        parameters: {
          type: "OBJECT",
          properties: {
            check_in: {
              type: "STRING",
              description: "Petsa ng check-in, format na YYYY-MM-DD",
            },
            check_out: {
              type: "STRING",
              description: "Petsa ng check-out, format na YYYY-MM-DD",
            },
          },
          required: ["check_in", "check_out"],
        },
      },
      {
        name: "create_booking",
        description:
          "Mag-save ng PENDING na booking. Gamitin lang pagkatapos kumpirmahin ng bisita ang lahat ng detalye.",
        parameters: {
          type: "OBJECT",
          properties: {
            name: { type: "STRING", description: "Pangalan ng bisita" },
            phone: {
              type: "STRING",
              description: "Numero ng telepono ng bisita",
            },
            check_in: { type: "STRING", description: "YYYY-MM-DD" },
            check_out: { type: "STRING", description: "YYYY-MM-DD" },
            guests: { type: "INTEGER", description: "Bilang ng bisita" },
          },
          required: ["name", "phone", "check_in", "check_out", "guests"],
        },
      },
    ],
  },
];

// ---------- Telegram ----------
async function sendTelegram(chatId, text) {
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: String(text).slice(0, 4000),
        }),
      },
    );
    if (!res.ok) console.error("Telegram error:", res.status, await res.text());
  } catch (err) {
    console.error("Telegram fetch failed:", err.message);
  }
}

function describeUser(msg) {
  const name = [
    msg.from?.first_name,
    msg.from?.username ? `@${msg.from.username}` : null,
  ]
    .filter(Boolean)
    .join(" ");
  return `${name || "Hindi kilala"} (chat ID: ${msg.chat.id})`;
}

// ---------- Apps Script ----------
async function callAppsScript(payload) {
  if (!APPS_SCRIPT_URL || !APPS_SCRIPT_SECRET) {
    return { ok: false, error: "Hindi pa naka-setup ang booking system." };
  }
  try {
    const res = await fetch(APPS_SCRIPT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret: APPS_SCRIPT_SECRET, ...payload }),
      redirect: "follow",
      signal: AbortSignal.timeout(25000),
    });
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      console.error("Apps Script: hindi JSON ang sagot, status", res.status);
      return { ok: false, error: "Hindi maabot ang booking system ngayon." };
    }
    if (data?.error === "unauthorized") {
      console.error(
        "Apps Script: unauthorized. Tingnan kung pareho ang secret at ang deployment version.",
      );
      return { ok: false, error: "Hindi maabot ang booking system ngayon." };
    }
    return data;
  } catch (err) {
    console.error("Apps Script fetch failed:", err.message);
    return { ok: false, error: "Hindi maabot ang booking system ngayon." };
  }
}

const bookingCounts = new Map(); // `${chatId}:${petsa}` -> bilang

async function runTool(name, args, ctx) {
  if (name === "check_availability") {
    if (
      !DATE_RE.test(args.check_in || "") ||
      !DATE_RE.test(args.check_out || "")
    ) {
      return {
        ok: false,
        error: "Kailangan ng petsa sa format na YYYY-MM-DD.",
      };
    }
    return callAppsScript({
      action: "check",
      checkIn: args.check_in,
      checkOut: args.check_out,
    });
  }

  if (name === "create_booking") {
    const guests = Number(args.guests);
    const guestName = String(args.name || "")
      .trim()
      .slice(0, 80);
    const phone = String(args.phone || "")
      .trim()
      .slice(0, 30);

    if (!guestName || !phone)
      return { ok: false, error: "Kulang ang pangalan o telepono." };
    if (!Number.isInteger(guests) || guests < 1 || guests > 20)
      return { ok: false, error: "Hindi wasto ang bilang ng bisita." };
    if (
      !DATE_RE.test(args.check_in || "") ||
      !DATE_RE.test(args.check_out || "")
    ) {
      return {
        ok: false,
        error: "Kailangan ng petsa sa format na YYYY-MM-DD.",
      };
    }

    const today = new Date().toLocaleDateString("en-CA", {
      timeZone: "Asia/Manila",
    });
    const key = `${ctx.msg.chat.id}:${today}`;
    if ((bookingCounts.get(key) || 0) >= MAX_BOOKINGS_PER_CHAT_PER_DAY) {
      return {
        ok: false,
        error:
          "Naabot na ang limitasyon ng booking request para ngayong araw. Makipag-ugnayan sa staff.",
      };
    }

    const result = await callAppsScript({
      action: "book",
      name: guestName,
      phone,
      checkIn: args.check_in,
      checkOut: args.check_out,
      guests,
      chatId: String(ctx.msg.chat.id),
    });

    if (result?.ok) {
      bookingCounts.set(key, (bookingCounts.get(key) || 0) + 1);
      if (OWNER_CHAT_ID) {
        await sendTelegram(
          OWNER_CHAT_ID,
          `🔔 Bagong booking (PENDING)\nPangalan: ${guestName}\nTelepono: ${phone}\nCheck-in: ${args.check_in}\nCheck-out: ${args.check_out}\nBisita: ${guests}\nMula sa Telegram: ${describeUser(ctx.msg)}`,
        );
      }
    }
    return result;
  }

  return { ok: false, error: "Hindi kilalang tool." };
}

// ---------- Gemini ----------
async function callGemini(contents, systemPrompt) {
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
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents,
          tools: TOOLS,
          generationConfig: { temperature: 0.3 },
        }),
        signal: AbortSignal.timeout(30000),
      });

      if (res.ok) return await res.json();

      console.error(
        `Gemini error ${res.status}:`,
        (await res.text()).slice(0, 500),
      );
      if (![429, 500, 503].includes(res.status)) return null;
    } catch (err) {
      console.error("Gemini fetch failed:", err.message);
    }
    await new Promise((r) => setTimeout(r, 2000 * attempt));
  }
  return null;
}

// ---------- Memory ng usapan (nasa RAM; nawawala kapag nag-restart) ----------
const histories = new Map();

function saveHistory(chatId, userText, modelText) {
  const h = histories.get(chatId) || [];
  h.push({ role: "user", parts: [{ text: userText }] });
  h.push({ role: "model", parts: [{ text: modelText }] });
  while (h.length > MAX_HISTORY) h.shift();
  while (h.length && h[0].role === "model") h.shift();
  histories.delete(chatId);
  histories.set(chatId, h);
  if (histories.size > 500) histories.delete(histories.keys().next().value);
}

async function answer(msg) {
  const chatId = msg.chat.id;
  const contents = [
    ...(histories.get(chatId) || []),
    { role: "user", parts: [{ text: msg.text }] },
  ];
  const systemPrompt = buildSystemPrompt();
  let finalText = null;

  for (let step = 0; step < MAX_TOOL_STEPS; step++) {
    const data = await callGemini(contents, systemPrompt);
    const content = data?.candidates?.[0]?.content;
    if (!content?.parts?.length) break;

    const calls = content.parts.filter((p) => p.functionCall);
    if (calls.length === 0) {
      finalText = content.parts
        .filter((p) => p.text && !p.thought)
        .map((p) => p.text)
        .join("")
        .trim();
      break;
    }

    contents.push(content);
    const responseParts = [];
    for (const p of calls) {
      const result = await runTool(
        p.functionCall.name,
        p.functionCall.args || {},
        { msg },
      );
      responseParts.push({
        functionResponse: { name: p.functionCall.name, response: result },
      });
    }
    contents.push({ role: "user", parts: responseParts });
  }

  if (!finalText) return FALLBACK;

  const needsStaff = finalText.includes("[STAFF]");
  const reply = finalText.replace(/\[STAFF\]/g, "").trim() || FALLBACK;
  saveHistory(chatId, msg.text, reply);
  return { reply, needsStaff };
}

async function handleMessage(msg) {
  const chatId = msg.chat.id;

  if (msg.text === "/start") {
    histories.delete(chatId);
    await sendTelegram(
      chatId,
      "Kumusta! Ako ang assistant ng Sample Resort. Pwede kitang tulungan sa tanong at sa booking. Ano ang maitutulong ko?",
    );
    return;
  }
  if (msg.text === "/id") {
    await sendTelegram(chatId, `Ang chat ID mo ay: ${chatId}`);
    return;
  }

  const result = await answer(msg);
  if (result === FALLBACK) {
    await sendTelegram(chatId, FALLBACK);
    return;
  }

  await sendTelegram(chatId, result.reply);

  if (result.needsStaff && OWNER_CHAT_ID) {
    await sendTelegram(
      OWNER_CHAT_ID,
      `🔔 Kailangan ng staff\nMula kay: ${describeUser(msg)}\nTanong: ${msg.text}\nSagot ng bot: ${result.reply}`,
    );
  }
}

// ---------- Server ----------
const app = express();
app.use(express.json());

const queues = new Map(); // isang mensahe lang kada chat sa isang pagkakataon
function enqueue(chatId, fn) {
  const prev = queues.get(chatId) || Promise.resolve();
  const next = prev
    .then(fn)
    .catch((err) => console.error("Handler error:", err));
  queues.set(chatId, next);
  next.finally(() => {
    if (queues.get(chatId) === next) queues.delete(chatId);
  });
}

const seen = new Set(); // iwas dobleng proseso kapag nag-retry ang Telegram
function isDuplicate(id) {
  if (id == null) return false;
  if (seen.has(id)) return true;
  seen.add(id);
  if (seen.size > 500) seen.delete(seen.values().next().value);
  return false;
}

app.get("/", (req, res) => res.send("Resort bot is running"));
app.get("/healthz", (req, res) => res.json({ status: "ok" }));

app.post("/webhook", (req, res) => {
  res.sendStatus(200);
  const update = req.body;
  if (isDuplicate(update?.update_id)) return;
  const msg = update?.message;
  if (!msg?.text || msg.chat?.type !== "private") return;
  enqueue(msg.chat.id, () => handleMessage(msg));
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
