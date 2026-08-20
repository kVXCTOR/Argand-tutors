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
function load() {
  try { return JSON.parse(fs.readFileSync(DB_PATH, "utf8")); }
  catch { return { applications: [], tutors: [] }; }
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
  json(res, 200, { token, tutor: { id: t.id, name: t.name, university: t.university, course: t.course } });
}

function publicTutors(res) {
  json(res, 200, db.tutors.filter(t => t.active).map(t => ({
    id: t.id, name: t.name, university: t.university, course: t.course, year: t.year,
    grades: t.grades, subjectIds: t.subjectIds, bio: t.bio, premium: t.premium, photo: t.photo
  })));
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
    if (p === "/api/health") return json(res, 200, { ok: true, tutors: db.tutors.length, pending: db.applications.filter(a => a.status === "pending").length });
    if (p === "/api/applications" && req.method === "POST") return await createApplication(req, res, ip);
    if (p === "/api/tutors" && req.method === "GET") return publicTutors(res);
    if (p === "/api/login" && req.method === "POST") return await login(req, res, ip);

    let m = p.match(/^\/api\/applications\/([^/]+)\/verify$/);
    if (m && req.method === "POST") return await verifyApplication(req, res, m[1], ip);

    m = p.match(/^\/api\/applications\/([^/]+)\/approve$/);
    if (m && req.method === "GET") return ownerApprove(res, m[1], url.searchParams.get("token"));

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
  console.log(`Data file:    ${DB_PATH}`);
  HOME = findHomePage();
  if (HOME.warning) {
    console.log(`\n  ⚠  ${HOME.warning}\n`);
  } else {
    console.log(`Home page:    ${HOME.file}\n`);
  }
});
