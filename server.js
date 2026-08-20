/* ============================================================
   Argand Tutors — application server
   Node 18+. No npm dependencies.
     node server.js
   ============================================================ */
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const OWNER_EMAIL = process.env.OWNER_EMAIL || "owner@argandtutors.co.uk";
const FROM_EMAIL = process.env.FROM_EMAIL || "Argand Tutors <noreply@argandtutors.co.uk>";
const RESEND_API_KEY = process.env.RESEND_API_KEY || null;
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "data.json");

/* ---------------- storage ---------------- */
const EMPTY = { applications: [], tutors: [], bookings: [], holds: [], waitlist: [] };
function load() {
  try { return { ...EMPTY, ...JSON.parse(fs.readFileSync(DB_PATH, "utf8")) }; }
  catch { return JSON.parse(JSON.stringify(EMPTY)); }
}
function save(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}
let db = load();

/* ---------------- passwords ---------------- */
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(pw, salt, 64).toString("hex");
  return `scrypt$${salt}$${hash}`;
}
function verifyPassword(pw, stored) {
  const [, salt, hash] = stored.split("$");
  const test = crypto.scryptSync(pw, salt, 64);
  const known = Buffer.from(hash, "hex");
  return test.length === known.length && crypto.timingSafeEqual(test, known);
}

/* ---------------- rate limiting ---------------- */
const hits = new Map();
function rateLimit(ip, bucket, max, windowMs) {
  const k = `${ip}:${bucket}`;
  const now = Date.now();
  const rec = hits.get(k) || { n: 0, reset: now + windowMs };
  if (now > rec.reset) { rec.n = 0; rec.reset = now + windowMs; }
  rec.n++;
  hits.set(k, rec);
  return rec.n <= max;
}

/* ---------------- email ---------------- */
async function sendEmail(to, subject, html) {
  if (!RESEND_API_KEY) {
    console.log("\n──────── EMAIL (no RESEND_API_KEY set, printing instead) ────────");
    console.log("To:     ", to);
    console.log("Subject:", subject);
    console.log(html.replace(/<[^>]+>/g, "").replace(/\n{3,}/g, "\n\n").trim());
    console.log("────────────────────────────────────────────────────────────────\n");
    return { simulated: true };
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: FROM_EMAIL, to, subject, html })
  });
  if (!res.ok) throw new Error("Email provider rejected the message: " + await res.text());
  return res.json();
}

function ownerEmailBody(app) {
  const grades = app.grades.map(g => `${g.subject} — ${g.grade}`).join("<br>");
  return `
    <h2 style="font-family:system-ui">New tutor application</h2>
    <p style="font-family:system-ui"><b>${esc(app.name)}</b> has applied to tutor with Argand.</p>
    <table style="font-family:system-ui;font-size:14px;border-collapse:collapse">
      <tr><td style="padding:4px 12px 4px 0;color:#555">Email</td><td>${esc(app.email)}</td></tr>
      <tr><td style="padding:4px 12px 4px 0;color:#555">University</td><td>${esc(app.university)}</td></tr>
      <tr><td style="padding:4px 12px 4px 0;color:#555">Course</td><td>${esc(app.course)}, ${esc(app.year)}</td></tr>
      <tr><td style="padding:4px 12px 4px 0;color:#555;vertical-align:top">A-Levels</td><td>${grades}</td></tr>
      <tr><td style="padding:4px 12px 4px 0;color:#555;vertical-align:top">Would teach</td><td>${app.subjectNames.map(esc).join("<br>")}</td></tr>
    </table>
    <p style="font-family:system-ui;font-size:14px;white-space:pre-wrap;background:#f5f5f5;padding:12px;border-radius:6px">${esc(app.bio)}</p>
    <p style="font-family:system-ui">If you're happy to take them on, give them this confirmation code:</p>
    <p style="font-family:ui-monospace,monospace;font-size:32px;letter-spacing:6px;font-weight:700">${app.code}</p>
    <p style="font-family:system-ui;font-size:13px;color:#555">
      They enter it on the site to activate their account. It expires in 14 days.
      To reject the application, do nothing — no account is created without the code.
    </p>
    <p style="font-family:system-ui;font-size:13px">
      Or approve in one click:
      <a href="${PUBLIC_URL}/api/applications/${app.id}/approve?token=${app.approveToken}">${PUBLIC_URL}/api/applications/${app.id}/approve</a>
    </p>`;
}

const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/* ---------------- helpers ---------------- */
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", c => {
      data += c;
      if (data.length > 1e6) { reject(new Error("Body too large")); req.destroy(); }
    });
    req.on("end", () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch { reject(new Error("Invalid JSON")); }
    });
  });
}
const validEmail = e => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(e || ""));
const sixDigits = () => String(crypto.randomInt(100000, 1000000));

/* ---------------- routes ---------------- */
async function createApplication(req, res, ip) {
  if (!rateLimit(ip, "apply", 5, 60 * 60 * 1000))
    return json(res, 429, { error: "Too many applications from this address. Try again later." });

  const b = await readBody(req);
  const errors = [];
  if (!b.name || String(b.name).trim().length < 2) errors.push("name");
  if (!validEmail(b.email)) errors.push("email");
  if (!b.password || String(b.password).length < 8) errors.push("password");
  if (!b.university) errors.push("university");
  if (!b.course) errors.push("course");
  if (!Array.isArray(b.subjectIds) || !b.subjectIds.length) errors.push("subjects");
  if (!Array.isArray(b.grades) || !b.grades.some(g => g.grade === "A*")) errors.push("grades");
  if (!b.bio || String(b.bio).trim().length < 20) errors.push("bio");
  if (errors.length) return json(res, 400, { error: "Some details are missing or invalid.", fields: errors });

  const email = String(b.email).trim().toLowerCase();
  if (db.tutors.some(t => t.email === email))
    return json(res, 409, { error: "There's already an account with that email." });

  // a repeat application replaces the earlier pending one rather than stacking up
  db.applications = db.applications.filter(a => !(a.email === email && a.status === "pending"));

  const app = {
    id: crypto.randomUUID(),
    name: String(b.name).trim(),
    email,
    passwordHash: hashPassword(String(b.password)),
    university: String(b.university).trim(),
    course: String(b.course).trim(),
    year: String(b.year || "").trim(),
    grades: b.grades.filter(g => g.subject),
    subjectIds: b.subjectIds,
    subjectNames: b.subjectNames || [],
    bio: String(b.bio).trim(),
    code: sixDigits(),
    approveToken: crypto.randomBytes(24).toString("hex"),
    attempts: 0,
    status: "pending",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 14 * 864e5).toISOString()
  };
  db.applications.push(app);
  save(db);

  try {
    await sendEmail(OWNER_EMAIL, `Tutor application — ${app.name} (${app.university})`, ownerEmailBody(app));
  } catch (err) {
    console.error("Owner email failed:", err.message);
    // the application is still recorded; the owner can read it from data.json
  }

  json(res, 201, { id: app.id, status: "pending" });
}

async function verifyApplication(req, res, id, ip) {
  if (!rateLimit(ip, "verify", 20, 15 * 60 * 1000))
    return json(res, 429, { error: "Too many attempts. Try again shortly." });

  const b = await readBody(req);
  const app = db.applications.find(a => a.id === id);
  if (!app) return json(res, 404, { error: "Application not found." });
  if (app.status === "approved") return json(res, 409, { error: "This account is already active." });
  if (new Date(app.expiresAt) < new Date()) return json(res, 410, { error: "This code has expired. Please apply again." });
  if (app.attempts >= 5) return json(res, 429, { error: "Too many wrong codes. Ask the owner to re-send." });

  if (String(b.code) !== app.code) {
    app.attempts++;
    save(db);
    return json(res, 401, { error: "Incorrect code.", attemptsLeft: Math.max(0, 5 - app.attempts) });
  }

  app.status = "approved";
  db.tutors.push({
    id: crypto.randomUUID(),
    name: app.name,
    email: app.email,
    passwordHash: app.passwordHash,
    university: app.university,
    course: app.course,
    year: app.year,
    grades: app.grades,
    subjectIds: app.subjectIds,
    bio: app.bio,
    headline: (subjectById(app.subjectIds[0]) || {}).area + " \u00b7 " + app.university,
    sat: new Date().getFullYear(),
    hours: 0,
    premium: 3,
    photo: null,
    availability: {},
    blocked: [],
    buffer: 15,
    active: true,
    createdAt: new Date().toISOString()
  });
  save(db);

  sendEmail(app.email, "Your Argand tutor account is active",
    `<p style="font-family:system-ui">Hi ${esc(app.name.split(" ")[0])}, your account is live.
     Sign in at <a href="${PUBLIC_URL}/#/staff">${PUBLIC_URL}</a> to set your availability and finish your profile.</p>`
  ).catch(e => console.error("Welcome email failed:", e.message));

  json(res, 200, { status: "approved" });
}

function ownerApprove(res, id, token) {
  const app = db.applications.find(a => a.id === id);
  const page = (title, body) => {
    const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
      <div style="font-family:system-ui;max-width:520px;margin:12vh auto;padding:0 20px;line-height:1.5">
        <h1 style="font-size:22px">${title}</h1>${body}</div>`;
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  };
  if (!app || app.approveToken !== token) return page("Link not valid", "<p>That approval link doesn't match an application.</p>");
  if (app.status === "approved") return page("Already approved", `<p>${esc(app.name)} already has an active account.</p>`);
  page("Approved", `<p>Send <b>${esc(app.name)}</b> this confirmation code so they can activate their account:</p>
    <p style="font-family:ui-monospace,monospace;font-size:36px;letter-spacing:8px;font-weight:700">${app.code}</p>
    <p style="color:#555;font-size:14px">Their email: ${esc(app.email)}</p>`);
}

async function login(req, res, ip) {
  if (!rateLimit(ip, "login", 10, 15 * 60 * 1000))
    return json(res, 429, { error: "Too many attempts. Try again shortly." });
  const b = await readBody(req);
  const t = db.tutors.find(x => x.email === String(b.email || "").trim().toLowerCase());
  if (!t || !t.active || !verifyPassword(String(b.password || ""), t.passwordHash))
    return json(res, 401, { error: "Those details don't match an account." });
  const token = crypto.randomBytes(24).toString("hex");
  t.session = { token, expires: Date.now() + 7 * 864e5 };
  save(db);
  json(res, 200, { token, tutor: publicTutor(t) });
}


/* ============================================================
   CATALOGUE — edit these to change what you offer. Prices per hour, in pounds.
   ============================================================ */
const SUBJECTS = [
  { id:1, name:"GCSE Maths", area:"Maths", level:"GCSE", price:30, icon:"\u2211",
    desc:"Foundation and Higher tier. Algebra, geometry, ratio and probability, with past-paper technique every session." },
  { id:2, name:"GCSE Further Maths", area:"Maths", level:"GCSE", price:32, icon:"\u03c0",
    desc:"AQA Level 2 Certificate. Matrices, calculus foundations and advanced algebra for pupils heading to A-Level." },
  { id:3, name:"GCSE Physics", area:"Physics", level:"GCSE", price:30, icon:"\u269b",
    desc:"Separate and combined award. Forces, electricity, waves and the required practicals." },
  { id:4, name:"GCSE Computer Science", area:"Computing", level:"GCSE", price:31, icon:"\u2328",
    desc:"Algorithms, data representation and Python, plus the written paper technique that trips people up." },
  { id:5, name:"A-Level Mathematics", area:"Maths", level:"A-Level", price:36, icon:"\u222b",
    desc:"Pure, statistics and mechanics across Edexcel, AQA and OCR. Built around your last mock paper." },
  { id:6, name:"A-Level Further Maths", area:"Maths", level:"A-Level", price:40, icon:"\u2202",
    desc:"Complex numbers, matrices, differential equations and the optional applied modules." },
  { id:7, name:"A-Level Physics", area:"Physics", level:"A-Level", price:36, icon:"\u03a9",
    desc:"Mechanics, fields, thermal and particle physics, with heavy drilling on six-mark explanation questions." },
  { id:8, name:"A-Level Computer Science", area:"Computing", level:"A-Level", price:38, icon:"{}",
    desc:"Data structures, OOP, theory of computation and NEA supervision from specification to evaluation." }
];
const LENGTHS = [{mins:30,mult:0.6,blocks:1},{mins:60,mult:1,blocks:1},{mins:90,mult:1.45,blocks:2}];
const subjectById = id => SUBJECTS.find(s => s.id === Number(id));

// Card payments stay off until Stripe is wired in. Bookings are still real sessions;
// you invoice separately. Better than a "Pay now" button on a live site that takes nothing.
const PAYMENTS_ENABLED = false;
const BRAND = process.env.BRAND || "Argand Tutors";

const clean = (v, max = 500) => String(v ?? "").trim().slice(0, max);
const money = n => "\u00a3" + n.toFixed(2).replace(/\.00$/, "");
const wrap = i => `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:15px;line-height:1.6;color:#111;max-width:520px">${i}<p style="color:#777;font-size:12px;margin-top:28px">${esc(BRAND)}</p></div>`;
const dayKey = d => d.toISOString().slice(0, 10);

function currentTutor(req) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!token) return null;
  const t = db.tutors.find(x => x.session && x.session.token === token && x.session.expires > Date.now());
  return t && t.active ? t : null;
}

// every hour this tutor is unavailable, as "YYYY-MM-DD:H", covering both
// confirmed bookings and slots currently held mid-checkout
function busyHours(tutorId) {
  const out = [];
  const push = (day, hour, mins) => {
    const blocks = LENGTHS.find(l => l.mins === mins).blocks;
    for (let i = 0; i < blocks; i++) out.push(`${day}:${hour + i}`);
  };
  for (const b of db.bookings) if (b.tutorId === tutorId && b.status === "confirmed") push(b.day, b.hour, b.mins);
  for (const h of db.holds) if (h.tutorId === tutorId && h.expires > Date.now())
    for (const d of h.days) push(d, h.hour, h.mins);
  return out;
}

function slotFree(t, isoDay, hour, mins) {
  const d = new Date(isoDay + "T12:00:00Z");
  const range = (t.availability || {})[String(d.getUTCDay())];
  if (!range || (t.blocked || []).includes(isoDay)) return false;
  const blocks = LENGTHS.find(l => l.mins === Number(mins)).blocks;
  if (hour < range[0] || hour + blocks > range[1]) return false;
  const busy = new Set(busyHours(t.id));
  for (let i = 0; i < blocks; i++) if (busy.has(`${isoDay}:${hour + i}`)) return false;
  if (t.buffer > 0 && hour + blocks < range[1] && busy.has(`${isoDay}:${hour + blocks}`)) return false;
  return true;
}

const priceFor = (t, subjectId, mins) =>
  Math.round((subjectById(subjectId).price + (t.premium || 0)) * LENGTHS.find(l => l.mins === Number(mins)).mult * 100) / 100;

const publicTutor = t => ({
  id: t.id, name: t.name, headline: t.headline, bio: t.bio,
  university: t.university, course: t.course, year: t.year, sat: t.sat,
  grades: t.grades, subjectIds: t.subjectIds, premium: t.premium, photo: t.photo,
  availability: t.availability || {}, blocked: t.blocked || [], buffer: t.buffer ?? 15,
  hours: t.hours || 0, busy: busyHours(t.id)
});

async function updateMe(req, res, t) {
  const b = await readBody(req);
  if (b.headline !== undefined) t.headline = clean(b.headline, 70);
  if (b.bio !== undefined) t.bio = clean(b.bio, 600);
  if (b.university !== undefined) t.university = clean(b.university, 80);
  if (b.course !== undefined) t.course = clean(b.course, 80);
  if (b.premium !== undefined) t.premium = Math.max(0, Math.min(30, Number(b.premium) || 0));
  if (b.buffer !== undefined && [0, 15, 30].includes(Number(b.buffer))) t.buffer = Number(b.buffer);
  if (b.photo !== undefined) {
    if (b.photo === null) t.photo = null;
    else if (typeof b.photo === "string" && /^data:image\/(png|jpeg|webp);base64,/.test(b.photo) && b.photo.length < 4e6) t.photo = b.photo;
    else return json(res, 400, { error: "That image can't be used. Use a JPEG, PNG or WebP under 3 MB." });
  }
  if (b.availability && typeof b.availability === "object") {
    const next = {};
    for (const [k, v] of Object.entries(b.availability)) {
      const d = Number(k);
      if (!(d >= 0 && d <= 6) || !Array.isArray(v)) continue;
      const s0 = Math.max(0, Math.min(23, Number(v[0])));
      next[d] = [s0, Math.max(s0 + 1, Math.min(24, Number(v[1])))];
    }
    t.availability = next;
  }
  if (Array.isArray(b.blocked)) t.blocked = b.blocked.filter(x => /^\d{4}-\d{2}-\d{2}$/.test(x)).slice(0, 200);
  save(db);
  json(res, 200, publicTutor(t));
}

/* ---------- booking: hold the slot, verify the email, then confirm ---------- */
async function createHold(req, res, ip) {
  if (!rateLimit(ip, "hold", 30, 36e5)) return json(res, 429, { error: "Too many booking attempts. Try again later." });
  const b = await readBody(req);
  const t = db.tutors.find(x => x.id === b.tutorId && x.active);
  const sj = subjectById(b.subjectId);
  const len = LENGTHS.find(l => l.mins === Number(b.mins));
  if (!t || !sj || !len) return json(res, 400, { error: "That tutor, subject or session length isn't available." });
  if (!t.subjectIds.includes(sj.id)) return json(res, 400, { error: t.name + " doesn't teach " + sj.name + "." });
  if (!validEmail(b.email) || clean(b.name).length < 2) return json(res, 400, { error: "We need a name and a valid email address." });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.day || ""))) return json(res, 400, { error: "Invalid date." });

  db.holds = db.holds.filter(h => h.expires > Date.now());
  const weeks = [1, 4, 8].includes(Number(b.repeat)) ? Number(b.repeat) : 1;
  const days = [], skipped = [];
  for (let w = 0; w < weeks; w++) {
    const d = new Date(b.day + "T12:00:00Z");
    d.setUTCDate(d.getUTCDate() + w * 7);
    (slotFree(t, dayKey(d), Number(b.hour), len.mins) ? days : skipped).push(dayKey(d));
  }
  if (!days.length) return json(res, 409, { error: "That time has just been taken. Please choose another." });

  const per = priceFor(t, sj.id, len.mins), disc = days.length >= 4 ? 0.9 : 1;
  const hold = {
    id: crypto.randomUUID(), tutorId: t.id, subjectId: sj.id, mins: len.mins, hour: Number(b.hour),
    days, skipped, name: clean(b.name, 80), email: clean(b.email).toLowerCase(),
    perSession: Math.round(per * disc * 100) / 100,
    total: Math.round(per * days.length * disc * 100) / 100,
    code: sixDigits(), attempts: 0, expires: Date.now() + 15 * 6e4
  };
  db.holds.push(hold); save(db);

  sendEmail(hold.email, "Your " + BRAND + " verification code", wrap(
    `<p>Your code is</p><p style="font-family:ui-monospace,monospace;font-size:32px;letter-spacing:6px;font-weight:700">${hold.code}</p>
     <p style="font-size:13px;color:#555">It expires in 15 minutes. If this wasn't you, ignore it \u2014 nothing has been booked.</p>`)
  ).catch(e => console.error("Code email failed:", e.message));

  json(res, 201, { holdId: hold.id, total: hold.total, perSession: hold.perSession, sessions: days.length, skipped });
}

async function confirmHold(req, res) {
  const b = await readBody(req);
  const hold = db.holds.find(h => h.id === b.holdId);
  if (!hold) return json(res, 404, { error: "That booking attempt has expired. Please start again." });
  if (hold.expires < Date.now()) return json(res, 410, { error: "Your held slot expired. Please start again." });
  if (hold.attempts >= 5) return json(res, 429, { error: "Too many wrong codes. Please start again." });
  if (String(b.code) !== hold.code) {
    hold.attempts++; save(db);
    return json(res, 401, { error: "That code isn't right.", attemptsLeft: 5 - hold.attempts });
  }
  const t = db.tutors.find(x => x.id === hold.tutorId), sj = subjectById(hold.subjectId);
  db.holds = db.holds.filter(h => h.id !== hold.id);
  const made = [];
  for (const iso of hold.days) {
    if (!slotFree(t, iso, hold.hour, hold.mins)) continue;
    made.push({
      ref: "AR-" + crypto.randomBytes(3).toString("hex").toUpperCase(),
      manageToken: crypto.randomBytes(20).toString("hex"),
      tutorId: t.id, subjectId: sj.id, day: iso, hour: hold.hour, mins: hold.mins,
      price: hold.perSession, name: hold.name, email: hold.email,
      status: "confirmed", note: null, paid: false, createdAt: new Date().toISOString()
    });
  }
  if (!made.length) { save(db); return json(res, 409, { error: "That time was taken while you were confirming. Nothing has been booked." }); }
  db.bookings.push(...made); save(db);

  const f = made[0];
  const when = x => new Date(x.day + "T12:00:00Z").toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })
                    + " at " + String(x.hour).padStart(2, "0") + ":00";
  sendEmail(f.email, "Booking confirmed \u2014 " + sj.name + " with " + t.name, wrap(
    `<h2 style="font-size:19px;margin:0 0 12px">You're booked in</h2>
     <p>${esc(sj.name)} with ${esc(t.name)}${made.length > 1 ? ", " + made.length + " weekly sessions starting" : ","} ${when(f)}.</p>
     <p>Reference <b>${f.ref}</b> \u00b7 ${hold.mins} minutes \u00b7 ${money(f.price)}${made.length > 1 ? " per session" : ""}</p>
     ${PAYMENTS_ENABLED ? "" : `<p style="font-size:13px;color:#555">${esc(t.name.split(" ")[0])} will arrange payment with you directly before the first session.</p>`}
     <p><a href="${PUBLIC_URL}/#/manage/${f.manageToken}">Manage or cancel this booking</a></p>
     <p style="font-size:13px;color:#555">Free to move or cancel up to 24 hours before.</p>`)
  ).catch(e => console.error(e.message));

  sendEmail(t.email, "New booking \u2014 " + sj.name + ", " + when(f), wrap(
    `<p><b>${esc(f.name)}</b> has booked ${esc(sj.name)}${made.length > 1 ? " (" + made.length + " weekly sessions)" : ""}.</p>
     <p>${when(f)} \u00b7 ${hold.mins} minutes<br>${esc(f.email)}</p>
     <p><a href="${PUBLIC_URL}/#/staff">Open your dashboard</a></p>`)
  ).catch(e => console.error(e.message));

  json(res, 201, { bookings: made.map(x => ({ ...x, manageToken: undefined })), manageToken: f.manageToken, skipped: hold.skipped });
}

function bookingByToken(res, token) {
  const b = db.bookings.find(x => x.manageToken === token);
  if (!b) return json(res, 404, { error: "That link isn't valid." });
  json(res, 200, { bookings: db.bookings.filter(x => x.email === b.email)
    .map(x => ({ ...x, manageToken: x.manageToken === token ? token : undefined })) });
}

async function cancelBooking(req, res, token) {
  const b = db.bookings.find(x => x.manageToken === token);
  if (!b) return json(res, 404, { error: "That link isn't valid." });
  if (b.status !== "confirmed") return json(res, 409, { error: "That booking isn't active." });
  const start = new Date(b.day + "T" + String(b.hour).padStart(2, "0") + ":00:00Z").getTime();
  const free = (start - Date.now()) / 36e5 > 24;
  b.status = "cancelled"; b.cancelledAt = new Date().toISOString(); b.refundDue = free ? b.price : 0;
  save(db);
  const t = db.tutors.find(x => x.id === b.tutorId);
  if (t) sendEmail(t.email, "Cancelled \u2014 " + subjectById(b.subjectId).name + ", " + b.day, wrap(
    `<p>${esc(b.name)} cancelled their ${b.day} session at ${String(b.hour).padStart(2, "0")}:00.</p>
     <p style="font-size:13px;color:#555">${free ? "More than 24 hours' notice \u2014 refund due." : "Inside 24 hours \u2014 chargeable under the policy."}</p>`)
  ).catch(e => console.error(e.message));
  json(res, 200, { status: "cancelled", refund: b.refundDue });
}

async function joinWaitlist(req, res, ip) {
  if (!rateLimit(ip, "wait", 20, 36e5)) return json(res, 429, { error: "Too many requests." });
  const b = await readBody(req);
  if (!validEmail(b.email)) return json(res, 400, { error: "Enter a valid email address." });
  db.waitlist.push({ id: crypto.randomUUID(), tutorId: b.tutorId, day: clean(b.day, 10),
    hour: Number(b.hour), email: clean(b.email).toLowerCase(), createdAt: new Date().toISOString() });
  save(db);
  json(res, 201, { ok: true });
}


/* ---------------- static files ---------------- */
const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript",
               ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".ico": "image/x-icon" };
// The site's HTML can live either next to server.js or in a "public" folder.
// Both work; whichever is found first wins.
function findHomePage() {
  const roots = [path.join(__dirname, "public"), __dirname];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    const index = path.join(root, "index.html");
    if (fs.existsSync(index)) return { file: index, root, warning: null };
  }
  // No index.html anywhere — but if there's exactly one HTML file, that's obviously the site.
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    const htmls = fs.readdirSync(root).filter(f => f.toLowerCase().endsWith(".html"));
    if (htmls.length === 1) {
      return { file: path.join(root, htmls[0]), root, warning:
        `Serving "${htmls[0]}" as the home page. Renaming it to index.html is tidier, but not required.` };
    }
  }
  return { file: null, root: __dirname, warning:
    `No HTML file found.\n` +
    `  Put the site's index.html either next to server.js (${__dirname})\n` +
    `  or in a "public" folder inside it. Then reload the page.` };
}
let HOME = findHomePage();

function diagnosticPage(res) {
  const body = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <div style="font-family:system-ui;max-width:640px;margin:10vh auto;padding:0 20px;line-height:1.6">
      <h1 style="font-size:22px">The server is running, but there's no site file to show</h1>
      <p>Nothing is broken in the code \u2014 it just can't find the page.</p>
      <pre style="background:#f4f2ee;padding:14px;border-radius:6px;font-size:13px;white-space:pre-wrap">${esc(HOME.warning || "")}</pre>
      <p style="font-size:14px;color:#555">Drop the file in, then reload \u2014 no need to restart the server.</p>
    </div>`;
  res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
  res.end(body);
}

function serveStatic(req, res) {
  HOME = findHomePage();
  if (!HOME.file) return diagnosticPage(res);

  let rel = decodeURIComponent(req.url.split("?")[0]);
  if (rel === "/") rel = "/" + path.basename(HOME.file);

  const file = path.join(HOME.root, path.normalize(rel).replace(/^(\.\.[/\\])+/, ""));
  if (!file.startsWith(HOME.root)) { res.writeHead(403); return res.end("Forbidden"); }

  fs.readFile(file, (err, data) => {
    if (err) {
      // unknown path — hand it to the single-page app
      return fs.readFile(HOME.file, (e2, home) => {
        if (e2) return diagnosticPage(res);
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(home);
      });
    }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(file)] || "application/octet-stream",
      "Cache-Control": file === HOME.file ? "no-cache" : "public, max-age=3600"
    });
    res.end(data);
  });
}

/* ---------------- server ---------------- */
const server = http.createServer(async (req, res) => {
  const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "?").split(",")[0].trim();
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const p = url.pathname;

  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");

  try {
    if (p === "/api/health") return json(res, 200, { ok: true, tutors: db.tutors.filter(t => t.active).length, bookings: db.bookings.length, pending: db.applications.filter(a => a.status === "pending").length });
    if (p === "/api/applications" && req.method === "POST") return await createApplication(req, res, ip);
    if (p === "/api/tutors" && req.method === "GET")
      return json(res, 200, db.tutors.filter(t => t.active).map(publicTutor));
    if (p === "/api/config")
      return json(res, 200, { brand: BRAND, subjects: SUBJECTS, lengths: LENGTHS, paymentsEnabled: PAYMENTS_ENABLED });
    if (p === "/api/holds" && req.method === "POST") return await createHold(req, res, ip);
    if (p === "/api/holds/confirm" && req.method === "POST") return await confirmHold(req, res);
    if (p === "/api/waitlist" && req.method === "POST") return await joinWaitlist(req, res, ip);
    if (p === "/api/me" || p === "/api/me/bookings") {
      const me = currentTutor(req);
      if (!me) return json(res, 401, { error: "Please sign in again." });
      if (p === "/api/me" && req.method === "GET") return json(res, 200, publicTutor(me));
      if (p === "/api/me" && req.method === "PATCH") return await updateMe(req, res, me);
      if (p === "/api/me/bookings" && req.method === "GET") return json(res, 200, {
        bookings: db.bookings.filter(x => x.tutorId === me.id).map(x => ({ ...x, manageToken: undefined })),
        waitlist: db.waitlist.filter(w => w.tutorId === me.id)
      });
    }
    if (p === "/api/login" && req.method === "POST") return await login(req, res, ip);

    let m = p.match(/^\/api\/applications\/([^/]+)\/verify$/);
    if (m && req.method === "POST") return await verifyApplication(req, res, m[1], ip);

    m = p.match(/^\/api\/applications\/([^/]+)\/approve$/);
    if (m && req.method === "GET") return ownerApprove(res, m[1], url.searchParams.get("token"));

    m = p.match(/^\/api\/manage\/([^/]+)$/);
    if (m && req.method === "GET") return bookingByToken(res, m[1]);

    m = p.match(/^\/api\/manage\/([^/]+)\/cancel$/);
    if (m && req.method === "POST") return await cancelBooking(req, res, m[1]);

    m = p.match(/^\/api\/me\/bookings\/([^/]+)\/note$/);
    if (m && req.method === "POST") {
      const me = currentTutor(req);
      if (!me) return json(res, 401, { error: "Please sign in again." });
      const bk = db.bookings.find(x => x.ref === m[1] && x.tutorId === me.id);
      if (!bk) return json(res, 404, { error: "No such booking." });
      bk.note = clean((await readBody(req)).note, 400) || null; save(db);
      return json(res, 200, { ok: true });
    }

    if (p.startsWith("/api/")) return json(res, 404, { error: "No such endpoint." });
    serveStatic(req, res);
  } catch (err) {
    console.error(err);
    json(res, 500, { error: "Something went wrong on our side." });
  }
});

server.listen(PORT, () => {
  console.log(`\nArgand Tutors running at ${PUBLIC_URL}`);
  console.log(`Owner email:  ${OWNER_EMAIL}`);
  console.log(`Sending mail: ${RESEND_API_KEY ? "yes, via Resend" : "no — codes will be printed to this console"}`);
  console.log(`Card payments: ${PAYMENTS_ENABLED ? "on" : "off \u2014 bookings are taken, you invoice separately"}`);
  console.log(`Data file:    ${DB_PATH}`);
  HOME = findHomePage();
  if (HOME.warning) {
    console.log(`\n  ⚠  ${HOME.warning}\n`);
  } else {
    console.log(`Home page:    ${HOME.file}\n`);
  }
});

setInterval(() => {
  const before = db.holds.length;
  db.holds = db.holds.filter(h => h.expires > Date.now());
  if (db.holds.length !== before) save(db);
}, 60000).unref();
