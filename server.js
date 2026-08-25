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
// Where tutor applications and approval codes are sent.
// Override with an OWNER_EMAIL environment variable when you deploy.
const OWNER_EMAIL = process.env.OWNER_EMAIL || "argandtutors@gmail.com";
// onboarding@resend.dev works straight away with no domain setup.
// Swap to noreply@yourdomain once you have verified the domain with Resend.
const FROM_EMAIL = process.env.FROM_EMAIL || "Argand Tutors <onboarding@resend.dev>";
const RESEND_API_KEY = process.env.RESEND_API_KEY || null;
const BREVO_API_KEY = process.env.BREVO_API_KEY || null;

// Card payments switch themselves on as soon as a Stripe key is present.
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || null;
const STRIPE_API_BASE = process.env.STRIPE_API_BASE || "https://api.stripe.com";
const CURRENCY = process.env.CURRENCY || "gbp";
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "data.json");

/* ---------------- encryption for bank details ----------------
   Bank details are encrypted with AES-256-GCM. The key lives in a separate
   file next to the data, or in ENCRYPTION_KEY. Lose the key and the bank
   details are unrecoverable — the rest of the data is unaffected. */
const KEY_PATH = process.env.KEY_PATH || path.join(__dirname, ".enc-key");
function loadKey() {
  if (process.env.ENCRYPTION_KEY) return crypto.createHash("sha256").update(process.env.ENCRYPTION_KEY).digest();
  try { return Buffer.from(fs.readFileSync(KEY_PATH, "utf8").trim(), "hex"); }
  catch {
    const k = crypto.randomBytes(32);
    try { fs.writeFileSync(KEY_PATH, k.toString("hex"), { mode: 0o600 }); }
    catch (e) { console.error("Could not save the encryption key:", e.message); }
    return k;
  }
}
const ENC_KEY = loadKey();
function encrypt(text) {
  if (!text) return null;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", ENC_KEY, iv);
  const out = Buffer.concat([c.update(String(text), "utf8"), c.final()]);
  return ["v1", iv.toString("hex"), c.getAuthTag().toString("hex"), out.toString("hex")].join(":");
}
function decrypt(blob) {
  if (!blob) return "";
  try {
    const [, ivh, tagh, data] = String(blob).split(":");
    const d = crypto.createDecipheriv("aes-256-gcm", ENC_KEY, Buffer.from(ivh, "hex"));
    d.setAuthTag(Buffer.from(tagh, "hex"));
    return Buffer.concat([d.update(Buffer.from(data, "hex")), d.final()]).toString("utf8");
  } catch { return ""; }
}
const maskAccount = n => (!n ? "" : "•••• " + String(n).slice(-4));

/* ---------------- storage ---------------- */
const EMPTY = { applications: [], tutors: [], bookings: [], holds: [], waitlist: [] };
function load() {
  try { return { ...EMPTY, ...JSON.parse(fs.readFileSync(DB_PATH, "utf8")) }; }
  catch { return JSON.parse(JSON.stringify(EMPTY)); }
}
/* ---------------- optional Postgres ----------------
   Set DATABASE_URL and the whole document lives in Postgres instead of a file,
   so it survives the disk being wiped on hosts like Render. Everything else
   in this file is unchanged — the data shape is identical. */
const DATABASE_URL = process.env.DATABASE_URL || null;
let pg = null;
async function initPg(ClientOverride) {
  if (!DATABASE_URL) return false;
  const { Client } = ClientOverride ? { Client: ClientOverride } : require("pg");
  pg = new Client({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await pg.connect();
  await pg.query("CREATE TABLE IF NOT EXISTS store (id int PRIMARY KEY, doc jsonb NOT NULL)");
  const r = await pg.query("SELECT doc FROM store WHERE id = 1");
  if (r.rows.length) db = { ...EMPTY, ...r.rows[0].doc };
  else await pg.query("INSERT INTO store (id, doc) VALUES (1, $1)", [JSON.stringify(db)]);
  return true;
}
async function writePg() {
  if (!pg) return;
  await pg.query("INSERT INTO store (id, doc) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET doc = $1",
    [JSON.stringify(db)]);
}

function save(db) {
  if (pg) { writePg().catch(e => console.error("Could not write to the database:", e.message)); return; }
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}
let db = load();

/* ---------------- the admin account ----------------
   Seeded once, never listed as a tutor. Change the password from the
   default as soon as you've signed in. */
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || "argandtutors@gmail.com").toLowerCase();
const ADMIN_DEFAULT_PASSWORD = process.env.ADMIN_PASSWORD || "Confazzled28@";
const DEFAULT_COMMISSION = Math.min(0.9, Math.max(0, Number(process.env.PLATFORM_COMMISSION ?? 0.2)));
if (!db.settings) db.settings = {};
if (db.settings.commission === undefined) db.settings.commission = DEFAULT_COMMISSION;
const commission = () => Math.min(0.9, Math.max(0, Number(db.settings.commission)));
const CONTACT_EMAIL = process.env.CONTACT_EMAIL || OWNER_EMAIL;
if (!Array.isArray(db.admins)) db.admins = [];
function ensureAdmin() {
  let a = db.admins.find(x => x.email === ADMIN_EMAIL);
  if (!a) {
    a = { id: crypto.randomUUID(), email: ADMIN_EMAIL, name: "Argand Admin",
          passwordHash: hashPassword(ADMIN_DEFAULT_PASSWORD), usingDefaultPassword: true,
          createdAt: new Date().toISOString() };
    db.admins.push(a);
    save(db);
  }
  return a;
}

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
  if (BREVO_API_KEY) {
    // Brevo works without owning a domain — handy before you buy one.
    const sender = process.env.BREVO_SENDER || OWNER_EMAIL;
    const res = await fetch((process.env.BREVO_API_BASE || "https://api.brevo.com") + "/v3/smtp/email", {
      method: "POST",
      headers: { "api-key": BREVO_API_KEY, "Content-Type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        sender: { name: BRAND, email: sender },
        to: [{ email: to }],
        subject, htmlContent: html
      })
    });
    if (!res.ok) throw new Error("Brevo rejected the message: " + await res.text());
    return res.json();
  }
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
      <tr><td style="padding:4px 12px 4px 0;color:#555">Phone</td><td>${app.phone ? esc(app.phone) : "not given"}</td></tr>
    </table>
    <p style="font-family:system-ui;font-size:14px;white-space:pre-wrap;background:#f5f5f5;padding:12px;border-radius:6px">${esc(app.bio)}</p>
    <p>If you're happy to take them on, give them this confirmation code:</p>
    ${codeBlock(app.code)}
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
  if (clean(b.bankHolder).length < 2) errors.push("bankHolder");
  if (clean(b.bankSortCode).replace(/\D/g, "").length !== 6) errors.push("bankSortCode");
  if (clean(b.bankAccountNumber).replace(/\D/g, "").length !== 8) errors.push("bankAccountNumber");

  if (errors.length) return json(res, 400, { error: "Some details are missing or invalid.", fields: errors });
  // an A* in the subject is the entry requirement, so enforce it per subject
  const chosen = (Array.isArray(b.subjectIds) ? b.subjectIds : []).map(subjectById).filter(Boolean);
  const unqualified = chosen.filter(sj => !gradeQualifies(sj, b.grades));
  if (unqualified.length) return json(res, 400, {
    error: "You can only teach subjects you got an A* in: " + unqualified.map(x => x.name).join(", "),
    fields: ["subjects"], unqualified: unqualified.map(x => x.id)
  });

  const email = String(b.email).trim().toLowerCase();
  if (db.tutors.some(t => t.email === email && t.active))
    return json(res, 409, { error: "There's already an account with that email. Sign in instead." });

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
    phone: clean(b.phone, 32),
    bank: {
      holder: clean(b.bankHolder, 80),
      sortCode: encrypt(clean(b.bankSortCode, 12).replace(/\D/g, "")),
      accountNumber: encrypt(clean(b.bankAccountNumber, 12).replace(/\D/g, "")),
      last4: clean(b.bankAccountNumber, 12).replace(/\D/g, "").slice(-4)
    },
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
    console.error("\n  ####  COULD NOT EMAIL YOU THE APPLICATION  ####");
    console.error("  Reason: " + err.message);
    console.error("  Applicant: " + app.name + " <" + app.email + ">");
    console.error("  Their approval code is: " + app.code);
    console.error("  Nothing is lost - send them that code and their account activates.");
    console.error("  ###############################################\n");
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
  const returning = db.tutors.find(x => x.email === app.email);
  if (returning) {
    Object.assign(returning, {
      name: app.name, passwordHash: app.passwordHash, university: app.university,
      course: app.course, year: app.year, grades: app.grades, subjectIds: app.subjectIds,
      bio: app.bio, phone: app.phone || returning.phone, bank: app.bank || returning.bank,
      active: true, session: null, reactivatedAt: new Date().toISOString()
    });
    save(db);
    sendEmail(app.email, "Your " + BRAND + " account is active again", wrap(
      `<p>Hi ${esc(app.name.split(" ")[0])}, your account has been reinstated.</p>
       <p>Your past sessions and earnings history are still there. Check your availability is
       right before students start booking.</p>
       ${emailButton(PUBLIC_URL + "/#/staff", "Sign in")}`)).catch(e => console.error(e.message));
    return json(res, 200, { status: "approved", reactivated: true });
  }
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
    rates: {},
    phone: app.phone || "",
    bank: app.bank || null,
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
  const email = clean(b.email).toLowerCase();

  const admin = db.admins.find(x => x.email === email);
  if (admin) {
    if (!verifyPassword(String(b.password || ""), admin.passwordHash))
      return json(res, 401, { error: "Those details don't match an account." });
    const at = crypto.randomBytes(24).toString("hex");
    admin.session = { token: at, expires: Date.now() + 7 * 864e5 };
    save(db);
    return json(res, 200, { token: at, role: "admin",
      admin: { name: admin.name, email: admin.email, usingDefaultPassword: !!admin.usingDefaultPassword } });
  }

  const t = db.tutors.find(x => x.email === email);
  if (!t || !t.active || !verifyPassword(String(b.password || ""), t.passwordHash))
    return json(res, 401, { error: "Those details don't match an account." });
  const token = crypto.randomBytes(24).toString("hex");
  t.session = { token, expires: Date.now() + 7 * 864e5 };
  save(db);
  json(res, 200, { token, role: "tutor", tutor: { ...publicTutor(t), phone: t.phone || "", email: t.email } });
}


/* ============================================================
   CATALOGUE — edit these to change what you offer. Prices per hour, in pounds.
   ============================================================ */
const DEFAULT_SUBJECTS = [
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
// Subjects live in the database so the admin can change them. Each carries the
// A-Level subject names that qualify someone to teach it.
const SUBJECT_QUALIFIERS = {
  1: ["maths", "mathematics", "further maths", "further mathematics"],
  2: ["further maths", "further mathematics"],
  3: ["physics"],
  4: ["computer science", "computing", "computer studies"],
  5: ["maths", "mathematics", "further maths", "further mathematics"],
  6: ["further maths", "further mathematics"],
  7: ["physics"],
  8: ["computer science", "computing", "computer studies"]
};
if (!Array.isArray(db.settings.subjects) || !db.settings.subjects.length) {
  db.settings.subjects = DEFAULT_SUBJECTS.map(x => ({
    ...x, active: true, qualifiers: SUBJECT_QUALIFIERS[x.id] || [x.name.toLowerCase()]
  }));
  save(db);
}
const allSubjects = () => db.settings.subjects;
const activeSubjects = () => db.settings.subjects.filter(x => x.active !== false);
const subjectById = id => db.settings.subjects.find(s => s.id === Number(id));
const nextSubjectId = () => db.settings.subjects.reduce((m, x) => Math.max(m, x.id), 0) + 1;

// Does an A* in one of these grades qualify someone to teach this subject?
function gradeQualifies(subject, grades) {
  const stars = (grades || []).filter(g => String(g.grade).trim() === "A*")
    .map(g => String(g.subject || "").toLowerCase().replace(/[^a-z ]/g, "").trim());
  if (!stars.length) return false;
  const want = (subject.qualifiers && subject.qualifiers.length)
    ? subject.qualifiers : [String(subject.name).toLowerCase()];
  // one-way on purpose: "further mathematics" contains "mathematics", so matching
  // both directions would let a plain Maths A* unlock Further Maths
  return stars.some(got => want.some(w => got.includes(w)));
}

/* Promo codes. Add more by copying a line. `percent` is the discount.
   Set `expires` to an ISO date string to make one temporary. */
const PROMOS = {
  EPSILON: { percent: 20, label: "EPSILON", expires: null }
};
function lookupPromo(code) {
  if (!code) return null;
  const p = PROMOS[String(code).trim().toUpperCase()];
  if (!p) return null;
  if (p.expires && new Date(p.expires) < new Date()) return null;
  return p;
}

// Card payments stay off until Stripe is wired in. Bookings are still real sessions;
// you invoice separately. Better than a "Pay now" button on a live site that takes nothing.
const PAYMENTS_ENABLED = !!STRIPE_SECRET_KEY;

// Customers are not asked to verify their email by default — an extra step
// before paying loses bookings. Set VERIFY_CUSTOMER_EMAIL=true to switch it
// back on if you start getting junk bookings.
const VERIFY_EMAIL = String(process.env.VERIFY_CUSTOMER_EMAIL || "").toLowerCase() === "true";
const BRAND = process.env.BRAND || "Argand Tutors";

const clean = (v, max = 500) => String(v ?? "").trim().slice(0, max);
const money = n => "\u00a3" + n.toFixed(2).replace(/\.00$/, "");
// Email HTML has to survive Outlook, so it's tables and inline styles throughout.
// The mark is drawn with borders rather than an image — most clients block images
// by default, and a header that vanishes looks broken.
const wrap = (inner, opts = {}) => `<!doctype html>
<html><body style="margin:0;padding:0;background:#f4f2ee;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f2ee;padding:24px 12px;">
<tr><td align="center">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:540px;background:#ffffff;border-radius:10px;overflow:hidden;border:1px solid rgba(0,0,0,.08);">

    <tr><td style="background:#2743c4;padding:20px 24px;">
      <table role="presentation" cellpadding="0" cellspacing="0"><tr>
        <td width="34" style="padding-right:12px;">
          <table role="presentation" width="30" height="30" cellpadding="0" cellspacing="0"
                 style="border-left:2px solid #ffffff;border-bottom:2px solid #ffffff;">
            <tr><td align="right" valign="top" style="font-family:Georgia,serif;font-size:15px;color:#ffffff;line-height:1;padding:1px 2px 0 0;">&bull;</td></tr>
          </table>
        </td>
        <td style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;">
          <div style="color:#ffffff;font-size:18px;font-weight:600;letter-spacing:-.2px;">${esc(BRAND)}</div>
          <div style="color:rgba(255,255,255,.72);font-size:12px;">GCSE and A-Level maths, physics and computing</div>
        </td>
      </tr></table>
    </td></tr>

    <tr><td style="padding:24px;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#1a1a1a;">
      ${inner}
    </td></tr>

    <tr><td style="background:#fafafa;border-top:1px solid rgba(0,0,0,.08);padding:16px 24px;
        font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:12px;color:#666;line-height:1.5;">
      Questions? Reply to this email or write to
      <a href="mailto:${esc(CONTACT_EMAIL)}" style="color:#2743c4;">${esc(CONTACT_EMAIL)}</a>.<br>
      ${esc(BRAND)}${opts.footer ? " &middot; " + opts.footer : ""}
    </td></tr>

  </table>
</td></tr></table>
</body></html>`;

// a button that still looks like a button in Outlook
const emailButton = (href, label) => `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:18px 0;">
  <tr><td style="background:#2743c4;border-radius:6px;">
    <a href="${href}" style="display:inline-block;padding:11px 22px;color:#ffffff;text-decoration:none;
       font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:14px;font-weight:600;">${label}</a>
  </td></tr></table>`;

// the big code, styled so it reads at a glance
const codeBlock = code => `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:16px 0;">
  <tr><td style="background:#eef1fc;border-radius:8px;padding:14px 22px;font-family:ui-monospace,Menlo,Consolas,monospace;
     font-size:30px;letter-spacing:7px;font-weight:700;color:#182b8c;">${code}</td></tr></table>`;
const dayKey = d => d.toISOString().slice(0, 10);

function currentAdmin(req) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!token) return null;
  return db.admins.find(x => x.session && x.session.token === token && x.session.expires > Date.now()) || null;
}
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

// A tutor's own rate for a subject wins. Otherwise it's the subject's base
// price plus their premium, which is what a brand-new tutor starts on.
function hourlyFor(t, subjectId) {
  const own = (t.rates || {})[String(subjectId)];
  if (own !== undefined && own !== null && own !== "") return Number(own);
  return subjectById(subjectId).price + (t.premium || 0);
}
const priceFor = (t, subjectId, mins) =>
  Math.round(hourlyFor(t, subjectId) * LENGTHS.find(l => l.mins === Number(mins)).mult * 100) / 100;

const publicTutor = t => ({
  id: t.id, name: t.name, headline: t.headline, bio: t.bio,
  university: t.university, course: t.course, year: t.year, sat: t.sat,
  grades: t.grades, subjectIds: t.subjectIds, premium: t.premium, rates: t.rates || {}, photo: t.photo,
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
  if (b.phone !== undefined) t.phone = clean(b.phone, 32);
  if (b.rates && typeof b.rates === "object") {
    const next = {};
    for (const [k, v] of Object.entries(b.rates)) {
      if (!subjectById(k)) continue;
      if (v === null || v === "") continue;
      next[k] = Math.max(5, Math.min(300, Number(v) || 0));
    }
    t.rates = next;
  }
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

/* ---------- Stripe ---------- */
// Form-encodes nested objects the way Stripe's API expects: a[b][c]=v
function formEncode(obj, prefix = "", out = []) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}[${k}]` : k;
    if (v === undefined || v === null) continue;
    if (typeof v === "object") formEncode(v, key, out);
    else out.push(encodeURIComponent(key) + "=" + encodeURIComponent(v));
  }
  return out;
}
async function stripe(path, body, method = "POST") {
  const res = await fetch(STRIPE_API_BASE + "/v1/" + path, {
    method,
    headers: {
      Authorization: "Bearer " + STRIPE_SECRET_KEY,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: body ? formEncode(body).join("&") : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data.error && data.error.message) || "Payment provider error");
  return data;
}

async function createCheckout(req, res, holdId) {
  const hold = db.holds.find(h => h.id === holdId);
  if (!hold) return json(res, 404, { error: "That booking attempt has expired. Please start again." });
  if (!hold.verified) return json(res, 403, { error: "Confirm your email address first." });
  if (hold.expires < Date.now()) return json(res, 410, { error: "Your held slot expired. Please start again." });

  const t = db.tutors.find(x => x.id === hold.tutorId), sj = subjectById(hold.subjectId);
  const n = hold.days.length;
  try {
    const session = await stripe("checkout/sessions", {
      mode: "payment",
      customer_email: hold.email,
      success_url: `${PUBLIC_URL}/#/paid/${hold.id}/{CHECKOUT_SESSION_ID}`,
      cancel_url: `${PUBLIC_URL}/#/profile/${t.id}`,
      metadata: { holdId: hold.id },
      line_items: {
        0: {
          quantity: n,
          price_data: {
            currency: CURRENCY,
            unit_amount: Math.round(hold.perSession * 100),
            product_data: {
              name: `${sj.name} with ${t.name}`,
              description: `${hold.mins}-minute session${n > 1 ? "s" : ""}, ${hold.days.join(", ")}`
            }
          }
        }
      }
    });
    hold.checkoutSessionId = session.id;
    save(db);
    json(res, 200, { url: session.url });
  } catch (err) {
    console.error("Stripe checkout failed:", err.message);
    json(res, 502, { error: "We couldn't start the payment. Nothing has been charged — please try again." });
  }
}

// Called when Stripe sends the customer back. We ask Stripe directly whether the
// session was paid rather than trusting anything the browser hands us.
async function completeCheckout(req, res, holdId, sessionId) {
  const hold = db.holds.find(h => h.id === holdId);
  if (!hold) {
    const already = db.bookings.filter(b => b.checkoutSessionId === sessionId && b.status === "confirmed");
    if (already.length) return json(res, 200, { bookings: already.map(b => ({ ...b, manageToken: undefined })),
      manageToken: already[0].manageToken, skipped: [], alreadyDone: true });
    return json(res, 404, { error: "That booking attempt has expired. If you were charged, contact us and we'll sort it." });
  }
  let session;
  try { session = await stripe("checkout/sessions/" + encodeURIComponent(sessionId), null, "GET"); }
  catch (err) { return json(res, 502, { error: "We couldn't confirm the payment yet. Please refresh in a moment." }); }
  if (session.payment_status !== "paid") return json(res, 402, { error: "That payment hasn't completed." });

  return finaliseBooking(res, hold, { paid: true, sessionId, paymentIntent: session.payment_intent });
}

// What a tutor has taught and what they're owed. A session counts once it has
// finished; anything already settled is excluded from the outstanding figure.
function earningsFor(tutorId) {
  const now = Date.now();
  let hours = 0, gross = 0, outstanding = 0, sessions = 0, upcoming = 0;
  for (const b of db.bookings) {
    if (b.tutorId !== tutorId || b.status !== "confirmed") continue;
    const end = new Date(`${b.day}T${String(b.hour).padStart(2, "0")}:00:00Z`).getTime() + b.mins * 6e4;
    if (end > now) { upcoming++; continue; }
    sessions++;
    hours += b.mins / 60;
    gross += b.price;
    if (!b.settledAt) outstanding += b.price;
  }
  const round = n => Math.round(n * 100) / 100;
  return {
    sessions, upcoming, hours: round(hours), gross: round(gross),
    commission: round(outstanding * commission()),
    owed: round(outstanding * (1 - commission())),
    outstandingGross: round(outstanding)
  };
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

  const promo = lookupPromo(b.promo);
  if (b.promo && !promo) return json(res, 400, { error: "That promo code isn't valid." });
  const per = priceFor(t, sj.id, len.mins);
  const disc = days.length >= 4 ? 0.9 : 1;
  const promoMult = promo ? (100 - promo.percent) / 100 : 1;
  const hold = {
    id: crypto.randomUUID(), tutorId: t.id, subjectId: sj.id, mins: len.mins, hour: Number(b.hour),
    days, skipped, name: clean(b.name, 80), email: clean(b.email).toLowerCase(),
    phone: clean(b.phone, 32),
    listPrice: per,
    blockDiscount: disc < 1,
    promo: promo ? promo.label : null,
    promoPercent: promo ? promo.percent : 0,
    perSession: Math.round(per * disc * promoMult * 100) / 100,
    total: Math.round(per * days.length * disc * promoMult * 100) / 100,
    code: sixDigits(), attempts: 0, expires: Date.now() + 15 * 6e4
  };
  db.holds.push(hold); save(db);

  if (VERIFY_EMAIL) sendEmail(hold.email, "Your " + BRAND + " verification code", wrap(
    `<h2 style="font-size:19px;margin:0 0 6px;">Confirm your email</h2>
     <p style="margin:0 0 4px;color:#555;">Enter this code to finish booking:</p>
     ${codeBlock(hold.code)}
     <p style="font-size:13px;color:#666;margin:0;">It expires in 15 minutes. If this wasn't you, ignore it \u2014 nothing has been booked.</p>`)
  ).catch(e => {
    console.error("\n  ####  COULD NOT EMAIL THE CUSTOMER THEIR CODE  ####");
    console.error("  Reason: " + e.message);
    console.error("  Customer: " + hold.email);
    console.error("  Their code is: " + hold.code);
    console.error("  ###################################################\n");
  });

  json(res, 201, { holdId: hold.id, total: hold.total, perSession: hold.perSession,
    listPrice: hold.listPrice, sessions: days.length, skipped, verifyEmail: VERIFY_EMAIL,
    blockDiscount: hold.blockDiscount, promo: hold.promo, promoPercent: hold.promoPercent });
}

async function confirmHold(req, res) {
  const b = await readBody(req);
  const hold = db.holds.find(h => h.id === b.holdId);
  if (!hold) return json(res, 404, { error: "That booking attempt has expired. Please start again." });
  if (hold.expires < Date.now()) return json(res, 410, { error: "Your held slot expired. Please start again." });
  if (VERIFY_EMAIL && hold.attempts >= 5) return json(res, 429, { error: "Too many wrong codes. Please start again." });
  if (VERIFY_EMAIL && String(b.code) !== hold.code) {
    hold.attempts++; save(db);
    return json(res, 401, { error: "That code isn't right.", attemptsLeft: 5 - hold.attempts });
  }
  if (PAYMENTS_ENABLED) {
    hold.verified = true; save(db);
    return json(res, 200, { needsPayment: true, holdId: hold.id, total: hold.total });
  }
  return finaliseBooking(res, hold, { paid: false });
}

function finaliseBooking(res, hold, pay) {
  const t = db.tutors.find(x => x.id === hold.tutorId), sj = subjectById(hold.subjectId);
  db.holds = db.holds.filter(h => h.id !== hold.id);
  const made = [];
  for (const iso of hold.days) {
    if (!slotFree(t, iso, hold.hour, hold.mins)) continue;
    made.push({
      ref: "AR-" + crypto.randomBytes(3).toString("hex").toUpperCase(),
      manageToken: crypto.randomBytes(20).toString("hex"),
      tutorId: t.id, subjectId: sj.id, day: iso, hour: hold.hour, mins: hold.mins,
      price: hold.perSession, name: hold.name, email: hold.email, phone: hold.phone || "",
      promo: hold.promo || null,
      status: "confirmed", note: null,
      paid: !!pay.paid, checkoutSessionId: pay.sessionId || null, paymentIntent: pay.paymentIntent || null,
      remind24: false, remind1: false, createdAt: new Date().toISOString()
    });
  }
  if (!made.length) { save(db); return json(res, 409, { error: "That time was taken while you were confirming. Nothing has been booked." }); }
  db.bookings.push(...made); save(db);

  const f = made[0];
  const when = x => new Date(x.day + "T12:00:00Z").toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })
                    + " at " + String(x.hour).padStart(2, "0") + ":00";
  const contactBox = (title, rows) => `<table style="font-size:14px;border-collapse:collapse;margin:4px 0 14px">
     <tr><td colspan="2" style="padding:6px 0 2px;font-weight:600">${title}</td></tr>
     ${rows.filter(Boolean).map(([k, v]) => `<tr><td style="padding:2px 14px 2px 0;color:#666">${k}</td><td>${v}</td></tr>`).join("")}
   </table>`;
  const tutorBoxFor = title => contactBox(title, [
    ["Name", esc(t.name)],
    ["Email", `<a href="mailto:${esc(t.email)}">${esc(t.email)}</a>`],
    t.phone ? ["Phone", esc(t.phone)] : null,
    ["Studying", esc(t.course) + ", " + esc(t.university)]
  ]);
  const tutorBox = tutorBoxFor("Your tutor");
  const clientBox = contactBox("Your student", [
    ["Name", esc(f.name)],
    ["Email", `<a href="mailto:${esc(f.email)}">${esc(f.email)}</a>`],
    f.phone ? ["Phone", esc(f.phone)] : ["Phone", "not given"]
  ]);

  sendEmail(f.email, "Booking confirmed \u2014 " + sj.name + " with " + t.name, wrap(
    `<h2 style="font-size:19px;margin:0 0 12px">You're booked in</h2>
     <p>${esc(sj.name)} with ${esc(t.name)}${made.length > 1 ? ", " + made.length + " weekly sessions starting" : ","} ${when(f)}.</p>
     <p>Reference <b>${f.ref}</b> \u00b7 ${hold.mins} minutes \u00b7 ${money(f.price)}${made.length > 1 ? " per session" : ""}
     ${hold.promo ? `<br><span style="color:#0f766e">Promo ${esc(hold.promo)} applied \u2014 ${hold.promoPercent}% off</span>` : ""}</p>
     ${tutorBox}
     ${clientBox}
     ${pay.paid
       ? `<p style="font-size:13px;color:#555">Paid by card \u2014 ${money(hold.total)} in total. Your card statement will show ${esc(BRAND)}.</p>`
       : `<p style="font-size:13px;color:#555">${esc(t.name.split(" ")[0])} will arrange payment with you directly before the first session.</p>`}
     ${emailButton(`${PUBLIC_URL}/#/manage/${f.manageToken}`, "View or cancel this booking")}
     <p style="font-size:13px;color:#555">Free to cancel up to 24 hours before, using the link above.</p>`)
  ).catch(e => console.error(e.message));

  sendEmail(t.email, "New booking \u2014 " + sj.name + " with " + f.name + ", " + when(f), wrap(
    `<h2 style="font-size:19px;margin:0 0 12px">You have a new booking</h2>
     <p><b>${esc(f.name)}</b> has booked ${esc(sj.name)}${made.length > 1 ? " \u2014 " + made.length + " weekly sessions" : ""}.</p>
     <p>${when(f)} \u00b7 ${hold.mins} minutes \u00b7 ${money(f.price)}${made.length > 1 ? " per session" : ""}
     ${made.length > 1 ? `<br><span style="color:#666">All dates: ${made.map(x => x.day).join(", ")}</span>` : ""}
     ${hold.promo ? `<br><span style="color:#0f766e">Promo ${esc(hold.promo)} applied \u2014 ${hold.promoPercent}% off</span>` : ""}</p>
     ${clientBox}
     ${tutorBoxFor("Your details, as the student sees them")}
     ${PAYMENTS_ENABLED && pay.paid
        ? `<p style="font-size:13px;color:#555">Paid by card. Nothing to collect.</p>`
        : `<p style="font-size:13px;color:#555">Payment hasn't been taken by the site \u2014 arrange it with ${esc(f.name.split(" ")[0])} directly.</p>`}
     ${emailButton(`${PUBLIC_URL}/#/staff`, "Open your dashboard")}`)
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

  if (free && b.paid && b.paymentIntent && PAYMENTS_ENABLED) {
    try {
      await stripe("refunds", { payment_intent: b.paymentIntent, amount: Math.round(b.price * 100) });
      b.refunded = true; save(db);
    } catch (err) {
      console.error("Refund failed for " + b.ref + ":", err.message);
      b.refundError = err.message; save(db);
    }
  }

  sendEmail(b.email, "Cancelled \u2014 " + subjectById(b.subjectId).name + ", " + b.day, wrap(
    `<p>Your ${b.day} session at ${String(b.hour).padStart(2, "0")}:00 has been cancelled.</p>
     <p>${free
        ? (b.paid ? `A refund of ${money(b.price)} is on its way back to your card. Card refunds usually take 5\u201310 working days.`
                  : `Nothing is owed for this session.`)
        : `This was inside the 24-hour window, so under the cancellation policy the session is still chargeable.`}</p>`)
  ).catch(e => console.error(e.message));
  const t = db.tutors.find(x => x.id === b.tutorId);
  const waiting = db.waitlist.filter(w => w.tutorId === b.tutorId && w.day === b.day && w.hour === b.hour);
  if (waiting.length) {
    for (const w of waiting) {
      sendEmail(w.email, "A slot has opened up \u2014 " + b.day, wrap(
        `<p>The ${String(b.hour).padStart(2, "0")}:00 session on ${b.day} with ${esc(t ? t.name : "your tutor")} is free again.</p>
         <p>It's first come, first served \u2014 <a href="${PUBLIC_URL}/#/profile/${b.tutorId}">book it here</a>.</p>`)
      ).catch(e => console.error("Waitlist email failed:", e.message));
    }
    db.waitlist = db.waitlist.filter(w => !waiting.includes(w));
    save(db);
  }
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
  let mm2;

  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");

  try {
    if (p === "/api/health") return json(res, 200, { ok: true, tutors: db.tutors.filter(t => t.active).length, bookings: db.bookings.length, pending: db.applications.filter(a => a.status === "pending").length });
    if (p === "/api/applications" && req.method === "POST") return await createApplication(req, res, ip);
    if (p === "/api/tutors" && req.method === "GET")
      return json(res, 200, db.tutors.filter(t => t.active).map(publicTutor));
    if (p === "/api/config")
      return json(res, 200, { brand: BRAND, subjects: activeSubjects(), lengths: LENGTHS,
        paymentsEnabled: PAYMENTS_ENABLED, verifyEmail: VERIFY_EMAIL, contactEmail: CONTACT_EMAIL });
    if (p === "/api/holds" && req.method === "POST") return await createHold(req, res, ip);
    if (p === "/api/holds/confirm" && req.method === "POST") return await confirmHold(req, res);
    if ((mm2 = p.match(/^\/api\/holds\/([^/]+)\/checkout$/)) && req.method === "POST")
      return await createCheckout(req, res, mm2[1]);
    if ((mm2 = p.match(/^\/api\/holds\/([^/]+)\/complete\/([^/]+)$/)) && req.method === "POST")
      return await completeCheckout(req, res, mm2[1], mm2[2]);
    if (p === "/api/waitlist" && req.method === "POST") return await joinWaitlist(req, res, ip);
    if (p === "/api/promo" && req.method === "POST") {
      if (!rateLimit(ip, "promo", 40, 36e5)) return json(res, 429, { error: "Too many attempts." });
      const pc = lookupPromo((await readBody(req)).code);
      return pc ? json(res, 200, { valid: true, percent: pc.percent, label: pc.label })
                : json(res, 404, { valid: false, error: "That code isn't recognised." });
    }
    if (p === "/api/me" || p === "/api/me/bookings") {
      const me = currentTutor(req);
      if (!me) return json(res, 401, { error: "Please sign in again." });
      if (p === "/api/me" && req.method === "GET")
        return json(res, 200, { ...publicTutor(me), phone: me.phone || "", email: me.email });
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

    if (p.startsWith("/api/admin")) {
      const admin = currentAdmin(req);
      if (!admin) return json(res, 401, { error: "Admin sign-in required." });

      if (p === "/api/admin/overview" && req.method === "GET") {
        const tutors = db.tutors.map(t => ({
          ...publicTutor(t), email: t.email, phone: t.phone || "", active: t.active,
          bank: t.bank ? { holder: t.bank.holder, last4: t.bank.last4 } : null,
          earnings: earningsFor(t.id)
        }));
        const totals = tutors.reduce((a, t) => ({
          owed: a.owed + t.earnings.owed, hours: a.hours + t.earnings.hours,
          gross: a.gross + t.earnings.gross
        }), { owed: 0, hours: 0, gross: 0 });
        return json(res, 200, {
          tutors,
          totals: { owed: Math.round(totals.owed * 100) / 100, hours: Math.round(totals.hours * 100) / 100,
                    gross: Math.round(totals.gross * 100) / 100 },
          commission: commission(),
          applications: db.applications.filter(a => a.status === "pending")
            .map(a => ({ id: a.id, name: a.name, email: a.email, university: a.university,
                         course: a.course, grades: a.grades, createdAt: a.createdAt })),
          bookings: db.bookings.length,
          usingDefaultPassword: !!admin.usingDefaultPassword
        });
      }

      let am;
      if ((am = p.match(/^\/api\/admin\/tutors\/([^/]+)\/bank$/)) && req.method === "GET") {
        const t = db.tutors.find(x => x.id === am[1]);
        if (!t || !t.bank) return json(res, 404, { error: "No bank details on file." });
        console.log(`[audit] ${new Date().toISOString()} admin viewed bank details for ${t.name}`);
        return json(res, 200, {
          holder: t.bank.holder,
          sortCode: decrypt(t.bank.sortCode).replace(/(\d{2})(\d{2})(\d{2})/, "$1-$2-$3"),
          accountNumber: decrypt(t.bank.accountNumber)
        });
      }
      if ((am = p.match(/^\/api\/admin\/tutors\/([^/]+)$/)) && req.method === "PATCH") {
        const t = db.tutors.find(x => x.id === am[1]);
        if (!t) return json(res, 404, { error: "No such tutor." });
        const body = await readBody(req);
        if (body.active !== undefined) t.active = !!body.active;
        if (body.headline !== undefined) t.headline = clean(body.headline, 70);
        if (body.bio !== undefined) t.bio = clean(body.bio, 600);
        if (body.phone !== undefined) t.phone = clean(body.phone, 32);
        if (body.university !== undefined) t.university = clean(body.university, 80);
        if (body.course !== undefined) t.course = clean(body.course, 80);
        if (body.premium !== undefined) t.premium = Math.max(0, Math.min(30, Number(body.premium) || 0));
        if (Array.isArray(body.subjectIds)) t.subjectIds = body.subjectIds.filter(subjectById);
        if (body.rates && typeof body.rates === "object") {
          const next = {};
          for (const [k, v] of Object.entries(body.rates)) {
            if (!subjectById(k) || v === "" || v === null) continue;
            next[k] = Math.max(5, Math.min(300, Number(v) || 0));
          }
          t.rates = next;
        }
        save(db);
        return json(res, 200, { ...publicTutor(t), active: t.active, email: t.email, phone: t.phone || "" });
      }
      if ((am = p.match(/^\/api\/admin\/tutors\/([^/]+)\/settle$/)) && req.method === "POST") {
        const t = db.tutors.find(x => x.id === am[1]);
        if (!t) return json(res, 404, { error: "No such tutor." });
        const now = Date.now(), stamp = new Date().toISOString();
        let n = 0;
        for (const b of db.bookings) {
          if (b.tutorId !== t.id || b.status !== "confirmed" || b.settledAt) continue;
          const end = new Date(`${b.day}T${String(b.hour).padStart(2, "0")}:00:00Z`).getTime() + b.mins * 6e4;
          if (end <= now) { b.settledAt = stamp; n++; }
        }
        save(db);
        console.log(`[audit] ${stamp} admin settled ${n} sessions for ${t.name}`);
        return json(res, 200, { settled: n, earnings: earningsFor(t.id) });
      }
      if (p === "/api/admin/settings" && req.method === "POST") {
        const body = await readBody(req);
        if (body.commission !== undefined) {
          const c = Number(body.commission);
          if (!(c >= 0 && c <= 90)) return json(res, 400, { error: "Commission must be between 0 and 90 percent." });
          db.settings.commission = c / 100;
        }
        save(db);
        return json(res, 200, { commission: commission() });
      }

      if (p === "/api/admin/bookings" && req.method === "GET") {
        const rows = db.bookings.slice().sort((a, b) => (b.day + b.hour).localeCompare(a.day + a.hour)).slice(0, 200);
        return json(res, 200, rows.map(b => {
          const t = db.tutors.find(x => x.id === b.tutorId);
          return { ref: b.ref, day: b.day, hour: b.hour, mins: b.mins, price: b.price, status: b.status,
                   promo: b.promo || null, paid: !!b.paid, settled: !!b.settledAt,
                   subject: (subjectById(b.subjectId) || {}).name, tutor: t ? t.name : "—",
                   client: b.name, email: b.email, phone: b.phone || "" };
        }));
      }

      if (p === "/api/admin/export.csv" && req.method === "GET") {
        const esc2 = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
        const head = ["Reference","Date","Time","Minutes","Subject","Tutor","Client","Email","Phone",
                      "Price","Promo","Status","Paid by card","Settled with tutor"];
        const lines = [head.join(",")];
        for (const b of db.bookings) {
          const t = db.tutors.find(x => x.id === b.tutorId);
          lines.push([b.ref, b.day, String(b.hour).padStart(2, "0") + ":00", b.mins,
            (subjectById(b.subjectId) || {}).name, t ? t.name : "", b.name, b.email, b.phone || "",
            b.price, b.promo || "", b.status, b.paid ? "yes" : "no", b.settledAt ? "yes" : "no"
          ].map(esc2).join(","));
        }
        const body = lines.join("\r\n");
        res.writeHead(200, { "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="argand-bookings-${new Date().toISOString().slice(0,10)}.csv"` });
        return res.end(body);
      }

      if ((am = p.match(/^\/api\/admin\/applications\/([^/]+)$/)) && req.method === "GET") {
        const a = db.applications.find(x => x.id === am[1]);
        if (!a) return json(res, 404, { error: "No such application." });
        console.log(`[audit] ${new Date().toISOString()} admin viewed the code for ${a.name}`);
        return json(res, 200, { code: a.code, email: a.email, name: a.name, bio: a.bio,
          phone: a.phone, grades: a.grades, subjectNames: a.subjectNames });
      }

      if ((am = p.match(/^\/api\/admin\/applications\/([^/]+)\/reject$/)) && req.method === "POST") {
        const a = db.applications.find(x => x.id === am[1]);
        if (!a) return json(res, 404, { error: "No such application." });
        a.status = "rejected"; save(db);
        return json(res, 200, { ok: true });
      }

      if (p === "/api/admin/subjects" && req.method === "GET")
        return json(res, 200, allSubjects());

      if (p === "/api/admin/subjects" && req.method === "POST") {
        const body = await readBody(req);
        const name = clean(body.name, 60);
        if (name.length < 3) return json(res, 400, { error: "Give the subject a name." });
        if (allSubjects().some(x => x.name.toLowerCase() === name.toLowerCase()))
          return json(res, 409, { error: "There's already a subject with that name." });
        const price = Math.max(5, Math.min(300, Number(body.price) || 30));
        const sj = {
          id: nextSubjectId(), name,
          area: clean(body.area, 30) || "Other",
          level: clean(body.level, 20) || "A-Level",
          price, icon: clean(body.icon, 4) || "\u2022",
          desc: clean(body.desc, 300) || "One to one sessions in " + name + ".",
          qualifiers: (Array.isArray(body.qualifiers) && body.qualifiers.length
            ? body.qualifiers : [name.replace(/^(GCSE|A-Level)\s+/i, "")])
            .map(x => String(x).toLowerCase().trim()).filter(Boolean),
          active: true
        };
        db.settings.subjects.push(sj); save(db);
        return json(res, 201, sj);
      }

      if ((am = p.match(/^\/api\/admin\/subjects\/(\d+)$/)) && req.method === "PATCH") {
        const sj = subjectById(am[1]);
        if (!sj) return json(res, 404, { error: "No such subject." });
        const body = await readBody(req);
        if (body.name !== undefined && clean(body.name, 60).length >= 3) sj.name = clean(body.name, 60);
        if (body.price !== undefined) sj.price = Math.max(5, Math.min(300, Number(body.price) || sj.price));
        if (body.desc !== undefined) sj.desc = clean(body.desc, 300);
        if (body.area !== undefined) sj.area = clean(body.area, 30);
        if (body.level !== undefined) sj.level = clean(body.level, 20);
        if (body.icon !== undefined) sj.icon = clean(body.icon, 4);
        if (body.active !== undefined) sj.active = !!body.active;
        if (Array.isArray(body.qualifiers))
          sj.qualifiers = body.qualifiers.map(x => String(x).toLowerCase().trim()).filter(Boolean);
        save(db);
        return json(res, 200, sj);
      }

      if ((am = p.match(/^\/api\/admin\/subjects\/(\d+)$/)) && req.method === "DELETE") {
        const sj = subjectById(am[1]);
        if (!sj) return json(res, 404, { error: "No such subject." });
        const used = db.bookings.some(b => b.subjectId === sj.id);
        if (used) {
          // bookings still point at it, so hide it rather than break their history
          sj.active = false; save(db);
          return json(res, 200, { hidden: true,
            message: sj.name + " has past bookings, so it's been hidden rather than deleted." });
        }
        db.settings.subjects = db.settings.subjects.filter(x => x.id !== sj.id);
        for (const t of db.tutors) t.subjectIds = (t.subjectIds || []).filter(id => id !== sj.id);
        save(db);
        return json(res, 200, { deleted: true });
      }

      if ((am = p.match(/^\/api\/admin\/tutors\/([^/]+)$/)) && req.method === "DELETE") {
        const t = db.tutors.find(x => x.id === am[1]);
        if (!t) return json(res, 404, { error: "No such tutor." });
        const owed = earningsFor(t.id).owed;
        const body = await readBody(req).catch(() => ({}));
        if (owed > 0 && !body.force)
          return json(res, 409, { error: "You still owe " + money(owed) + ". Settle up first, or confirm again to delete anyway.", owed });
        const upcoming = db.bookings.filter(b => b.tutorId === t.id && b.status === "confirmed" &&
          new Date(b.day + "T23:59:59Z").getTime() > Date.now());
        // keep the booking history readable, but drop everything personal
        for (const b of db.bookings) if (b.tutorId === t.id) b.tutorName = t.name;
        db.tutors = db.tutors.filter(x => x.id !== t.id);
        db.applications = db.applications.filter(a => a.email !== t.email);
        db.waitlist = db.waitlist.filter(w => w.tutorId !== t.id);
        save(db);
        console.log(`[audit] ${new Date().toISOString()} admin deleted the account for ${t.name} (${t.email})`);
        return json(res, 200, { deleted: true, upcoming: upcoming.length });
      }

      if (p === "/api/admin/password" && req.method === "POST") {
        const body = await readBody(req);
        if (String(body.password || "").length < 10)
          return json(res, 400, { error: "Use at least 10 characters." });
        admin.passwordHash = hashPassword(String(body.password));
        admin.usingDefaultPassword = false;
        admin.session = null;
        save(db);
        return json(res, 200, { ok: true });
      }
      return json(res, 404, { error: "No such endpoint." });
    }

    if (p.startsWith("/api/")) return json(res, 404, { error: "No such endpoint." });
    serveStatic(req, res);
  } catch (err) {
    console.error(err);
    json(res, 500, { error: "Something went wrong on our side." });
  }
});

/* ---------------- one-shot email test ----------------
   node server.js --test-email
   Sends a single message to OWNER_EMAIL and says plainly what happened. */
if (process.argv.includes("--test-email")) {
  const provider = BREVO_API_KEY ? "Brevo" : RESEND_API_KEY ? "Resend" : null;
  console.log("\n" + BRAND + " — email test\n");
  if (!provider) {
    console.log("  No email key is set, so there is nothing to test.");
    console.log("  Set BREVO_API_KEY (or RESEND_API_KEY) and run this again.");
    console.log("  Without one, codes print to this window instead of being sent.\n");
    process.exit(0);
  }
  console.log("  Provider: " + provider);
  console.log("  Sending to: " + OWNER_EMAIL);
  if (BREVO_API_KEY) console.log("  Sending from: " + (process.env.BREVO_SENDER || OWNER_EMAIL));
  sendEmail(OWNER_EMAIL, BRAND + " — test email", wrap(
    `<h2 style="font-size:19px;margin:0 0 12px">Email is working</h2>
     <p>If you're reading this, ${esc(BRAND)} can send mail. Verification codes and booking
     confirmations will now reach real inboxes instead of printing to your terminal.</p>
     <p style="font-size:13px;color:#555">Sent ${new Date().toLocaleString("en-GB")}.</p>`))
    .then(() => {
      console.log("\n  Sent. Check " + OWNER_EMAIL + " — including the spam folder.");
      console.log("  If it doesn't arrive within a few minutes, the address you're");
      console.log("  sending FROM probably isn't verified with " + provider + ".\n");
      process.exit(0);
    })
    .catch(err => {
      console.log("\n  FAILED: " + err.message + "\n");
      console.log("  Most common causes:");
      console.log("    - the API key is wrong, or has a space or quote stuck to it");
      console.log("    - the sending address isn't verified with " + provider);
      if (RESEND_API_KEY && !BREVO_API_KEY)
        console.log("    - Resend only delivers to your own address until a domain is verified\n");
      else console.log("");
      process.exit(1);
    });
} else

if (process.argv.includes("--test-db")) {
  console.log("\n" + BRAND + " \u2014 database test\n");
  if (!DATABASE_URL) {
    console.log("  DATABASE_URL isn't set, so records are stored in " + DB_PATH + ".");
    console.log("  That's fine locally. On a host that wipes its disk, set DATABASE_URL.\n");
    process.exit(0);
  }
  initPg()
    .then(async () => {
      const before = JSON.stringify(db).length;
      await writePg();
      console.log("  Connected, table ready, document written (" + before + " bytes).");
      console.log("  Tutors: " + db.tutors.length + "  Bookings: " + db.bookings.length + "\n");
      process.exit(0);
    })
    .catch(err => {
      console.log("  FAILED: " + err.message + "\n");
      console.log("  Check the connection string is the pooled one from Neon, and that");
      console.log("  it ends with ?sslmode=require.\n");
      process.exit(1);
    });
} else

initPg().catch(err => {
  console.error("\n  Could not reach the database: " + err.message);
  console.error("  Falling back to " + DB_PATH + " so the site still runs.\n");
  pg = null;
}).then(() => {

server.listen(PORT, () => {
  console.log(`\nArgand Tutors running at ${PUBLIC_URL}`);
  console.log(`Owner email:  ${OWNER_EMAIL}   (applications and approval codes go here)`);
  if (BREVO_API_KEY) console.log(`Sending from: ${process.env.BREVO_SENDER || OWNER_EMAIL}   (must be verified in Brevo)`);
  else if (RESEND_API_KEY) console.log(`Sending from: ${FROM_EMAIL}`);
  console.log(`Sending mail: ${BREVO_API_KEY ? "yes, via Brevo" : RESEND_API_KEY ? "yes, via Resend" : "no — codes will be printed to this console"}`);
  console.log(`Email checks: ${VERIFY_EMAIL ? "customers must enter a code" : "off — customers book without a code"}`);
  console.log(`Card payments: ${PAYMENTS_ENABLED ? "on, via Stripe" + (STRIPE_SECRET_KEY.startsWith("sk_test") ? " (TEST MODE \u2014 no real money)" : " (LIVE)") : "off \u2014 bookings are taken, you invoice separately"}`);
  console.log(`Data file:    ${DB_PATH}`);
  const admin = ensureAdmin();
  console.log(`Admin login:  ${ADMIN_EMAIL}`);
  if (admin.usingDefaultPassword)
    console.log(`\n  \u26a0  The admin account is still on its default password.\n     Sign in and change it under Admin \u2192 Security before going live.\n`);
  if (!process.env.ENCRYPTION_KEY)
    console.log(`Bank details: encrypted with the key in ${KEY_PATH} \u2014 back this file up, and never commit it`);
  console.log(`Storage:      ${pg ? "Postgres (survives restarts)" : DB_PATH + " (a file \u2014 lost if the host wipes its disk)"}`);
  HOME = findHomePage();
  if (HOME.warning) {
    console.log(`\n  ⚠  ${HOME.warning}\n`);
  } else {
    console.log(`Home page:    ${HOME.file}\n`);
  }
});
});

// Reminders: one a day before, one an hour before. Flags on the booking stop
// anything being sent twice, even if the server restarts.
async function sendReminders() {
  const now = Date.now();
  for (const b of db.bookings) {
    if (b.status !== "confirmed") continue;
    const start = new Date(`${b.day}T${String(b.hour).padStart(2, "0")}:00:00Z`).getTime();
    const hrs = (start - now) / 36e5;
    const t = db.tutors.find(x => x.id === b.tutorId);
    const sj = subjectById(b.subjectId);
    if (!t || !sj) continue;
    const when = `${b.day} at ${String(b.hour).padStart(2, "0")}:00`;

    if (!b.remind24 && hrs <= 24 && hrs > 1) {
      b.remind24 = true; save(db);
      sendEmail(b.email, `Tomorrow: ${sj.name} with ${t.name}`, wrap(
        `<p>A reminder that your session is ${when} (${b.mins} minutes).</p>
         <p style="font-size:13px;color:#555">Need to change it? This is the last point you can cancel free of charge \\u2014
         <a href="${PUBLIC_URL}/#/manage/${b.manageToken}">manage your booking</a>.</p>`)).catch(() => {});
      sendEmail(t.email, `Tomorrow: ${sj.name} with ${b.name}`, wrap(
        `<p>${esc(b.name)}, ${when}, ${b.mins} minutes.</p>`)).catch(() => {});
    }
    if (!b.remind1 && hrs <= 1 && hrs > -0.5) {
      b.remind1 = true; save(db);
      sendEmail(b.email, `Starting soon: ${sj.name}`, wrap(
        `<p>Your session with ${esc(t.name)} starts at ${String(b.hour).padStart(2, "0")}:00.</p>`)).catch(() => {});
    }
  }
}
setInterval(sendReminders, 5 * 60 * 1000).unref();
setTimeout(sendReminders, Number(process.env.REMINDER_START_MS) || 10000).unref();

setInterval(() => {
  const before = db.holds.length;
  db.holds = db.holds.filter(h => h.expires > Date.now());
  if (db.holds.length !== before) save(db);
}, 60000).unref();
