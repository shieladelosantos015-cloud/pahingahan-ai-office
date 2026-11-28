const GRAPH_API_VERSION = "v27.0";

const HANDOFF =
  "Para po sa payment or downpayment, please wait lang po muna sandali. Ako po ang magbibigay sa inyo ng payment details kung saan ninyo puwedeng i-send ang downpayment. Thank you po! 😊";

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
          ? await buildMessengerReply(incoming.trim(), env, senderId)
          : "Salamat po sa pag-message! Maaari po bang i-type ang inyong tanong para matulungan namin kayo?";

        await sendMessengerReply(senderId, reply, env);
      } catch (error) {
        console.error("Messenger event error:", error && error.message);
      }
    }
  }
}

function extractRequestedDate(message) {
  const text = String(message || "").toLowerCase();
  let match = text.match(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/);
  if (match) return makeDateString(Number(match[1]), Number(match[2]), Number(match[3]));
  match = text.match(/\b(\d{1,2})[\/.-](\d{1,2})[\/.-](20\d{2})\b/);
  if (match) return makeDateString(Number(match[3]), Number(match[2]), Number(match[1]));

  const months = {
    january:1, jan:1, february:2, feb:2, march:3, mar:3, april:4, apr:4,
    may:5, june:6, jun:6, july:7, jul:7, august:8, aug:8, september:9,
    sep:9, sept:9, october:10, oct:10, november:11, nov:11, december:12, dec:12
  };
  match = text.match(/\b(january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sept|sep|october|oct|november|nov|december|dec)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(20\d{2}))?\b/);
  if (match) {
    const now = new Date();
    let year = match[3] ? Number(match[3]) : now.getFullYear();
    const month = months[match[1]];
    const day = Number(match[2]);
    let result = makeDateString(year, month, day);
    if (!match[3] && result && result < manilaToday()) result = makeDateString(year + 1, month, day);
    return result;
  }
  return null;
}

function makeDateString(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return String(year).padStart(4, "0") + "-" + String(month).padStart(2, "0") + "-" + String(day).padStart(2, "0");
}

function manilaToday() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

async function ensureBookingInquiriesTable(env) {
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS booking_inquiries (id INTEGER PRIMARY KEY AUTOINCREMENT, sender_id TEXT NOT NULL, requested_date TEXT NOT NULL, client_name TEXT, guests INTEGER, status TEXT NOT NULL DEFAULT 'awaiting_details', created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP)").run();
}

async function getActiveBookingInquiry(env, senderId) {
  await ensureBookingInquiriesTable(env);
  return await env.DB.prepare("SELECT * FROM booking_inquiries WHERE sender_id = ? AND status IN ('awaiting_details','awaiting_owner_payment') ORDER BY id DESC LIMIT 1").bind(senderId).first();
}

function parseBookingDetails(message) {
  const text = String(message || '').trim();
  let name = null;
  let guests = null;
  let match = text.match(/(?:pangalan|name)\s*[:=-]\s*([^;\n,]+)/i);
  if (match) name = match[1].trim().slice(0, 100);

  if (!name) {
    match = text.match(/(?:ako po si|ako si|this is|i am|i'm)\s+([a-z][a-z .'-]{1,80})/i);
    if (match) name = match[1].trim().replace(/[.!?]+$/, '').slice(0, 100);
  }

  const guestMatch = text.match(/(?:guests?|pax|katao|persons?|people|kami)\s*[:=-]?\s*\d{1,2}|\d{1,2}\s*(?:guests?|pax|katao|persons?|people|kami|adults?)/i);
  if (guestMatch) {
    const countMatch = guestMatch[0].match(/\d{1,2}/);
    const count = countMatch ? Number(countMatch[0]) : 0;
    if (count >= 1 && count <= 50) guests = count;

    if (!name) {
      const candidate = text.slice(0, guestMatch.index).replace(/[;,\s:-]+$/, '').trim();
      if (/[a-z]/i.test(candidate)) name = candidate.replace(/[.!?]+$/, '').slice(0, 100);
    }
  }

  return { name, guests };
}

async function saveBookingInquiryDetails(env, inquiry, details) {
  const name = details.name || inquiry.client_name || null;
  const guests = details.guests || inquiry.guests || null;
  const status = name && guests ? 'awaiting_owner_payment' : 'awaiting_details';
  await env.DB.prepare('UPDATE booking_inquiries SET client_name = ?, guests = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').bind(name, guests, status, inquiry.id).run();
  if (status === 'awaiting_owner_payment') {
    await env.DB.prepare('INSERT INTO activity_logs (agent_name, action, details) VALUES (?, ?, ?)').bind('Booking & Scheduling', 'Booking inquiry ready for owner', 'Inquiry #' + inquiry.id + ' — ' + name + ', ' + guests + ' guest(s), ' + inquiry.requested_date).run();
  }
  return { name, guests, status };
}

function requestedCalendarMonth(message) {
  const text = String(message || '').toLowerCase();
  const months = { january:1, jan:1, february:2, feb:2, march:3, mar:3, april:4, apr:4, may:5, june:6, jun:6, july:7, jul:7, august:8, aug:8, september:9, sept:9, sep:9, october:10, oct:10, november:11, nov:11, december:12, dec:12 };
  const match = text.match(/\b(january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sept|sep|october|oct|november|nov|december|dec)\s+(20\d{2})\b/i);
  if (match) return { year: Number(match[2]), month: months[match[1]] };
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-US', { timeZone:'Asia/Manila', year:'numeric', month:'numeric' }).formatToParts(now);
  return { year:Number(parts.find(p => p.type === 'year').value), month:Number(parts.find(p => p.type === 'month').value) };
}

async function buildCalendarImageUrl(env, monthInfo) {
  const year = monthInfo.year;
  const month = monthInfo.month;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const firstWeekday = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const available = [];
  const unavailable = [];
  const errors = [];
  const today = manilaToday();

  for (let day = 1; day <= daysInMonth; day++) {
    const date = makeDateString(year, month, day);
    const x = (firstWeekday + day - 1) % 7;
    const y = Math.floor((firstWeekday + day - 1) / 7);
    if (date < today) continue;
    try {
      const result = await callGoogleCalendar(env, { action:'availability', date });
      if (!result || result.success !== true || typeof result.available !== 'boolean') {
        errors.push(date);
        continue;
      }
      const point = { x, y, day, v:day };
      (result.available ? available : unavailable).push(point);
    } catch (error) {
      console.error('Calendar image date check failed:', date, error && error.message);
      errors.push(date);
    }
  }

  if (errors.length) throw new Error('Could not verify all dates in the requested month.');
  const monthName = new Intl.DateTimeFormat('en-US', { month:'long', timeZone:'UTC' }).format(new Date(Date.UTC(year, month - 1, 1)));
  const config = {
    type:'matrix',
    data:{
      datasets:[
        { label:'Available', data:available, backgroundColor:'#28a745', borderColor:'#ffffff', borderWidth:3, width:42, height:42 },
        { label:'Booked', data:unavailable, backgroundColor:'#dc3545', borderColor:'#ffffff', borderWidth:3, width:42, height:42 }
      ]
    },
    options:{
      responsive:false,
      plugins:{
        title:{ display:true, text:'PAHINGAHAN STAY CATION — '+monthName.toUpperCase()+' '+year, font:{size:24,weight:'bold'}, color:'#20252b', padding:18 },
        legend:{ display:true, position:'bottom', labels:{font:{size:16}, usePointStyle:true, padding:20} },
        datalabels:{ display:true, color:'#ffffff', font:{size:16,weight:'bold'} }
      },
      scales:{
        x:{ type:'linear', min:-0.5, max:6.5, ticks:{ stepSize:1, callback:(v)=>['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][v], font:{size:14,weight:'bold'} }, grid:{display:false}, offset:true },
        y:{ type:'linear', min:-0.5, max:5.5, reverse:true, ticks:{display:false,stepSize:1}, grid:{display:false}, offset:true }
      }
    }
  };
  return 'https://quickchart.io/chart?width=900&height=720&format=png&backgroundColor=white&c=' + encodeURIComponent(JSON.stringify(config));
}

async function sendMessengerImage(recipientId, imageUrl, env) {
  if (!env.PAGE_ACCESS_TOKEN) throw new Error('Missing PAGE_ACCESS_TOKEN secret');
  const response = await fetch(
    'https://graph.facebook.com/' + GRAPH_API_VERSION + '/me/messages?access_token=' + encodeURIComponent(env.PAGE_ACCESS_TOKEN),
    {
      method:'POST',
      headers:{ 'Content-Type':'application/json' },
      body:JSON.stringify({
        recipient:{ id:recipientId },
        messaging_type:'RESPONSE',
        message:{ attachment:{ type:'image', payload:{ url:imageUrl, is_reusable:true } } }
      })
    }
  );
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error('Messenger image API error:', response.status, JSON.stringify(result));
    throw new Error('Messenger image send failed: ' + response.status);
  }
}

async function buildMessengerReply(message, env, senderId) {
  const lowerMessage = String(message || '').toLowerCase();
  const asksCalendarImage = hasAny(lowerMessage, ['picture of calendar','photo of calendar','calendar picture','calendar photo','send calendar','show calendar','calendar image','picture ng calendar','photo ng calendar','screenshot ng calendar','calendar po','calendar','available dates','open dates','available slots','bakanteng dates']);
  if (asksCalendarImage) {
    try {
      const monthInfo = requestedCalendarMonth(message);
      const imageUrl = await buildCalendarImageUrl(env, monthInfo);
      await sendMessengerImage(senderId, imageUrl, env);
      const monthLabel = new Intl.DateTimeFormat('en-US', { month:'long', timeZone:'UTC' }).format(new Date(Date.UTC(monthInfo.year, monthInfo.month - 1, 1)));
      return 'Ito po ang calendar availability natin for ' + monthLabel + ' ' + monthInfo.year + '. 🗓️ Green = available; red = fully booked. Live calendar po ang chineck ko bago ginawa ang image. Paki-message lang po ang exact date na gusto ninyo para ma-check ko ulit bago mag-proceed sa booking. 😊';
    } catch (error) {
      console.error('Calendar image generation failed:', error && error.message);
      return 'Pasensya na po, hindi ko ma-generate ang calendar image ngayon dahil hindi ko ma-verify ang lahat ng dates. Maaari po bang subukan ulit mamaya, o sabihin ang exact date para ma-check ko? 😊';
    }
  }
  if (!env.DB) return 'Pasensya na po, may temporary issue sa booking system. Owner/admin po muna ang mag-a-assist sa inyo. 😊';
  const activeInquiry = await getActiveBookingInquiry(env, senderId);
  if (activeInquiry && activeInquiry.status === 'awaiting_details') {
    const saved = await saveBookingInquiryDetails(env, activeInquiry, parseBookingDetails(message));
    if (saved.status === 'awaiting_owner_payment') return 'Salamat po, ' + saved.name + '! 😊 Na-note ko na ang request ninyo para sa ' + activeInquiry.requested_date + ' para sa ' + saved.guests + ' guest(s). Ang rate po ay ₱1,400 for 22 hours, plus ₱150 bawat additional person. Required po ang ₱700 reservation downpayment para ma-secure ang slot; puwede rin pong full payment na ₱1,400. Ang remaining balance after downpayment ay ₱700, hindi pa kasama ang additional person kung meron. Alin po ang preferred ninyo? Kapag ready na po kayo, owner mismo ang magbibigay ng payment details. Hindi pa reserved ang slot hangga\'t hindi verified ang payment.';
    const missing = []; if (!saved.name) missing.push('pangalan'); if (!saved.guests) missing.push('bilang ng guests');
    return 'Salamat po! Pakibigay na lang po ang ' + missing.join(' at ') + ' para maipasa ko ang booking request ninyo. 😊';
  }
  if (activeInquiry && activeInquiry.status === 'awaiting_owner_payment') {
    if (hasAny(message.toLowerCase(), ['payment', 'downpayment', 'down payment', 'bayad', 'gcash', 'bank', 'deposit', 'full', '700', '1400', 'ready', 'sige', 'go'])) return HANDOFF;
    return 'Naka-note na po ang booking request ninyo para sa ' + activeInquiry.requested_date + '. Required po ang ₱700 downpayment para ma-secure ang slot, o puwede pong full payment na ₱1,400. Kapag ready na po kayo, owner mismo ang magbibigay ng payment details. 😊';
  }
  const s = message.toLowerCase();
  const asksAvailability = hasAny(s, ["available", "availability", "bakante", "may slot", "open pa", "vacant", "free pa", "gusto mag book", "want to book", "mag book", "mag-book", "pa-book", "pabook", "booking"]);
  if (!asksAvailability) return buildFaqReply(message);

  const date = extractRequestedDate(message);
  if (!date) {
    return "Sure po! 😊 Anong exact date po ang gusto ninyong i-book? Halimbawa: December 1, 2026. Iche-check ko po ang calendar natin.";
  }

  try {
    const result = await callGoogleCalendar(env, { action: "availability", date });
    if (!result || result.success !== true) {
      console.error("Calendar availability response:", JSON.stringify(result || {}));
      return "Pasensya na po, hindi ko ma-verify ang availability ngayon. Ipa-check ko po muna sa owner/admin bago tayo mag-confirm. 😊";
    }
    if (result.available === true) {
      await env.DB.prepare("INSERT INTO booking_inquiries (sender_id, requested_date, status) VALUES (?, ?, 'awaiting_details')").bind(senderId, date).run();
      return "Upon checking our calendar, available po ang " + date + "! 😊 Para maipasa ko ang booking request, pakibigay po ang inyong pangalan at bilang ng guests. Ang rate po ay ₱1,400 for 22 hours, plus ₱150 bawat additional person. Required po ang ₱700 downpayment para ma-secure ang slot, o puwede ring full payment na ₱1,400. Hindi pa po reserved ang slot hangga't hindi verified ang payment.";
    }
    return "Pasensya na po, hindi na available ang " + date + ". 😊 May iba pa po ba kayong preferred date para ma-check ko rin?";
  } catch (error) {
    console.error("Messenger calendar availability failed:", error && error.message);
    return "Pasensya na po, hindi ko ma-check ang calendar sa ngayon. Owner/admin po muna ang magve-verify ng availability. 😊";
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
    return "₱1,400 po ang rate for 22 hours. Check-in po ay 2:00 PM at check-out ay 12:00 noon kinabukasan. 😊";
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
    return "₱150 po bawat additional person. 😊";
  }

  if (hasAny(s, ["booking", "book", "reservation", "mag reserve", "mag-reserve", "paano magbook"])) {
    return "Sure po! 😊 I-send lang po ang preferred date at bilang ng guests. Iche-check ng owner/admin ang availability at siya rin ang magbibigay ng final booking confirmation.";
  }

  if (hasAny(s, ["hi", "hello", "good morning", "good afternoon", "good evening", "magandang umaga", "magandang hapon", "magandang gabi"]) || s.length < 18) {
    return "Hello po! Welcome sa Pahingahan Stay Cation. 😊 Ano pong maitutulong namin? Maaari po kayong magtanong tungkol sa rates, check-in/check-out, additional person, o booking.";
  }

  return "Salamat po sa pag-message sa Pahingahan Stay Cation! 😊 Ang rate po ay ₱1,400 for 22 hours; check-in ay 2:00 PM at check-out ay 12:00 noon kinabukasan. Para sa ibang detalye, owner/admin po ang makakapag-confirm.";
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

async function callGoogleCalendar(env, payload) {
  if (!env.GOOGLE_CALENDAR_URL || !env.GOOGLE_CALENDAR_API_KEY) {
    throw new Error("Google Calendar URL or API key secret is not configured.");
  }
  const response = await fetch(env.GOOGLE_CALENDAR_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...payload,
      api_key: env.GOOGLE_CALENDAR_API_KEY
    })
  });
  const raw = await response.text();
  let result;
  try {
    result = JSON.parse(raw);
  } catch {
    throw new Error("Google Calendar returned a non-JSON response. Check Apps Script deployment and permissions.");
  }
  if (!response.ok) {
    throw new Error("Google Calendar request failed with HTTP " + response.status + ".");
  }
  return result;
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
    if (request.method === "POST" && path === "/api/office/calendar/availability") {
      const body = await request.json();
      const date = String(body.date || "");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || isNaN(new Date(date + "T00:00:00+08:00").getTime())) {
        return json({ error: "A valid date in YYYY-MM-DD format is required." }, 400);
      }
      const result = await callGoogleCalendar(env, {
        action: "availability",
        date
      });
      if (!result.success) return json({ error: result.error || "Calendar availability check failed." }, 502);
      return json(result);
    }

    if (request.method === "POST" && path === "/api/office/calendar/book") {
      const body = await request.json();
      const date = String(body.date || "");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || isNaN(new Date(date + "T00:00:00+08:00").getTime())) {
        return json({ error: "A valid date in YYYY-MM-DD format is required." }, 400);
      }
      if (body.owner_confirmed_payment !== true) {
        return json({ error: "Owner payment confirmation is required before booking." }, 403);
      }
      const result = await callGoogleCalendar(env, {
        action: "create_booking",
        date,
        client_name: String(body.client_name || "Guest").slice(0, 100),
        guests: String(body.guests || "Not specified").slice(0, 50),
        owner_confirmed_payment: true
      });
      if (!result.success) return json({ error: result.error || "Calendar booking failed." }, 409);
      await env.DB.prepare(
        "INSERT INTO activity_logs (agent_name, action, details) VALUES (?, ?, ?)"
      ).bind("Booking & Scheduling", "Google Calendar booking created", "Calendar event created for " + date + " — " + String(body.client_name || "Guest").slice(0, 100)).run();
      return json(result, 201);
    }

    if (request.method === "POST" && /^\/api\/office\/bookings\/\d+\/confirm-payment$/.test(path)) {
      const inquiryId = Number(path.split("/")[4]);
      await ensureBookingInquiriesTable(env);
      const inquiry = await env.DB.prepare("SELECT * FROM booking_inquiries WHERE id = ?").bind(inquiryId).first();
      if (!inquiry) return json({ error: "Booking inquiry not found." }, 404);
      if (inquiry.status !== "awaiting_owner_payment") return json({ error: "This inquiry is not ready for owner payment confirmation." }, 409);
      const result = await callGoogleCalendar(env, { action: "create_booking", date: inquiry.requested_date, client_name: inquiry.client_name, guests: String(inquiry.guests), owner_confirmed_payment: true });
      if (!result.success) return json({ error: result.error || "Calendar booking failed." }, 409);
      await env.DB.prepare("UPDATE booking_inquiries SET status = 'booked', updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(inquiryId).run();
      await env.DB.prepare("INSERT INTO activity_logs (agent_name, action, details) VALUES (?, ?, ?)").bind("Booking & Scheduling", "Owner confirmed payment and booking", "Inquiry #" + inquiryId + " — " + inquiry.client_name + ", " + inquiry.guests + " guest(s), " + inquiry.requested_date).run();
      return json({ ok: true, inquiry_id: inquiryId, status: "booked", calendar: result }, 201);
    }
    if (request.method === "GET" && path === "/api/office") {
      await ensureBookingInquiriesTable(env);
      const results = await Promise.all([
        env.DB.prepare("SELECT * FROM tasks ORDER BY id DESC LIMIT 100").all(),
        env.DB.prepare("SELECT * FROM leads ORDER BY id DESC LIMIT 100").all(),
        env.DB.prepare("SELECT * FROM activity_logs ORDER BY id DESC LIMIT 100").all(),
        env.DB.prepare("SELECT * FROM agent_memory ORDER BY id DESC LIMIT 100").all(),
        env.DB.prepare("SELECT * FROM booking_inquiries ORDER BY id DESC LIMIT 100").all()
      ]);
      return json({
        ok: true,
        tasks: results[0].results || [],
        leads: results[1].results || [],
        logs: results[2].results || [],
        memories: results[3].results || [],
        booking_inquiries: results[4].results || []
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
              content: [
                "You are Emma, the Customer Relations agent for Pahingahan Stay Cation in the Philippines.",
                "Write in natural, warm, polite Filipino/Taglish. Address customers respectfully using po/opo. Avoid stiff literal translations, awkward phrases, and unnecessary English.",
                "Verified facts: rate PHP 1,950 for 22 hours; check-in 2:00 PM; checkout 12:00 noon the next day; each additional person PHP 200.",
                "Ask customers for their preferred date and number of guests when they want to book. Owner/admin checks live availability and gives final booking confirmation.",
                "The owner handles all payment instructions and final booking confirmation. Direct payment questions and requests to pay to the owner/admin. Never invent payment methods, account details, or payment instructions.",
                "A requested slot may be held for 4 hours while payment is arranged ONLY if the owner confirms the hold. Never imply a hold or availability without confirmation.",
                "Never invent included guest count, amenities, address, capacity, availability, house rules, or policies. For unknown amenities/location, say owner/admin will confirm the verified details. Never output placeholders.",
                "Create a concise playbook and complete ready-to-send Messenger replies. Use these styles: Greeting: 'Hello po! Welcome sa Pahingahan Stay Cation. 😊 Ano pong maitutulong namin?' Price: '₱1,400 po ang rate natin for 22 hours. Check-in po ay 2:00 PM at check-out ay 12:00 noon kinabukasan. 😊' Booking: 'Sure po! 😊 Anong preferred date ninyo at ilan po kayong guests? Iche-check po ng owner/admin ang availability at siya rin ang magbibigay ng final confirmation.' Availability: 'Iche-check po muna ng owner/admin kung available ang preferred date ninyo. Anong date po ang balak ninyo?' Check-in: 'Check-in po ay 2:00 PM.' Checkout: 'Check-out po ay 12:00 noon kinabukasan.' Extra guests: '₱150 po ang bawat additional person.' Amenities/location: 'Para sa verified details tungkol sa amenities at location, owner/admin po muna ang magko-confirm. 😊' Payment: 'Owner/admin po mismo ang magbibigay ng payment instructions. Paki-message po sila directly para sa tamang details.' Final confirmation: 'Owner/admin po ang magbibigay ng final booking confirmation. Maraming salamat po!'",
                "Keep each customer reply short, natural, courteous, and directly usable. Do not use phrases like 'kailangan mo ng tawagan', 'sila ang magpapakita', or 'mabuti ba ang araw mo'.",
                "Include staff safety notes. Output plain text, not JSON."
              ].join(" "),
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
          "Output for task #" + taskId + " — " + taskResult.title + "\n" + output.slice(0, 3900)
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
