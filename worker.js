/**
 * Pahingahan Stay Cation — FREE Messenger FAQ Worker
 *
 * Required Cloudflare Worker secrets:
 * VERIFY_TOKEN, APP_SECRET, PAGE_ACCESS_TOKEN
 *
 * This version does NOT call OpenAI and needs no OpenAI credits.
 * It uses Filipino/Taglish keyword-based FAQ replies.
 * It does NOT check a live calendar, send owner notifications, or confirm bookings.
 */

const GRAPH_API_VERSION = "v27.0";

const BUSINESS = {
  rate: "₱1,950 po ang 22-hour stay.",
  checkIn: "Check-in po ay 2:00 PM.",
  checkOut: "Check-out po ay 12:00 noon kinabukasan.",
  extra: "Ang bawat additional person ay ₱200.",
  duration: "Hanggang 22 hours lang po ang stay na ino-offer namin sa ngayon.",
  hold: "Ang slot ay maaaring i-hold nang hanggang 4 hours habang inaasikaso ang payment. Owner po ang magbibigay ng instructions at final confirmation.",
};

const HANDOFF =
  "Para sa payment at final reservation confirmation, owner po mismo ang mag-aassist. Paki-message po ang owner/admin ng Page para ma-check at maasikaso ang inyong booking. Huwag pong magpadala ng payment hangga't hindi direktang kinukumpirma ng owner.";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "GET") {
      const mode = url.searchParams.get("hub.mode");
      const token = url.searchParams.get("hub.verify_token");
      const challenge = url.searchParams.get("hub.challenge");

      if (mode === "subscribe" && token && token === env.VERIFY_TOKEN) {
        return new Response(challenge || "", { status: 200 });
      }
      return new Response("Pahingahan Messenger FAQ Worker is running.", { status: 200 });
    }

    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    const rawBody = await request.text();
    const signature = request.headers.get("x-hub-signature-256");
    const valid = await verifySignature(rawBody, signature, env.APP_SECRET);

    if (!valid) {
      console.error("Webhook signature verification failed.");
      return new Response("Invalid signature", { status: 401 });
    }

    let body;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }

    ctx.waitUntil(processWebhookEvents(body, env));
    return new Response("EVENT_RECEIVED", { status: 200 });
  },
};

async function verifySignature(rawBody, signatureHeader, appSecret) {
  if (!signatureHeader || !appSecret) return false;

  const supplied = signatureHeader.replace(/^sha256=/, "").toLowerCase();
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(appSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(rawBody)
  );
  const expected = [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return constantTimeEqual(supplied, expected);
}

function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

async function processWebhookEvents(body, env) {
  if (body.object !== "page" || !Array.isArray(body.entry)) return;

  for (const entry of body.entry) {
    for (const event of entry.messaging || []) {
      try {
        const senderId = event.sender && event.sender.id;
        if (!senderId) continue;
        if (event.message && event.message.is_echo) continue;

        const incoming = event.message && event.message.text;
        let reply;

        if (!incoming || !incoming.trim()) {
          reply = "Salamat po sa pag-message! Maaari po bang i-type ang inyong tanong para matulungan namin kayo?";
        } else {
          reply = buildFaqReply(incoming.trim());
        }

        await sendMessengerReply(senderId, reply, env);
      } catch (error) {
        console.error("Error processing Messenger event:", error && error.message);
      }
    }
  }
}

function buildFaqReply(message) {
  const s = message.toLowerCase();

  // Payment and confirmation must always be handled by the owner.
  if (hasAny(s, [
    "payment", "magbabayad", "bayad na", "downpayment", "down payment",
    "gcash", "bank", "deposit", "mag deposit", "mag-deposit",
    "account number", "qr", "resibo", "receipt", "paid na",
    "pa-reserve", "pa reserve", "reserve na", "i-book na", "book na",
    "confirm booking", "booking confirmation", "pa-confirm", "pa confirm",
  ])) {
    return HANDOFF;
  }

  const asksPrice = hasAny(s, [
    "magkano", "presyo", "price", "rate", "rates", "hm", "how much", "cost",
  ]);
  const asksCheckIn = hasAny(s, [
    "check in", "check-in", "checkin", "anong oras pasok", "oras ng pasok",
  ]);
  const asksCheckOut = hasAny(s, [
    "check out", "check-out", "checkout", "anong oras alis", "oras ng alis",
  ]);
  const asksDuration = hasAny(s, [
    "ilang oras", "how many hours", "duration", "22 hours", "22hrs", "22 hrs",
  ]);
  const asksExtra = hasAny(s, [
    "additional", "extra person", "extra guest", "dagdag na tao",
    "sobra", "excess", "per head", "per person",
  ]);
  const asksAvailability = hasAny(s, [
    "available", "availability", "bakante", "may slot", "open pa",
    "vacant", "free pa", "may available",
  ]);
  const asksBooking = hasAny(s, [
    "booking", "book", "reservation", "mag reserve", "mag-reserve",
    "paano magbook", "paano mag-book",
  ]);
  const asksAmenities = hasAny(s, [
    "amenities", "facilities", "pool", "swimming", "parking", "wifi",
    "wifi", "kitchen", "room", "kwarto", "luto", "pet", "pets",
    "address", "location", "saan kayo", "nasaan kayo",
  ]);
  const greeting = hasAny(s, [
    "hi", "hello", "good morning", "good afternoon", "good evening",
    "magandang umaga", "magandang hapon", "magandang gabi", " 문의",
  ]);

  const answers = [];

  if (asksPrice) answers.push(BUSINESS.rate);
  if (asksCheckIn) answers.push(BUSINESS.checkIn);
  if (asksCheckOut) answers.push(BUSINESS.checkOut);
  if (asksDuration) answers.push(BUSINESS.duration);
  if (asksExtra) answers.push(BUSINESS.extra);

  if (asksAvailability) {
    answers.push("Wala pa po akong access sa live availability calendar, kaya hindi ako makakapag-confirm kung bakante ang date. Paki-send po ang preferred date at i-check ito sa owner/admin ng Page.");
  }

  if (asksBooking) {
    answers.push("Para magpa-check ng booking, ihanda po ang preferred date at bilang ng guests. Owner/admin po ang magche-check ng availability at magbibigay ng final confirmation. Hindi pa po confirmed ang booking hangga't hindi ito kinukumpirma ng owner.");
  }

  if (asksAmenities) {
    answers.push("Pasensya na po, wala pa sa aking verified information ang kumpletong listahan ng amenities, address, at house rules. Paki-message po ang owner/admin ng Page para sa eksaktong detalye.");
  }

  if (answers.length) {
    return answers.join("\n\n");
  }

  if (greeting || s.length < 18) {
    return "Hello po! Welcome sa Pahingahan Stay Cation. 😊 Maaari po kayong magtanong tungkol sa rates, 22-hour stay, check-in/check-out, additional person, at booking.";
  }

  return "Salamat po sa inyong inquiry! Ang alam kong details ay ₱1,950 para sa 22-hour stay, check-in 2:00 PM, check-out 12:00 noon kinabukasan, at ₱200 bawat additional person. Para sa amenities, exact availability, at iba pang detalye, paki-message po ang owner/admin ng Page para makumpirma nang tama.";
}

function hasAny(text, keywords) {
  return keywords.some((keyword) => text.includes(keyword));
}

async function sendMessengerReply(recipientId, message, env) {
  if (!env.PAGE_ACCESS_TOKEN) {
    throw new Error("Missing PAGE_ACCESS_TOKEN secret");
  }

  const response = await fetch(
    "https://graph.facebook.com/" + GRAPH_API_VERSION +
      "/me/messages?access_token=" + encodeURIComponent(env.PAGE_ACCESS_TOKEN),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recipient: { id: recipientId },
        messaging_type: "RESPONSE",
        message: { text: String(message).slice(0, 2000) },
      }),
    }
  );

  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error("Messenger Send API error:", response.status, JSON.stringify(result));
    throw new Error("Messenger Send API failed: " + response.status);
  }
  console.log("Messenger reply sent successfully.");
}
