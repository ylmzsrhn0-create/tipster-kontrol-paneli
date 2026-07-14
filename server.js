const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const zlib = require("zlib");
const net = require("net");
const tls = require("tls");

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, "public");
const DATA = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, "data");
const DB_FILE = path.join(DATA, "database.json");
const BACKUP_DIR = path.join(DATA, "backups");
const PORT = Number(process.env.PORT || 3000);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "1234";
const TRUST_PROXY = process.env.TRUST_PROXY === "1";
const SESSION_TTL_MS = 1000 * 60 * 60 * 8;
const OTP_TTL_MS = 1000 * 60 * 5;
const LOGIN_LOCK_MS = 1000 * 60 * 10;
const LOGIN_MAX_ATTEMPTS = 5;
const OTP_ENABLED = process.env.EMAIL_OTP_ENABLED === "1";
const FALLBACK_OTP_EMAIL = String(process.env.ADMIN_OTP_EMAIL || "").trim();
const SMTP_HOST = String(process.env.SMTP_HOST || "").trim();
const SMTP_PORT = Number(process.env.SMTP_PORT || 465);
const SMTP_USER = String(process.env.SMTP_USER || "").trim();
const SMTP_PASS = String(process.env.SMTP_PASS || "");
const SMTP_FROM = String(process.env.SMTP_FROM || SMTP_USER || "").trim();

fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(BACKUP_DIR, { recursive: true });

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.pbkdf2Sync(password, salt, 210000, 32, "sha256").toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored || "").split(":");
  if (!salt || !hash) return false;
  const check = hashPassword(password, salt).split(":")[1];
  return safeEqual(check, hash);
}

function defaultDb() {
  return {
    users: [
      {
        id: crypto.randomUUID(),
        role: "owner",
        username: "admin",
        name: "Ana Admin",
        email: "",
        gsmMasked: "",
        percentage: 0,
        passwordHash: hashPassword(ADMIN_PASSWORD),
        createdAt: new Date().toISOString()
      }
    ],
    rows: [],
    uploads: [],
    messages: [],
    feedbacks: [],
    auditLogs: [],
    uploadReports: [],
    payments: [],
    portalLists: []
  };
}

function readDb() {
  if (!fs.existsSync(DB_FILE)) {
    const db = defaultDb();
    writeDb(db);
    return db;
  }
  const raw = JSON.parse(fs.readFileSync(DB_FILE, "utf8").replace(/^\uFEFF/, ""));
  const normalized = normalizeDb(raw);
  if (JSON.stringify(raw) !== JSON.stringify(normalized)) {
    writeDb(normalized);
  }
  return normalized;
}

function writeDb(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
  createDailyBackup(db);
}

function backupSafeName(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "yedek";
}

function createBackupFile(db, reason = "manual", actor = "system") {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `${stamp}-${backupSafeName(reason)}-${backupSafeName(actor)}.json.gz`;
  const filePath = path.join(BACKUP_DIR, filename);
  const payload = {
    createdAt: new Date().toISOString(),
    reason,
    actor,
    database: db
  };
  fs.writeFileSync(filePath, zlib.gzipSync(Buffer.from(JSON.stringify(payload, null, 2), "utf8")));
  cleanupBackups();
  return backupInfo(filename);
}

function createDailyBackup(db) {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const hasToday = listBackups().some(item => item.filename.startsWith(today) && item.filename.includes("-otomatik-"));
    if (!hasToday) createBackupFile(db, "otomatik", "sistem");
  } catch {
    // Yedekleme ana islemi bozmamali.
  }
}

function backupInfo(filename) {
  const filePath = path.join(BACKUP_DIR, filename);
  const stat = fs.statSync(filePath);
  return {
    filename,
    size: stat.size,
    createdAt: stat.mtime.toISOString()
  };
}

function listBackups() {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs.readdirSync(BACKUP_DIR)
    .filter(filename => filename.endsWith(".json.gz"))
    .map(filename => backupInfo(filename))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

function cleanupBackups() {
  const backups = listBackups();
  backups.slice(30).forEach(item => {
    const filePath = path.join(BACKUP_DIR, item.filename);
    if (filePath.startsWith(BACKUP_DIR)) fs.rmSync(filePath, { force: true });
  });
}

function normalizeDb(db) {
  db.users ||= [];
  db.rows ||= [];
  db.uploads ||= [];
  db.messages ||= [];
  db.feedbacks ||= [];
  db.auditLogs ||= [];
  db.uploadReports ||= [];
  db.payments ||= [];
  db.portalLists ||= [];
  let owner = db.users.find(user => user.role === "owner");
  if (!owner) {
    owner = db.users.find(user => user.role === "admin" && user.username === "admin") || db.users.find(user => user.role === "admin");
    if (owner) {
      owner.role = "owner";
      owner.name ||= "Ana Admin";
    }
  }
  const ownerId = owner?.id || db.users.find(user => user.role === "admin")?.id || "";
  const firstUpload = db.uploads[0];
  if (firstUpload) {
    db.rows.forEach(row => {
      if (!row.uploadId) row.uploadId = firstUpload.id;
    });
  }
  db.uploads.forEach(upload => {
    if (!upload.ownerId) upload.ownerId = ownerId;
    upload.uploadType = upload.uploadType === "daily" ? "daily" : "weekly";
    upload.uploadDate ||= dateOnly(upload.createdAt);
  });
  db.rows.forEach(row => {
    if (!row.ownerId) {
      const upload = db.uploads.find(item => item.id === row.uploadId);
      row.ownerId = upload?.ownerId || ownerId;
    }
  });
  const rowUploadIds = new Set(db.rows.map(row => row.uploadId).filter(Boolean));
  db.uploads = db.uploads.filter(upload => rowUploadIds.has(upload.id));
  db.users.forEach(user => {
    if (isStaff(user)) user.email = normalizeEmail(user.email);
    if (user.role === "member" && !user.ownerId) user.ownerId = ownerId;
    if (user.role === "admin" && !user.createdBy) user.createdBy = ownerId;
    const records = backfillNumberRecordDates(db, user);
    user.numberRecords = records;
    user.gsmMasked = records[0]?.number || user.gsmMasked || "";
    user.gsmList = records.slice(user.gsmMasked ? 1 : 0).map(record => record.name || record.createdAt ? { number: record.number, name: record.name, createdAt: record.createdAt } : record.number);
  });
  db.messages.forEach(message => {
    message.recipientIds ||= [];
    message.readBy ||= {};
  });
  db.feedbacks.forEach(feedback => {
    feedback.type ||= "suggestion";
    feedback.status ||= "new";
  });
  db.auditLogs.forEach(log => {
    log.details ||= "";
    log.actorRole ||= "";
  });
  db.uploadReports.forEach(report => {
    report.totalAmount ||= 0;
    report.totalCommission ||= 0;
    report.activeNumberCount ||= 0;
    report.passiveCount ||= 0;
    report.unmatchedCount ||= 0;
  });
  db.payments.forEach(payment => {
    payment.ownerId ||= ownerId;
    payment.memberId ||= "";
    payment.uploadId ||= "";
    payment.weekLabel ||= "";
    payment.calculatedAmount = Number(payment.calculatedAmount) || 0;
    payment.paidAmount = Number(payment.paidAmount) || 0;
    payment.paymentDate = validDateOnly(payment.paymentDate) ? payment.paymentDate : dateOnly(payment.createdAt);
    payment.note ||= "";
  });
  db.portalLists.forEach(list => {
    list.ownerId ||= ownerId;
    list.weekLabel ||= list.filename || "Bayi Portal listesi";
    list.numbers = Array.from(new Set((list.numbers || []).map(canonicalGsm).filter(Boolean)));
    list.rowCount = Number(list.rowCount) || list.numbers.length;
    list.createdAt ||= new Date().toISOString();
  });
  return db;
}

const sessions = new Map();
const pendingOtps = new Map();
const loginAttempts = new Map();

function clientIp(req) {
  const forwarded = TRUST_PROXY ? String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() : "";
  return forwarded || req.socket.remoteAddress || "unknown";
}

function loginAttemptKey(req, username, loginType) {
  return `${clientIp(req)}:${String(loginType || "")}:${String(username || "").trim().toLowerCase()}`;
}

function loginLockInfo(key) {
  const item = loginAttempts.get(key);
  if (!item) return null;
  if (item.lockedUntil && item.lockedUntil > Date.now()) return item;
  if (item.lockedUntil && item.lockedUntil <= Date.now()) loginAttempts.delete(key);
  return null;
}

function recordLoginFailure(key) {
  const item = loginAttempts.get(key) || { count: 0, lockedUntil: 0 };
  item.count += 1;
  if (item.count >= LOGIN_MAX_ATTEMPTS) {
    item.lockedUntil = Date.now() + LOGIN_LOCK_MS;
  }
  loginAttempts.set(key, item);
  return item;
}

function clearLoginFailure(key) {
  loginAttempts.delete(key);
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || "";
  for (const part of raw.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    out[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1));
  }
  return out;
}

function currentSession(req) {
  const sid = parseCookies(req).sid;
  if (!sid) return null;
  const session = sessions.get(sid);
  if (!session || session.expiresAt < Date.now()) {
    sessions.delete(sid);
    return null;
  }
  session.expiresAt = Date.now() + SESSION_TTL_MS;
  return session;
}

function setSession(res, user) {
  const sid = crypto.randomBytes(32).toString("hex");
  const csrf = crypto.randomBytes(24).toString("hex");
  sessions.set(sid, {
    userId: user.id,
    role: user.role,
    csrf,
    expiresAt: Date.now() + SESSION_TTL_MS
  });
  const secure = TRUST_PROXY ? "; Secure" : "";
  res.setHeader("Set-Cookie", `sid=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${secure}`);
  return csrf;
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function validEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || ""));
}

function normalizePhone(value) {
  return String(value || "").trim().replace(/[^\d+]/g, "");
}

function validPhone(value) {
  const digits = normalizePhone(value).replace(/\D/g, "");
  return digits.length >= 10 && digits.length <= 15;
}

function dateOnly(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return new Date().toISOString().slice(0, 10);
  return date.toISOString().slice(0, 10);
}

function addYearsDateOnly(value, years) {
  const date = new Date(`${dateOnly(value)}T00:00:00Z`);
  date.setUTCFullYear(date.getUTCFullYear() + years);
  return date.toISOString().slice(0, 10);
}

function validDateOnly(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) return false;
  return !Number.isNaN(new Date(`${value}T00:00:00Z`).getTime());
}

function excelDateHeader(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? `${match[3]}.${match[2]}.${match[1]}` : "";
}

function uploadDateFromFilename(filename, fallback = "") {
  const text = String(filename || "");
  const match = text.match(/(\d{1,2})[.,_-](\d{1,2})(?:[.,_-](\d{2,4}))?/);
  if (!match) return validDateOnly(fallback) ? fallback : "";
  const day = match[1].padStart(2, "0");
  const month = match[2].padStart(2, "0");
  let year = match[3] || (validDateOnly(fallback) ? fallback.slice(0, 4) : String(new Date().getFullYear()));
  if (year.length === 2) year = `20${year}`;
  const date = `${year}-${month}-${day}`;
  return validDateOnly(date) ? date : (validDateOnly(fallback) ? fallback : "");
}

function excelCellMatchesDate(value, uploadDate) {
  const wanted = excelDateHeader(uploadDate);
  if (!wanted) return true;
  const text = String(value || "").trim();
  if (text === wanted) return true;
  const iso = String(uploadDate || "").trim();
  if (text === iso) return true;
  const match = text.match(/^(\d{2})[./-](\d{2})[./-](\d{4})$/);
  return Boolean(match && `${match[1]}.${match[2]}.${match[3]}` === wanted);
}

function defaultAccessStartsAt(user) {
  return user.accessStartsAt || dateOnly(user.createdAt);
}

function defaultAccessEndsAt(user) {
  return user.accessEndsAt || addYearsDateOnly(defaultAccessStartsAt(user), 1);
}

function otpRecipientFor(user) {
  return normalizeEmail(user?.email) || FALLBACK_OTP_EMAIL;
}

function emailOtpConfigured() {
  return OTP_ENABLED && SMTP_HOST && SMTP_PORT && SMTP_USER && SMTP_PASS && SMTP_FROM;
}

function maskEmail(email) {
  const [name, domain] = String(email || "").split("@");
  if (!name || !domain) return "kayitli e-posta";
  const visible = name.length <= 2 ? name[0] : `${name.slice(0, 2)}***`;
  return `${visible}@${domain}`;
}

function createOtpLogin(user) {
  const loginToken = crypto.randomBytes(32).toString("hex");
  const code = String(crypto.randomInt(100000, 1000000));
  pendingOtps.set(loginToken, {
    userId: user.id,
    codeHash: hashPassword(code),
    expiresAt: Date.now() + OTP_TTL_MS,
    attempts: 0
  });
  return { loginToken, code };
}

function cleanupOtps() {
  const now = Date.now();
  for (const [token, otp] of pendingOtps.entries()) {
    if (otp.expiresAt < now) pendingOtps.delete(token);
  }
}

function smtpRead(socket) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const onData = chunk => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split(/\r?\n/).filter(Boolean);
      const last = lines[lines.length - 1] || "";
      if (/^\d{3} /.test(last)) {
        socket.off("data", onData);
        socket.off("error", onError);
        resolve(buffer);
      }
    };
    const onError = error => {
      socket.off("data", onData);
      reject(error);
    };
    socket.on("data", onData);
    socket.on("error", onError);
  });
}

async function smtpCommand(socket, command, expected = /^[23]/) {
  socket.write(`${command}\r\n`);
  const response = await smtpRead(socket);
  if (!expected.test(response)) throw new Error(response.trim());
  return response;
}

function smtpConnect() {
  return new Promise((resolve, reject) => {
    const options = { host: SMTP_HOST, port: SMTP_PORT, servername: SMTP_HOST };
    const socket = SMTP_PORT === 465 ? tls.connect(options) : net.connect(options);
    socket.setTimeout(15000);
    socket.once("error", reject);
    socket.once("timeout", () => reject(new Error("SMTP zaman asimi.")));
    if (SMTP_PORT === 465) socket.once("secureConnect", () => resolve(socket));
    else socket.once("connect", () => resolve(socket));
  });
}

function smtpStartTls(socket) {
  return new Promise((resolve, reject) => {
    const secureSocket = tls.connect({ socket, servername: SMTP_HOST });
    secureSocket.once("secureConnect", () => resolve(secureSocket));
    secureSocket.once("error", reject);
  });
}

function emailMessage(to, subject, text) {
  return [
    `From: ${SMTP_FROM}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    text
  ].join("\r\n");
}

async function sendOtpEmail(to, code) {
  let socket = await smtpConnect();
  try {
    await smtpRead(socket);
    await smtpCommand(socket, `EHLO ${SMTP_HOST}`);
    if (SMTP_PORT !== 465) {
      await smtpCommand(socket, "STARTTLS");
      socket = await smtpStartTls(socket);
      await smtpCommand(socket, `EHLO ${SMTP_HOST}`);
    }
    await smtpCommand(socket, "AUTH LOGIN", /^3/);
    await smtpCommand(socket, Buffer.from(SMTP_USER).toString("base64"), /^3/);
    await smtpCommand(socket, Buffer.from(SMTP_PASS).toString("base64"));
    await smtpCommand(socket, `MAIL FROM:<${SMTP_FROM}>`);
    await smtpCommand(socket, `RCPT TO:<${to}>`);
    await smtpCommand(socket, "DATA", /^3/);
    const text = `Tipster Kontrol Paneli admin giris kodunuz: ${code}\n\nBu kod 5 dakika gecerlidir. Bu istegi siz yapmadiysaniz sifrenizi degistirin.`;
    socket.write(`${emailMessage(to, "Tipster Kontrol Paneli giris kodu", text)}\r\n.\r\n`);
    const dataResponse = await smtpRead(socket);
    if (!/^[23]/.test(dataResponse)) throw new Error(dataResponse.trim());
    await smtpCommand(socket, "QUIT").catch(() => {});
  } finally {
    socket.end();
  }
}

function clearSession(req, res) {
  const sid = parseCookies(req).sid;
  if (sid) sessions.delete(sid);
  res.setHeader("Set-Cookie", "sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(body));
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function readBody(req, limit = 20 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", chunk => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("Dosya veya istek çok büyük."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function requireAuth(req, res, role) {
  const session = currentSession(req);
  if (!session) {
    sendJson(res, 401, { error: "Oturum gerekli." });
    return null;
  }
  if (role && session.role !== role) {
    sendJson(res, 403, { error: "Bu işlem için yetki yok." });
    return null;
  }
  if (req.method !== "GET" && req.headers["x-csrf-token"] !== session.csrf) {
    sendJson(res, 403, { error: "Güvenlik doğrulaması başarısız." });
    return null;
  }
  return session;
}

function isStaff(user) {
  return user && (user.role === "owner" || user.role === "admin");
}

function requireStaff(req, res) {
  const session = requireAuth(req, res);
  if (!session) return null;
  if (session.role !== "owner" && session.role !== "admin") {
    sendJson(res, 403, { error: "Bu islem icin admin yetkisi gerekli." });
    return null;
  }
  return session;
}

function publicUser(user) {
  const gsmList = getUserGsms(user);
  const numberRecords = getUserNumberRecords(user);
  return {
    id: user.id,
    role: user.role,
    username: user.username,
    name: user.name,
    email: isStaff(user) ? normalizeEmail(user.email) : "",
    gsmMasked: user.gsmMasked,
    gsmList,
    numberRecords,
    percentage: user.percentage,
    ownerId: user.ownerId,
    createdAt: user.createdAt,
    accessStartsAt: isStaff(user) ? defaultAccessStartsAt(user) : "",
    accessEndsAt: isStaff(user) ? defaultAccessEndsAt(user) : "",
    sharedNumbersEnabled: isStaff(user) ? Boolean(user.sharedNumbersEnabled) : false
  };
}

function publicAdmin(user) {
  return {
    id: user.id,
    username: user.username,
    name: user.name,
    email: normalizeEmail(user.email),
    phone: user.phone || "",
    role: user.role,
    sharedNumbersEnabled: Boolean(user.sharedNumbersEnabled),
    createdAt: user.createdAt,
    accessStartsAt: defaultAccessStartsAt(user),
    accessEndsAt: defaultAccessEndsAt(user)
  };
}

function publicMessageForAdmin(db, message) {
  const recipients = message.recipientIds
    .map(id => db.users.find(user => user.id === id && user.role === "member"))
    .filter(Boolean)
    .map(user => ({
      id: user.id,
      name: user.name,
      username: user.username,
      readAt: message.readBy?.[user.id] || ""
    }));
  return {
    id: message.id,
    title: message.title,
    body: message.body,
    targetType: message.targetType,
    createdAt: message.createdAt,
    recipientCount: recipients.length,
    readCount: recipients.filter(item => item.readAt).length,
    unreadCount: recipients.filter(item => !item.readAt).length,
    recipients
  };
}

function publicMessageForMember(message, memberId) {
  const readAt = message.readBy?.[memberId] || "";
  return {
    id: message.id,
    title: message.title,
    body: message.body,
    senderName: message.senderName || "Admin",
    createdAt: message.createdAt,
    readAt,
    unread: !readAt
  };
}

function publicFeedback(feedback) {
  return {
    id: feedback.id,
    type: feedback.type,
    title: feedback.title,
    body: feedback.body,
    senderName: feedback.senderName,
    senderUsername: feedback.senderUsername,
    senderRole: feedback.senderRole,
    createdAt: feedback.createdAt
  };
}

function publicAuditLog(log) {
  return {
    id: log.id,
    action: log.action,
    details: log.details,
    actorName: log.actorName,
    actorUsername: log.actorUsername,
    actorRole: log.actorRole,
    memberId: log.memberId || "",
    memberName: log.memberName || "",
    memberUsername: log.memberUsername || "",
    createdAt: log.createdAt
  };
}

function publicUploadReport(report) {
  return {
    id: report.id,
    uploadId: report.uploadId,
    filename: report.filename,
    weekLabel: report.weekLabel,
    uploadType: report.uploadType || "weekly",
    uploadDate: report.uploadDate || "",
    rowCount: report.rowCount,
    totalAmount: report.totalAmount,
    totalCommission: report.totalCommission,
    activeNumberCount: report.activeNumberCount,
    passiveCount: report.passiveCount,
    unmatchedCount: report.unmatchedCount,
    createdAt: report.createdAt
  };
}

function publicPayment(db, payment) {
  const member = db.users.find(user => user.id === payment.memberId);
  const upload = db.uploads.find(item => item.id === payment.uploadId);
  return {
    id: payment.id,
    ownerId: payment.ownerId,
    memberId: payment.memberId,
    memberName: member?.name || payment.memberName || "",
    memberUsername: member?.username || payment.memberUsername || "",
    uploadId: payment.uploadId,
    weekLabel: payment.weekLabel || upload?.weekLabel || upload?.filename || "Hafta",
    calculatedAmount: Number(payment.calculatedAmount) || 0,
    paidAmount: Number(payment.paidAmount) || 0,
    paymentDate: payment.paymentDate || "",
    note: payment.note || "",
    createdAt: payment.createdAt
  };
}

function publicPortalList(list) {
  return {
    id: list.id,
    filename: list.filename,
    weekLabel: list.weekLabel,
    rowCount: Number(list.rowCount) || (list.numbers || []).length,
    createdAt: list.createdAt
  };
}

function paymentSummary(payments) {
  return {
    count: payments.length,
    totalPaid: payments.reduce((sum, payment) => sum + Number(payment.paidAmount || 0), 0),
    totalCalculated: payments.reduce((sum, payment) => sum + Number(payment.calculatedAmount || 0), 0)
  };
}

function addAuditLog(db, ownerId, actor, action, details = "", meta = {}) {
  db.auditLogs ||= [];
  db.auditLogs.push({
    id: crypto.randomUUID(),
    ownerId,
    actorId: actor?.id || "",
    actorName: actor?.name || actor?.username || "Sistem",
    actorUsername: actor?.username || "",
    actorRole: actor?.role || "",
    action,
    details: String(details || "").slice(0, 500),
    memberId: meta.memberId || (actor?.role === "member" ? actor.id : ""),
    memberName: meta.memberName || (actor?.role === "member" ? actor.name || actor.username || "" : ""),
    memberUsername: meta.memberUsername || (actor?.role === "member" ? actor.username || "" : ""),
    createdAt: new Date().toISOString()
  });
  db.auditLogs = db.auditLogs.slice(-500);
}

function numberFrom(value) {
  if (typeof value === "number") return value;
  const clean = String(value ?? "").replace(/\./g, "").replace(",", ".").replace(/[^\d.-]/g, "");
  const n = Number(clean);
  return Number.isFinite(n) ? n : 0;
}

function normalizeSearchText(value) {
  return String(value || "")
    .trim()
    .toLocaleLowerCase("tr")
    .replaceAll("ı", "i")
    .replaceAll("ğ", "g")
    .replaceAll("ü", "u")
    .replaceAll("ş", "s")
    .replaceAll("ö", "o")
    .replaceAll("ç", "c")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ");
}

function isBonusDisiKuponOynama(value) {
  const text = normalizeSearchText(value);
  return text === "bonus disi kupon oynama" || text === "kupon oynama";
}

function normalizeGsm(value) {
  const text = String(value ?? "").trim().replace(/\s+/g, "");
  const masked = text.match(/0?5\d{2}\*{3}\d{4}/);
  if (masked) {
    const value = masked[0];
    return value.startsWith("0") ? value : `0${value}`;
  }

  const digits = text.replace(/\D/g, "");
  let national = "";
  if (/^05\d{9}$/.test(digits)) national = digits;
  if (/^5\d{9}$/.test(digits)) national = `0${digits}`;
  if (/^905\d{9}$/.test(digits)) national = `0${digits.slice(2)}`;
  if (!national) return text;

  return `${national.slice(0, 4)}***${national.slice(-4)}`;
}

function canonicalGsm(value) {
  const normalized = normalizeGsm(value);
  const masked = String(normalized || "").match(/05\d{2}\*{3}\d{4}/);
  return masked ? masked[0] : "";
}

function portalNumberFromCell(value) {
  return canonicalGsm(value);
}

function normalizeNumberName(value) {
  return String(value ?? "").trim().slice(0, 80);
}

function validIsoDate(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function numberRecordFrom(value) {
  if (typeof value === "object" && value !== null) {
    return {
      number: normalizeGsm(value.number || value.gsmMasked || value.gsm || ""),
      name: normalizeNumberName(value.name || value.label || ""),
      createdAt: validIsoDate(value.createdAt || value.registeredAt || value.addedAt)
    };
  }
  return { number: normalizeGsm(value), name: "", createdAt: "" };
}

function getUserNumberRecords(user) {
  const records = [];
  const add = record => {
    if (!record.number || records.some(item => item.number === record.number)) return;
    records.push(record);
  };
  if (Array.isArray(user.numberRecords)) user.numberRecords.map(numberRecordFrom).forEach(add);
  add({ number: normalizeGsm(user.gsmMasked), name: normalizeNumberName(user.gsmName || "") });
  (user.gsmList || []).map(numberRecordFrom).forEach(add);
  return records;
}

function auditCreatedAtForNumber(db, user, number) {
  const normalized = normalizeGsm(number);
  return (db.auditLogs || [])
    .filter(log =>
      log.action === "Numara eklendi" &&
      log.actorId === user.id &&
      String(log.details || "").includes(normalized)
    )
    .map(log => log.createdAt)
    .filter(Boolean)
    .sort()[0] || "";
}

function backfillNumberRecordDates(db, user) {
  const fallbackDate = validIsoDate(user.createdAt) || new Date().toISOString();
  return getUserNumberRecords(user).map(record => ({
    ...record,
    createdAt: record.createdAt || auditCreatedAtForNumber(db, user, record.number) || fallbackDate
  }));
}

function getUserGsms(user) {
  return getUserNumberRecords(user).map(record => record.number);
}

function latestPortalList(db, ownerId) {
  return (db.portalLists || [])
    .filter(list => list.ownerId === ownerId)
    .slice()
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))[0] || null;
}

function portalNumberSet(db, ownerId) {
  return new Set((latestPortalList(db, ownerId)?.numbers || []).map(canonicalGsm).filter(Boolean));
}

function withPortalStatus(records, portalSet) {
  return (records || []).map(record => {
    const registered = portalSet.has(canonicalGsm(record.number));
    return {
      ...record,
      portalRegistered: registered,
      portalStatusText: registered ? "Kayitli" : "Kayitli degil"
    };
  });
}

function findNumberOwner(db, ownerId, gsm, exceptUserId = "") {
  return db.users.find(user =>
    user.role === "member" &&
    user.ownerId === ownerId &&
    user.id !== exceptUserId &&
    getUserGsms(user).includes(gsm)
  );
}

function duplicateNumberMessage(owner) {
  return owner
    ? `Bu numara ${owner.name || owner.username} adli tipsterda kayitli.`
    : "Bu numara baska bir tipsterda kayitli.";
}

function zipEntries(buffer) {
  const entries = new Map();
  let offset = buffer.length - 22;
  while (offset >= 0 && buffer.readUInt32LE(offset) !== 0x06054b50) offset--;
  if (offset < 0) throw new Error("Excel dosyası okunamadı.");
  const total = buffer.readUInt16LE(offset + 10);
  let central = buffer.readUInt32LE(offset + 16);
  for (let i = 0; i < total; i++) {
    if (buffer.readUInt32LE(central) !== 0x02014b50) throw new Error("Excel zip yapısı hatalı.");
    const method = buffer.readUInt16LE(central + 10);
    const compressedSize = buffer.readUInt32LE(central + 20);
    const fileNameLength = buffer.readUInt16LE(central + 28);
    const extraLength = buffer.readUInt16LE(central + 30);
    const commentLength = buffer.readUInt16LE(central + 32);
    const localOffset = buffer.readUInt32LE(central + 42);
    const name = buffer.slice(central + 46, central + 46 + fileNameLength).toString("utf8");
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = buffer.slice(dataStart, dataStart + compressedSize);
    const data = method === 0 ? compressed : zlib.inflateRawSync(compressed);
    entries.set(name, data.toString("utf8"));
    central += 46 + fileNameLength + extraLength + commentLength;
  }
  return entries;
}

function tagAttrs(tag) {
  const attrs = {};
  for (const match of tag.matchAll(/([\w:]+)="([^"]*)"/g)) attrs[match[1]] = match[2];
  return attrs;
}

function xmlText(value) {
  return String(value ?? "")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

function parseSharedStrings(xml) {
  if (!xml) return [];
  const strings = [];
  for (const match of xml.matchAll(/<si\b[\s\S]*?<\/si>/g)) {
    const parts = [...match[0].matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map(item => xmlText(item[1]));
    strings.push(parts.join(""));
  }
  return strings;
}

function parseWorkbook(entries) {
  const workbook = entries.get("xl/workbook.xml");
  const rels = entries.get("xl/_rels/workbook.xml.rels");
  const relMap = {};
  for (const match of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    const attrs = tagAttrs(match[0]);
    relMap[attrs.Id] = attrs.Target;
  }
  const sheetMatch = workbook.match(/<sheet\b[^>]*>/);
  if (!sheetMatch) throw new Error("Excel içinde sayfa bulunamadı.");
  const attrs = tagAttrs(sheetMatch[0]);
  let target = relMap[attrs["r:id"]];
  if (!target) throw new Error("Excel sayfası okunamadı.");
  if (!target.startsWith("/")) target = `xl/${target}`;
  target = target.replace(/^\/+/, "").replaceAll("\\", "/");
  return { sheetName: attrs.name, target };
}

function parseWorkbookSheets(entries) {
  const workbook = entries.get("xl/workbook.xml");
  const rels = entries.get("xl/_rels/workbook.xml.rels");
  const relMap = {};
  for (const match of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    const attrs = tagAttrs(match[0]);
    relMap[attrs.Id] = attrs.Target;
  }
  return [...workbook.matchAll(/<sheet\b[^>]*>/g)].map(match => {
    const attrs = tagAttrs(match[0]);
    let target = relMap[attrs["r:id"]];
    if (!target) return null;
    if (!target.startsWith("/")) target = `xl/${target}`;
    target = target.replace(/^\/+/, "").replaceAll("\\", "/");
    return { sheetName: attrs.name, target };
  }).filter(Boolean);
}

function columnIndex(ref) {
  const letters = String(ref || "").replace(/[^A-Z]/gi, "").toUpperCase();
  let n = 0;
  for (const ch of letters) n = n * 26 + ch.charCodeAt(0) - 64;
  return n - 1;
}

function parseSheetRows(xml, sharedStrings) {
  const rows = [];
  for (const rowMatch of xml.matchAll(/<row\b[^>]*>[\s\S]*?<\/row>/g)) {
    const row = [];
    for (const cellMatch of rowMatch[0].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attrs = tagAttrs(`<c ${cellMatch[1]}>`);
      const idx = columnIndex(attrs.r);
      const body = cellMatch[2];
      let value = "";
      const inline = body.match(/<is>[\s\S]*?<t(?:\s[^>]*)?>([\s\S]*?)<\/t>[\s\S]*?<\/is>/);
      const v = body.match(/<v>([\s\S]*?)<\/v>/);
      if (attrs.t === "inlineStr" && inline) value = xmlText(inline[1]);
      else if (attrs.t === "s" && v) value = sharedStrings[Number(v[1])] || "";
      else if (v) value = xmlText(v[1]);
      row[idx] = value;
    }
    rows.push(row.map(value => value ?? ""));
  }
  return rows;
}

function parseExcel(buffer, options = {}) {
  const entries = zipEntries(buffer);
  const sharedStrings = parseSharedStrings(entries.get("xl/sharedStrings.xml"));
  const sheets = options.uploadType === "daily" ? parseWorkbookSheets(entries) : [parseWorkbook(entries)];
  const selectedDailyHeader = excelDateHeader(options.uploadDate);
  const parsedRows = [];
  const sheetErrors = [];
  const preparedSheets = sheets.map(sheet => {
    const rows = parseSheetRows(entries.get(sheet.target), sharedStrings);
    const headers = rows.shift() || [];
    const normalizedHeaders = headers.map(normalizeSearchText);
    return { ...sheet, rows, headers, normalizedHeaders };
  });
  const dailyDetailSheets = options.uploadType === "daily"
    ? preparedSheets.filter(sheet =>
      sheet.normalizedHeaders.includes("kupon tarihi") &&
      sheet.normalizedHeaders.includes("oyuncu gsm") &&
      sheet.normalizedHeaders.includes("tutar") &&
      sheet.normalizedHeaders.includes("islem tipi"))
    : [];
  const sheetsToRead = dailyDetailSheets.length ? dailyDetailSheets : preparedSheets;
  for (const { sheetName, rows, headers, normalizedHeaders } of sheetsToRead) {
    const gsmIndex = normalizedHeaders.findIndex(h => h === "oyuncu gsm");
    const totalIndex = normalizedHeaders.findIndex(h => h === "toplam tutar");
    const amountIndex = normalizedHeaders.findIndex(h => h === "tutar");
    const typeIndex = normalizedHeaders.findIndex(h => h === "islem tipi" || h === "aciklama");
    const dateIndex = normalizedHeaders.findIndex(h => h === "tarih" || h === "kupon tarihi");
    if (gsmIndex === -1 || typeIndex === -1 || (options.uploadType !== "daily" && totalIndex === -1)) {
      sheetErrors.push(sheetName);
      continue;
    }
    const dailyColumnKeys = headers
      .map((header, index) => ({ header, index }))
      .filter(item => /^\d{2}\.\d{2}\.\d{4}$/.test(String(item.header)));
    if (options.uploadType === "daily" && !dailyColumnKeys.length && amountIndex === -1) {
      sheetErrors.push(sheetName);
      continue;
    }
    const hasDailyHeader = daily => selectedDailyHeader && Object.prototype.hasOwnProperty.call(daily, selectedDailyHeader);
    const sheetRows = rows
      .filter(row => normalizeGsm(row[gsmIndex]))
      .filter(row => isBonusDisiKuponOynama(row[typeIndex]))
      .filter(row => options.uploadType !== "daily" || dateIndex === -1 || excelCellMatchesDate(row[dateIndex], options.uploadDate))
      .map(row => {
        const daily = Object.fromEntries(dailyColumnKeys.map(item => [item.header, numberFrom(row[item.index])]));
        const hasDailyColumns = Object.keys(daily).length > 0;
        const selectedDailyAmount = hasDailyHeader(daily)
          ? daily[selectedDailyHeader]
          : Object.values(daily).reduce((sum, value) => sum + value, 0);
        const dailyCalculation = options.uploadType === "daily" && hasDailyColumns;
        const excelTotalAmount = totalIndex === -1 ? 0 : numberFrom(row[totalIndex]);
        const directDailyAmount = amountIndex === -1 ? 0 : numberFrom(row[amountIndex]);
        const totalAmount = options.uploadType === "daily"
          ? (dailyCalculation ? selectedDailyAmount : directDailyAmount)
          : excelTotalAmount;
        return {
          id: crypto.randomUUID(),
          gsmMasked: normalizeGsm(row[gsmIndex]),
          processType: row[typeIndex] || "",
          totalAmount,
          excelTotalAmount,
          calculationSource: dailyCalculation
            ? (hasDailyHeader(daily) ? selectedDailyHeader : "gunluk tarih sutunlari")
            : (options.uploadType === "daily" ? "tutar" : "toplam tutar"),
          daily,
          sheetName,
          importedAt: new Date().toISOString()
        };
      })
      .filter(row => options.uploadType !== "daily" || row.totalAmount !== 0 || !Object.keys(row.daily || {}).length);
    if (sheetRows.length) parsedRows.push(...sheetRows);
    if (options.uploadType !== "daily") break;
  }
  if (!parsedRows.length && sheetErrors.length) {
    throw new Error(options.uploadType === "daily"
      ? "Gunluk Excel icinde OYUNCU GSM, ISLEM TIPI/ACIKLAMA ve TUTAR veya gunluk tarih sutunlari bulunmali."
      : "Excel icinde OYUNCU GSM, TOPLAM TUTAR ve ISLEM TIPI basliklari bulunmali.");
  }
  return parsedRows;
}

function parsePortalNumberExcel(buffer) {
  const entries = zipEntries(buffer);
  const sharedStrings = parseSharedStrings(entries.get("xl/sharedStrings.xml"));
  const sheets = parseWorkbookSheets(entries);
  const rows = sheets.flatMap(sheet => parseSheetRows(entries.get(sheet.target), sharedStrings));
  const numbers = [];
  const seen = new Set();
  rows.flat().forEach(cell => {
    const number = portalNumberFromCell(cell);
    if (!number || seen.has(number)) return;
    seen.add(number);
    numbers.push(number);
  });
  if (!numbers.length) {
    throw new Error("Bayi Portal Excel icinde telefon numarasi bulunamadi.");
  }
  return numbers;
}

function parseMultipart(buffer, contentType) {
  const boundaryMatch = String(contentType || "").match(/boundary=(?:"([^"]+)"|([^;]+))/);
  if (!boundaryMatch) throw new Error("Yükleme sınırı bulunamadı.");
  const boundary = Buffer.from(`--${boundaryMatch[1] || boundaryMatch[2]}`);
  const parts = [];
  let start = buffer.indexOf(boundary) + boundary.length + 2;
  while (start > boundary.length) {
    const next = buffer.indexOf(boundary, start);
    if (next === -1) break;
    const part = buffer.slice(start, next - 2);
    const split = part.indexOf(Buffer.from("\r\n\r\n"));
    if (split !== -1) {
      const header = part.slice(0, split).toString("utf8");
      const data = part.slice(split + 4);
      const name = (header.match(/name="([^"]+)"/) || [])[1];
      const filename = (header.match(/filename="([^"]*)"/) || [])[1];
      parts.push({ name, filename, data });
    }
    start = next + boundary.length + 2;
  }
  return parts;
}

function selectedRows(db, uploadId, ownerId) {
  const rows = (ownerId ? db.rows.filter(row => row.ownerId === ownerId) : db.rows)
    .filter(row => isBonusDisiKuponOynama(row.processType));
  if (!uploadId || uploadId === "all") return rows;
  return rows.filter(row => row.uploadId === uploadId);
}

function uploadsByType(db, ownerId, uploadType) {
  return db.uploads.filter(upload => upload.ownerId === ownerId && (upload.uploadType || "weekly") === uploadType);
}

function latestUploadByType(db, ownerId, uploadType) {
  const uploads = uploadsByType(db, ownerId, uploadType);
  return uploads[uploads.length - 1] || null;
}

function sharedNumbersEnabledForOwner(db, ownerId) {
  const owner = db.users.find(user => user.id === ownerId && isStaff(user));
  return Boolean(owner?.sharedNumbersEnabled);
}

function numberShareCounts(db, ownerId) {
  if (!sharedNumbersEnabledForOwner(db, ownerId)) return new Map();
  const counts = new Map();
  db.users
    .filter(user => user.role === "member" && user.ownerId === ownerId)
    .forEach(member => {
      new Set(getUserGsms(member)).forEach(number => {
        if (!number) return;
        counts.set(number, (counts.get(number) || 0) + 1);
      });
    });
  return counts;
}

function sharedNumberSummary(db, uploadId, ownerId) {
  if (!sharedNumbersEnabledForOwner(db, ownerId)) return [];
  const grouped = new Map();
  db.users
    .filter(user => user.role === "member" && user.ownerId === ownerId)
    .forEach(member => {
      getUserNumberRecords(member).forEach(record => {
        if (!record.number) return;
        const current = grouped.get(record.number) || {
          number: record.number,
          name: record.name || "",
          members: []
        };
        current.members.push({
          id: member.id,
          name: member.name || member.username,
          username: member.username,
          percentage: Number(member.percentage) || 0
        });
        if (!current.name && record.name) current.name = record.name;
        grouped.set(record.number, current);
      });
    });
  const rows = selectedRows(db, uploadId, ownerId);
  return Array.from(grouped.values())
    .filter(item => item.members.length > 1)
    .map(item => {
      const numberRows = rows.filter(row => row.gsmMasked === item.number);
      const total = numberRows.reduce((sum, row) => sum + Number(row.totalAmount || 0), 0);
      return {
        ...item,
        memberCount: item.members.length,
        rowCount: numberRows.length,
        total,
        sharedTotal: item.members.length ? total / item.members.length : total
      };
    })
    .sort((a, b) => b.memberCount - a.memberCount || b.total - a.total || a.number.localeCompare(b.number));
}

function sharedRow(row, shareCounts) {
  const shareCount = Math.max(1, shareCounts.get(row.gsmMasked) || 1);
  const originalTotalAmount = Number(row.totalAmount) || 0;
  return {
    ...row,
    originalTotalAmount,
    shareCount,
    totalAmount: originalTotalAmount / shareCount
  };
}

function memberSummary(db, user, uploadId) {
  const ownerId = user.role === "member" ? user.ownerId : user.id;
  const numberRecords = getUserNumberRecords(user);
  const numbers = numberRecords.map(record => canonicalGsm(record.number)).filter(Boolean);
  const gsmSet = new Set(numbers);
  const sourceRows = selectedRows(db, uploadId, ownerId);
  const shareCounts = numberShareCounts(db, ownerId);
  const portalSet = portalNumberSet(db, ownerId);
  const rows = sourceRows.filter(row => gsmSet.has(canonicalGsm(row.gsmMasked))).map(row => {
    const shared = sharedRow(row, shareCounts);
    const sharedNumber = canonicalGsm(shared.gsmMasked);
    const record = numberRecords.find(item => canonicalGsm(item.number) === sharedNumber);
    const registered = portalSet.has(sharedNumber);
    return {
      ...shared,
      createdAt: record?.createdAt || "",
      portalRegistered: registered,
      portalStatusText: registered ? "Kayitli" : "Kayitli degil"
    };
  });
  const total = rows.reduce((sum, row) => sum + row.totalAmount, 0);
  const calculated = total * (Number(user.percentage) || 0) / 100;
  const numberSummaries = numberRecords.map(record => {
    const recordNumber = canonicalGsm(record.number);
    const numberRows = sourceRows.filter(row => canonicalGsm(row.gsmMasked) === recordNumber).map(row => sharedRow(row, shareCounts));
    const numberTotal = numberRows.reduce((sum, row) => sum + row.totalAmount, 0);
    const shareCount = Math.max(1, shareCounts.get(recordNumber) || 1);
    return {
      number: record.number,
      name: record.name,
      createdAt: record.createdAt,
      active: numberRows.length > 0,
      portalRegistered: portalSet.has(recordNumber),
      portalStatusText: portalSet.has(recordNumber) ? "Kayitli" : "Kayitli degil",
      rowCount: numberRows.length,
      shareCount,
      total: numberTotal,
      calculated: numberTotal * (Number(user.percentage) || 0) / 100
    };
  });
  return { rows, total, calculated, numberSummaries };
}

function memberPrivateSummary(summary) {
  return {
    ...summary,
    rows: summary.rows.map(({ shareCount, originalTotalAmount, ...row }) => row),
    numberSummaries: summary.numberSummaries.map(({ shareCount, ...item }) => item)
  };
}

function memberDailySummaries(db, user, ownerId) {
  const uploads = uploadsByType(db, ownerId, "daily").slice().reverse();
  return uploads.map(upload => {
    const summary = memberPrivateSummary(memberSummary(db, user, upload.id));
    return {
      uploadId: upload.id,
      label: upload.weekLabel || upload.filename || "Gunluk Excel",
      uploadDate: upload.uploadDate || dateOnly(upload.createdAt),
      rowCount: summary.rows.length,
      total: summary.total,
      calculated: summary.calculated,
      createdAt: upload.createdAt
    };
  });
}

function adminSummary(db, uploadId, ownerId) {
  const members = db.users.filter(user => user.role === "member" && user.ownerId === ownerId);
  const rows = selectedRows(db, uploadId, ownerId);
  const totalAmount = rows.reduce((sum, row) => sum + row.totalAmount, 0);
  const totalCommission = members.reduce((sum, member) => sum + memberSummary(db, member, uploadId).calculated, 0);
  return {
    memberCount: members.length,
    rowCount: rows.length,
    totalAmount,
    totalCommission,
    uploadCount: db.uploads.length
  };
}

function adminOverview(db, uploadId, ownerId, unmatchedUploadIds = [uploadId]) {
  const members = db.users.filter(user => user.role === "member" && user.ownerId === ownerId);
  const rows = selectedRows(db, uploadId, ownerId);
  const activeNumbers = new Set(rows.map(row => row.gsmMasked).filter(Boolean));
  const passiveNumbers = passiveNumberSummary(db, uploadId, ownerId);
  const unmatchedNumbers = combinedUnmatchedNumberSummary(db, unmatchedUploadIds, ownerId);
  const portalNumbers = portalNumberSet(db, ownerId);
  const tipsterNumbers = new Set(members.flatMap(member => getUserGsms(member).map(canonicalGsm)).filter(Boolean));
  const portalMatchedCount = Array.from(tipsterNumbers).filter(number => portalNumbers.has(number)).length;
  const portalMissingCount = Math.max(0, tipsterNumbers.size - portalMatchedCount);
  const portalUnassignedCount = Array.from(portalNumbers).filter(number => !tipsterNumbers.has(number)).length;
  const unreadMessages = (db.messages || [])
    .filter(message => message.ownerId === ownerId)
    .reduce((sum, message) => {
      const unread = message.recipientIds.filter(id => !message.readBy?.[id]).length;
      return sum + unread;
    }, 0);
  const uploadReports = (db.uploadReports || []).filter(report => report.ownerId === ownerId);
  const latestReport = uploadReports.slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0] || null;
  const latestBackup = listBackups()[0] || null;
  return {
    totalMembers: members.length,
    activeNumberCount: activeNumbers.size,
    passiveNumberCount: passiveNumbers.length,
    unmatchedNumberCount: unmatchedNumbers.length,
    portalListCount: portalNumbers.size,
    tipsterNumberCount: tipsterNumbers.size,
    portalMatchedCount,
    portalMissingCount,
    portalUnassignedCount,
    uploadCount: db.uploads.filter(upload => upload.ownerId === ownerId).length,
    unreadMessageCount: unreadMessages,
    feedbackCount: (db.feedbacks || []).filter(feedback => feedback.status === "new").length,
    latestUploadAt: latestReport?.createdAt || "",
    latestBackupAt: latestBackup?.createdAt || "",
    latestBackupFile: latestBackup?.filename || ""
  };
}

function unmatchedNumberSummary(db, uploadId, ownerId) {
  const registeredNumbers = new Set(
    db.users
      .filter(user => (user.role === "member" && user.ownerId === ownerId) || user.id === ownerId)
      .flatMap(user => getUserNumberRecords(user).map(record => canonicalGsm(record.number)).filter(Boolean))
  );
  const grouped = new Map();
  selectedRows(db, uploadId, ownerId)
    .map(row => ({ ...row, compareNumber: canonicalGsm(row.gsmMasked) }))
    .filter(row => row.compareNumber && !registeredNumbers.has(row.compareNumber))
    .forEach(row => {
      const current = grouped.get(row.compareNumber) || {
        number: row.compareNumber,
        rowCount: 0,
        total: 0,
        uploads: new Set(),
        lastSeenAt: ""
      };
      const upload = db.uploads.find(item => item.id === row.uploadId);
      current.rowCount += 1;
      current.total += Number(row.totalAmount) || 0;
      if (upload) current.uploads.add(upload.weekLabel || upload.filename);
      if (!current.lastSeenAt || String(row.importedAt || "").localeCompare(current.lastSeenAt) > 0) {
        current.lastSeenAt = row.importedAt || "";
      }
      grouped.set(row.compareNumber, current);
    });
  return Array.from(grouped.values())
    .map(item => ({ ...item, uploads: Array.from(item.uploads) }))
    .sort((a, b) => b.total - a.total || a.number.localeCompare(b.number));
}

function combinedUnmatchedNumberSummary(db, uploadIds, ownerId) {
  const ids = Array.from(new Set((uploadIds || []).filter(Boolean)));
  const summaries = ids.length ? ids.flatMap(id => unmatchedNumberSummary(db, id, ownerId)) : unmatchedNumberSummary(db, "", ownerId);
  const grouped = new Map();
  summaries.forEach(item => {
    const current = grouped.get(item.number) || {
      number: item.number,
      rowCount: 0,
      total: 0,
      uploads: new Set(),
      lastSeenAt: ""
    };
    current.rowCount += Number(item.rowCount) || 0;
    current.total += Number(item.total) || 0;
    (item.uploads || []).forEach(upload => current.uploads.add(upload));
    if (!current.lastSeenAt || String(item.lastSeenAt || "").localeCompare(current.lastSeenAt) > 0) {
      current.lastSeenAt = item.lastSeenAt || "";
    }
    grouped.set(item.number, current);
  });
  return Array.from(grouped.values())
    .map(item => ({ ...item, uploads: Array.from(item.uploads) }))
    .sort((a, b) => b.total - a.total || a.number.localeCompare(b.number));
}

function uploadDisplayLabel(upload) {
  return upload ? (upload.weekLabel || upload.filename || "Excel") : "";
}

function uploadTypeLabel(upload) {
  return upload?.uploadType === "daily" ? "Gunluk" : "Haftalik";
}

function passiveNumberSummary(db, uploadId, ownerId) {
  const selected = selectedRows(db, uploadId, ownerId);
  const selectedNumbers = new Set(selected.map(row => canonicalGsm(row.gsmMasked)).filter(Boolean));
  const allRows = selectedRows(db, "all", ownerId);
  const uploadMap = new Map(db.uploads.map(upload => [upload.id, upload]));
  const selectedUpload = uploadId && uploadId !== "all" ? uploadMap.get(uploadId) : null;
  const passiveSince = selectedUpload ? uploadDisplayLabel(selectedUpload) : "Tum haftalar";

  return db.users
    .filter(user => user.role === "member" && user.ownerId === ownerId)
    .flatMap(user => getUserNumberRecords(user).map(record => {
      const recordNumber = canonicalGsm(record.number);
      if (!recordNumber || selectedNumbers.has(recordNumber)) return null;
      const numberRows = allRows
        .filter(row => canonicalGsm(row.gsmMasked) === recordNumber)
        .sort((a, b) => String(b.importedAt || "").localeCompare(String(a.importedAt || "")));
      if (uploadId === "all" && numberRows.length) return null;
      const lastRow = numberRows[0];
      const lastUpload = lastRow ? uploadMap.get(lastRow.uploadId) : null;
      return {
        memberId: user.id,
        memberName: user.name || user.username,
        memberUsername: user.username,
        number: recordNumber,
        name: record.name,
        passiveSince,
        lastActive: lastUpload ? uploadDisplayLabel(lastUpload) : "",
        lastActiveAt: lastRow?.importedAt || "",
        statusText: lastUpload ? `${uploadDisplayLabel(lastUpload)} sonrasi pasif` : "Hic aktif olmadi"
      };
    }))
    .filter(Boolean)
    .sort((a, b) => a.memberName.localeCompare(b.memberName, "tr") || a.number.localeCompare(b.number));
}

function createUploadReport(db, upload, ownerId) {
  const rows = selectedRows(db, upload.id, ownerId);
  const activeNumbers = new Set(rows.map(row => row.gsmMasked).filter(Boolean));
  return {
    id: crypto.randomUUID(),
    uploadId: upload.id,
    ownerId,
    filename: upload.filename,
    weekLabel: upload.weekLabel,
    uploadType: upload.uploadType || "weekly",
    uploadDate: upload.uploadDate || "",
    rowCount: rows.length,
    totalAmount: rows.reduce((sum, row) => sum + Number(row.totalAmount || 0), 0),
    totalCommission: adminSummary(db, upload.id, ownerId).totalCommission,
    activeNumberCount: activeNumbers.size,
    passiveCount: passiveNumberSummary(db, upload.id, ownerId).length,
    unmatchedCount: unmatchedNumberSummary(db, upload.id, ownerId).length,
    createdAt: new Date().toISOString()
  };
}

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function xmlEscape(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function excelColumn(index) {
  let out = "";
  let current = index + 1;
  while (current > 0) {
    const mod = (current - 1) % 26;
    out = String.fromCharCode(65 + mod) + out;
    current = Math.floor((current - mod) / 26);
  }
  return out;
}

function createSheetXml(rows) {
  const body = rows.map((row, rowIndex) => {
    const cells = row.map((value, colIndex) => {
      const ref = `${excelColumn(colIndex)}${rowIndex + 1}`;
      const text = xmlEscape(value);
      return `<c r="${ref}" t="inlineStr"><is><t>${text}</t></is></c>`;
    }).join("");
    return `<row r="${rowIndex + 1}">${cells}</row>`;
  }).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`;
}

function createZip(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name);
    const data = Buffer.from(file.content);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, ...centralParts, end]);
}

function createNumbersXlsx(member, summaries) {
  const rows = [
    ["Isim", "Numara", "Kayit tarihi", "Durum", "Bayi Portal", "Kayit", "Toplam oyun", "Komisyon"],
    ...summaries.map(item => [
      item.name || "",
      item.number,
      item.createdAt ? new Date(item.createdAt).toLocaleString("tr-TR", { timeZone: "Europe/Istanbul" }) : "",
      item.active ? "Aktif" : "Pasif",
      item.portalRegistered ? "Kayitli" : "Kayitli degil",
      item.rowCount,
      item.total,
      item.calculated
    ])
  ];
  const sheet = createSheetXml(rows);
  return createZip([
    {
      name: "[Content_Types].xml",
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`
    },
    {
      name: "_rels/.rels",
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`
    },
    {
      name: "docProps/app.xml",
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>Tipster Kontrol Paneli</Application></Properties>`
    },
    {
      name: "docProps/core.xml",
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:creator>Tipster Kontrol Paneli</dc:creator><cp:lastModifiedBy>Tipster Kontrol Paneli</cp:lastModifiedBy></cp:coreProperties>`
    },
    {
      name: "xl/workbook.xml",
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Numaralar" sheetId="1" r:id="rId1"/></sheets></workbook>`
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`
    },
    {
      name: "xl/styles.xml",
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs></styleSheet>`
    },
    { name: "xl/worksheets/sheet1.xml", content: sheet }
  ]);
}

function serveStatic(req, res) {
  const requestedPath = decodeURIComponent(req.url.split("?")[0]);
  const requested = requestedPath === "/" ? "/index.html" : requestedPath;
  const filePath = path.normalize(path.join(PUBLIC, requested));
  if (!filePath.startsWith(PUBLIC)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      const wantsPage = !path.extname(filePath) || path.extname(filePath) === ".html";
      if (wantsPage && requested !== "/maintenance.html") {
        const maintenancePath = path.join(PUBLIC, "maintenance.html");
        fs.readFile(maintenancePath, (maintenanceErr, maintenanceData) => {
          if (maintenanceErr) {
            res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
            res.end("Sistem guncelleniyor. Lutfen biraz sonra tekrar deneyin.");
            return;
          }
          res.writeHead(503, {
            "Content-Type": "text/html; charset=utf-8",
            "X-Content-Type-Options": "nosniff",
            "Cache-Control": "no-store"
          });
          res.end(maintenanceData);
        });
        return;
      }
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    const ext = path.extname(filePath);
    const types = {
      ".css": "text/css",
      ".js": "text/javascript",
      ".json": "application/json",
      ".webmanifest": "application/manifest+json",
      ".png": "image/png",
      ".svg": "image/svg+xml",
      ".html": "text/html"
    };
    const type = types[ext] || "application/octet-stream";
    const charset = type.startsWith("text/") || type.includes("json") || type.includes("svg") ? "; charset=utf-8" : "";
    res.writeHead(200, {
      "Content-Type": `${type}${charset}`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store"
    });
    res.end(data);
  });
}

async function handleApi(req, res) {
  const db = readDb();
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "POST" && url.pathname === "/api/login") {
    const body = JSON.parse((await readBody(req, 1024 * 20)).toString("utf8"));
    const username = String(body.username || "").trim();
    const loginType = String(body.loginType || "");
    const attemptKey = loginAttemptKey(req, username, loginType);
    const locked = loginLockInfo(attemptKey);
    if (locked) {
      const minutes = Math.ceil((locked.lockedUntil - Date.now()) / 60000);
      sendJson(res, 429, { error: `Cok fazla hatali deneme yapildi. ${minutes} dakika sonra tekrar deneyin.` });
      return;
    }
    const user = db.users.find(item => item.username === username);
    if (!user || !verifyPassword(body.password, user.passwordHash)) {
      recordLoginFailure(attemptKey);
      sendJson(res, 401, { error: "Kullanıcı adı veya şifre hatalı." });
      return;
    }
    if (loginType === "admin" && !isStaff(user)) {
      recordLoginFailure(attemptKey);
      sendJson(res, 401, { error: "Bu hesap admin hesabi degil." });
      return;
    }
    if (loginType === "member" && user.role !== "member") {
      recordLoginFailure(attemptKey);
      sendJson(res, 401, { error: "Bu hesap tipster hesabi degil." });
      return;
    }
    clearLoginFailure(attemptKey);
    if (isStaff(user) && emailOtpConfigured()) {
      const otpEmail = otpRecipientFor(user);
      if (!validEmail(otpEmail)) {
        sendJson(res, 400, { error: "Admin e-posta adresi tanimli degil." });
        return;
      }
      cleanupOtps();
      const { loginToken, code } = createOtpLogin(user);
      try {
        await sendOtpEmail(otpEmail, code);
      } catch (error) {
        pendingOtps.delete(loginToken);
        sendJson(res, 500, { error: "E-posta kodu gonderilemedi. Mail ayarlarini kontrol edin." });
        return;
      }
      sendJson(res, 200, {
        requiresOtp: true,
        loginToken,
        email: maskEmail(otpEmail),
        message: "Giris kodu e-posta adresine gonderildi."
      });
      return;
    }
    const csrf = setSession(res, user);
    addAuditLog(db, user.role === "member" ? user.ownerId : user.id, user, "Giris yapildi", user.role === "member" ? "Tipster girisi" : "Admin girisi");
    writeDb(db);
    sendJson(res, 200, { csrf, user: publicUser(user) });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/logout") {
    const session = currentSession(req);
    const user = session ? db.users.find(item => item.id === session.userId) : null;
    if (user) {
      addAuditLog(db, user.role === "member" ? user.ownerId : user.id, user, "Cikis yapildi", user.role === "member" ? "Tipster cikisi" : "Admin cikisi");
      writeDb(db);
    }
    clearSession(req, res);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/login/verify") {
    const body = JSON.parse((await readBody(req, 1024 * 20)).toString("utf8"));
    cleanupOtps();
    const token = String(body.loginToken || "");
    const code = String(body.code || "").trim();
    const pending = pendingOtps.get(token);
    if (!pending || !/^\d{6}$/.test(code)) {
      sendJson(res, 400, { error: "Kod hatali veya suresi dolmus." });
      return;
    }
    pending.attempts += 1;
    if (pending.attempts > 5) {
      pendingOtps.delete(token);
      sendJson(res, 400, { error: "Cok fazla hatali deneme yapildi. Tekrar giris yapin." });
      return;
    }
    if (!verifyPassword(code, pending.codeHash)) {
      sendJson(res, 400, { error: "Onay kodu hatali." });
      return;
    }
    const user = db.users.find(item => item.id === pending.userId && isStaff(item));
    if (!user) {
      pendingOtps.delete(token);
      sendJson(res, 400, { error: "Giris gecersiz." });
      return;
    }
    pendingOtps.delete(token);
    const csrf = setSession(res, user);
    addAuditLog(db, user.id, user, "Giris yapildi", "E-posta onay kodu ile admin girisi");
    writeDb(db);
    sendJson(res, 200, { csrf, user: publicUser(user) });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/me") {
    const session = currentSession(req);
    if (!session) {
      sendJson(res, 200, { user: null });
      return;
    }
    const user = db.users.find(item => item.id === session.userId);
    sendJson(res, 200, { csrf: session.csrf, user: publicUser(user) });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/admin/password") {
    const session = requireStaff(req, res);
    if (!session) return;
    const body = JSON.parse((await readBody(req, 1024 * 20)).toString("utf8"));
    const user = db.users.find(item => item.id === session.userId);
    const currentPassword = String(body.currentPassword || "");
    const newPassword = String(body.newPassword || "");
    if (!verifyPassword(currentPassword, user.passwordHash)) {
      sendJson(res, 400, { error: "Mevcut sifre hatali." });
      return;
    }
    if (newPassword.length < 8) {
      sendJson(res, 400, { error: "Yeni sifre en az 8 karakter olmali." });
      return;
    }
    user.passwordHash = hashPassword(newPassword);
    addAuditLog(db, user.id, user, "Admin sifresi degisti", "Admin kendi sifresini guncelledi");
    writeDb(db);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/admin/email") {
    const session = requireStaff(req, res);
    if (!session) return;
    const body = JSON.parse((await readBody(req, 1024 * 20)).toString("utf8"));
    const user = db.users.find(item => item.id === session.userId);
    const email = normalizeEmail(body.email);
    if (!validEmail(email)) {
      sendJson(res, 400, { error: "Gecerli bir e-posta adresi girin." });
      return;
    }
    user.email = email;
    addAuditLog(db, user.id, user, "Admin e-postasi guncellendi", "Giris onay kodu e-postasi degisti");
    writeDb(db);
    sendJson(res, 200, { ok: true, user: publicUser(user) });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/member/password") {
    const session = requireAuth(req, res, "member");
    if (!session) return;
    const body = JSON.parse((await readBody(req, 1024 * 20)).toString("utf8"));
    const user = db.users.find(item => item.id === session.userId && item.role === "member");
    const currentPassword = String(body.currentPassword || "");
    const newPassword = String(body.newPassword || "");
    if (!user || !verifyPassword(currentPassword, user.passwordHash)) {
      sendJson(res, 400, { error: "Mevcut sifre hatali." });
      return;
    }
    if (newPassword.length < 6) {
      sendJson(res, 400, { error: "Yeni sifre en az 6 karakter olmali." });
      return;
    }
    user.passwordHash = hashPassword(newPassword);
    addAuditLog(db, user.ownerId, user, "Tipster sifresi degisti", `${user.name || user.username} kendi sifresini guncelledi`);
    writeDb(db);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/admins") {
    const session = requireAuth(req, res, "owner");
    if (!session) return;
    const admins = db.users.filter(user => user.role === "admin" && user.createdBy === session.userId).map(publicAdmin);
    sendJson(res, 200, { admins });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/admins") {
    const session = requireAuth(req, res, "owner");
    if (!session) return;
    const body = JSON.parse((await readBody(req, 1024 * 50)).toString("utf8"));
    const username = String(body.username || "").trim();
    const password = String(body.password || "");
    const name = String(body.name || "").trim();
    const email = normalizeEmail(body.email);
    const phone = normalizePhone(body.phone);
    const accessStartsAt = String(body.accessStartsAt || "").trim();
    const accessEndsAt = String(body.accessEndsAt || "").trim();
    if (!name || !username || password.length < 8) {
      sendJson(res, 400, { error: "Ad, kullanici adi ve en az 8 haneli sifre gerekli." });
      return;
    }
    if (!validEmail(email)) {
      sendJson(res, 400, { error: "Gecerli bir e-posta adresi gerekli." });
      return;
    }
    if (!validPhone(phone)) {
      sendJson(res, 400, { error: "Gecerli bir telefon numarasi gerekli." });
      return;
    }
    if (db.users.some(user => user.username === username)) {
      sendJson(res, 400, { error: "Bu kullanici adi zaten var." });
      return;
    }
    if (!validDateOnly(accessStartsAt) || !validDateOnly(accessEndsAt)) {
      sendJson(res, 400, { error: "Kullanim baslangic ve bitis tarihlerini secin." });
      return;
    }
    if (new Date(`${accessEndsAt}T00:00:00Z`) < new Date(`${accessStartsAt}T00:00:00Z`)) {
      sendJson(res, 400, { error: "Kullanim bitisi baslangictan once olamaz." });
      return;
    }
    const admin = {
      id: crypto.randomUUID(),
      role: "admin",
      username,
      name,
      email,
      phone,
      sharedNumbersEnabled: false,
      accessStartsAt,
      accessEndsAt,
      gsmMasked: "",
      percentage: 0,
      passwordHash: hashPassword(password),
      createdBy: session.userId,
      createdAt: new Date().toISOString()
    };
    db.users.push(admin);
    addAuditLog(db, session.userId, db.users.find(user => user.id === session.userId), "Admin olusturuldu", `${name} (${username}) admin hesabi acildi`);
    writeDb(db);
    sendJson(res, 200, { ok: true, admin: publicAdmin(admin) });
    return;
  }

  if (req.method === "POST" && url.pathname.startsWith("/api/admins/") && url.pathname.endsWith("/password")) {
    const session = requireAuth(req, res, "owner");
    if (!session) return;
    const id = url.pathname.split("/")[3];
    const admin = db.users.find(user => user.id === id && user.role === "admin" && user.createdBy === session.userId);
    if (!admin) {
      sendJson(res, 404, { error: "Admin bulunamadi." });
      return;
    }
    const body = JSON.parse((await readBody(req, 1024 * 20)).toString("utf8"));
    const password = String(body.password || "");
    if (password.length < 8) {
      sendJson(res, 400, { error: "Yeni sifre en az 8 karakter olmali." });
      return;
    }
    admin.passwordHash = hashPassword(password);
    addAuditLog(db, session.userId, db.users.find(user => user.id === session.userId), "Admin sifresi yenilendi", `${admin.name || admin.username} admin sifresi yenilendi`);
    writeDb(db);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && url.pathname.startsWith("/api/admins/") && url.pathname.endsWith("/shared-numbers")) {
    const session = requireAuth(req, res, "owner");
    if (!session) return;
    const id = url.pathname.split("/")[3];
    const admin = db.users.find(user => user.id === id && user.role === "admin" && user.createdBy === session.userId);
    if (!admin) {
      sendJson(res, 404, { error: "Admin bulunamadi." });
      return;
    }
    const body = JSON.parse((await readBody(req, 1024 * 20)).toString("utf8"));
    admin.sharedNumbersEnabled = Boolean(body.enabled);
    addAuditLog(
      db,
      session.userId,
      db.users.find(user => user.id === session.userId),
      "Admin ortak numara ayari guncellendi",
      `${admin.name || admin.username} icin ortak numara paylasimi ${admin.sharedNumbersEnabled ? "acildi" : "kapatildi"}`
    );
    writeDb(db);
    sendJson(res, 200, { ok: true, admin: publicAdmin(admin) });
    return;
  }

  if (req.method === "DELETE" && url.pathname.startsWith("/api/admins/")) {
    const session = requireAuth(req, res, "owner");
    if (!session) return;
    const id = url.pathname.split("/")[3];
    const admin = db.users.find(user => user.id === id && user.role === "admin" && user.createdBy === session.userId);
    if (!admin) {
      sendJson(res, 404, { error: "Admin bulunamadi." });
      return;
    }
    const memberIds = new Set(db.users.filter(user => user.role === "member" && user.ownerId === admin.id).map(user => user.id));
    db.users = db.users.filter(user => user.id !== admin.id && user.ownerId !== admin.id);
    db.rows = db.rows.filter(row => row.ownerId !== admin.id);
    db.uploads = db.uploads.filter(upload => upload.ownerId !== admin.id);
    db.uploadReports = (db.uploadReports || []).filter(report => report.ownerId !== admin.id);
    db.messages = (db.messages || []).filter(message => message.ownerId !== admin.id);
    db.auditLogs = (db.auditLogs || []).filter(log => log.ownerId !== admin.id && log.actorId !== admin.id && !memberIds.has(log.actorId));
    db.feedbacks = (db.feedbacks || []).filter(feedback => feedback.senderId !== admin.id && !memberIds.has(feedback.senderId));
    db.payments = (db.payments || []).filter(payment => payment.ownerId !== admin.id && !memberIds.has(payment.memberId));
    for (const [sid, activeSession] of sessions.entries()) {
      if (activeSession.userId === admin.id || memberIds.has(activeSession.userId)) sessions.delete(sid);
    }
    addAuditLog(db, session.userId, db.users.find(user => user.id === session.userId), "Admin silindi", `${admin.name || admin.username} admin hesabi ve bagli kayitlari silindi`);
    writeDb(db);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/dashboard") {
    const session = requireAuth(req, res);
    if (!session) return;
    const user = db.users.find(item => item.id === session.userId);
    const staffOwnerId = isStaff(user) ? user.id : user.ownerId;
    const visibleUploads = uploadsByType(db, staffOwnerId, "weekly");
    const dailyUploads = uploadsByType(db, staffOwnerId, "daily");
    const portalLists = (db.portalLists || []).filter(list => list.ownerId === staffOwnerId);
    const currentPortalList = latestPortalList(db, staffOwnerId);
    const currentPortalSet = portalNumberSet(db, staffOwnerId);
    const latestUpload = visibleUploads[visibleUploads.length - 1];
    const latestDailyUpload = dailyUploads[dailyUploads.length - 1];
    const uploadId = url.searchParams.get("uploadId") || latestUpload?.id || "all";
    const dailyUploadId = url.searchParams.get("dailyUploadId") || latestDailyUpload?.id || "";
    const uploads = visibleUploads.slice().reverse();
    if (isStaff(user)) {
      const members = db.users.filter(item => item.role === "member" && item.ownerId === user.id).map(member => {
        const summary = memberSummary(db, member, uploadId);
        const publicMember = publicUser(member);
        publicMember.numberRecords = withPortalStatus(publicMember.numberRecords, currentPortalSet);
        return {
          ...publicMember,
          numberCount: publicMember.numberRecords.length,
          total: summary.total,
          calculated: summary.calculated,
          rowCount: summary.rows.length
        };
      });
      const dailyMembers = db.users.filter(item => item.role === "member" && item.ownerId === user.id).map(member => {
        const summary = dailyUploadId ? memberSummary(db, member, dailyUploadId) : { total: 0, calculated: 0, rows: [] };
        const publicMember = publicUser(member);
        publicMember.numberRecords = withPortalStatus(publicMember.numberRecords, currentPortalSet);
        return {
          ...publicMember,
          numberCount: publicMember.numberRecords.length,
          dailyTotal: summary.total,
          dailyCalculated: summary.calculated,
          dailyRowCount: summary.rows.length
        };
      });
      const messages = db.messages
        .filter(message => message.ownerId === user.id)
        .slice()
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
        .slice(0, 30)
        .map(message => publicMessageForAdmin(db, message));
      const unmatchedNumbers = combinedUnmatchedNumberSummary(db, [uploadId, dailyUploadId], user.id);
      const passiveNumbers = passiveNumberSummary(db, uploadId, user.id);
      const sharedNumbers = sharedNumberSummary(db, uploadId, user.id);
      const uploadReports = (db.uploadReports || [])
        .filter(report => report.ownerId === user.id)
        .slice()
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
        .slice(0, 20)
        .map(publicUploadReport);
      const auditLogs = (db.auditLogs || [])
        .filter(log => log.ownerId === user.id)
        .slice()
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
        .slice(0, 60)
        .map(publicAuditLog);
      const ownerPayments = (db.payments || [])
        .filter(payment => payment.ownerId === user.id)
        .slice()
        .sort((a, b) => String(b.paymentDate || b.createdAt).localeCompare(String(a.paymentDate || a.createdAt)));
      const payments = ownerPayments
        .slice(0, 120)
        .map(payment => publicPayment(db, payment));
      const selectedPayments = ownerPayments.filter(payment => payment.uploadId === uploadId);
      const payload = { role: user.role, currentAdmin: publicUser(user), summary: adminSummary(db, uploadId, user.id), overview: adminOverview(db, uploadId, user.id, [uploadId, dailyUploadId]), backups: listBackups().slice(0, 10), members, dailyMembers, uploads, dailyUploads: dailyUploads.slice().reverse(), portalLists: portalLists.slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).map(publicPortalList), currentPortalList: currentPortalList ? publicPortalList(currentPortalList) : null, messages, unmatchedNumbers, passiveNumbers, sharedNumbers, uploadReports, auditLogs, payments, paymentSummary: paymentSummary(selectedPayments), selectedUploadId: uploadId, selectedDailyUploadId: dailyUploadId };
      if (user.role === "owner") {
        payload.admins = db.users.filter(item => item.role === "admin" && item.createdBy === user.id).map(publicAdmin);
        payload.feedbacks = db.feedbacks
          .slice()
          .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
          .slice(0, 80)
          .map(publicFeedback);
      }
      sendJson(res, 200, payload);
      return;
    }
    const summary = memberPrivateSummary(memberSummary(db, user, uploadId));
    const publicMember = publicUser(user);
    publicMember.numberRecords = withPortalStatus(publicMember.numberRecords, currentPortalSet);
    sendJson(res, 200, {
      role: "member",
      member: publicMember,
      total: summary.total,
      calculated: summary.calculated,
      percentage: Number(user.percentage) || 0,
      rows: summary.rows,
      numberSummaries: summary.numberSummaries,
      dailySummaries: memberDailySummaries(db, user, user.ownerId),
      passiveNumbers: passiveNumberSummary(db, uploadId, user.ownerId).filter(item => item.memberId === user.id),
      messages: db.messages
        .filter(message => message.ownerId === user.ownerId && message.recipientIds.includes(user.id))
        .slice()
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
        .slice(0, 30)
        .map(message => publicMessageForMember(message, user.id)),
      uploads,
      dailyUploads: dailyUploads.slice().reverse(),
      currentPortalList: currentPortalList ? publicPortalList(currentPortalList) : null,
      selectedUploadId: uploadId,
      selectedDailyUploadId: dailyUploadId
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/backups") {
    const session = requireStaff(req, res);
    if (!session) return;
    const actor = db.users.find(item => item.id === session.userId);
    const backup = createBackupFile(db, "manuel", actor?.username || "admin");
    addAuditLog(db, session.userId, actor, "Yedek alindi", `${backup.filename} dosyasi olusturuldu`);
    writeDb(db);
    sendJson(res, 200, { ok: true, backup, backups: listBackups().slice(0, 10) });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/backups/download") {
    const session = requireStaff(req, res);
    if (!session) return;
    const filename = path.basename(String(url.searchParams.get("file") || ""));
    const filePath = path.join(BACKUP_DIR, filename);
    if (!filename.endsWith(".json.gz") || !filePath.startsWith(BACKUP_DIR) || !fs.existsSync(filePath)) {
      sendJson(res, 404, { error: "Yedek bulunamadi." });
      return;
    }
    res.writeHead(200, {
      "Content-Type": "application/gzip",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store"
    });
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/members") {
    const session = requireStaff(req, res);
    if (!session) return;
    const body = JSON.parse((await readBody(req, 1024 * 50)).toString("utf8"));
    const username = String(body.username || "").trim();
    const password = String(body.password || "");
    const percentage = Number(body.percentage);
    if (!username || password.length < 6 || !String(body.name || "").trim() || !normalizeGsm(body.gsmMasked)) {
      sendJson(res, 400, { error: "Ad, kullanıcı adı, en az 6 haneli şifre ve GSM gerekli." });
      return;
    }
    if (!Number.isFinite(percentage) || percentage < 0 || percentage > 100) {
      sendJson(res, 400, { error: "Yüzde 0 ile 100 arasında olmalı." });
      return;
    }
    if (db.users.some(user => user.username === username)) {
      sendJson(res, 400, { error: "Bu kullanıcı adı zaten var." });
      return;
    }
    const initialGsm = normalizeGsm(body.gsmMasked);
    if (!sharedNumbersEnabledForOwner(db, session.userId)) {
      const numberOwner = findNumberOwner(db, session.userId, initialGsm);
      if (numberOwner) {
        sendJson(res, 400, { error: duplicateNumberMessage(numberOwner) });
        return;
      }
    }
    const actor = db.users.find(item => item.id === session.userId);
    const member = {
      id: crypto.randomUUID(),
      role: "member",
      username,
      name: String(body.name).trim(),
      gsmMasked: initialGsm,
      percentage,
      ownerId: session.userId,
      passwordHash: hashPassword(password),
      createdAt: new Date().toISOString()
    };
    db.users.push(member);
    addAuditLog(db, session.userId, actor, "Tipster olusturuldu", `${member.name} (${username}) tipster hesabi acildi`, {
      memberId: member.id,
      memberName: member.name,
      memberUsername: member.username
    });
    writeDb(db);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/messages") {
    const session = requireStaff(req, res);
    if (!session) return;
    const body = JSON.parse((await readBody(req, 1024 * 80)).toString("utf8"));
    const user = db.users.find(item => item.id === session.userId && isStaff(item));
    const title = String(body.title || "").trim().slice(0, 90);
    const messageBody = String(body.body || "").trim().slice(0, 1200);
    const targetType = body.targetType === "all" ? "all" : "selected";
    const ownMembers = db.users.filter(item => item.role === "member" && item.ownerId === session.userId);
    const requestedIds = Array.isArray(body.recipientIds) ? body.recipientIds.map(String) : [];
    const recipientIds = targetType === "all"
      ? ownMembers.map(member => member.id)
      : ownMembers.filter(member => requestedIds.includes(member.id)).map(member => member.id);
    if (!title || !messageBody) {
      sendJson(res, 400, { error: "Baslik ve mesaj gerekli." });
      return;
    }
    if (!recipientIds.length) {
      sendJson(res, 400, { error: "En az bir tipster secin." });
      return;
    }
    const message = {
      id: crypto.randomUUID(),
      ownerId: session.userId,
      senderId: session.userId,
      senderName: user?.name || user?.username || "Admin",
      targetType,
      recipientIds,
      title,
      body: messageBody,
      readBy: {},
      createdAt: new Date().toISOString()
    };
    db.messages.push(message);
    addAuditLog(db, session.userId, user, "Tipsterlara mesaj gonderildi", `${recipientIds.length} tipstera mesaj gonderildi: ${title}`);
    writeDb(db);
    sendJson(res, 200, { ok: true, message: publicMessageForAdmin(db, message) });
    return;
  }

  if (req.method === "POST" && (url.pathname === "/api/unmatched-numbers/assign-admin" || url.pathname === "/api/unmatched-numbers/assign-yilmaz")) {
    const session = requireStaff(req, res);
    if (!session) return;
    const body = JSON.parse((await readBody(req, 1024 * 20)).toString("utf8"));
    const uploadId = String(body.uploadId || "all");
    const dailyUploadId = String(body.dailyUploadId || "");
    const admin = db.users.find(user => user.id === session.userId && isStaff(user));
    if (!admin) {
      sendJson(res, 404, { error: "Admin bulunamadi." });
      return;
    }
    const existing = new Set(getUserGsms(admin));
    const unmatched = combinedUnmatchedNumberSummary(db, [uploadId, dailyUploadId], session.userId);
    const records = getUserNumberRecords(admin);
    let addedCount = 0;
    unmatched.forEach(item => {
      const number = normalizeGsm(item.number);
      if (!number || existing.has(number)) return;
      records.push({ number, name: "", createdAt: new Date().toISOString() });
      existing.add(number);
      addedCount += 1;
    });
    admin.numberRecords = records;
    admin.gsmMasked = records[0]?.number || admin.gsmMasked || "";
    admin.gsmName = records[0]?.name || admin.gsmName || "";
    admin.gsmList = records.slice(1).map(record => record.name || record.createdAt ? { number: record.number, name: record.name, createdAt: record.createdAt } : record.number);
    addAuditLog(db, session.userId, admin, "Tipstersiz numaralar admin kaydina aktarildi", `${addedCount} tipstersiz numara admin kaydina eklendi`);
    writeDb(db);
    sendJson(res, 200, { ok: true, addedCount, admin: publicUser(admin) });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/payments") {
    const session = requireStaff(req, res);
    if (!session) return;
    const body = JSON.parse((await readBody(req, 1024 * 20)).toString("utf8"));
    const admin = db.users.find(user => user.id === session.userId && isStaff(user));
    const member = db.users.find(user => user.id === String(body.memberId || "") && user.role === "member" && user.ownerId === session.userId);
    const uploadId = String(body.uploadId || "");
    const upload = db.uploads.find(item => item.id === uploadId && item.ownerId === session.userId && (item.uploadType || "weekly") === "weekly");
    const paidAmount = numberFrom(body.paidAmount);
    const paymentDate = validDateOnly(String(body.paymentDate || "")) ? String(body.paymentDate) : dateOnly(new Date());
    const note = String(body.note || "").trim().slice(0, 240);
    if (!admin || !member) {
      sendJson(res, 404, { error: "Tipster bulunamadi." });
      return;
    }
    if (!upload) {
      sendJson(res, 400, { error: "Haftalik Excel secimi gerekli." });
      return;
    }
    if (paidAmount <= 0) {
      sendJson(res, 400, { error: "Odenen tutar 0'dan buyuk olmali." });
      return;
    }
    const calculatedAmount = memberSummary(db, member, uploadId).calculated;
    const payment = {
      id: crypto.randomUUID(),
      ownerId: session.userId,
      memberId: member.id,
      memberName: member.name || member.username,
      memberUsername: member.username,
      uploadId,
      weekLabel: upload.weekLabel || upload.filename || "Hafta",
      calculatedAmount,
      paidAmount,
      paymentDate,
      note,
      createdAt: new Date().toISOString()
    };
    db.payments ||= [];
    db.payments.push(payment);
    addAuditLog(db, session.userId, admin, "Haftalik odeme kaydi eklendi", `${member.name || member.username} icin ${payment.weekLabel} odemesi: ${paidAmount}`, {
      memberId: member.id,
      memberName: member.name || member.username,
      memberUsername: member.username
    });
    writeDb(db);
    sendJson(res, 200, { ok: true, payment: publicPayment(db, payment) });
    return;
  }

  if (req.method === "DELETE" && url.pathname.startsWith("/api/payments/")) {
    const session = requireStaff(req, res);
    if (!session) return;
    const id = decodeURIComponent(url.pathname.split("/").pop() || "");
    const payment = (db.payments || []).find(item => item.id === id && item.ownerId === session.userId);
    if (!payment) {
      sendJson(res, 404, { error: "Odeme kaydi bulunamadi." });
      return;
    }
    db.payments = (db.payments || []).filter(item => item.id !== id);
    addAuditLog(db, session.userId, db.users.find(user => user.id === session.userId), "Haftalik odeme kaydi silindi", `${payment.memberName || payment.memberUsername || "Tipster"} icin ${payment.weekLabel || "hafta"} odeme kaydi silindi`, {
      memberId: payment.memberId,
      memberName: payment.memberName,
      memberUsername: payment.memberUsername
    });
    writeDb(db);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/feedbacks") {
    const session = requireAuth(req, res);
    if (!session) return;
    const body = JSON.parse((await readBody(req, 1024 * 40)).toString("utf8"));
    const user = db.users.find(item => item.id === session.userId);
    const type = body.type === "complaint" ? "complaint" : "suggestion";
    const title = String(body.title || "").trim().slice(0, 90);
    const feedbackBody = String(body.body || "").trim().slice(0, 1200);
    if (!user) {
      sendJson(res, 401, { error: "Oturum bulunamadi." });
      return;
    }
    if (!title || !feedbackBody) {
      sendJson(res, 400, { error: "Baslik ve mesaj gerekli." });
      return;
    }
    db.feedbacks.push({
      id: crypto.randomUUID(),
      ownerId: db.users.find(item => item.role === "owner")?.id || "",
      senderId: user.id,
      senderName: user.name || user.username,
      senderUsername: user.username,
      senderRole: user.role,
      type,
      title,
      body: feedbackBody,
      status: "new",
      createdAt: new Date().toISOString()
    });
    writeDb(db);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && url.pathname.startsWith("/api/messages/") && url.pathname.endsWith("/read")) {
    const session = requireAuth(req, res, "member");
    if (!session) return;
    const id = url.pathname.split("/")[3];
    const user = db.users.find(item => item.id === session.userId && item.role === "member");
    const message = db.messages.find(item => item.id === id && item.ownerId === user?.ownerId && item.recipientIds.includes(session.userId));
    if (!message) {
      sendJson(res, 404, { error: "Mesaj bulunamadi." });
      return;
    }
    message.readBy ||= {};
    if (!message.readBy[session.userId]) message.readBy[session.userId] = new Date().toISOString();
    writeDb(db);
    sendJson(res, 200, { ok: true, message: publicMessageForMember(message, session.userId) });
    return;
  }

  if (req.method === "GET" && url.pathname.startsWith("/api/members/") && url.pathname.endsWith("/details")) {
    const session = requireStaff(req, res);
    if (!session) return;
    const id = url.pathname.split("/")[3];
    const member = db.users.find(user => user.id === id && user.role === "member" && user.ownerId === session.userId);
    if (!member) {
      sendJson(res, 404, { error: "Tipster bulunamadi." });
      return;
    }
    const visibleUploads = uploadsByType(db, session.userId, "weekly");
    const latestUpload = visibleUploads[visibleUploads.length - 1];
    const uploadId = url.searchParams.get("uploadId") || latestUpload?.id || "all";
    const summary = memberSummary(db, member, uploadId);
    const publicMember = publicUser(member);
    publicMember.numberRecords = withPortalStatus(publicMember.numberRecords, portalNumberSet(db, session.userId));
    sendJson(res, 200, {
      member: publicMember,
      total: summary.total,
      calculated: summary.calculated,
      percentage: Number(member.percentage) || 0,
      rows: summary.rows,
      numberSummaries: summary.numberSummaries,
      dailySummaries: memberDailySummaries(db, member, session.userId),
      uploads: visibleUploads.slice().reverse(),
      selectedUploadId: uploadId
    });
    return;
  }

  if (req.method === "PATCH" && url.pathname.startsWith("/api/members/")) {
    const session = requireStaff(req, res);
    if (!session) return;
    const id = url.pathname.split("/").pop();
    const member = db.users.find(user => user.id === id && user.role === "member" && user.ownerId === session.userId);
    if (!member) {
      sendJson(res, 404, { error: "Tipster bulunamadi." });
      return;
    }
    const body = JSON.parse((await readBody(req, 1024 * 50)).toString("utf8"));
    const percentage = Number(body.percentage);
    if (body.percentage !== undefined) {
      if (!Number.isFinite(percentage) || percentage < 0 || percentage > 100) {
        sendJson(res, 400, { error: "Yuzde 0 ile 100 arasinda olmali." });
        return;
      }
      member.percentage = percentage;
    }
    if (body.name !== undefined && String(body.name).trim()) member.name = String(body.name).trim();
    if (body.gsmMasked !== undefined && normalizeGsm(body.gsmMasked)) {
      const nextGsm = normalizeGsm(body.gsmMasked);
      if (!sharedNumbersEnabledForOwner(db, session.userId)) {
        const numberOwner = findNumberOwner(db, session.userId, nextGsm, member.id);
        if (numberOwner) {
          sendJson(res, 400, { error: duplicateNumberMessage(numberOwner) });
          return;
        }
      }
      const records = getUserNumberRecords(member);
      if (records.length) {
        records[0].number = nextGsm;
        member.numberRecords = records;
        member.gsmMasked = nextGsm;
        member.gsmName = records[0].name || "";
        records[0].createdAt ||= new Date().toISOString();
        member.gsmList = records.slice(1).map(record => record.name || record.createdAt ? { number: record.number, name: record.name, createdAt: record.createdAt } : record.number);
      } else {
        member.gsmMasked = nextGsm;
        member.numberRecords = [{ number: nextGsm, name: "", createdAt: new Date().toISOString() }];
      }
    }
    if (body.password) {
      const password = String(body.password);
      if (password.length < 6) {
        sendJson(res, 400, { error: "Tipster sifresi en az 6 karakter olmali." });
        return;
      }
      member.passwordHash = hashPassword(password);
    }
    addAuditLog(db, session.userId, db.users.find(item => item.id === session.userId), "Tipster bilgisi guncellendi", `${member.name || member.username} tipster kaydi guncellendi`, {
      memberId: member.id,
      memberName: member.name || member.username,
      memberUsername: member.username
    });
    writeDb(db);
    sendJson(res, 200, { ok: true, member: publicUser(member) });
    return;
  }

  if (req.method === "DELETE" && url.pathname.startsWith("/api/members/")) {
    const session = requireStaff(req, res);
    if (!session) return;
    const id = url.pathname.split("/").pop();
    const deletedMember = db.users.find(user => user.id === id && user.role === "member" && user.ownerId === session.userId);
    const before = db.users.length;
    db.users = db.users.filter(user => user.id !== id || user.role !== "member" || user.ownerId !== session.userId);
    if (db.users.length === before) {
      sendJson(res, 404, { error: "Üye bulunamadı." });
      return;
    }
    addAuditLog(db, session.userId, db.users.find(item => item.id === session.userId), "Tipster silindi", `${deletedMember?.name || deletedMember?.username || "Tipster"} silindi`, {
      memberId: deletedMember?.id || "",
      memberName: deletedMember?.name || deletedMember?.username || "Tipster",
      memberUsername: deletedMember?.username || ""
    });
    writeDb(db);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/my-numbers") {
    const session = requireAuth(req, res, "member");
    if (!session) return;
    const body = JSON.parse((await readBody(req, 1024 * 20)).toString("utf8"));
    const gsm = normalizeGsm(body.gsmMasked);
    const name = normalizeNumberName(body.name);
    if (!gsm) {
      sendJson(res, 400, { error: "Numara gerekli." });
      return;
    }
    if (!/^05\d{2}\*{3}\d{4}$/.test(gsm)) {
      sendJson(res, 400, { error: "Numara Excel formatında olmalı. Örnek: 0505***0794" });
      return;
    }
    const user = db.users.find(item => item.id === session.userId);
    const existing = getUserGsms(user);
    if (existing.includes(gsm)) {
      sendJson(res, 400, { error: "Bu numara zaten kayıtlı." });
      return;
    }
    if (!sharedNumbersEnabledForOwner(db, user.ownerId)) {
      const numberOwner = findNumberOwner(db, user.ownerId, gsm, user.id);
      if (numberOwner) {
        sendJson(res, 400, { error: duplicateNumberMessage(numberOwner) });
        return;
      }
    }
    const records = [...getUserNumberRecords(user), { number: gsm, name, createdAt: new Date().toISOString() }];
    user.numberRecords = records;
    user.gsmMasked = records[0]?.number || "";
    user.gsmName = records[0]?.name || "";
    user.gsmList = records.slice(1).map(record => record.name || record.createdAt ? { number: record.number, name: record.name, createdAt: record.createdAt } : record.number);
    addAuditLog(db, user.ownerId, user, "Numara eklendi", `${name || "Isimsiz"} ${gsm} numarasi eklendi`);
    writeDb(db);
    sendJson(res, 200, { ok: true, numbers: getUserGsms(user), numberRecords: getUserNumberRecords(user) });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/my-numbers/export") {
    const session = requireAuth(req, res, "member");
    if (!session) return;
    const user = db.users.find(item => item.id === session.userId);
    const visibleUploads = db.uploads.filter(upload => upload.ownerId === user.ownerId);
    const latestUpload = visibleUploads[visibleUploads.length - 1];
    const uploadId = url.searchParams.get("uploadId") || latestUpload?.id || "all";
    const summary = memberSummary(db, user, uploadId);
    const buffer = createNumbersXlsx(user, summary.numberSummaries);
    const filename = encodeURIComponent(`${user.username || "tipster"}-numaralar.xlsx`);
    res.writeHead(200, {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename*=UTF-8''${filename}`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store"
    });
    res.end(buffer);
    return;
  }

  if (req.method === "DELETE" && url.pathname.startsWith("/api/my-numbers/")) {
    const session = requireAuth(req, res, "member");
    if (!session) return;
    const gsm = normalizeGsm(decodeURIComponent(url.pathname.split("/").pop()));
    const user = db.users.find(item => item.id === session.userId);
    const oldRecords = getUserNumberRecords(user);
    const records = oldRecords.filter(item => item.number !== gsm);
    if (records.length === oldRecords.length) {
      sendJson(res, 404, { error: "Numara bulunamadi." });
      return;
    }
    user.numberRecords = records;
    user.gsmMasked = records[0]?.number || "";
    user.gsmName = records[0]?.name || "";
    user.gsmList = records.slice(1).map(record => record.name || record.createdAt ? { number: record.number, name: record.name, createdAt: record.createdAt } : record.number);
    addAuditLog(db, user.ownerId, user, "Numara silindi", `${gsm} numarasi silindi`);
    writeDb(db);
    sendJson(res, 200, { ok: true, numbers: getUserGsms(user), numberRecords: getUserNumberRecords(user) });
    return;
  }

  if (req.method === "DELETE" && url.pathname.startsWith("/api/my-numbers-legacy/")) {
    const session = requireAuth(req, res, "member");
    if (!session) return;
    const gsm = normalizeGsm(decodeURIComponent(url.pathname.split("/").pop()));
    const user = db.users.find(item => item.id === session.userId);
    const numbers = getUserGsms(user).filter(item => item !== gsm);
    if (numbers.length === getUserGsms(user).length) {
      sendJson(res, 404, { error: "Numara bulunamadı." });
      return;
    }
    user.gsmMasked = numbers[0] || "";
    user.gsmList = numbers.slice(1);
    addAuditLog(db, user.ownerId, user, "Numara silindi", `${gsm} numarasi silindi`);
    writeDb(db);
    sendJson(res, 200, { ok: true, numbers });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/portal-list") {
    const session = requireStaff(req, res);
    if (!session) return;
    const parts = parseMultipart(await readBody(req), req.headers["content-type"]);
    const file = parts.find(part => part.name === "excel" && part.filename);
    const weekPart = parts.find(part => part.name === "weekLabel");
    if (!file || !file.filename.toLowerCase().endsWith(".xlsx")) {
      sendJson(res, 400, { error: "Lutfen Bayi Portal telefon listesini .xlsx olarak yukle." });
      return;
    }
    const numbers = parsePortalNumberExcel(file.data);
    const fileBase = file.filename.replace(/\.xlsx$/i, "");
    const weekLabel = String(weekPart?.data?.toString("utf8") || "").trim() || fileBase;
    const portalList = {
      id: crypto.randomUUID(),
      ownerId: session.userId,
      filename: escapeHtml(file.filename),
      weekLabel: escapeHtml(weekLabel),
      numbers,
      rowCount: numbers.length,
      createdAt: new Date().toISOString()
    };
    db.portalLists ||= [];
    db.portalLists.push(portalList);
    addAuditLog(db, session.userId, db.users.find(item => item.id === session.userId), "Bayi Portal listesi yuklendi", `${portalList.weekLabel} icin ${numbers.length} numara aktarildi`);
    writeDb(db);
    sendJson(res, 200, { ok: true, portalList: publicPortalList(portalList) });
    return;
  }

  if (req.method === "DELETE" && url.pathname.startsWith("/api/portal-lists/")) {
    const session = requireStaff(req, res);
    if (!session) return;
    const id = decodeURIComponent(url.pathname.split("/").pop() || "");
    const portalList = (db.portalLists || []).find(item => item.id === id && item.ownerId === session.userId);
    if (!portalList) {
      sendJson(res, 404, { error: "Bayi Portal listesi bulunamadi." });
      return;
    }
    db.portalLists = (db.portalLists || []).filter(item => item.id !== id || item.ownerId !== session.userId);
    addAuditLog(db, session.userId, db.users.find(item => item.id === session.userId), "Bayi Portal listesi silindi", `${portalList.weekLabel || portalList.filename} listesi silindi`);
    writeDb(db);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/upload") {
    const session = requireStaff(req, res);
    if (!session) return;
    const parts = parseMultipart(await readBody(req), req.headers["content-type"]);
    const files = parts.filter(part => part.name === "excel" && part.filename);
    const weekPart = parts.find(part => part.name === "weekLabel");
    const typePart = parts.find(part => part.name === "uploadType");
    const datePart = parts.find(part => part.name === "uploadDate");
    if (!files.length || files.some(file => !file.filename.toLowerCase().endsWith(".xlsx"))) {
      sendJson(res, 400, { error: "Lutfen .xlsx Excel dosyasi yukle." });
      return;
    }
    const baseWeekLabel = String(weekPart?.data?.toString("utf8") || "").trim();
    const uploadType = String(typePart?.data?.toString("utf8") || "weekly").trim() === "daily" ? "daily" : "weekly";
    const uploadDate = validDateOnly(String(datePart?.data?.toString("utf8") || "").trim())
      ? String(datePart.data.toString("utf8")).trim()
      : dateOnly(new Date());
    const imported = files.map(file => {
      const uploadId = crypto.randomUUID();
      const fileUploadDate = uploadType === "daily" ? uploadDateFromFilename(file.filename, uploadDate) : uploadDate;
      const rows = parseExcel(file.data, { uploadType, uploadDate: fileUploadDate }).map(row => ({ ...row, uploadId, ownerId: session.userId }));
      const fileBase = file.filename.replace(/\.xlsx$/i, "");
      const weekLabel = files.length === 1
        ? (baseWeekLabel || (uploadType === "daily" ? `Gunluk ${fileUploadDate}` : fileBase))
        : (baseWeekLabel ? baseWeekLabel + " - " + fileBase : (uploadType === "daily" ? `Gunluk ${fileUploadDate} - ${fileBase}` : fileBase));
      db.rows.push(...rows);
      const upload = {
        id: uploadId,
        filename: escapeHtml(file.filename),
        weekLabel: escapeHtml(weekLabel),
        uploadType,
        uploadDate: fileUploadDate,
        rowCount: rows.length,
        ownerId: session.userId,
        createdAt: new Date().toISOString()
      };
      db.uploads.push(upload);
      db.uploadReports ||= [];
      db.uploadReports.push(createUploadReport(db, upload, session.userId));
      return { uploadId, rowCount: rows.length, filename: file.filename, weekLabel };
    });
    addAuditLog(db, session.userId, db.users.find(item => item.id === session.userId), uploadType === "daily" ? "Gunluk Excel yuklendi" : "Haftalik Excel yuklendi", `${imported.length} Excel aktarildi, ${imported.reduce((sum, item) => sum + item.rowCount, 0)} Bonus Disi Kupon Oynama satiri islendi`);
    writeDb(db);
    const last = imported[imported.length - 1];
    sendJson(res, 200, {
      ok: true,
      rowCount: imported.reduce((sum, item) => sum + item.rowCount, 0),
      uploadId: last.uploadId,
      uploadType,
      uploads: imported
    });
    return;
  }
  if (req.method === "DELETE" && url.pathname.startsWith("/api/uploads/")) {
    const session = requireStaff(req, res);
    if (!session) return;
    const uploadId = decodeURIComponent(url.pathname.split("/").pop() || "");
    const upload = db.uploads.find(item => item.id === uploadId && item.ownerId === session.userId);
    if (!upload) {
      sendJson(res, 404, { error: "Excel kaydi bulunamadi." });
      return;
    }
    db.rows = db.rows.filter(row => row.uploadId !== uploadId || row.ownerId !== session.userId);
    db.uploads = db.uploads.filter(item => item.id !== uploadId || item.ownerId !== session.userId);
    db.uploadReports = (db.uploadReports || []).filter(report => report.uploadId !== uploadId || report.ownerId !== session.userId);
    addAuditLog(
      db,
      session.userId,
      db.users.find(item => item.id === session.userId),
      upload.uploadType === "daily" ? "Gunluk Excel silindi" : "Haftalik Excel silindi",
      `${upload.weekLabel || upload.filename} Excel kaydi silindi`
    );
    writeDb(db);
    sendJson(res, 200, { ok: true });
    return;
  }
  if (req.method === "DELETE" && url.pathname === "/api/uploads") {
    const session = requireStaff(req, res);
    if (!session) return;
    db.rows = db.rows.filter(row => row.ownerId !== session.userId);
    db.uploads = db.uploads.filter(upload => upload.ownerId !== session.userId);
    db.uploadReports = (db.uploadReports || []).filter(report => report.ownerId !== session.userId);
    addAuditLog(db, session.userId, db.users.find(item => item.id === session.userId), "Excel kayitlari temizlendi", "Tum Excel kayitlari temizlendi");
    writeDb(db);
    sendJson(res, 200, { ok: true });
    return;
  }

  sendJson(res, 404, { error: "Adres bulunamadı." });
}

const server = http.createServer((req, res) => {
  if (req.url.startsWith("/api/")) {
    handleApi(req, res).catch(error => sendJson(res, 500, { error: error.message || "Bir hata oluştu." }));
    return;
  }
  serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`Üye sistemi hazır: http://localhost:${PORT}`);
});
