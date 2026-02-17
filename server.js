require("dotenv").config();
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const Database = require("better-sqlite3");
const nodemailer = require("nodemailer");
const session = require("express-session");
const bcrypt = require("bcryptjs");

const app = express();
app.use(express.json({ limit: "50kb" }));

// --- Session setup ---
app.use(
  session({
    name: "vpsmon.sid",
    secret: process.env.SESSION_SECRET || "dev_secret_change_me",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: false, // set true when behind HTTPS in production
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    },
  })
);

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const DB_PATH = process.env.DB_PATH || "./data/metrics.db";
const db = new Database(DB_PATH);

// --- DB setup ---
db.exec(`
CREATE TABLE IF NOT EXISTS metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  cpu REAL NOT NULL,
  ram REAL NOT NULL,
  disk REAL NOT NULL,
  net_rx_bps REAL NOT NULL,
  net_tx_bps REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_metrics_server_ts ON metrics(server_id, ts);

CREATE TABLE IF NOT EXISTS alert_state (
  server_id TEXT PRIMARY KEY,
  cpu_alert_active INTEGER DEFAULT 0,
  cpu_last_email_ts INTEGER DEFAULT 0
);


CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);


`);

// --- Ensure admin user exists ---
function ensureAdminUser() {
  const adminUser = process.env.ADMIN_USER || "admin";
  const adminPass = process.env.ADMIN_PASS || "admin123";

  const hash = bcrypt.hashSync(adminPass, 12);

  const existing = db
    .prepare("SELECT id FROM users WHERE username = ?")
    .get(adminUser);

  if (!existing) {
    db.prepare(
      "INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)"
    ).run(adminUser, hash, Math.floor(Date.now() / 1000));

    console.log(`✅ Created admin user: ${adminUser} ${adminPass}`);
  } else {
    db.prepare("UPDATE users SET password_hash = ? WHERE username = ?")
      .run(hash, adminUser);

    console.log(`✅ Updated admin password from .env for: ${adminUser}`);
  }
}

ensureAdminUser();



// --- Email setup ---
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: false,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
});

async function sendAlertEmail(subject, text) {
  await transporter.sendMail({
    from: process.env.MAIL_FROM,
    to: process.env.MAIL_TO,
    subject,
    text,
  });
}

// --- Auth middleware for ingest ---
function verifyIngest(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token || token !== process.env.INGEST_SHARED_SECRET) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  next();
}

function requireLogin(req, res, next) {
  if (req.session && req.session.userId) return next();
  // If API request, send JSON. If browser, redirect.
  if (req.path.startsWith("/api/")) {
    return res.status(401).json({ ok: false, error: "Not logged in" });
  }
  return res.redirect(`/login.html?next=${encodeURIComponent(req.originalUrl)}`);
}


// --- Ingest endpoint ---
const insertMetric = db.prepare(`
INSERT INTO metrics (server_id, ts, cpu, ram, disk, net_rx_bps, net_tx_bps)
VALUES (@server_id, @ts, @cpu, @ram, @disk, @net_rx_bps, @net_tx_bps)
`);

// --- Auth endpoints ---
app.post("/api/auth/login", (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ ok: false, error: "Missing fields" });
  }

  const user = db
    .prepare("SELECT id, username, password_hash FROM users WHERE username = ?")
    .get(username);

  if (!user) return res.status(401).json({ ok: false, error: "Invalid login" });

  const ok = bcrypt.compareSync(password, user.password_hash);
  if (!ok) return res.status(401).json({ ok: false, error: "Invalid login" });

  req.session.userId = user.id;
  req.session.username = user.username;
  res.json({ ok: true, username: user.username });
});

app.post("/api/auth/logout", (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("vpsmon.sid");
    res.json({ ok: true });
  });
});

app.get("/api/auth/me", (req, res) => {
  if (req.session?.userId) {
    return res.json({ ok: true, user: { username: req.session.username } });
  }
  res.status(401).json({ ok: false });
});


app.post("/api/ingest", verifyIngest, (req, res) => {
  const m = req.body;

  if (
    !m.server_id ||
    typeof m.ts !== "number" ||
    typeof m.cpu !== "number" ||
    typeof m.ram !== "number" ||
    typeof m.disk !== "number" ||
    typeof m.net_rx_bps !== "number" ||
    typeof m.net_tx_bps !== "number"
  ) {
    return res.status(400).json({ ok: false, error: "Invalid payload" });
  }

  insertMetric.run(m);

  // Push realtime to UI
  io.emit("metric", m);

  res.json({ ok: true });
});




// Latest per server
app.get("/api/latest", requireLogin, (req, res) => {
  const rows = db
    .prepare(
      `
      SELECT m.*
      FROM metrics m
      INNER JOIN (
        SELECT server_id, MAX(ts) AS max_ts
        FROM metrics
        GROUP BY server_id
      ) x ON x.server_id = m.server_id AND x.max_ts = m.ts
      ORDER BY m.server_id;
    `
    )
    .all();

  res.json({ ok: true, data: rows });
});

// Redirect root to dashboard (with auth)
app.get("/", requireLogin, (req, res) => {
  res.redirect("/index.html"); // or res.sendFile(...) if you prefer
});

// Protect all .html routes except login.html
app.get(/^\/(?!login\.html).*\.html$/, requireLogin);

// Serve simple UI
app.use(express.static("public"));

// --- Alert worker: CPU >= 100 for 5 minutes ---
const CPU_THRESHOLD = 100;
const WINDOW_SECONDS = 300; // 5 mins
const CHECK_EVERY_MS = 60 * 1000; // 1 min
const EMAIL_COOLDOWN_SECONDS = 45 * 60; // 45 mins cooldown to avoid spamming

function ensureAlertState(serverId) {
  db.prepare(
    `INSERT OR IGNORE INTO alert_state (server_id, cpu_alert_active, cpu_last_email_ts)
     VALUES (?, 0, 0)`
  ).run(serverId);
}

function getServers() {
  const rows = db.prepare(`SELECT DISTINCT server_id FROM metrics`).all();
  return rows.map((r) => r.server_id);
}

function avgCpuInWindow(serverId, sinceTs) {
  const row = db
    .prepare(
      `SELECT AVG(cpu) as avg_cpu FROM metrics
       WHERE server_id = ? AND ts >= ?`
    )
    .get(serverId, sinceTs);
  return row?.avg_cpu ?? null;
}

function getAlertState(serverId) {
  return db
    .prepare(
      `SELECT cpu_alert_active, cpu_last_email_ts FROM alert_state WHERE server_id = ?`
    )
    .get(serverId);
}

function updateAlertState(serverId, active, lastEmailTs) {
  db.prepare(
    `UPDATE alert_state SET cpu_alert_active = ?, cpu_last_email_ts = ? WHERE server_id = ?`
  ).run(active ? 1 : 0, lastEmailTs, serverId);
}

async function alertLoop() {
  const now = Math.floor(Date.now() / 1000);
  const since = now - WINDOW_SECONDS;

  const servers = getServers();
  for (const serverId of servers) {
    ensureAlertState(serverId);

    const avgCpu = avgCpuInWindow(serverId, since);
    if (avgCpu === null) continue;

    const state = getAlertState(serverId);
    const active = state.cpu_alert_active === 1;
    const lastEmail = state.cpu_last_email_ts || 0;

    const shouldTrigger = avgCpu >= CPU_THRESHOLD;
    const cooldownOk = now - lastEmail >= EMAIL_COOLDOWN_SECONDS;

    if (shouldTrigger && (!active || cooldownOk)) {
      // fire alert
      const subject = `ALERT: ${serverId} CPU high (${avgCpu.toFixed(1)}% avg / 5m)`;
      const text = `Server: ${serverId}\nAvg CPU (last 5m): ${avgCpu.toFixed(
        1
      )}%\nTime: ${new Date().toISOString()}`;

      try {
        await sendAlertEmail(subject, text);
        updateAlertState(serverId, true, now);
        console.log("Sent alert email:", subject);
      } catch (e) {
        console.error("Email send failed:", e.message);
      }
    }

    // resolve (optional): mark inactive when CPU drops
    if (!shouldTrigger && active) {
      updateAlertState(serverId, false, lastEmail);
      console.log(`Resolved CPU alert for ${serverId}`);
    }
  }
}

setInterval(() => {
  alertLoop().catch((e) => console.error("alertLoop error:", e));
}, CHECK_EVERY_MS);

io.on("connection", (socket) => {
  console.log("UI connected:", socket.id);
});

// Start
const PORT = Number(process.env.PORT || 5050);
server.listen(PORT, () => console.log(`Dashboard running on http://localhost:${PORT}`));
