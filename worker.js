const GRAPH_API_VERSION = "v27.0";

const HANDOFF =
  "Para sa payment at final reservation confirmation, owner po mismo ang mag-aassist. Paki-message po ang owner/admin ng Page para ma-check at maasikaso ang inyong booking. Huwag pong magpadala ng payment hangga't hindi direktang kinukumpirma ng owner.";

export default {
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runManagerRoutine(env));
  },

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

async function runManagerRoutine(env) {
  if (!env.DB) {
    console.error("Manager routine skipped: D1 binding DB is missing.");
    return;
  }

  try {
    const result = await env.DB.prepare(
      "SELECT status, COUNT(*) AS total FROM tasks GROUP BY status"
    ).all();

    const counts = { pending: 0, in_progress: 0, completed: 0, blocked: 0 };
    for (const row of result.results || []) {
      if (Object.prototype.hasOwnProperty.call(counts, row.status)) {
        counts[row.status] = Number(row.total) || 0;
      }
    }

    const details =
      "Scheduled operations check. Pending: " + counts.pending +
      ", in progress: " + counts.in_progress +
      ", completed: " + counts.completed +
      ", blocked: " + counts.blocked +
      ". This routine monitors task status only; it does not execute tasks.";

    await env.DB.prepare(
      "INSERT INTO activity_logs (agent_name, action, details) VALUES (?, ?, ?)"
    ).bind("General Manager", "Automatic operations check", details).run();

    console.log(details);
  } catch (error) {
    console.error("Manager routine failed:", error && error.message);
  }
}

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

    if (request.method === "POST" && path === "/api/office/manager/delegate") {
      const body = await request.json();
      const instruction = String(body.instruction || "").trim().slice(0, 2000);
      if (!instruction) return json({ error: "Instruction is required." }, 400);
      if (!env.AI || typeof env.AI.run !== "function") {
        return json({ error: "Workers AI binding AI is not configured on this Worker." }, 503);
      }

      const allowedAgents = [
        "Customer Relations",
        "Client Hunting",
        "Creative & Editing",
        "Booking & Scheduling",
        "General Manager"
      ];
      let agent = "General Manager";
      let reason = "AI could not confidently classify the task; manager review is required.";
      let title = ("Manager delegation: " + instruction).slice(0, 200);

      function normalizeAgent(value) {
        const candidate = String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
        if (/customer|client relations|customer service|guest relations|support|crm/.test(candidate)) return "Customer Relations";
        if (/client hunting|lead generation|prospect|sales|marketing/.test(candidate)) return "Client Hunting";
        if (/creative|editing|design|content|social media/.test(candidate)) return "Creative & Editing";
        if (/booking|schedul|reservation|calendar/.test(candidate)) return "Booking & Scheduling";
        if (/general manager|manager|operations/.test(candidate)) return "General Manager";
        return null;
      }

      try {
        const aiResult = await env.AI.run("@cf/meta/llama-3.1-8b-instruct-fast", {
          messages: [
            {
              role: "system",
              content: "You are Michael, the General Manager of Pahingahan Stay Cation. Analyze the owner's instruction and delegate it to exactly one department. Allowed departments: Customer Relations, Client Hunting, Creative & Editing, Booking & Scheduling, General Manager. Never claim work is completed. Do not invent business facts, availability, amenities, prices, or customer details. Return ONLY valid JSON with keys: assigned_agent, task_title, reason. Keep task_title under 160 characters and reason under 300 characters."
            },
            {
              role: "user",
              content: "Owner instruction: " + instruction
            }
          ],
          max_tokens: 300,
          temperature: 0.2
        });

        function extractDelegation(value, depth = 0) {
          if (depth > 5 || value == null) return null;
          if (typeof value === "string") {
            const cleaned = value.trim().replace(/^\`\`\`(?:json)?\s*/i, "").replace(/\s*\`\`\`$/, "");
            const first = cleaned.indexOf("{");
            const last = cleaned.lastIndexOf("}");
            if (first < 0 || last <= first) return null;
            try { return extractDelegation(JSON.parse(cleaned.slice(first, last + 1)), depth + 1); }
            catch { return null; }
          }
          if (typeof value === "object") {
            if (value.assigned_agent) return value;
            for (const key of ["response", "result", "output", "content", "text", "generated_text"]) {
              if (value[key] !== undefined) {
                const found = extractDelegation(value[key], depth + 1);
                if (found) return found;
              }
            }
            for (const nested of Object.values(value)) {
              const found = extractDelegation(nested, depth + 1);
              if (found) return found;
            }
          }
          return null;
        }
        const parsed = extractDelegation(aiResult);
        if (!parsed) {
          throw new Error("Workers AI response did not contain a valid JSON delegation object. Response shape: " + JSON.stringify(aiResult).slice(0, 350));
        }
        const normalizedAgent = normalizeAgent(parsed.assigned_agent);
        if (!normalizedAgent || !allowedAgents.includes(normalizedAgent)) {
          throw new Error("AI returned an unrecognized department label: " + String(parsed.assigned_agent).slice(0, 120));
        }
        agent = normalizedAgent;
        reason = String(parsed.reason || reason).slice(0, 300);
        title = String(parsed.task_title || title).slice(0, 200);
      } catch (error) {
        const detail = String(error && (error.stack || error.message) || error || "Unknown Workers AI error").slice(0, 700);
        console.error("Manager AI delegation failed:", detail);
        return json({
          error: "Michael could not analyze this instruction. Workers AI detail: " + detail,
          details: detail
        }, 502);
      }

      const result = await env.DB.prepare(
        "INSERT INTO tasks (title, description, assigned_agent, status, priority) VALUES (?, ?, ?, 'pending', 'normal')"
      ).bind(title, instruction, agent).run();

      const id = result.meta && result.meta.last_row_id;
      await env.DB.prepare(
        "INSERT INTO activity_logs (agent_name, action, details) VALUES (?, ?, ?)"
      ).bind("General Manager", "AI task delegated", "Task #" + id + " -> " + agent + ": " + reason).run();

      return json({ ok: true, id, assigned_agent: agent, reason, status: "pending", model: "@cf/meta/llama-3.1-8b-instruct-fast" }, 201);
    }

    if (request.method === "POST" && path === "/api/office/agents/customer-relations/execute") {
      const body = await request.json();
      const taskId = Number(body.task_id);
      if (!Number.isInteger(taskId) || taskId < 1) return json({ error: "A valid task_id is required." }, 400);
      if (!env.AI || typeof env.AI.run !== "function") return json({ error: "Workers AI binding AI is not configured." }, 503);

      const taskResult = await env.DB.prepare("SELECT * FROM tasks WHERE id = ?").bind(taskId).first();
      if (!taskResult) return json({ error: "Task not found." }, 404);
      if (taskResult.assigned_agent !== "Customer Relations") return json({ error: "This task is not assigned to Customer Relations." }, 409);
      if (taskResult.status === "completed") return json({ error: "This task is already completed. Check Agent Work Output below." }, 409);

      await env.DB.prepare("UPDATE tasks SET status = 'in_progress', updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(taskId).run();

      try {
        const aiResult = await env.AI.run("@cf/meta/llama-3.1-8b-instruct-fast", {
          messages: [
            {
              role: "system",
              content: "You are Emma, Customer Relations agent for Pahingahan Stay Cation in the Philippines. Create a practical customer response playbook in friendly, natural Taglish. VERIFIED FACTS ONLY: rate ₱1,950 for a 22-hour stay; check-in 2:00 PM; checkout 12:00 noon the next day; additional person ₱200 each. The owner handles payments and gives final booking confirmation. A requested slot may be held for 4 hours while payment is arranged, but do not imply it is held unless owner confirms. Do not invent included guest count, amenities, address, capacity, availability, house rules, payment account details, or policies. For unknown facts, clearly say ask owner/admin. Never claim a booking is confirmed or a date is available. Produce: (1) short task summary, (2) ready-to-use replies for greeting, price, booking/date/guest details, availability, check-in/out, extra guest, amenities/location, payment and final confirmation handoff, (3) safety notes for staff. Keep concise and usable. Output plain text, no JSON.";
            },
            {
              role: "user",
              content: "Complete this assigned task and produce the customer response playbook. Task title: " + taskResult.title + "\nTask instructions: " + String(taskResult.description || "Create improved customer response templates.").slice(0, 3000)
            }
          ],
          max_tokens: 1000,
          temperature: 0.3
        });

        function extractText(value, depth = 0) {
          if (depth > 6 || value == null) return "";
          if (typeof value === "string") return value.trim();
          if (typeof value === "object") {
            for (const key of ["response", "generated_text", "text", "output", "content", "result"]) {
              if (value[key] !== undefined) {
                const found = extractText(value[key], depth + 1);
                if (found) return found;
              }
            }
            for (const nested of Object.values(value)) {
              const found = extractText(nested, depth + 1);
              if (found) return found;
            }
          }
          return "";
        }

        const output = extractText(aiResult);
        if (!output) throw new Error("Workers AI returned no readable text. Response shape: " + JSON.stringify(aiResult).slice(0, 300));

        await env.DB.prepare("INSERT INTO agent_memory (agent_name, memory) VALUES (?, ?)").bind(
          "Customer Relations",
          "Output for task #" + taskId + " — " + taskResult.title + "\\n" + output.slice(0, 3900)
        ).run();
        await env.DB.prepare("INSERT INTO activity_logs (agent_name, action, details) VALUES (?, ?, ?)").bind(
          "Customer Relations",
          "Task executed",
          "Completed task #" + taskId + " and saved customer response playbook to Agent Work Output."
        ).run();
        await env.DB.prepare("UPDATE tasks SET status = 'completed', updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(taskId).run();

        return json({ ok: true, task_id: taskId, status: "completed", output }, 200);
      } catch (error) {
        await env.DB.prepare("UPDATE tasks SET status = 'blocked', updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(taskId).run();
        await env.DB.prepare("INSERT INTO activity_logs (agent_name, action, details) VALUES (?, ?, ?)").bind(
          "Customer Relations", "Task execution failed", "Task #" + taskId + ": " + String(error && error.message || error).slice(0, 300)
        ).run();
        return json({ error: "Customer Relations could not complete the task: " + String(error && error.message || error).slice(0, 400) }, 502);
      }
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
