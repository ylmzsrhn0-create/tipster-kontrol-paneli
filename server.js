const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const zlib = require("zlib");

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, "public");
const DATA = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, "data");
const DB_FILE = path.join(DATA, "database.json");
const PORT = Number(process.env.PORT || 3000);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "1234";
const TRUST_PROXY = process.env.TRUST_PROXY === "1";
const SESSION_TTL_MS = 1000 * 60 * 60 * 8;

fs.mkdirSync(DATA, { recursive: true });

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
        gsmMasked: "",
        percentage: 0,
        passwordHash: hashPassword(ADMIN_PASSWORD),
        createdAt: new Date().toISOString()
      }
    ],
    rows: [],
    uploads: []
  };
}

function readDb() {
  if (!fs.existsSync(DB_FILE)) {
    const db = defaultDb();
    writeDb(db);
    return db;
  }
  return normalizeDb(JSON.parse(fs.readFileSync(DB_FILE, "utf8").replace(/^\uFEFF/, "")));
}

function writeDb(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

function normalizeDb(db) {
  db.users ||= [];
  db.rows ||= [];
  db.uploads ||= [];
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
    if (user.role === "member" && !user.ownerId) user.ownerId = ownerId;
    if (user.role === "admin" && !user.createdBy) user.createdBy = ownerId;
    user.gsmList = getUserGsms(user).slice(user.gsmMasked ? 1 : 0);
  });
  return db;
}

const sessions = new Map();

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
  return {
    id: user.id,
    role: user.role,
    username: user.username,
    name: user.name,
    gsmMasked: user.gsmMasked,
    gsmList,
    percentage: user.percentage,
    ownerId: user.ownerId,
    createdAt: user.createdAt
  };
}

function publicAdmin(user) {
  return {
    id: user.id,
    username: user.username,
    name: user.name,
    role: user.role,
    createdAt: user.createdAt
  };
}

function numberFrom(value) {
  if (typeof value === "number") return value;
  const clean = String(value ?? "").replace(/\./g, "").replace(",", ".").replace(/[^\d.-]/g, "");
  const n = Number(clean);
  return Number.isFinite(n) ? n : 0;
}

function normalizeGsm(value) {
  return String(value ?? "").trim().replace(/\s+/g, "");
}

function getUserGsms(user) {
  return [...new Set([user.gsmMasked, ...(user.gsmList || [])].map(normalizeGsm).filter(Boolean))];
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

function parseExcel(buffer) {
  const entries = zipEntries(buffer);
  const sharedStrings = parseSharedStrings(entries.get("xl/sharedStrings.xml"));
  const { sheetName, target } = parseWorkbook(entries);
  const rows = parseSheetRows(entries.get(target), sharedStrings);
  const headers = rows.shift() || [];
  const gsmIndex = headers.findIndex(h => String(h).trim().toLocaleUpperCase("tr") === "OYUNCU GSM");
  const totalIndex = headers.findIndex(h => String(h).trim().toLocaleUpperCase("tr") === "TOPLAM TUTAR");
  const typeIndex = headers.findIndex(h => String(h).trim().toLocaleUpperCase("tr") === "İŞLEM TİPİ");
  if (gsmIndex === -1 || totalIndex === -1) {
    throw new Error("Excel içinde OYUNCU GSM ve TOPLAM TUTAR başlıkları bulunmalı.");
  }
  return rows
    .filter(row => normalizeGsm(row[gsmIndex]))
    .map(row => ({
      id: crypto.randomUUID(),
      gsmMasked: normalizeGsm(row[gsmIndex]),
      processType: row[typeIndex] || "",
      totalAmount: numberFrom(row[totalIndex]),
      daily: Object.fromEntries(headers.map((h, i) => [h, numberFrom(row[i])]).filter(([h]) => /^\d{2}\.\d{2}\.\d{4}$/.test(String(h)))),
      sheetName,
      importedAt: new Date().toISOString()
    }));
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
  const rows = ownerId ? db.rows.filter(row => row.ownerId === ownerId) : db.rows;
  if (!uploadId || uploadId === "all") return rows;
  return rows.filter(row => row.uploadId === uploadId);
}

function memberSummary(db, user, uploadId) {
  const ownerId = user.role === "member" ? user.ownerId : user.id;
  const numbers = getUserGsms(user);
  const gsmSet = new Set(numbers);
  const sourceRows = selectedRows(db, uploadId, ownerId);
  const rows = sourceRows.filter(row => gsmSet.has(row.gsmMasked));
  const total = rows.reduce((sum, row) => sum + row.totalAmount, 0);
  const calculated = total * (Number(user.percentage) || 0) / 100;
  const numberSummaries = numbers.map(number => {
    const numberRows = sourceRows.filter(row => row.gsmMasked === number);
    const numberTotal = numberRows.reduce((sum, row) => sum + row.totalAmount, 0);
    return {
      number,
      rowCount: numberRows.length,
      total: numberTotal,
      calculated: numberTotal * (Number(user.percentage) || 0) / 100
    };
  });
  return { rows, total, calculated, numberSummaries };
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

function serveStatic(req, res) {
  const requested = req.url === "/" ? "/index.html" : decodeURIComponent(req.url.split("?")[0]);
  const filePath = path.normalize(path.join(PUBLIC, requested));
  if (!filePath.startsWith(PUBLIC)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    const ext = path.extname(filePath);
    const type = ext === ".css" ? "text/css" : ext === ".js" ? "text/javascript" : "text/html";
    res.writeHead(200, {
      "Content-Type": `${type}; charset=utf-8`,
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
    const user = db.users.find(item => item.username === body.username);
    if (!user || !verifyPassword(body.password, user.passwordHash)) {
      sendJson(res, 401, { error: "Kullanıcı adı veya şifre hatalı." });
      return;
    }
    const csrf = setSession(res, user);
    sendJson(res, 200, { csrf, user: publicUser(user) });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/logout") {
    clearSession(req, res);
    sendJson(res, 200, { ok: true });
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
    if (!name || !username || password.length < 8) {
      sendJson(res, 400, { error: "Ad, kullanici adi ve en az 8 haneli sifre gerekli." });
      return;
    }
    if (db.users.some(user => user.username === username)) {
      sendJson(res, 400, { error: "Bu kullanici adi zaten var." });
      return;
    }
    const admin = {
      id: crypto.randomUUID(),
      role: "admin",
      username,
      name,
      gsmMasked: "",
      percentage: 0,
      passwordHash: hashPassword(password),
      createdBy: session.userId,
      createdAt: new Date().toISOString()
    };
    db.users.push(admin);
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
    writeDb(db);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/dashboard") {
    const session = requireAuth(req, res);
    if (!session) return;
    const user = db.users.find(item => item.id === session.userId);
    const staffOwnerId = isStaff(user) ? user.id : user.ownerId;
    const visibleUploads = db.uploads.filter(upload => upload.ownerId === staffOwnerId);
    const latestUpload = visibleUploads[visibleUploads.length - 1];
    const uploadId = url.searchParams.get("uploadId") || latestUpload?.id || "all";
    const uploads = visibleUploads.slice().reverse();
    if (isStaff(user)) {
      const members = db.users.filter(item => item.role === "member" && item.ownerId === user.id).map(member => {
        const summary = memberSummary(db, member, uploadId);
        return { ...publicUser(member), total: summary.total, calculated: summary.calculated, rowCount: summary.rows.length };
      });
      const payload = { role: user.role, summary: adminSummary(db, uploadId, user.id), members, uploads, selectedUploadId: uploadId };
      if (user.role === "owner") {
        payload.admins = db.users.filter(item => item.role === "admin" && item.createdBy === user.id).map(publicAdmin);
      }
      sendJson(res, 200, payload);
      return;
    }
    const summary = memberSummary(db, user, uploadId);
    sendJson(res, 200, {
      role: "member",
      member: publicUser(user),
      total: summary.total,
      calculated: summary.calculated,
      percentage: Number(user.percentage) || 0,
      rows: summary.rows,
      numberSummaries: summary.numberSummaries,
      uploads,
      selectedUploadId: uploadId
    });
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
    db.users.push({
      id: crypto.randomUUID(),
      role: "member",
      username,
      name: String(body.name).trim(),
      gsmMasked: normalizeGsm(body.gsmMasked),
      percentage,
      ownerId: session.userId,
      passwordHash: hashPassword(password),
      createdAt: new Date().toISOString()
    });
    writeDb(db);
    sendJson(res, 200, { ok: true });
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
    const visibleUploads = db.uploads.filter(upload => upload.ownerId === session.userId);
    const latestUpload = visibleUploads[visibleUploads.length - 1];
    const uploadId = url.searchParams.get("uploadId") || latestUpload?.id || "all";
    const summary = memberSummary(db, member, uploadId);
    sendJson(res, 200, {
      member: publicUser(member),
      total: summary.total,
      calculated: summary.calculated,
      percentage: Number(member.percentage) || 0,
      rows: summary.rows,
      numberSummaries: summary.numberSummaries,
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
    if (body.gsmMasked !== undefined && normalizeGsm(body.gsmMasked)) member.gsmMasked = normalizeGsm(body.gsmMasked);
    if (body.password) {
      const password = String(body.password);
      if (password.length < 6) {
        sendJson(res, 400, { error: "Tipster sifresi en az 6 karakter olmali." });
        return;
      }
      member.passwordHash = hashPassword(password);
    }
    writeDb(db);
    sendJson(res, 200, { ok: true, member: publicUser(member) });
    return;
  }

  if (req.method === "DELETE" && url.pathname.startsWith("/api/members/")) {
    const session = requireStaff(req, res);
    if (!session) return;
    const id = url.pathname.split("/").pop();
    const before = db.users.length;
    db.users = db.users.filter(user => user.id !== id || user.role !== "member" || user.ownerId !== session.userId);
    if (db.users.length === before) {
      sendJson(res, 404, { error: "Üye bulunamadı." });
      return;
    }
    writeDb(db);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/my-numbers") {
    const session = requireAuth(req, res, "member");
    if (!session) return;
    const body = JSON.parse((await readBody(req, 1024 * 20)).toString("utf8"));
    const gsm = normalizeGsm(body.gsmMasked);
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
    user.gsmList = [...(user.gsmList || []), gsm];
    if (!user.gsmMasked) user.gsmMasked = gsm;
    writeDb(db);
    sendJson(res, 200, { ok: true, numbers: getUserGsms(user) });
    return;
  }

  if (req.method === "DELETE" && url.pathname.startsWith("/api/my-numbers/")) {
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
    writeDb(db);
    sendJson(res, 200, { ok: true, numbers });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/upload") {
    const session = requireStaff(req, res);
    if (!session) return;
    const parts = parseMultipart(await readBody(req), req.headers["content-type"]);
    const files = parts.filter(part => part.name === "excel" && part.filename);
    const weekPart = parts.find(part => part.name === "weekLabel");
    if (!files.length || files.some(file => !file.filename.toLowerCase().endsWith(".xlsx"))) {
      sendJson(res, 400, { error: "Lutfen .xlsx Excel dosyasi yukle." });
      return;
    }
    const baseWeekLabel = String(weekPart?.data?.toString("utf8") || "").trim();
    const imported = files.map(file => {
      const uploadId = crypto.randomUUID();
      const rows = parseExcel(file.data).map(row => ({ ...row, uploadId, ownerId: session.userId }));
      const fileBase = file.filename.replace(/\.xlsx$/i, "");
      const weekLabel = files.length === 1
        ? (baseWeekLabel || fileBase)
        : (baseWeekLabel ? baseWeekLabel + " - " + fileBase : fileBase);
      db.rows.push(...rows);
      db.uploads.push({
        id: uploadId,
        filename: escapeHtml(file.filename),
        weekLabel: escapeHtml(weekLabel),
        rowCount: rows.length,
        ownerId: session.userId,
        createdAt: new Date().toISOString()
      });
      return { uploadId, rowCount: rows.length, filename: file.filename, weekLabel };
    });
    writeDb(db);
    const last = imported[imported.length - 1];
    sendJson(res, 200, {
      ok: true,
      rowCount: imported.reduce((sum, item) => sum + item.rowCount, 0),
      uploadId: last.uploadId,
      uploads: imported
    });
    return;
  }
  if (req.method === "DELETE" && url.pathname === "/api/uploads") {
    const session = requireStaff(req, res);
    if (!session) return;
    db.rows = db.rows.filter(row => row.ownerId !== session.userId);
    db.uploads = db.uploads.filter(upload => upload.ownerId !== session.userId);
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
