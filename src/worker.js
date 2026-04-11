// Tee Times - Cloudflare Worker
// Serves both the API and the static frontend

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2, 6);
}

function formatTime12(t) {
  if (!t) return "";
  const [h, m] = t.split(":").map(Number);
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 || 12;
  return `${h12}:${m.toString().padStart(2, "0")} ${ampm}`;
}

// ── MailChannels Paid API ─────────────────────────────────────────────
// Requires env.MAILCHANNELS_API_KEY secret and DNS TXT record:
//   _mailchannels.cmart073.com  →  v=mc1 auth=bb3bn8rbnzgfgv

function formatDate(dateStr) {
  return new Date(dateStr + "T00:00:00").toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric",
  });
}

function buildGroupList(teeTime) {
  return [teeTime.postedBy, ...(teeTime.claims || []).map((c) => c.name)].join(", ");
}

function teeTimeBlock(teeTime, extraLines) {
  const lines = [
    `Course: ${teeTime.course}`,
    `Date: ${formatDate(teeTime.date)}`,
    `Time: ${formatTime12(teeTime.time)}`,
  ];
  if (extraLines) lines.push(...extraLines);
  lines.push("", "View at: https://teetimes.cmart073.com");
  return lines.join("\n");
}

// Send one email to multiple recipients via MailChannels paid API
async function sendEmail(env, recipients, subject, body) {
  if (!recipients.length) {
    console.log("[EMAIL] No recipients, skipping");
    return;
  }
  const to = recipients.map((r) => ({ email: r.email, name: r.name }));
  const hasKey = !!env.MAILCHANNELS_API_KEY;
  console.log(`[EMAIL] Sending to ${to.map(r => r.email).join(", ")} | subject: ${subject} | API key present: ${hasKey}`);
  try {
    const payload = {
      personalizations: [{ to }],
      from: { email: "noreply@cmart073.com", name: "Tee Times" },
      subject,
      content: [{ type: "text/plain", value: body }],
    };
    const resp = await fetch("https://api.mailchannels.net/tx/v1/send", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Api-Key": env.MAILCHANNELS_API_KEY,
      },
      body: JSON.stringify(payload),
    });
    const respText = await resp.text();
    console.log(`[EMAIL] Response: ${resp.status} ${respText}`);
  } catch (e) {
    console.error("[EMAIL] Fetch failed:", e.message || e);
  }
}

// Get all group members for a tee time (owner + claimants)
function getGroupRecipients(teeTime, excludeName) {
  const recipients = [];
  if (teeTime.postedBy !== excludeName) {
    recipients.push({ name: teeTime.postedBy, email: teeTime.postedByEmail });
  }
  for (const c of teeTime.claims || []) {
    if (c.name !== excludeName) {
      recipients.push({ name: c.name, email: c.email });
    }
  }
  return recipients;
}

// ── Notification functions ───────────────────────────────────────────

// Someone claimed a spot → notify owner + all existing claimants
async function notifySpotClaimed(env, teeTime, claimer) {
  const spotsLeft = teeTime.spots - (teeTime.claims?.length || 0);
  const recipients = getGroupRecipients(teeTime, claimer);
  const subject = `⛳ ${claimer} joined the tee time at ${teeTime.course}`;
  const body = `${claimer} just claimed a spot!\n\n` +
    teeTimeBlock(teeTime, [
      `Group: ${buildGroupList(teeTime)}`,
      `Spots remaining: ${spotsLeft}`,
    ]);
  await sendEmail(env, recipients, subject, body);
}

// Someone cancelled → notify owner + remaining claimants
async function notifySpotCancelled(env, teeTime, canceller) {
  const spotsLeft = teeTime.spots - (teeTime.claims?.length || 0);
  const recipients = getGroupRecipients(teeTime, canceller);
  const subject = `${canceller} left the tee time at ${teeTime.course}`;
  const body = `${canceller} cancelled their spot.\n\n` +
    teeTimeBlock(teeTime, [
      `Group: ${buildGroupList(teeTime)}`,
      `Spots remaining: ${spotsLeft}`,
    ]);
  await sendEmail(env, recipients, subject, body);
}

// New tee time posted → notify all registered users (except poster)
async function notifyNewTeeTime(env, teeTime) {
  const list = await env.TEETIMES.list({ prefix: "user:" });
  const recipients = [];
  for (const key of list.keys) {
    const user = await env.TEETIMES.get(key.name, "json");
    if (user && user.email !== teeTime.postedByEmail) {
      recipients.push({ name: user.name, email: user.email });
    }
  }
  const subject = `⛳ ${teeTime.postedBy} posted a tee time at ${teeTime.course}`;
  const body = `${teeTime.postedBy} just posted a tee time!\n\n` +
    teeTimeBlock(teeTime, [
      `Open spots: ${teeTime.spots}`,
      ...(teeTime.notes ? [`Notes: ${teeTime.notes}`] : []),
    ]);
  await sendEmail(env, recipients, subject, body);
}

// Tee time deleted → notify everyone who was signed up
async function notifyTeeTimeDeleted(env, teeTime) {
  const recipients = [];
  for (const c of teeTime.claims || []) {
    recipients.push({ name: c.name, email: c.email });
  }
  if (!recipients.length) return;
  const subject = `${teeTime.postedBy} cancelled the tee time at ${teeTime.course}`;
  const body = `${teeTime.postedBy} deleted their tee time.\n\n` +
    teeTimeBlock(teeTime, []) +
    `\n\nThis tee time is no longer available.`;
  await sendEmail(env, recipients, subject, body);
}

async function handleAPI(request, env, path, ctx) {
  // GET /api/teetimes
  if (path === "/api/teetimes" && request.method === "GET") {
    const list = await env.TEETIMES.list({ prefix: "tt:" });
    const teeTimes = [];
    for (const key of list.keys) {
      const val = await env.TEETIMES.get(key.name, "json");
      if (val) teeTimes.push(val);
    }
    teeTimes.sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time));
    return json(teeTimes);
  }

  // POST /api/teetimes
  if (path === "/api/teetimes" && request.method === "POST") {
    const data = await request.json();
    const { course, date, time, spots, notes, postedBy, postedByEmail } = data;

    if (!course || !date || !time || !spots || !postedBy || !postedByEmail) {
      return json({ error: "Missing required fields" }, 400);
    }

    const id = generateId();
    const teeTime = {
      id,
      course,
      date,
      time,
      spots: Math.min(Math.max(parseInt(spots), 1), 3),
      notes: notes || "",
      postedBy,
      postedByEmail,
      claims: [],
      createdAt: new Date().toISOString(),
    };

    // Save user info
    await env.TEETIMES.put(`user:${postedBy}`, JSON.stringify({ name: postedBy, email: postedByEmail }));

    // Store tee time with 30-day expiry past the date
    const expDate = new Date(date + "T00:00:00");
    expDate.setDate(expDate.getDate() + 30);
    await env.TEETIMES.put(`tt:${id}`, JSON.stringify(teeTime), {
      expiration: Math.floor(expDate.getTime() / 1000),
    });

    // Notify all users about the new tee time
    ctx.waitUntil(notifyNewTeeTime(env, teeTime));

    return json(teeTime, 201);
  }

  // POST|DELETE /api/teetimes/:id/claim
  const claimMatch = path.match(/^\/api\/teetimes\/([^/]+)\/claim$/);
  if (claimMatch) {
    const id = claimMatch[1];
    const body = await request.json();
    const { name, email } = body;

    const teeTime = await env.TEETIMES.get(`tt:${id}`, "json");
    if (!teeTime) return json({ error: "Not found" }, 404);

    if (request.method === "POST") {
      const spotsLeft = teeTime.spots - (teeTime.claims?.length || 0);
      if (spotsLeft <= 0) return json({ error: "No spots left" }, 400);
      if (teeTime.claims?.some((c) => c.name === name)) return json({ error: "Already claimed" }, 400);
      if (teeTime.postedBy === name) return json({ error: "Can't claim your own" }, 400);

      teeTime.claims = teeTime.claims || [];
      teeTime.claims.push({ name, email, claimedAt: new Date().toISOString() });

      await env.TEETIMES.put(`user:${name}`, JSON.stringify({ name, email }));
      await env.TEETIMES.put(`tt:${id}`, JSON.stringify(teeTime));

      // Notify owner + all existing claimants
      ctx.waitUntil(notifySpotClaimed(env, teeTime, name));

      return json(teeTime);
    }

    if (request.method === "DELETE") {
      teeTime.claims = (teeTime.claims || []).filter((c) => c.name !== name);
      await env.TEETIMES.put(`tt:${id}`, JSON.stringify(teeTime));

      // Notify owner + remaining claimants
      ctx.waitUntil(notifySpotCancelled(env, teeTime, name));

      return json(teeTime);
    }
  }

  // POST /api/teetimes/:id/add-guest — owner manually adds a guest
  const addGuestMatch = path.match(/^\/api\/teetimes\/([^/]+)\/add-guest$/);
  if (addGuestMatch && request.method === "POST") {
    const id = addGuestMatch[1];
    const body = await request.json();
    const { guestName, requestedBy } = body;

    const teeTime = await env.TEETIMES.get(`tt:${id}`, "json");
    if (!teeTime) return json({ error: "Not found" }, 404);
    if (teeTime.postedBy !== requestedBy) return json({ error: "Only the poster can add guests" }, 403);

    const spotsLeft = teeTime.spots - (teeTime.claims?.length || 0);
    if (spotsLeft <= 0) return json({ error: "No spots left" }, 400);
    if (teeTime.claims?.some((c) => c.name === guestName)) return json({ error: "Already in the group" }, 400);
    if (teeTime.postedBy === guestName) return json({ error: "You're already in the group" }, 400);

    teeTime.claims = teeTime.claims || [];
    teeTime.claims.push({ name: guestName, manual: true, addedBy: requestedBy, claimedAt: new Date().toISOString() });

    await env.TEETIMES.put(`tt:${id}`, JSON.stringify(teeTime));
    return json(teeTime);
  }

  // DELETE /api/teetimes/:id/remove-guest — owner removes a guest they added
  const removeGuestMatch = path.match(/^\/api\/teetimes\/([^/]+)\/remove-guest$/);
  if (removeGuestMatch && request.method === "DELETE") {
    const id = removeGuestMatch[1];
    const body = await request.json();
    const { guestName, requestedBy } = body;

    const teeTime = await env.TEETIMES.get(`tt:${id}`, "json");
    if (!teeTime) return json({ error: "Not found" }, 404);
    if (teeTime.postedBy !== requestedBy) return json({ error: "Only the poster can remove guests" }, 403);

    teeTime.claims = (teeTime.claims || []).filter((c) => c.name !== guestName);
    await env.TEETIMES.put(`tt:${id}`, JSON.stringify(teeTime));
    return json(teeTime);
  }

  // DELETE /api/teetimes/:id
  const deleteMatch = path.match(/^\/api\/teetimes\/([^/]+)$/);
  if (deleteMatch && request.method === "DELETE") {
    const id = deleteMatch[1];
    const body = await request.json();
    const teeTime = await env.TEETIMES.get(`tt:${id}`, "json");
    if (!teeTime) return json({ error: "Not found" }, 404);
    if (teeTime.postedBy !== body.name) return json({ error: "Not authorized" }, 403);
    await env.TEETIMES.delete(`tt:${id}`);

    // Notify everyone who was signed up
    ctx.waitUntil(notifyTeeTimeDeleted(env, teeTime));

    return json({ success: true });
  }

  // GET /api/users
  if (path === "/api/users" && request.method === "GET") {
    const list = await env.TEETIMES.list({ prefix: "user:" });
    const users = [];
    for (const key of list.keys) {
      const val = await env.TEETIMES.get(key.name, "json");
      if (val) users.push(val);
    }
    return json(users);
  }

  return null;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    // API routes
    if (path.startsWith("/api/")) {
      const apiResponse = await handleAPI(request, env, path, ctx);
      if (apiResponse) return apiResponse;
      return json({ error: "Not found" }, 404);
    }

    // Serve static HTML for everything else
    return new Response(HTML, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  },
};

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>Tee Times</title>
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>⛳</text></svg>">
  <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600;700&family=Playfair+Display:wght@400;600;700&display=swap" rel="stylesheet">
  <style>
    * { margin:0; padding:0; box-sizing:border-box; -webkit-tap-highlight-color:transparent; }
    body { background:#0d0d0d; color:#e8e4de; font-family:'DM Sans',sans-serif; min-height:100vh; min-height:100dvh; }
    input,select,button { font-family:inherit; }
    select { appearance:none; -webkit-appearance:none; background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%23666' d='M6 8L1 3h10z'/%3E%3C/svg%3E"); background-repeat:no-repeat; background-position:right 12px center; padding-right:32px !important; }
    input[type="date"],input[type="time"] { color-scheme:dark; }
    .modal-overlay { position:fixed; inset:0; background:rgba(0,0,0,0.85); display:flex; align-items:center; justify-content:center; z-index:1000; backdrop-filter:blur(8px); -webkit-backdrop-filter:blur(8px); padding:20px; }
    .modal { background:#1a1a1a; border:1px solid #2a3a2a; border-radius:16px; padding:32px; max-width:440px; width:100%; max-height:90vh; overflow-y:auto; }
    .input { width:100%; padding:12px 16px; background:#111; border:1px solid #333; border-radius:8px; color:#e8e4de; font-size:15px; outline:none; }
    .input:focus { border-color:#5a8a6a; }
    .label { display:block; font-size:12px; letter-spacing:2px; color:#5a8a6a; text-transform:uppercase; margin-bottom:6px; font-weight:500; }
    .btn-primary { width:100%; padding:14px; background:#2d5e3f; color:#7fdb98; border:none; border-radius:8px; font-size:15px; font-weight:600; cursor:pointer; letter-spacing:0.5px; }
    .btn-primary:disabled { opacity:0.5; cursor:not-allowed; }
    .btn-primary:active:not(:disabled) { transform:scale(0.98); }
    .header { border-bottom:1px solid #1a1a1a; padding:16px 20px; position:sticky; top:0; background:#0d0d0d; z-index:100; }
    .header-inner { max-width:900px; margin:0 auto; display:flex; justify-content:space-between; align-items:center; }
    .content { max-width:900px; margin:0 auto; padding:0 16px 40px; }
    .view-toggle { display:flex; gap:4px; margin:16px 0 20px; }
    .view-btn { background:transparent; color:#555; border:1px solid transparent; border-radius:8px; padding:8px 16px; font-size:13px; cursor:pointer; text-transform:capitalize; letter-spacing:0.5px; font-family:inherit; }
    .view-btn.active { background:#1a2a1a; color:#7fdb98; border-color:#2d5e3f; }
    .cal-nav { display:flex; justify-content:space-between; align-items:center; margin-bottom:24px; }
    .cal-nav button { background:none; border:1px solid #333; color:#8a8a7a; border-radius:8px; padding:8px 16px; cursor:pointer; font-size:16px; font-family:inherit; }
    .cal-weekdays { display:grid; grid-template-columns:repeat(7,1fr); gap:2px; margin-bottom:4px; }
    .cal-weekday { text-align:center; font-size:11px; letter-spacing:2px; color:#555; text-transform:uppercase; padding:8px 0; }
    .cal-grid { display:grid; grid-template-columns:repeat(7,1fr); gap:2px; }
    .cal-day { min-height:80px; background:#111; border:1px solid #1a1a1a; border-radius:8px; padding:6px; cursor:pointer; display:flex; flex-direction:column; transition:border-color 0.15s; }
    .cal-day:hover:not(.past):not(.empty) { border-color:#2d5e3f; }
    .cal-day.today { background:#1a2a1a; border-color:#2d5e3f; }
    .cal-day.past { opacity:0.35; cursor:default; }
    .cal-day.empty { background:transparent; border-color:transparent; cursor:default; }
    .cal-day-num { font-size:13px; color:#8a8a7a; margin-bottom:4px; }
    .cal-day.today .cal-day-num { color:#7fdb98; font-weight:700; }
    .tee-chip { border-radius:6px; padding:3px 6px; margin-bottom:2px; cursor:pointer; transition:transform 0.1s; }
    .tee-chip:active { transform:scale(0.95); }
    .tee-chip-time { font-size:10px; font-weight:600; line-height:1.3; }
    .tee-chip-course { font-size:9px; opacity:0.7; line-height:1.2; }
    .tee-chip-spots { font-size:9px; line-height:1.3; }
    .upcoming-card { display:flex; align-items:center; gap:14px; padding:12px 14px; background:#111; border-radius:10px; margin-bottom:8px; cursor:pointer; transition:transform 0.1s; }
    .upcoming-card:active { transform:scale(0.98); }
    .group-chip { border-radius:8px; padding:8px 14px; font-size:13px; }
    @media(max-width:600px) {
      .cal-day { min-height:64px; padding:4px; }
      .tee-chip { padding:2px 4px; }
      .tee-chip-time { font-size:9px; }
      .tee-chip-course { font-size:8px; }
      .tee-chip-spots { font-size:8px; }
      .modal { padding:24px; margin:12px; }
    }
  </style>
</head>
<body>
  <div id="app"></div>
  <script>
    // ---- State ----
    const API = location.origin + '/api';
    const COURSES = ["WeaverRidge","Metamora Fields","Coyote Creek","Kellogg","Madison","Newman"];
    const WEEKDAYS = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
    const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
    const COURSE_COLORS = {
      "WeaverRidge":{bg:"#1a3a2a",text:"#7fdb98",border:"#2d5e3f"},
      "Metamora Fields":{bg:"#2a1f3a",text:"#c4a0e8",border:"#4a3566"},
      "Coyote Creek":{bg:"#3a2a1a",text:"#e8c07f",border:"#5e4a2d"},
      "Kellogg":{bg:"#1a2a3a",text:"#7fb8e8",border:"#2d4a5e"},
      "Madison":{bg:"#3a1a2a",text:"#e87fa0",border:"#5e2d45"},
      "Newman":{bg:"#2a3a1a",text:"#b8e87f",border:"#4a5e2d"},
    };
    const DEFAULT_COLOR = {bg:"#2a2a2a",text:"#aaa",border:"#444"};

    let state = {
      user: null,
      teeTimes: [],
      currentMonth: new Date(),
      view: 'calendar',
      loading: true,
      modal: null, // 'onboard' | 'post' | {type:'detail', teeTime}
    };

    function cc(course) { return COURSE_COLORS[course] || DEFAULT_COLOR; }
    function fmt12(t) { if(!t) return ''; const [h,m]=t.split(':').map(Number); return (h%12||12)+':'+String(m).padStart(2,'0')+(h>=12?' PM':' AM'); }
    function dateStr(y,mo,d) { return y+'-'+String(mo+1).padStart(2,'0')+'-'+String(d).padStart(2,'0'); }
    function isToday(y,mo,d) { const t=new Date(); return t.getFullYear()===y&&t.getMonth()===mo&&t.getDate()===d; }
    function isPast(ds) { const t=new Date(); t.setHours(0,0,0,0); return new Date(ds+'T00:00:00')<t; }

    // ---- API ----
    async function fetchTeeTimes() {
      try { const r=await fetch(API+'/teetimes'); if(r.ok) state.teeTimes=await r.json(); } catch(e){ console.error(e); }
      state.loading=false; render();
    }
    async function postTeeTime(data) {
      try { const r=await fetch(API+'/teetimes',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)}); if(r.ok){ state.modal=null; await fetchTeeTimes(); }} catch(e){ console.error(e); }
    }
    async function claimSpot(id, unclaim) {
      try {
        const r=await fetch(API+'/teetimes/'+id+'/claim',{method:unclaim?'DELETE':'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:state.user.name,email:state.user.email})});
        if(r.ok){ const updated=await r.json(); state.modal={type:'detail',teeTime:updated}; await fetchTeeTimes(); }
      } catch(e){ console.error(e); }
    }
    async function deleteTeeTime(id) {
      try { const r=await fetch(API+'/teetimes/'+id,{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:state.user.name})}); if(r.ok){ state.modal=null; await fetchTeeTimes(); }} catch(e){ console.error(e); }
    }
    async function addGuest(id, guestName) {
      try {
        const r=await fetch(API+'/teetimes/'+id+'/add-guest',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({guestName,requestedBy:state.user.name})});
        if(r.ok){ const updated=await r.json(); state.modal={type:'detail',teeTime:updated}; await fetchTeeTimes(); }
      } catch(e){ console.error(e); }
    }
    async function removeGuest(id, guestName) {
      try {
        const r=await fetch(API+'/teetimes/'+id+'/remove-guest',{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({guestName,requestedBy:state.user.name})});
        if(r.ok){ const updated=await r.json(); state.modal={type:'detail',teeTime:updated}; await fetchTeeTimes(); }
      } catch(e){ console.error(e); }
    }

    // ---- Render ----
    function h(tag, attrs, ...children) {
      const el = document.createElement(tag);
      if(attrs) Object.entries(attrs).forEach(([k,v])=>{
        if(k==='style'&&typeof v==='object') Object.assign(el.style,v);
        else if(k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(),v);
        else if(k==='className') el.className=v;
        else if(k==='value') el.value=v;
        else el.setAttribute(k,v);
      });
      children.flat(Infinity).forEach(c=>{
        if(c==null||c===false) return;
        el.appendChild(typeof c==='string'||typeof c==='number' ? document.createTextNode(c) : c);
      });
      return el;
    }

    function renderOnboardModal() {
      let nameVal='',emailVal='',err='';
      const errEl = h('div',{style:{color:'#e87f7f',fontSize:'13px',marginBottom:'12px',minHeight:'18px'}});
      const nameInput = h('input',{className:'input',placeholder:'Your name',style:{marginBottom:'16px'}});
      const emailInput = h('input',{className:'input',placeholder:'Your email',type:'email',style:{marginBottom:'16px'}});
      nameInput.addEventListener('input',e=>{nameVal=e.target.value;errEl.textContent='';});
      emailInput.addEventListener('input',e=>{emailVal=e.target.value;errEl.textContent='';});
      const submit = h('button',{className:'btn-primary',onClick:()=>{
        if(!nameVal.trim()){errEl.textContent='Name is required';return;}
        if(!emailVal.trim()||!emailVal.includes('@')){errEl.textContent='Valid email required';return;}
        state.user={name:nameVal.trim(),email:emailVal.trim()};
        localStorage.setItem('teetimes_user',JSON.stringify(state.user));
        state.modal=null; render();
      }},'Get Started');
      return h('div',{className:'modal-overlay'},
        h('div',{className:'modal'},
          h('div',{style:{fontSize:'14px',letterSpacing:'3px',color:'#5a8a6a',marginBottom:'8px',textTransform:'uppercase'}},'Welcome to'),
          h('div',{style:{fontSize:'28px',fontFamily:"'Playfair Display',serif",marginBottom:'24px'}},'Tee Times'),
          h('p',{style:{color:'#8a8a7a',fontSize:'14px',lineHeight:'1.6',marginBottom:'24px'}},'Enter your name and email to get started. You\\'ll be notified when someone joins your posted tee times.'),
          nameInput,emailInput,errEl,submit
        )
      );
    }

    function renderPostModal(defaultDate) {
      let courseVal=COURSES[0],customVal='',isCustom=false,dateVal=defaultDate||'',timeVal='08:00',spotsVal=3,notesVal='';
      const today=new Date().toISOString().split('T')[0];

      function buildInner() {
        const inner=h('div',{className:'modal'});
        // Header
        inner.appendChild(h('div',{style:{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:'24px'}},
          h('div',{style:{fontSize:'22px',fontFamily:"'Playfair Display',serif"}},'Post a Tee Time'),
          h('button',{style:{background:'none',border:'none',color:'#666',fontSize:'24px',cursor:'pointer',padding:'4px'},onClick:()=>{state.modal=null;render();}},'×')
        ));

        // Course
        inner.appendChild(h('label',{className:'label'},'Course'));
        if(!isCustom) {
          const sel=h('select',{className:'input',style:{marginBottom:'4px'}});
          COURSES.forEach(c=>{const o=h('option',{value:c},c);if(c===courseVal)o.selected=true;sel.appendChild(o);});
          sel.addEventListener('change',e=>{courseVal=e.target.value;});
          inner.appendChild(sel);
          inner.appendChild(h('button',{style:{background:'none',border:'none',color:'#5a8a6a',fontSize:'13px',cursor:'pointer',marginBottom:'16px',padding:'4px 0',fontFamily:'inherit'},onClick:()=>{isCustom=true;rebuildModal();}},'+  Other course'));
        } else {
          const ci=h('input',{className:'input',placeholder:'Course name',style:{marginBottom:'4px'}});
          ci.value=customVal;
          ci.addEventListener('input',e=>{customVal=e.target.value;});
          inner.appendChild(ci);
          inner.appendChild(h('button',{style:{background:'none',border:'none',color:'#5a8a6a',fontSize:'13px',cursor:'pointer',marginBottom:'16px',padding:'4px 0',fontFamily:'inherit'},onClick:()=>{isCustom=false;rebuildModal();}},'← Back to list'));
        }

        // Date
        inner.appendChild(h('label',{className:'label'},'Date'));
        const di=h('input',{className:'input',type:'date',min:today,style:{marginBottom:'16px'}});
        di.value=dateVal;
        di.addEventListener('change',e=>{dateVal=e.target.value;});
        inner.appendChild(di);

        // Time
        inner.appendChild(h('label',{className:'label'},'Tee Time'));
        const ti=h('input',{className:'input',type:'time',style:{marginBottom:'16px'}});
        ti.value=timeVal;
        ti.addEventListener('change',e=>{timeVal=e.target.value;});
        inner.appendChild(ti);

        // Spots
        inner.appendChild(h('label',{className:'label'},'Open Spots'));
        const spotsDiv=h('div',{style:{display:'flex',gap:'8px',marginBottom:'16px'}});
        [1,2,3].forEach(n=>{
          spotsDiv.appendChild(h('button',{style:{flex:'1',padding:'12px',background:spotsVal===n?'#2d5e3f':'#111',color:spotsVal===n?'#7fdb98':'#666',border:'1px solid '+(spotsVal===n?'#2d5e3f':'#333'),borderRadius:'8px',fontSize:'16px',fontWeight:'600',cursor:'pointer',fontFamily:'inherit'},onClick:()=>{spotsVal=n;rebuildModal();}},String(n)));
        });
        inner.appendChild(spotsDiv);

        // Notes
        inner.appendChild(h('label',{className:'label'},h('span',null,'Notes '),h('span',{style:{color:'#555',fontWeight:'400'}},'(optional)')));
        const ni=h('input',{className:'input',placeholder:'Cart included, walking, rate, etc.',style:{marginBottom:'24px'}});
        ni.value=notesVal;
        ni.addEventListener('input',e=>{notesVal=e.target.value;});
        inner.appendChild(ni);

        // Submit
        inner.appendChild(h('button',{className:'btn-primary',onClick:async()=>{
          const fc=isCustom?customVal.trim():courseVal;
          if(!fc||!dateVal||!timeVal) return;
          await postTeeTime({course:fc,date:dateVal,time:timeVal,spots:spotsVal,notes:notesVal.trim(),postedBy:state.user.name,postedByEmail:state.user.email});
        }},'Post Tee Time'));

        return inner;
      }

      let overlay;
      function rebuildModal() {
        const newInner=buildInner();
        overlay.innerHTML='';
        overlay.appendChild(newInner);
      }
      overlay=h('div',{className:'modal-overlay',onClick:()=>{state.modal=null;render();}});
      const inner=buildInner();
      inner.addEventListener('click',e=>e.stopPropagation());
      overlay.appendChild(inner);
      return overlay;
    }

    function renderDetailModal(tt) {
      const color=cc(tt.course);
      const spotsLeft=tt.spots-(tt.claims?.length||0);
      const alreadyClaimed=tt.claims?.some(c=>c.name===state.user.name);
      const isOwner=tt.postedBy===state.user.name;
      const past=isPast(tt.date);
      let confirmDelete=false;

      const overlay=h('div',{className:'modal-overlay',onClick:()=>{state.modal=null;render();}});
      const modal=h('div',{className:'modal',style:{borderColor:color.border}});
      modal.addEventListener('click',e=>e.stopPropagation());

      // Header
      modal.appendChild(h('div',{style:{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:'16px'}},
        h('div',null,
          h('div',{style:{fontSize:'12px',letterSpacing:'2px',color:color.text,textTransform:'uppercase',marginBottom:'4px'}},tt.course),
          h('div',{style:{fontSize:'22px',fontFamily:"'Playfair Display',serif"}},fmt12(tt.time))
        ),
        h('button',{style:{background:'none',border:'none',color:'#666',fontSize:'24px',cursor:'pointer',padding:'4px'},onClick:()=>{state.modal=null;render();}},'×')
      ));

      const dateObj=new Date(tt.date+'T00:00:00');
      modal.appendChild(h('div',{style:{color:'#8a8a7a',fontSize:'14px',marginBottom:'8px'}},dateObj.toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric'})));
      modal.appendChild(h('div',{style:{color:'#8a8a7a',fontSize:'14px',marginBottom:'16px'}},
        'Posted by ',h('span',{style:{color:'#e8e4de'}},tt.postedBy)
      ));

      if(tt.notes) modal.appendChild(h('div',{style:{background:'#111',borderRadius:'8px',padding:'10px 14px',marginBottom:'16px',color:'#8a8a7a',fontSize:'13px',fontStyle:'italic'}},tt.notes));

      // Group
      modal.appendChild(h('div',{style:{fontSize:'12px',letterSpacing:'2px',color:'#555',textTransform:'uppercase',marginBottom:'10px'}},'The Group'));
      const groupDiv=h('div',{style:{display:'flex',gap:'8px',flexWrap:'wrap',marginBottom:'20px'}});
      groupDiv.appendChild(h('div',{className:'group-chip',style:{background:color.bg,border:'1px solid '+color.border,color:color.text,fontWeight:'600'}},tt.postedBy+' ★'));
      (tt.claims||[]).forEach(c=>{
        const chipWrapper=h('div',{style:{display:'flex',alignItems:'center',gap:'0'}});
        const isManual=c.manual;
        const chip=h('div',{className:'group-chip',style:{background:isManual?'#1a2a2a':'#1a2a1a',border:'1px solid '+(isManual?'#2d4a5e':'#2d5e3f'),color:isManual?'#7fb8e8':'#7fdb98',fontWeight:'500',borderRadius:isOwner&&!past?'8px 0 0 8px':'8px'}},c.name+(isManual?' (guest)':''));
        chipWrapper.appendChild(chip);
        if(isOwner&&!past) {
          const removeBtn=h('button',{style:{background:'#2a1a1a',border:'1px solid '+(isManual?'#2d4a5e':'#2d5e3f'),borderLeft:'none',borderRadius:'0 8px 8px 0',color:'#e87f7f',padding:'8px 8px',fontSize:'12px',cursor:'pointer',fontFamily:'inherit',lineHeight:'1'},onClick:async(e)=>{e.stopPropagation();if(isManual){await removeGuest(tt.id,c.name);}else{await removeGuest(tt.id,c.name);}}},'✕');
          chipWrapper.appendChild(removeBtn);
        }
        groupDiv.appendChild(chipWrapper);
      });
      for(let i=0;i<spotsLeft;i++) groupDiv.appendChild(h('div',{className:'group-chip',style:{background:'#111',border:'1px dashed #333',color:'#444'}},'Open'));
      modal.appendChild(groupDiv);

      // Add Guest (owner only)
      if(isOwner&&!past&&spotsLeft>0) {
        let guestVal='';
        const addGuestDiv=h('div',{style:{display:'flex',gap:'8px',marginBottom:'16px'}});
        const guestInput=h('input',{className:'input',placeholder:'Add guest name...',style:{flex:'1',marginBottom:'0'}});
        guestInput.addEventListener('input',e=>{guestVal=e.target.value;});
        guestInput.addEventListener('keydown',async e=>{if(e.key==='Enter'&&guestVal.trim()){await addGuest(tt.id,guestVal.trim());}});
        const addBtn=h('button',{style:{background:'#1a2a3a',color:'#7fb8e8',border:'1px solid #2d4a5e',borderRadius:'8px',padding:'12px 16px',fontSize:'13px',fontWeight:'600',cursor:'pointer',fontFamily:'inherit',whiteSpace:'nowrap'},onClick:async()=>{if(guestVal.trim()){await addGuest(tt.id,guestVal.trim());}}},'+ Add');
        addGuestDiv.appendChild(guestInput);
        addGuestDiv.appendChild(addBtn);
        modal.appendChild(addGuestDiv);
      }

      // Actions
      if(!past) {
        if(!isOwner&&!alreadyClaimed&&spotsLeft>0) {
          modal.appendChild(h('button',{className:'btn-primary',onClick:async()=>{ await claimSpot(tt.id,false); }},"I'm In!"));
        }
        if(!isOwner&&alreadyClaimed) {
          modal.appendChild(h('button',{style:{width:'100%',padding:'14px',background:'#3a1a1a',color:'#e87f7f',border:'none',borderRadius:'8px',fontSize:'15px',fontWeight:'600',cursor:'pointer',fontFamily:'inherit'},onClick:async()=>{ await claimSpot(tt.id,true); }},'Cancel My Spot'));
        }
        if(spotsLeft===0&&!alreadyClaimed&&!isOwner) {
          modal.appendChild(h('div',{style:{textAlign:'center',color:'#e8c07f',fontSize:'14px'}},'Group is full!'));
        }
        if(isOwner) {
          const delBtn=h('button',{style:{width:'100%',padding:'14px',background:'#2a1a1a',color:'#e87f7f',border:'1px solid #3a2a2a',borderRadius:'8px',fontSize:'14px',fontWeight:'500',cursor:'pointer',fontFamily:'inherit',marginTop:'8px'},onClick:async()=>{
            if(!confirmDelete){confirmDelete=true;delBtn.textContent='Confirm Delete?';delBtn.style.background='#5e1a1a';delBtn.style.borderColor='#8a2d2d';return;}
            await deleteTeeTime(tt.id);
          }},'Delete This Tee Time');
          modal.appendChild(delBtn);
        }
      } else {
        modal.appendChild(h('div',{style:{textAlign:'center',color:'#555',fontSize:'14px'}},'This tee time has passed'));
      }

      overlay.appendChild(modal);
      return overlay;
    }

    function renderCalendar() {
      const cm=state.currentMonth;
      const y=cm.getFullYear(),mo=cm.getMonth();
      const firstDay=new Date(y,mo,1).getDay();
      const daysInMonth=new Date(y,mo+1,0).getDate();
      const today=new Date();

      const container=h('div');

      // Nav
      const nav=h('div',{className:'cal-nav'});
      nav.appendChild(h('button',{onClick:()=>{state.currentMonth=new Date(y,mo-1,1);render();}},'‹'));
      nav.appendChild(h('div',{style:{fontSize:'24px',fontFamily:"'Playfair Display',serif"}},MONTHS[mo]+' '+y));
      nav.appendChild(h('button',{onClick:()=>{state.currentMonth=new Date(y,mo+1,1);render();}},'›'));
      container.appendChild(nav);

      // Weekday headers
      const wh=h('div',{className:'cal-weekdays'});
      WEEKDAYS.forEach(w=>wh.appendChild(h('div',{className:'cal-weekday'},w)));
      container.appendChild(wh);

      // Grid
      const grid=h('div',{className:'cal-grid'});

      // Empty cells
      for(let i=0;i<firstDay;i++) grid.appendChild(h('div',{className:'cal-day empty'}));

      // Day cells
      for(let d=1;d<=daysInMonth;d++) {
        const ds=dateStr(y,mo,d);
        const tees=state.teeTimes.filter(t=>t.date===ds).sort((a,b)=>a.time.localeCompare(b.time));
        const todayClass=isToday(y,mo,d);
        const pastDay=new Date(y,mo,d)<new Date(today.getFullYear(),today.getMonth(),today.getDate());

        const cls='cal-day'+(todayClass?' today':'')+(pastDay?' past':'');
        const cell=h('div',{className:cls});
        if(!pastDay) cell.addEventListener('click',()=>{state.modal={type:'post',date:ds};render();});

        cell.appendChild(h('div',{className:'cal-day-num'},String(d)));

        tees.forEach(t=>{
          const c=cc(t.course);
          const sl=t.spots-(t.claims?.length||0);
          const chip=h('div',{className:'tee-chip',style:{background:c.bg,border:'1px solid '+c.border}});
          chip.appendChild(h('div',{className:'tee-chip-time',style:{color:c.text}},fmt12(t.time)));
          chip.appendChild(h('div',{className:'tee-chip-course',style:{color:c.text}},t.course));
          chip.appendChild(h('div',{className:'tee-chip-spots',style:{color:sl===0?'#e87f7f':'#7fdb98'}},sl===0?'Full':sl+' open'));
          chip.addEventListener('click',e=>{e.stopPropagation();state.modal={type:'detail',teeTime:t};render();});
          cell.appendChild(chip);
        });

        grid.appendChild(cell);
      }

      container.appendChild(grid);
      return container;
    }

    function renderUpcoming() {
      const today=new Date();today.setHours(0,0,0,0);
      const upcoming=state.teeTimes.filter(t=>new Date(t.date+'T00:00:00')>=today).sort((a,b)=>a.date.localeCompare(b.date)||a.time.localeCompare(b.time)).slice(0,15);

      const container=h('div');

      if(upcoming.length===0) {
        container.appendChild(h('div',{style:{textAlign:'center',padding:'40px 20px',color:'#555'}},
          h('div',{style:{fontSize:'32px',marginBottom:'8px'}},'⛳'),
          h('div',{style:{fontSize:'14px'}},'No upcoming tee times'),
          h('div',{style:{fontSize:'13px',marginTop:'4px'}},'Post one and get the group together!')
        ));
        return container;
      }

      container.appendChild(h('div',{style:{fontSize:'12px',letterSpacing:'2px',color:'#555',textTransform:'uppercase',marginBottom:'12px'}},'Upcoming'));
      upcoming.forEach(t=>{
        const c=cc(t.course);
        const sl=t.spots-(t.claims?.length||0);
        const dateObj=new Date(t.date+'T00:00:00');
        const isTod=isToday(dateObj.getFullYear(),dateObj.getMonth(),dateObj.getDate());

        const card=h('div',{className:'upcoming-card',style:{border:'1px solid '+c.border},onClick:()=>{state.modal={type:'detail',teeTime:t};render();}},
          h('div',{style:{minWidth:'48px',textAlign:'center'}},
            h('div',{style:{fontSize:'11px',color:isTod?'#7fdb98':'#666',textTransform:'uppercase'}},isTod?'Today':dateObj.toLocaleDateString('en-US',{weekday:'short'})),
            h('div',{style:{fontSize:'22px',fontFamily:"'Playfair Display',serif"}},String(dateObj.getDate()))
          ),
          h('div',{style:{flex:'1'}},
            h('div',{style:{fontSize:'15px',color:c.text,fontWeight:'600'}},t.course),
            h('div',{style:{fontSize:'13px',color:'#8a8a7a'}},fmt12(t.time)+' · '+t.postedBy)
          ),
          h('div',{style:{textAlign:'right'}},
            h('div',{style:{fontSize:'20px',fontWeight:'700',color:sl===0?'#e87f7f':'#7fdb98'}},String(sl)),
            h('div',{style:{fontSize:'10px',color:'#555',textTransform:'uppercase',letterSpacing:'1px'}},sl===0?'Full':'Open')
          )
        );
        container.appendChild(card);
      });
      return container;
    }

    function render() {
      const app=document.getElementById('app');
      app.innerHTML='';

      // Modal
      if(state.modal==='onboard') app.appendChild(renderOnboardModal());
      else if(state.modal?.type==='post') app.appendChild(renderPostModal(state.modal.date));
      else if(state.modal?.type==='detail') app.appendChild(renderDetailModal(state.modal.teeTime));

      // Header
      const header=h('div',{className:'header'},
        h('div',{className:'header-inner'},
          h('div',{style:{fontSize:'11px',letterSpacing:'3px',color:'#5a8a6a',textTransform:'uppercase'}},'⛳ Tee Times'),
          state.user ? h('div',{style:{display:'flex',alignItems:'center',gap:'12px'}},
            h('span',{style:{fontSize:'13px',color:'#666'}},state.user.name),
            h('button',{style:{background:'#2d5e3f',color:'#7fdb98',border:'none',borderRadius:'8px',padding:'10px 20px',fontSize:'14px',fontWeight:'600',cursor:'pointer',fontFamily:'inherit',letterSpacing:'0.5px'},onClick:()=>{state.modal={type:'post',date:''};render();}},'+ Post')
          ) : h('div')
        )
      );
      app.appendChild(header);

      // Content wrapper
      const content=h('div',{className:'content'});

      // View toggle
      const toggle=h('div',{className:'view-toggle'});
      ['calendar','upcoming'].forEach(v=>{
        toggle.appendChild(h('button',{className:'view-btn'+(state.view===v?' active':''),onClick:()=>{state.view=v;render();}},v));
      });
      content.appendChild(toggle);

      // Main content
      if(state.loading) {
        content.appendChild(h('div',{style:{textAlign:'center',padding:'60px',color:'#555'}},'Loading...'));
      } else if(state.view==='calendar') {
        content.appendChild(renderCalendar());
      } else {
        content.appendChild(renderUpcoming());
      }

      app.appendChild(content);
    }

    // ---- Init ----
    const saved=localStorage.getItem('teetimes_user');
    if(saved) { state.user=JSON.parse(saved); }
    else { state.modal='onboard'; }
    render();
    fetchTeeTimes();
    setInterval(fetchTeeTimes,30000);
  </script>
</body>
</html>`;
