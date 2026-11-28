const GRAPH_API_VERSION = "v27.0";

const HANDOFF =
  "Para sa payment at final reservation confirmation, owner po mismo ang mag-aassist. Paki-message po ang owner/admin ng Page para ma-check at maasikaso ang inyong booking. Huwag pong magpadala ng payment hangga't hindi direktang kinukumpirma ng owner.";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/office")) {
      return handleOfficeApi(request, env);
    }

    if (request.method === "GET") {
      const mode = url.searchParams.get("hub.mode");
      const token = url.searchParams.get("hub.verify_token");
      const challenge = url.searchParams.get("hub.challenge");

      if (mode === "subscribe" && token && token === env.VERIFY_TOKEN) {
        return new Response(challenge || "", { status: 200 });
      }
      return new Response("Pahingahan Messenger Worker is running.", { status: 200 });
    }

    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    const rawBody = await request.text();
    const signature = request.headers.get("x-hub-signature-256");
    const valid = await verifySignature(rawBody, signature, env.APP_SECRET);

    if (!valid) return new Response("Invalid signature", { status: 401 });

    let body;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }

    ctx.waitUntil(processWebhookEvents(body, env));
    return new Response("EVENT_RECEIVED", { status: 200 });
  }
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
  const expected = Array.from(new Uint8Array(digest))
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
        if (!senderId || (event.message && event.message.is_echo)) continue;

        const incoming = event.message && event.message.text;
        const reply = incoming && incoming.trim()
          ? buildFaqReply(incoming.trim())
          : "Salamat po sa pag-message! Maaari po bang i-type ang inyong tanong para matulungan namin kayo?";

        await sendMessengerReply(senderId, reply, env);
      } catch (error) {
        console.error("Messenger event error:", error && error.message);
      }
    }
  }
}

function buildFaqReply(message) {
  const s = message.toLowerCase().trim();

  if (hasAny(s, [
    "payment", "magbabayad", "bayad na", "downpayment", "down payment",
    "gcash", "bank", "deposit", "account number", "qr", "resibo", "receipt",
    "paid na", "pa-reserve", "pa reserve", "reserve na", "book na",
    "confirm booking", "booking confirmation", "pa-confirm", "pa confirm"
  ])) return HANDOFF;

  if (hasAny(s, ["available", "availability", "bakante", "may slot", "open pa", "vacant", "free pa"])) {
    return "I-check po muna natin ang date ninyo. Wala pa akong direct access sa live calendar, kaya owner/admin po ang magko-confirm kung available. Anong date po ang balak ninyo?";
  }

  if (hasAny(s, ["amenities", "facilities", "pool", "swimming", "parking", "wifi", "kitchen", "address", "location", "house rules", "pets"])) {
    return "Para tama po ang maibigay kong impormasyon, owner/admin po muna ang magko-confirm ng amenities, address, at house rules. 😊";
  }

  if (hasAny(s, ["magkano", "presyo", "price", "rate", "rates", "hm", "how much", "cost"])) {
    return "₱1,950 po ang rate for 22 hours. Check-in po ay 2:00 PM at check-out ay 12:00 noon kinabukasan. 😊";
  }

  if (hasAny(s, ["check in", "check-in", "checkin", "oras pasok"])) {
    return "Check-in po ay 2:00 PM. 😊";
  }

  if (hasAny(s, ["check out", "check-out", "checkout", "oras alis"])) {
    return "Check-out po ay 12:00 noon kinabukasan. 😊";
  }

  if (hasAny(s, ["ilang oras", "how many hours", "how long", "duration", "gaano katagal"])) {
    return "Up to 22 hours po ang stay natin. Check-in ay 2:00 PM at check-out ay 12:00 noon kinabukasan. 😊";
  }

  if (hasAny(s, ["additional", "extra person", "extra guest", "dagdag na tao", "per head", "per person"])) {
    return "₱200 po bawat additional person. 😊";
  }

  if (hasAny(s, ["booking", "book", "reservation", "mag reserve", "mag-reserve", "paano magbook"])) {
    return "Sure po! 😊 I-send lang po ang preferred date at bilang ng guests. Iche-check ng owner/admin ang availability at siya rin ang magbibigay ng final booking confirmation.";
  }

  if (hasAny(s, ["hi", "hello", "good morning", "good afternoon", "good evening", "magandang umaga", "magandang hapon", "magandang gabi"]) || s.length < 18) {
    return "Hello po! Welcome sa Pahingahan Stay Cation. 😊 Ano pong maitutulong namin? Maaari po kayong magtanong tungkol sa rates, check-in/check-out, additional person, o booking.";
  }

  return "Salamat po sa pag-message sa Pahingahan Stay Cation! 😊 Ang rate po ay ₱1,950 for 22 hours; check-in ay 2:00 PM at check-out ay 12:00 noon kinabukasan. Para sa ibang detalye, owner/admin po ang makakapag-confirm.";
}

function hasAny(value, words) {
  return words.some((word) => value.includes(word));
}

async function sendMessengerReply(recipientId, message, env) {
  if (!env.PAGE_ACCESS_TOKEN) throw new Error("Missing PAGE_ACCESS_TOKEN secret");

  const response = await fetch(
    "https://graph.facebook.com/" + GRAPH_API_VERSION +
    "/me/messages?access_token=" + encodeURIComponent(env.PAGE_ACCESS_TOKEN),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recipient: { id: recipientId },
        messaging_type: "RESPONSE",
        message: { text: String(message).slice(0, 2000) }
      })
    }
  );

  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error("Messenger API error:", response.status, JSON.stringify(result));
    throw new Error("Messenger Send API failed: " + response.status);
  }
}

async function handleOfficeApi(request, env) {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Office-Key"
  };

  function json(data, status) {
    return new Response(JSON.stringify(data), {
      status: status || 200,
      headers: { ...cors, "Content-Type": "application/json; charset=utf-8" }
    });
  }

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors });
  }

  if (!env.DB) return json({ error: "D1 binding DB is not configured." }, 503);
  if (!env.OFFICE_ADMIN_TOKEN) return json({ error: "OFFICE_ADMIN_TOKEN secret is not configured." }, 503);

  const encodedKey = request.headers.get("X-Office-Key") || "";
  let decodedKey = "";
  try {
    const binary = atob(encodedKey);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    decodedKey = new TextDecoder().decode(bytes);
  } catch {
    decodedKey = "";
  }

  if (decodedKey !== env.OFFICE_ADMIN_TOKEN) {
    return json({ error: "Unauthorized. Check your Office access key." }, 401);
  }

  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "");

  try {
    if (request.method === "GET" && path === "/api/office") {
      const results = await Promise.all([
        env.DB.prepare("SELECT * FROM tasks ORDER BY id DESC LIMIT 100").all(),
        env.DB.prepare("SELECT * FROM leads ORDER BY id DESC LIMIT 100").all(),
        env.DB.prepare("SELECT * FROM activity_logs ORDER BY id DESC LIMIT 100").all(),
        env.DB.prepare("SELECT * FROM agent_memory ORDER BY id DESC LIMIT 100").all()
      ]);
      return json({
        ok: true,
        tasks: results[0].results || [],
        leads: results[1].results || [],
        logs: results[2].results || [],
        memories: results[3].results || []
      });
    }

    if (request.method === "POST" && path === "/api/office/tasks") {
      const body = await request.json();
      if (!body.title || !String(body.title).trim()) {
        return json({ error: "Task title is required." }, 400);
      }

      const title = String(body.title).trim().slice(0, 200);
      const description = String(body.description || "").slice(0, 3000);
      const agent = String(body.assigned_agent || "General Manager").slice(0, 80);
      const priority = ["low", "normal", "high"].includes(body.priority) ? body.priority : "normal";

      const result = await env.DB.prepare(
        "INSERT INTO tasks (title, description, assigned_agent, status, priority) VALUES (?, ?, ?, 'pending', ?)"
      ).bind(title, description, agent, priority).run();

      await env.DB.prepare(
        "INSERT INTO activity_logs (agent_name, action, details) VALUES (?, ?, ?)"
      ).bind("General Manager", "Task created", title + " -> " + agent).run();

      return json({ ok: true, id: result.meta && result.meta.last_row_id, status: "pending" }, 201);
    }

    if (request.method === "PATCH" && path.startsWith("/api/office/tasks/")) {
      const id = Number(path.split("/").pop());
      const body = await request.json();
      const status = String(body.status || "");

      if (!Number.isInteger(id) || id < 1 || !["pending", "in_progress", "completed", "blocked"].includes(status)) {
        return json({ error: "Invalid task id or status." }, 400);
      }

      await env.DB.prepare(
        "UPDATE tasks SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
      ).bind(status, id).run();

      await env.DB.prepare(
        "INSERT INTO activity_logs (agent_name, action, details) VALUES (?, ?, ?)"
      ).bind(String(body.agent_name || "General Manager"), "Task status changed", "Task #" + id + " -> " + status).run();

      return json({ ok: true, id: id, status: status });
    }

    if (request.method === "POST" && path === "/api/office/leads") {
      const body = await request.json();
      const result = await env.DB.prepare(
        "INSERT INTO leads (client_name, source, post_url, inquiry, suggested_reply, status) VALUES (?, ?, ?, ?, ?, 'new')"
      ).bind(
        String(body.client_name || "").slice(0, 160),
        String(body.source || "").slice(0, 300),
        String(body.post_url || "").slice(0, 1000),
        String(body.inquiry || "").slice(0, 3000),
        String(body.suggested_reply || "").slice(0, 2000)
      ).run();

      await env.DB.prepare(
        "INSERT INTO activity_logs (agent_name, action, details) VALUES (?, ?, ?)"
      ).bind("Client Hunting", "Lead saved", String(body.client_name || "Unnamed lead").slice(0, 160)).run();

      return json({ ok: true, id: result.meta && result.meta.last_row_id }, 201);
    }

    if (request.method === "POST" && path === "/api/office/memory") {
      const body = await request.json();
      if (!body.agent_name || !body.memory) {
        return json({ error: "agent_name and memory are required." }, 400);
      }

      await env.DB.prepare(
        "INSERT INTO agent_memory (agent_name, memory) VALUES (?, ?)"
      ).bind(String(body.agent_name).slice(0, 80), String(body.memory).slice(0, 4000)).run();

      return json({ ok: true });
    }

    return json({ error: "Office API route not found." }, 404);
  } catch (error) {
    console.error("Office API error:", error && error.message);
    return json({ error: "Office API request failed." }, 500);
  }
}
