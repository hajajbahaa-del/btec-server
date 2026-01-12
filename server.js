// server.js
// BTEC Server (Node + Express + SQLite + Uploads)
// تشغيل: npm install ثم npm start

const path = require("path");
const fs = require("fs");
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const Database = require("better-sqlite3");

const app = express();

// ====== إعدادات ======
const PORT = process.env.PORT || 3000;

// غيّرهم لأي شي بدك (يفضل تحطهم كـ Environment Variables على Render/Railway)
const ADMIN_USER = process.env.ADMIN_USER || "bahaa_hajaj";
const ADMIN_PASS = process.env.ADMIN_PASS || "bahaahajaj0775135361n";

// توكن بسيط (جلسة) بالذاكرة
const SESSIONS = new Map(); // token -> {username, createdAt}

// ====== Middleware ======
app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// ====== static front-end ======
app.use(express.static(path.join(__dirname, "public")));

// ====== uploads folder ======
const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
app.use("/uploads", express.static(uploadsDir));

// ====== multer upload ======
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const safe = (file.originalname || "file").replace(/[^\w.\-()+\s]/g, "_");
    cb(null, Date.now() + "_" + safe);
  }
});
const upload = multer({ storage });

// ====== Database (SQLite) ======
const dbPath = path.join(__dirname, "btec.db");
const db = new Database(dbPath);

// إنشاء الجداول
db.exec(`
CREATE TABLE IF NOT EXISTS generations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  descr TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  genId TEXT NOT NULL,
  title TEXT NOT NULL,
  descr TEXT DEFAULT '',
  createdAt INTEGER NOT NULL,
  FOREIGN KEY(genId) REFERENCES generations(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS python_lessons (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  createdAt INTEGER NOT NULL,
  slidesJson TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS task_docs (
  id TEXT PRIMARY KEY,
  taskId TEXT NOT NULL,
  displayName TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime TEXT DEFAULT 'application/octet-stream',
  size INTEGER DEFAULT 0,
  url TEXT NOT NULL,
  createdAt INTEGER NOT NULL,
  FOREIGN KEY(taskId) REFERENCES tasks(id) ON DELETE CASCADE
);
`);

// Seed بسيط للأجيال إذا فاضي
const genCount = db.prepare("SELECT COUNT(*) as c FROM generations").get().c;
if (genCount === 0) {
  const ins = db.prepare("INSERT INTO generations (id,name,descr) VALUES (?,?,?)");
  ins.run("g_2008", "جيل 2008", "");
  ins.run("g_2009", "جيل 2009", "");
  ins.run("g_2010", "جيل 2010", "");
}

// ====== Helpers ======
function uid(prefix = "id") {
  return prefix + "_" + Math.random().toString(16).slice(2) + Date.now().toString(16);
}

function requireAdmin(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const s = token ? SESSIONS.get(token) : null;
  if (!s) return res.status(401).json({ ok: false, msg: "غير مصرح (سجّل دخول أدمن)" });
  next();
}

// ====== Auth ======
app.post("/api/admin/login", (req, res) => {
  const { username, password } = req.body || {};
  if ((username || "").trim() === ADMIN_USER && (password || "").trim() === ADMIN_PASS) {
    const token = uid("tok");
    SESSIONS.set(token, { username: ADMIN_USER, createdAt: Date.now() });
    return res.json({ ok: true, token, username: ADMIN_USER });
  }
  return res.status(401).json({ ok: false, msg: "بيانات الأدمن غير صحيحة" });
});

app.post("/api/admin/logout", requireAdmin, (req, res) => {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (token) SESSIONS.delete(token);
  res.json({ ok: true });
});

// ====== Public read ======
app.get("/api/public/state", (req, res) => {
  const generations = db.prepare("SELECT * FROM generations").all();
  const tasks = db.prepare("SELECT * FROM tasks ORDER BY createdAt DESC").all();
  const taskDocs = db.prepare("SELECT * FROM task_docs ORDER BY createdAt DESC").all();
  const pythonLessons = db.prepare("SELECT id,title,createdAt,slidesJson FROM python_lessons ORDER BY createdAt DESC").all()
    .map(r => ({ id: r.id, title: r.title, createdAt: r.createdAt, slides: JSON.parse(r.slidesJson || "[]") }));

  res.json({ ok: true, data: { generations, tasks, taskDocs, pythonLessons } });
});

// ====== Admin CRUD: generations ======
app.post("/api/admin/generations", requireAdmin, (req, res) => {
  const name = (req.body?.name || "").trim();
  const descr = (req.body?.descr || "").trim();
  if (!name) return res.status(400).json({ ok: false, msg: "اسم الجيل مطلوب" });

  const exists = db.prepare("SELECT 1 FROM generations WHERE lower(name)=lower(?)").get(name);
  if (exists) return res.status(400).json({ ok: false, msg: "اسم الجيل موجود مسبقًا" });

  const id = uid("g");
  db.prepare("INSERT INTO generations (id,name,descr) VALUES (?,?,?)").run(id, name, descr);
  res.json({ ok: true, id });
});

app.delete("/api/admin/generations/:id", requireAdmin, (req, res) => {
  const id = req.params.id;
  // حذف المهام والملفات التابعة
  const tasks = db.prepare("SELECT id FROM tasks WHERE genId=?").all(id).map(x => x.id);
  const delDoc = db.prepare("DELETE FROM task_docs WHERE taskId=?");
  for (const tid of tasks) delDoc.run(tid);
  db.prepare("DELETE FROM tasks WHERE genId=?").run(id);
  db.prepare("DELETE FROM generations WHERE id=?").run(id);
  res.json({ ok: true });
});

// ====== Admin CRUD: tasks ======
app.post("/api/admin/tasks", requireAdmin, (req, res) => {
  const genId = (req.body?.genId || "").trim();
  const title = (req.body?.title || "").trim();
  const descr = (req.body?.descr || "").trim();
  if (!genId) return res.status(400).json({ ok: false, msg: "genId مطلوب" });
  if (!title) return res.status(400).json({ ok: false, msg: "عنوان المهمة مطلوب" });

  const id = uid("t");
  db.prepare("INSERT INTO tasks (id,genId,title,descr,createdAt) VALUES (?,?,?,?,?)")
    .run(id, genId, title, descr, Date.now());
  res.json({ ok: true, id });
});

app.delete("/api/admin/tasks/:id", requireAdmin, (req, res) => {
  const id = req.params.id;
  // حذف الملفات التابعة
  db.prepare("DELETE FROM task_docs WHERE taskId=?").run(id);
  db.prepare("DELETE FROM tasks WHERE id=?").run(id);
  res.json({ ok: true });
});

// ====== Admin CRUD: docs (upload) ======
app.post("/api/admin/taskdocs/upload", requireAdmin, upload.single("file"), (req, res) => {
  const taskId = (req.body?.taskId || "").trim();
  const displayName = (req.body?.displayName || "").trim();
  if (!taskId) return res.status(400).json({ ok: false, msg: "taskId مطلوب" });
  if (!displayName) return res.status(400).json({ ok: false, msg: "اسم المستند مطلوب" });
  if (!req.file) return res.status(400).json({ ok: false, msg: "اختر ملف" });

  const id = uid("doc");
  const url = "/uploads/" + req.file.filename;

  db.prepare("INSERT INTO task_docs (id,taskId,displayName,filename,mime,size,url,createdAt) VALUES (?,?,?,?,?,?,?,?)")
    .run(
      id,
      taskId,
      displayName,
      req.file.originalname || req.file.filename,
      req.file.mimetype || "application/octet-stream",
      req.file.size || 0,
      url,
      Date.now()
    );

  res.json({ ok: true, id, url });
});

app.delete("/api/admin/taskdocs/:id", requireAdmin, (req, res) => {
  const id = req.params.id;
  const row = db.prepare("SELECT url FROM task_docs WHERE id=?").get(id);
  if (row?.url) {
    const localPath = path.join(__dirname, row.url.replace("/uploads/", "uploads/"));
    if (fs.existsSync(localPath)) {
      try { fs.unlinkSync(localPath); } catch {}
    }
  }
  db.prepare("DELETE FROM task_docs WHERE id=?").run(id);
  res.json({ ok: true });
});

// ====== Admin CRUD: python lessons ======
app.post("/api/admin/pythonlessons", requireAdmin, (req, res) => {
  const title = (req.body?.title || "").trim();
  const slides = req.body?.slides;

  if (!title) return res.status(400).json({ ok: false, msg: "عنوان الدرس مطلوب" });
  if (!Array.isArray(slides) || slides.length === 0) {
    return res.status(400).json({ ok: false, msg: "لازم تضيف على الأقل شريحة واحدة" });
  }

  const cleanSlides = slides.map(s => ({
    title: (s?.title || "").trim() || "شريحة",
    bullets: Array.isArray(s?.bullets) ? s.bullets.map(x => String(x).trim()).filter(Boolean) : [],
    code: (s?.code || "").trim()
  }));

  const id = uid("py");
  db.prepare("INSERT INTO python_lessons (id,title,createdAt,slidesJson) VALUES (?,?,?,?)")
    .run(id, title, Date.now(), JSON.stringify(cleanSlides));

  res.json({ ok: true, id });
});

app.delete("/api/admin/pythonlessons/:id", requireAdmin, (req, res) => {
  const id = req.params.id;
  db.prepare("DELETE FROM python_lessons WHERE id=?").run(id);
  res.json({ ok: true });
});

// ====== SPA fallback ======
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log("BTEC server running on port", PORT);
});
