let csrfToken = "";
let currentDashboard = null;
let selectedLoginType = "admin";
let selectedUploadId = "";
let selectedDailyUploadId = "";
let detailMemberId = "";
let detailUploadId = "";
let pendingLoginToken = "";
let pendingLoginType = "";
let pendingRememberMe = false;
let calculatorMode = "percent";
let normalCalcValue = "0";
let normalCalcStored = null;
let normalCalcOperator = "";
let normalCalcFresh = true;
let mobileSelectTarget = null;
let mobileSelectHistoryOpen = false;
let loginSubmitting = false;
let swRegistrationPromise = null;
const expandedAdminNumbers = new Set();
const mobileSelectIds = ["adminUploadSelect", "adminDailyUploadSelect", "adminMemberSort", "adminDailyMemberSort", "memberUploadSelect", "memberDailyUploadSelect", "commissionRowsSort", "myRowsSort", "numberListSort", "detailUploadSelect", "paymentMemberSelect", "adminFeedbackType"];

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    swRegistrationPromise = navigator.serviceWorker.register("/sw.js").catch(() => null);
  });
}

const loginView = document.getElementById("loginView");
const appView = document.getElementById("appView");
const adminPanel = document.getElementById("adminPanel");
const ownerPanel = document.getElementById("ownerPanel");
const memberPanel = document.getElementById("memberPanel");
const loginHint = document.getElementById("loginHint");
const detailModal = document.getElementById("memberDetailModal");
const kvkkModal = document.getElementById("kvkkModal");
const pushPromptModal = document.getElementById("pushPromptModal");
const mobileSelectModal = document.getElementById("mobileSelectModal");
const notificationBadge = document.getElementById("notificationBadge");
const rememberStorageKey = "tipsterPanelRememberLogin";
const pushPromptSessionKey = "tipsterPanelPushPromptDismissed";

const money = new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 2 });

function setMessage(id, text, ok = false) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text || "";
  el.style.color = ok ? "var(--ok)" : "var(--danger)";
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function parseMoneyInput(value) {
  const clean = String(value || "").replace(/\./g, "").replace(",", ".").replace(/[^\d.-]/g, "");
  const number = Number(clean);
  return Number.isFinite(number) ? number : 0;
}

function api(path, options = {}) {
  const headers = options.headers || {};
  if (csrfToken && options.method && options.method !== "GET") headers["X-CSRF-Token"] = csrfToken;
  return fetch(path, { ...options, headers }).then(async response => {
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Islem basarisiz.");
    return data;
  });
}

function setPushMessage(text, ok = false) {
  setMessage("pushMessage", text, ok);
  setMessage("pushPromptMessage", text, ok);
}

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map(char => char.charCodeAt(0)));
}

async function serviceWorkerRegistration() {
  if (!("serviceWorker" in navigator)) return null;
  if (!swRegistrationPromise) swRegistrationPromise = navigator.serviceWorker.register("/sw.js").catch(() => null);
  return swRegistrationPromise || navigator.serviceWorker.ready;
}

async function updatePushButton() {
  const button = document.getElementById("pushEnableBtn");
  const testButton = document.getElementById("pushTestBtn");
  const panel = document.getElementById("pushPanel");
  if (!button || !panel) return;
  if (!("Notification" in window) || !("PushManager" in window) || !("serviceWorker" in navigator)) {
    button.disabled = true;
    if (testButton) testButton.disabled = true;
    button.textContent = "Bildirim desteklenmiyor";
    setPushMessage("Bu telefon/tarayici web bildirimi desteklemiyor.");
    return;
  }
  const registration = await serviceWorkerRegistration();
  const subscription = await registration?.pushManager?.getSubscription?.();
  if (Notification.permission === "granted" && subscription) {
    try {
      const saved = await savePushSubscription(subscription);
      button.disabled = true;
      if (testButton) testButton.disabled = false;
      button.textContent = "Bildirimler acik";
      setPushMessage(`Bu cihaz icin bildirimler acik. Kayitli cihaz: ${saved.subscriptionCount || 1}`, true);
    } catch (error) {
      button.disabled = false;
      if (testButton) testButton.disabled = true;
      button.textContent = "Tekrar bagla";
      setPushMessage("Bildirim izni var ama sunucu kaydi yenilenemedi. Tekrar bagla butonuna basin.");
    }
  } else if (Notification.permission === "denied") {
    button.disabled = true;
    if (testButton) testButton.disabled = true;
    button.textContent = "Bildirim izni kapali";
    setPushMessage("Bildirim izni tarayicida kapali. Telefon ayarlarindan izin vermek gerekir.");
  } else {
    button.disabled = false;
    if (testButton) testButton.disabled = true;
    button.textContent = "Bildirimleri ac";
    setPushMessage("");
  }
}

async function savePushSubscription(subscription) {
  return api("/api/push/subscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ subscription })
  });
}

async function sendTestPush() {
  const testButton = document.getElementById("pushTestBtn");
  if (testButton) testButton.disabled = true;
  try {
    const registration = await serviceWorkerRegistration();
    const subscription = await registration?.pushManager?.getSubscription?.();
    if (!subscription || Notification.permission !== "granted") {
      throw new Error("Once bildirimleri acmak gerekiyor.");
    }
    await savePushSubscription(subscription);
    const result = await api("/api/push/test", { method: "POST" });
    setPushMessage(pushResultText(result, "Test bildirimi"), Boolean(result.sent));
  } catch (error) {
    setPushMessage(error.message);
  } finally {
    await updatePushButton();
  }
}

function pushResultText(result, prefix = "Bildirim") {
  if (!result?.enabled) return `${prefix}: bildirim sistemi sunucuda hazir degil.`;
  if (!result.total) return `${prefix}: bu tipster icin kayitli telefon yok. Tipster kendi telefonundan Bildirimleri ac demeli.`;
  if (result.sent) return `${prefix}: ${result.sent} cihaza gonderildi.`;
  if (result.failed) return `${prefix}: ${result.failed} cihazda hata olustu. Telefon bildirim iznini kapatip tekrar acmak gerekebilir.`;
  return `${prefix}: gonderilemedi.`;
}

async function enablePushNotifications() {
  const button = document.getElementById("pushEnableBtn");
  const promptButton = document.getElementById("pushPromptEnableBtn");
  if (!button && !promptButton) return;
  if (button) button.disabled = true;
  if (promptButton) promptButton.disabled = true;
  setPushMessage("");
  try {
    if (!("Notification" in window) || !("PushManager" in window) || !("serviceWorker" in navigator)) {
      throw new Error("Bu telefon/tarayici web bildirimi desteklemiyor.");
    }
    const permission = await Notification.requestPermission();
    if (permission !== "granted") throw new Error("Bildirim izni verilmedi.");
    const keyData = await api("/api/push/public-key");
    if (!keyData.enabled || !keyData.publicKey) throw new Error("Bildirim sistemi henuz hazir degil.");
    const registration = await serviceWorkerRegistration();
    if (!registration) throw new Error("Bildirim servisi baslatilamadi.");
    let subscription = await registration.pushManager.getSubscription();
    if (subscription) {
      try { await subscription.unsubscribe(); } catch (error) {}
      subscription = null;
    }
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(keyData.publicKey)
      });
    }
    await savePushSubscription(subscription);
    setPushMessage("Bildirimler acildi. Mesaj ve haftalik Excel yuklemelerinde haber verilecek.", true);
    closePushPrompt(false);
  } catch (error) {
    setPushMessage(error.message);
  } finally {
    await updatePushButton();
    if (promptButton) promptButton.disabled = "Notification" in window && Notification.permission === "denied";
  }
}

function closePushPrompt(saveForSession = true) {
  pushPromptModal?.classList.add("hidden");
  if (saveForSession) {
    try { sessionStorage.setItem(pushPromptSessionKey, "1"); } catch (error) {}
  }
}

async function maybeShowPushPrompt() {
  if (!pushPromptModal || currentDashboard?.role !== "member") return;
  try {
    if (sessionStorage.getItem(pushPromptSessionKey) === "1") return;
  } catch (error) {}
  if (!("Notification" in window) || !("PushManager" in window) || !("serviceWorker" in navigator)) return;
  if (Notification.permission !== "default") return;
  const registration = await serviceWorkerRegistration();
  const subscription = await registration?.pushManager?.getSubscription?.();
  if (subscription) return;
  pushPromptModal.classList.remove("hidden");
}

function showApp(user) {
  loginView.classList.add("hidden");
  appView.classList.remove("hidden");
  document.body.classList.remove("login-mode");
  document.body.classList.add("app-mode");
  document.getElementById("panelTitle").textContent = user.role === "owner" ? "Ana Admin Paneli" : user.role === "admin" ? "Admin Paneli" : user.name;
  document.getElementById("panelSubtitle").textContent = user.role === "owner"
    ? "Admin hesaplari ve kendi paneliniz burada yonetilir."
    : user.role === "admin"
    ? "Tipsterlar, Excel haftalari ve hesaplamalar burada yonetilir."
    : "Numaralarini ve haftalik hesaplarini buradan takip ediyorsun.";
}

function showLogin() {
  appView.classList.add("hidden");
  loginView.classList.remove("hidden");
  document.body.classList.remove("app-mode");
  document.body.classList.add("login-mode");
  ownerPanel.classList.add("hidden");
  adminPanel.classList.add("hidden");
  memberPanel.classList.add("hidden");
  detailModal.classList.add("hidden");
  kvkkModal.classList.add("hidden");
  closePushPrompt(false);
  notificationBadge.classList.add("hidden");
  document.title = "Tipster Kontrol Paneli";
}

function resetOtpLogin() {
  pendingLoginToken = "";
  pendingLoginType = "";
  pendingRememberMe = false;
  document.getElementById("otpPanel").classList.add("hidden");
  document.getElementById("otpCode").required = false;
  document.getElementById("otpCode").value = "";
  document.getElementById("username").disabled = false;
  document.getElementById("password").disabled = false;
  document.querySelectorAll("[data-login-type]").forEach(item => item.disabled = false);
}

function rememberLoginChoice(user) {
  const rememberMe = document.getElementById("rememberMe")?.checked;
  try {
    if (rememberMe) {
      localStorage.setItem(rememberStorageKey, JSON.stringify({
        loginType: selectedLoginType,
        username: document.getElementById("username").value.trim()
      }));
    } else {
      localStorage.removeItem(rememberStorageKey);
    }
  } catch (error) {}
}

function restoreRememberedLogin() {
  try {
    const saved = JSON.parse(localStorage.getItem(rememberStorageKey) || "{}");
    if (!saved.username) {
      document.getElementById("username").value = "admin";
      return;
    }
    selectedLoginType = saved.loginType === "member" ? "member" : "admin";
    document.querySelectorAll("[data-login-type]").forEach(item => item.classList.toggle("active", item.dataset.loginType === selectedLoginType));
    document.getElementById("username").value = saved.username;
    document.getElementById("rememberMe").checked = true;
    loginHint.textContent = selectedLoginType === "admin"
      ? "Admin hesabi icin size verilen guvenli sifreyi kullanin."
      : "Tipster girisi icin adminin olusturdugu kullanici adi ve sifre kullanilir.";
  } catch (error) {
    document.getElementById("username").value = "admin";
  }
}

function uploadLabel(upload) {
  if (!upload) return "Tum haftalar";
  const type = upload.uploadType === "daily" ? "Gunluk" : "Haftalik";
  return `${type}: ${upload.weekLabel || upload.filename} (${upload.rowCount} satir)`;
}

function uploadTypeText(upload) {
  return upload?.uploadType === "daily" ? "Gunluk" : "Haftalik";
}

function portalStatusPill(item) {
  const hasList = Boolean(currentDashboard?.currentPortalList);
  if (!hasList) return `<span class="status-pill passive">Liste yok</span>`;
  const registered = Boolean(item?.portalRegistered);
  return `<span class="status-pill ${registered ? "active" : "passive"}">${registered ? "Kayitli" : "Kayitli degil"}</span>`;
}

function numberRecordsOf(member) {
  if (Array.isArray(member.numberRecords)) return member.numberRecords;
  return (member.gsmList || []).map(number => ({ number, name: "" }));
}

function numberRecordText(member) {
  return numberRecordsOf(member).map(record => record.name ? `${record.name} (${record.number})` : record.number).join(", ");
}

function numberDateHtml(record) {
  return record?.createdAt ? `<small class="number-date">Kayit: ${escapeHtml(formatDateTime(record.createdAt))}</small>` : "";
}

function numberRecordsHtml(member) {
  const records = numberRecordsOf(member);
  if (!records.length) return "-";
  return records.map(record => `
    <div class="number-status-line">
      <span>${escapeHtml(record.name ? `${record.name} (${record.number})` : record.number)}${numberDateHtml(record)}</span>
      ${portalStatusPill(record)}
    </div>
  `).join("");
}

function filteredNumberRecords(member, query = "") {
  const records = numberRecordsOf(member);
  if (!query) return records;
  return records.filter(record => searchMatches(`${record.name || ""} ${record.number || ""}`, query));
}

function numberMiniList(records, emptyText) {
  return records.map(record => `
    <div class="number-status-line">
      <span>${escapeHtml(record.name ? `${record.name} (${record.number})` : record.number)}${numberDateHtml(record)}</span>
    </div>
  `).join("") || `<p class="muted mini-empty">${escapeHtml(emptyText)}</p>`;
}

function adminNumberSplitHtml(member, scope, query = "") {
  const numberQuery = searchNumber(query) || searchDigits(query);
  const records = numberQuery ? filteredNumberRecords(member, query) : numberRecordsOf(member);
  if (!records.length) return query ? `<span class="muted">Aranan numara bu tipsterda yok.</span>` : "-";
  const key = `${scope}:${member.id}`;
  const expanded = expandedAdminNumbers.has(key) || Boolean(query);
  const hasPortalList = Boolean(currentDashboard?.currentPortalList);
  const registered = hasPortalList ? records.filter(record => record.portalRegistered) : [];
  const unregistered = hasPortalList ? records.filter(record => !record.portalRegistered) : records;
  const allRecords = numberRecordsOf(member);
  const totalRegistered = hasPortalList ? allRecords.filter(record => record.portalRegistered).length : 0;
  const totalUnregistered = hasPortalList ? allRecords.length - totalRegistered : allRecords.length;
  const portalSummary = hasPortalList
    ? `Kayitli ${totalRegistered} / Kayitsiz ${totalUnregistered}`
    : "Bayi Portal listesi yok";
  return `
    <div class="admin-number-toggle">
      <button class="ghost small number-toggle-btn" type="button" data-number-toggle="${escapeHtml(key)}" aria-expanded="${expanded ? "true" : "false"}">
        ${query ? `${records.length} eslesen numara` : `${allRecords.length} numarayi goster`} - ${portalSummary}
      </button>
      <div class="admin-number-list ${expanded ? "" : "hidden"}">
        <div class="number-split">
          <section>
            <h4>Kayitli <span>${registered.length}</span></h4>
            ${hasPortalList ? numberMiniList(registered, "Kayitli numara yok.") : `<p class="muted mini-empty">Liste yok.</p>`}
          </section>
          <section>
            <h4>Kayitsiz <span>${unregistered.length}</span></h4>
            ${numberMiniList(unregistered, hasPortalList ? "Kayitsiz numara yok." : "Liste yok.")}
          </section>
        </div>
      </div>
    </div>
  `;
}

function adminNumberRecordsToggleHtml(member, scope) {
  const records = numberRecordsOf(member);
  if (!records.length) return "-";
  const key = `${scope}:${member.id}`;
  const expanded = expandedAdminNumbers.has(key);
  const hasPortalList = Boolean(currentDashboard?.currentPortalList);
  const registeredCount = hasPortalList ? records.filter(record => record.portalRegistered).length : 0;
  const unregisteredCount = hasPortalList ? records.length - registeredCount : 0;
  const portalSummary = hasPortalList
    ? ` - Kayitli ${registeredCount} / Kayitli degil ${unregisteredCount}`
    : " - Bayi Portal listesi yok";
  return `
    <div class="admin-number-toggle">
      <button class="ghost small number-toggle-btn" type="button" data-number-toggle="${escapeHtml(key)}" aria-expanded="${expanded ? "true" : "false"}">
        ${expanded ? `Numaralari gizle${portalSummary}` : `${records.length} numarayi goster${portalSummary}`}
      </button>
      <div class="admin-number-list ${expanded ? "" : "hidden"}">
        ${numberRecordsHtml(member)}
      </div>
    </div>
  `;
}

function searchText(value) {
  return String(value || "").toLocaleLowerCase("tr").replace(/\s+/g, " ").trim();
}

function searchNumber(value) {
  return String(value || "").toLocaleLowerCase("tr").replace(/[^0-9*]/g, "");
}

function searchDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

function canonicalGsm(value) {
  const raw = String(value || "").trim();
  const masked = raw.match(/05\d{2}\*{3}\d{4}/);
  if (masked) return masked[0];
  const digits = searchDigits(raw);
  const national = digits.startsWith("90") && digits.length === 12 ? digits.slice(2) : digits;
  if (/^5\d{9}$/.test(national)) return `0${national.slice(0, 3)}***${national.slice(-4)}`;
  if (/^05\d{9}$/.test(national)) return `${national.slice(0, 4)}***${national.slice(-4)}`;
  return raw.includes("*") ? searchNumber(raw) : "";
}

function maskedNumberMatches(haystack, query) {
  const haystackNumber = searchNumber(haystack);
  const queryNumber = searchNumber(query);
  if (!haystackNumber || !queryNumber) return false;
  const wildcardMatch = (masked, candidate) => {
    if (!masked.includes("*")) return false;
    const pattern = masked
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      .replace(/\\\*+/g, "\\d*");
    return new RegExp(pattern).test(candidate);
  };
  return wildcardMatch(haystackNumber, queryNumber) || wildcardMatch(queryNumber, haystackNumber);
}

function searchMatches(haystack, query) {
  const textQuery = searchText(query);
  const numberQuery = searchNumber(query);
  const digitQuery = searchDigits(query);
  if (!textQuery && !numberQuery && !digitQuery) return true;
  const textHaystack = searchText(haystack);
  const numberHaystack = searchNumber(haystack);
  const digitHaystack = searchDigits(haystack);
  return (textQuery && textHaystack.includes(textQuery))
    || (numberQuery && numberHaystack.includes(numberQuery))
    || (digitQuery && digitHaystack.includes(digitQuery))
    || maskedNumberMatches(haystack, query);
}

function sortByAmount(rows, sort, amountKey) {
  const sorted = [...(rows || [])];
  if (sort === "desc") sorted.sort((a, b) => Number(b[amountKey] || 0) - Number(a[amountKey] || 0));
  if (sort === "asc") sorted.sort((a, b) => Number(a[amountKey] || 0) - Number(b[amountKey] || 0));
  if (sort === "allWeeklyDesc") sorted.sort((a, b) => Number(b.allWeeklyTotal || 0) - Number(a.allWeeklyTotal || 0));
  if (sort === "allWeeklyAsc") sorted.sort((a, b) => Number(a.allWeeklyTotal || 0) - Number(b.allWeeklyTotal || 0));
  return sorted;
}

function dateInputValue(date) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

function addYears(date, years) {
  const next = new Date(date);
  next.setFullYear(next.getFullYear() + years);
  return next;
}

function parseDateOnly(value) {
  if (!value) return null;
  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatDateOnly(value) {
  const date = parseDateOnly(value);
  return date ? date.toLocaleDateString("tr-TR") : "-";
}

function accessPeriodInfo(user) {
  const startsAt = user?.accessStartsAt || "";
  const endsAt = user?.accessEndsAt || "";
  const endDate = parseDateOnly(endsAt);
  if (!endDate) {
    return { startsAt, endsAt, label: "Suresiz", className: "" };
  }
  const today = parseDateOnly(dateInputValue(new Date()));
  const daysLeft = Math.ceil((endDate.getTime() - today.getTime()) / 86400000);
  if (daysLeft < 0) return { startsAt, endsAt, label: "Sure doldu", className: "expired" };
  return {
    startsAt,
    endsAt,
    label: `${daysLeft} gun kaldi`,
    className: daysLeft <= 30 ? "warning" : ""
  };
}

function setDefaultAdminPeriod() {
  const startInput = document.getElementById("adminAccessStartsAt");
  const endInput = document.getElementById("adminAccessEndsAt");
  if (!startInput || !endInput) return;
  const today = new Date();
  startInput.value = dateInputValue(today);
  endInput.value = dateInputValue(addYears(today, 1));
}

function setDefaultUploadDate() {
  const input = document.getElementById("dailyUploadDate");
  if (input && !input.value) input.value = dateInputValue(new Date());
}

function setDefaultPaymentDate() {
  const input = document.getElementById("paymentDate");
  if (input && !input.value) input.value = dateInputValue(new Date());
}

function renderAdminPeriod(admin) {
  const banner = document.getElementById("adminPeriodBanner");
  const info = accessPeriodInfo(admin);
  if (!banner || !admin || admin.role !== "admin") {
    banner?.classList.add("hidden");
    return;
  }
  banner.className = `period-banner ${info.className || ""}`.trim();
  banner.innerHTML = `
    <div>
      <span>Kullanim suresi</span>
      <strong>${formatDateOnly(info.startsAt)} - ${formatDateOnly(info.endsAt)}</strong>
    </div>
    <b>${escapeHtml(info.label)}</b>
  `;
}

function renderUploadSelect(selectId, uploads, selected) {
  const select = document.getElementById(selectId);
  select.innerHTML = uploads.length
    ? `<option value="all">Tum haftalar</option>` + uploads.map(upload => `<option value="${upload.id}">${escapeHtml(uploadLabel(upload))}</option>`).join("")
    : `<option value="all">Excel yuklenmedi</option>`;
  select.value = selected || uploads[0]?.id || "all";
  updateMobileSelectTrigger(select);
}

function renderDailyUploadSelect(selectId, uploads, selected) {
  const select = document.getElementById(selectId);
  select.innerHTML = uploads.length
    ? uploads.map(upload => `<option value="${upload.id}">${escapeHtml(uploadLabel(upload))}</option>`).join("")
    : `<option value="">Gunluk Excel yuklenmedi</option>`;
  select.value = selected || uploads[0]?.id || "";
  updateMobileSelectTrigger(select);
}

function isMobileSelectMode() {
  return window.matchMedia("(max-width: 760px)").matches;
}

function normalizeSearchText(value) {
  return String(value || "")
    .trim()
    .toLocaleLowerCase("tr")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ");
}

function selectLabel(select) {
  const label = select.closest("label");
  const text = Array.from(label?.childNodes || [])
    .filter(node => node.nodeType === Node.TEXT_NODE)
    .map(node => node.textContent.trim())
    .filter(Boolean)
    .join(" ");
  return text || select.getAttribute("aria-label") || "Secim yap";
}

function mobileSelectOptions(query = "") {
  if (!mobileSelectTarget) return [];
  const normalizedQuery = normalizeSearchText(query);
  return Array.from(mobileSelectTarget.options)
    .map(option => ({
      value: option.value,
      text: option.textContent.trim(),
      selected: option.value === mobileSelectTarget.value,
      disabled: option.disabled
    }))
    .filter(option => !normalizedQuery || normalizeSearchText(option.text).includes(normalizedQuery));
}

function renderMobileSelectOptions() {
  const list = document.getElementById("mobileSelectList");
  const search = document.getElementById("mobileSelectSearch");
  const options = mobileSelectOptions(search.value);
  list.innerHTML = options.map(option => `
    <button class="mobile-select-option ${option.selected ? "active" : ""}" type="button" data-mobile-select-value="${escapeHtml(option.value)}" ${option.disabled ? "disabled" : ""}>
      <span>${escapeHtml(option.text)}</span>
      ${option.selected ? "<b>Secili</b>" : ""}
    </button>
  `).join("") || `<p class="muted mobile-select-empty">Sonuc bulunamadi.</p>`;
}

function updateMobileSelectTrigger(select) {
  if (!select || !mobileSelectIds.includes(select.id)) return;
  select.classList.add("mobile-select-native");
  let trigger = document.querySelector(`[data-mobile-select-trigger="${select.id}"]`);
  if (!trigger) {
    trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "mobile-select-trigger";
    trigger.dataset.mobileSelectTrigger = select.id;
    select.insertAdjacentElement("afterend", trigger);
  }
  const selectedText = select.selectedOptions[0]?.textContent?.trim() || "Secim yap";
  trigger.innerHTML = `<span>${escapeHtml(selectedText)}</span><b>Sec</b>`;
  trigger.disabled = select.disabled || select.options.length <= 1;
}

function refreshMobileSelectTriggers() {
  mobileSelectIds.forEach(selectId => updateMobileSelectTrigger(document.getElementById(selectId)));
}

function openMobileSelect(select) {
  if (!isMobileSelectMode() || !select || select.options.length <= 1) return false;
  mobileSelectTarget = select;
  document.getElementById("mobileSelectTitle").textContent = selectLabel(select);
  document.getElementById("mobileSelectSubtitle").textContent = select.selectedOptions[0]?.textContent?.trim() || "Listeden bir kayit sec.";
  document.getElementById("mobileSelectSearch").value = "";
  renderMobileSelectOptions();
  mobileSelectModal.classList.remove("hidden");
  document.body.classList.add("mobile-select-open");
  if (!mobileSelectHistoryOpen) {
    history.pushState({ mobileSelect: true }, "");
    mobileSelectHistoryOpen = true;
  }
  setTimeout(() => document.getElementById("mobileSelectSearch").focus(), 50);
  return true;
}

function closeMobileSelect(fromHistory = false) {
  if (mobileSelectModal.classList.contains("hidden")) return;
  mobileSelectModal.classList.add("hidden");
  document.body.classList.remove("mobile-select-open");
  mobileSelectTarget = null;
  if (!fromHistory && mobileSelectHistoryOpen) {
    mobileSelectHistoryOpen = false;
    history.back();
    return;
  }
  mobileSelectHistoryOpen = false;
}

function isMobilePanelMode() {
  return true;
}

function refreshMobilePanelState() {
  const activePanel = document.querySelector("details.collapsible.mobile-panel-page[open]");
  document.body.classList.toggle("mobile-panel-open", Boolean(activePanel));
}

function activateMobilePanel(details) {
  if (details?.classList.contains("calculator-panel")) return;
  if (!details || !details.classList.contains("collapsible") || !details.open || !isMobilePanelMode()) return;
  const parentPanel = details.parentElement?.closest("details.collapsible.mobile-panel-page");
  if (parentPanel) return;
  document.querySelectorAll("details.collapsible.mobile-panel-page[open]").forEach(panel => {
    if (panel !== details) {
      panel.classList.remove("mobile-panel-page");
      panel.open = false;
    }
  });
  details.classList.add("mobile-panel-page");
  document.body.classList.add("mobile-panel-open");
  details.scrollTop = 0;
}

function deactivateMobilePanel(details) {
  details?.classList.remove("mobile-panel-page");
  refreshMobilePanelState();
}

function renderAdmin(data, keepOwnerPanel = false) {
  currentDashboard = data;
  selectedUploadId = data.selectedUploadId;
  selectedDailyUploadId = data.selectedDailyUploadId || "";
  if (!keepOwnerPanel) ownerPanel.classList.add("hidden");
  adminPanel.classList.remove("hidden");
  memberPanel.classList.add("hidden");
  notificationBadge.classList.add("hidden");
  document.title = "Tipster Kontrol Paneli";
  renderAdminPeriod(data.currentAdmin);
  renderUploadSelect("adminUploadSelect", data.uploads, data.selectedUploadId);
  renderDailyUploadSelect("adminDailyUploadSelect", data.dailyUploads || [], data.selectedDailyUploadId);
  document.getElementById("deleteSelectedDailyUploadBtn").disabled = !(data.dailyUploads || []).length || !data.selectedDailyUploadId;
  document.getElementById("adminEmail").value = data.currentAdmin?.email || "";
  document.getElementById("memberCount").textContent = data.summary.memberCount;
  document.getElementById("rowCount").textContent = data.summary.rowCount;
  document.getElementById("totalAmount").textContent = money.format(data.summary.totalAmount);
  document.getElementById("totalCommission").textContent = money.format(data.summary.totalCommission || 0);
  renderOverview(data.overview || {});
  renderBackups(data.backups || []);
  renderMembers();
  renderDailyMembers();
  renderPaymentPanel();
  renderSharedNumbers(data.sharedNumbers || []);
  renderUnmatchedNumbers(data.unmatchedNumbers || []);
  renderPassiveNumbers(data.passiveNumbers || []);
  renderUploadReports(data.uploadReports || []);
  renderAuditLogs(data.auditLogs || []);
  renderMessageRecipients(data.members || []);
  renderAdminMessages(data.messages || []);
  document.getElementById("adminFeedbackPanel").classList.toggle("hidden", data.role === "owner");
  const weeklyUploads = data.uploads || [];
  const dailyUploads = data.dailyUploads || [];
  const portalLists = data.portalLists || [];
  document.getElementById("uploads").innerHTML = `
    <details class="upload-group upload-list-collapsible collapsible">
      <summary>
        <span>
          <strong>Haftalik Excel dosyalari</strong>
          <small>${weeklyUploads.length} yuklu dosya</small>
        </span>
      </summary>
      <div class="upload-list-body collapsible-body">
      ${weeklyUploads.map(upload => `
        <div class="upload-item">
          <div>
            <strong>${escapeHtml(upload.weekLabel || upload.filename)}</strong><br>
            ${escapeHtml(upload.filename)} - ${upload.rowCount} satir - ${new Date(upload.createdAt).toLocaleString("tr-TR")}
          </div>
          <button class="danger small" type="button" data-upload-delete="${escapeHtml(upload.id)}" data-upload-name="${escapeHtml(upload.weekLabel || upload.filename)}">Sil</button>
        </div>
      `).join("") || `<p class="muted">Henuz haftalik Excel yuklenmedi.</p>`}
      </div>
    </details>
    <details class="upload-group upload-list-collapsible collapsible">
      <summary>
        <span>
          <strong>Gunluk Excel dosyalari</strong>
          <small>${dailyUploads.length} yuklu dosya</small>
        </span>
      </summary>
      <div class="upload-list-body collapsible-body">
      ${dailyUploads.map(upload => `
        <div class="upload-item">
          <div>
            <strong>${escapeHtml(upload.weekLabel || upload.filename)}</strong><br>
            ${escapeHtml(upload.filename)} - ${escapeHtml(upload.uploadDate || "-")} - ${upload.rowCount} satir - ${new Date(upload.createdAt).toLocaleString("tr-TR")}
          </div>
          <button class="danger small" type="button" data-upload-delete="${escapeHtml(upload.id)}" data-upload-name="${escapeHtml(upload.weekLabel || upload.filename)}">Sil</button>
        </div>
      `).join("") || `<p class="muted">Henuz gunluk Excel yuklenmedi.</p>`}
      </div>
    </details>
    <details class="upload-group upload-list-collapsible collapsible">
      <summary>
        <span>
          <strong>Bayi Portal haftalik listeleri</strong>
          <small>${portalLists.length} yuklu liste</small>
        </span>
      </summary>
      <div class="upload-list-body collapsible-body">
      ${portalLists.map(list => `
        <div class="upload-item">
          <div>
            <strong>${escapeHtml(list.weekLabel || list.filename)}</strong><br>
            ${escapeHtml(list.filename)} - ${list.rowCount} numara - ${new Date(list.createdAt).toLocaleString("tr-TR")}
          </div>
          <button class="danger small" type="button" data-portal-delete="${escapeHtml(list.id)}" data-portal-name="${escapeHtml(list.weekLabel || list.filename)}">Sil</button>
        </div>
      `).join("") || `<p class="muted">Henuz Bayi Portal listesi yuklenmedi.</p>`}
      </div>
    </details>
  `;
  calculateAdminTool();
}

function selectedWeeklyUploadLabel() {
  if (selectedUploadId === "all") return "Tum haftalar";
  const upload = (currentDashboard?.uploads || []).find(item => item.id === selectedUploadId);
  return upload ? uploadLabel(upload) : "Haftalik Excel secilmedi";
}

function renderPaymentPanel() {
  const members = currentDashboard?.members || [];
  const payments = currentDashboard?.payments || [];
  const selectedWeekPayments = payments.filter(payment => payment.uploadId === selectedUploadId);
  const summary = currentDashboard?.paymentSummary || {
    count: selectedWeekPayments.length,
    totalPaid: selectedWeekPayments.reduce((sum, payment) => sum + Number(payment.paidAmount || 0), 0),
    totalCalculated: selectedWeekPayments.reduce((sum, payment) => sum + Number(payment.calculatedAmount || 0), 0)
  };
  const memberSelect = document.getElementById("paymentMemberSelect");
  memberSelect.innerHTML = members.length
    ? members.map(member => `<option value="${escapeHtml(member.id)}">${escapeHtml(member.name)} - hesap: ${money.format(member.calculated || 0)}</option>`).join("")
    : `<option value="">Tipster yok</option>`;
  updateMobileSelectTrigger(memberSelect);
  document.getElementById("paymentWeekLabel").value = selectedWeeklyUploadLabel();
  document.getElementById("paymentCount").textContent = summary.count || 0;
  document.getElementById("paymentCalculatedTotal").textContent = money.format(summary.totalCalculated || 0);
  document.getElementById("paymentPaidTotal").textContent = money.format(summary.totalPaid || 0);
  document.getElementById("paymentRows").innerHTML = payments.map(payment => `
    <tr>
      <td data-label="Tarih">${escapeHtml(payment.paymentDate || "-")}</td>
      <td data-label="Hafta">${escapeHtml(payment.weekLabel || "-")}</td>
      <td data-label="Tipster"><strong>${escapeHtml(payment.memberName || "-")}</strong><br><span class="muted">${escapeHtml(payment.memberUsername || "")}</span></td>
      <td data-label="Hesap">${money.format(payment.calculatedAmount || 0)}</td>
      <td data-label="Odenen"><strong>${money.format(payment.paidAmount || 0)}</strong></td>
      <td data-label="Not">${escapeHtml(payment.note || "-")}</td>
      <td data-label="Islem"><button class="danger small" data-payment-delete="${escapeHtml(payment.id)}" type="button">Sil</button></td>
    </tr>
  `).join("") || `<tr><td colspan="7">Henuz odeme kaydi yok.</td></tr>`;
  setDefaultPaymentDate();
}

function renderOwner(data) {
  ownerPanel.classList.remove("hidden");
  renderAdmin(data, true);
  renderAdmins(data.admins || []);
  renderOwnerFeedbacks(data.feedbacks || []);
}

function renderAdmins(admins) {
  document.getElementById("adminRows").innerHTML = admins.map(admin => `
    <div class="admin-item">
      <div>
        <strong>${escapeHtml(admin.name)}</strong>
        <span>${escapeHtml(admin.username)}</span>
        <span>${escapeHtml(admin.email || "E-posta yok")}</span>
        <span>${escapeHtml(admin.phone || "Telefon yok")}</span>
        <span>Kullanim: ${formatDateOnly(admin.accessStartsAt)} - ${formatDateOnly(admin.accessEndsAt)}</span>
        <span class="period-status ${accessPeriodInfo(admin).className}">${escapeHtml(accessPeriodInfo(admin).label)}</span>
      </div>
      <form class="reset-admin-form" data-admin-reset="${admin.id}">
        <input type="password" minlength="8" placeholder="Yeni sifre" required>
        <button class="ghost small" type="submit">Sifre yenile</button>
      </form>
      <label class="admin-toggle">
        <input type="checkbox" data-admin-shared="${admin.id}" ${admin.sharedNumbersEnabled ? "checked" : ""}>
        <span>Ortak numara paylasimi</span>
      </label>
      <button class="danger small" data-admin-delete="${admin.id}" type="button">Sil</button>
    </div>
  `).join("") || `<p class="muted">Henuz alt admin olusturulmadi.</p>`;
}

function formatDateTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "-" : date.toLocaleString("tr-TR");
}

function formatFileSize(size) {
  const bytes = Number(size || 0);
  if (bytes >= 1024 * 1024) return `${money.format(bytes / 1024 / 1024)} MB`;
  if (bytes >= 1024) return `${money.format(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function renderOverview(overview) {
  const cards = [
    ["Portal listesi", overview.portalListCount || 0, "Yuklenen Bayi Portal numarasi", "info"],
    ["Tipster kaydi", overview.tipsterNumberCount || 0, "Tipsterlarda kayitli benzersiz numara", "info"],
    ["Eslesen", overview.portalMatchedCount || 0, "Tipsterda olup Bayi Portalda bulunan", "good"],
    ["Kayitli degil", overview.portalMissingCount || 0, "Tipsterda var, Bayi Portalda yok", overview.portalMissingCount ? "warn" : "good"],
    ["Tipstersiz", overview.portalUnassignedCount || 0, "Bayi Portalda var, tipsterda yok", overview.portalUnassignedCount ? "warn" : "good"],
    ["Aktif numara", overview.activeNumberCount || 0, "Secili Excelde oynayan benzersiz numara", "info"],
    ["Pasif numara", overview.passiveNumberCount || 0, "Tipsterda kayitli olup secili haftada gorunmeyen", overview.passiveNumberCount ? "warn" : "good"],
    ["Excel tipstersiz", overview.unmatchedNumberCount || 0, "Excelde var, tipsterda kayitli degil", overview.unmatchedNumberCount ? "danger" : "good"],
    ["Okunmamis mesaj", overview.unreadMessageCount || 0, "Tipsterlar tarafindan henuz okunmayan", overview.unreadMessageCount ? "warn" : "info"],
    ["Excel sayisi", overview.uploadCount || 0, "Bu admin hesabindaki yuklu dosya", "info"],
    ["Son yedek", overview.latestBackupAt ? formatDateTime(overview.latestBackupAt) : "-", "Veri koruma kaydi", "info"]
  ];
  if (currentDashboard?.role === "owner") {
    cards.splice(10, 0, ["Gelen talep", overview.feedbackCount || 0, "Oneri ve sikayet kutusu", overview.feedbackCount ? "warn" : "info"]);
  }
  document.getElementById("overviewGrid").innerHTML = cards.map(([label, value, help, tone]) => `
    <div class="overview-card ${tone ? `overview-card-${tone}` : ""}">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
      <small>${escapeHtml(help)}</small>
    </div>
  `).join("");
}

function renderBackups(backups) {
  document.getElementById("backupCount").textContent = backups.length;
  document.getElementById("backupRows").innerHTML = backups.map(backup => `
    <article class="backup-item">
      <div>
        <strong>${escapeHtml(formatDateTime(backup.createdAt))}</strong>
        <span>${escapeHtml(backup.filename)} - ${escapeHtml(formatFileSize(backup.size))}</span>
      </div>
      <button class="ghost small" data-backup-download="${encodeURIComponent(backup.filename)}" type="button">Indir</button>
    </article>
  `).join("") || `<p class="muted">Henuz yedek bulunmuyor.</p>`;
}

function renderMembers() {
  const query = document.getElementById("search").value;
  const sort = document.getElementById("adminMemberSort")?.value || "default";
  const filteredRows = currentDashboard.members.filter(member => {
    const text = `${member.name} ${member.username} ${numberRecordText(member)}`;
    return searchMatches(text, query);
  });
  const rows = sortByAmount(filteredRows, sort, "total");
  document.getElementById("memberRows").innerHTML = rows.map(member => `
    <tr>
      <td data-label="Tipster"><strong>${escapeHtml(member.name)}</strong><br><span class="muted">${escapeHtml(member.username)}</span></td>
      <td data-label="Numara">${adminNumberSplitHtml(member, "weekly", query)}</td>
      <td data-label="Uye"><strong>${member.numberCount ?? numberRecordsOf(member).length}</strong></td>
      <td data-label="Yuzde">%${money.format(member.percentage)}</td>
      <td data-label="Excel kayit">${member.rowCount}</td>
      <td data-label="Toplam">${money.format(member.total)}</td>
      <td data-label="Yuklu haftalar toplam">${money.format(member.allWeeklyTotal || 0)}<br><span class="muted">${member.allWeeklyRowCount || 0} kayit</span></td>
      <td data-label="Hesap"><strong>${money.format(member.calculated)}</strong></td>
      <td data-label="Islem" class="action-cell">
        <button class="ghost small" data-detail="${member.id}" type="button">Detay</button>
        <button class="danger small" data-delete="${member.id}" type="button">Sil</button>
      </td>
    </tr>
  `).join("") || `<tr><td colspan="9">Tipster bulunamadi.</td></tr>`;
}

function renderDailyMembers() {
  const query = document.getElementById("search").value;
  const sort = document.getElementById("adminDailyMemberSort")?.value || "default";
  const filteredRows = (currentDashboard.dailyMembers || []).filter(member => {
    const text = `${member.name} ${member.username} ${numberRecordText(member)}`;
    return searchMatches(text, query);
  });
  const rows = sortByAmount(filteredRows, sort, "dailyTotal");
  document.getElementById("dailyMemberRows").innerHTML = rows.map(member => `
    <tr>
      <td data-label="Tipster"><strong>${escapeHtml(member.name)}</strong><br><span class="muted">${escapeHtml(member.username)}</span></td>
      <td data-label="Numara">${adminNumberSplitHtml(member, "daily", query)}</td>
      <td data-label="Uye"><strong>${member.numberCount ?? numberRecordsOf(member).length}</strong></td>
      <td data-label="Yuzde">%${money.format(member.percentage)}</td>
      <td data-label="Gunluk kayit">${member.dailyRowCount || 0}</td>
      <td data-label="Gunluk toplam">${money.format(member.dailyTotal || 0)}</td>
      <td data-label="Gunluk kazanc"><strong>${money.format(member.dailyCalculated || 0)}</strong></td>
    </tr>
  `).join("") || `<tr><td colspan="7">Gunluk kazanc bulunamadi.</td></tr>`;
}

function renderUnmatchedNumbers(numbers) {
  document.getElementById("unmatchedNumberCount").textContent = numbers.length;
  document.getElementById("unmatchedNumberRows").innerHTML = numbers.map(item => `
    <tr>
      <td data-label="Numara"><strong>${escapeHtml(item.number)}</strong></td>
      <td data-label="Excel kayit">${item.rowCount}</td>
      <td data-label="Toplam oyun">${money.format(item.total)}</td>
      <td data-label="Excel / dosya">${escapeHtml((item.uploads || []).join(", ") || "-")}</td>
    </tr>
  `).join("") || `<tr><td colspan="4">Secili haftalik ve gunluk Excelde tipstersiz numara yok.</td></tr>`;
}

function portalComparisonMemberText(item) {
  return (item.members || []).map(member => member.name || member.username).join(", ") || "-";
}

function portalComparisonFilter(items, query) {
  return (items || []).filter(item => {
    const memberText = (item.members || []).map(member => `${member.name} ${member.username}`).join(" ");
    return searchMatches(`${item.number} ${item.name || ""} ${memberText}`, query);
  });
}

function portalComparisonTableRows(items, emptyText) {
  return items.map(item => `
    <tr>
      <td data-label="Numara"><strong>${escapeHtml(item.number)}</strong></td>
      <td data-label="Tipster">${escapeHtml(portalComparisonMemberText(item))}</td>
      <td data-label="Kayit adi">${escapeHtml(item.name || "-")}</td>
    </tr>
  `).join("") || `<tr><td colspan="3">${escapeHtml(emptyText)}</td></tr>`;
}

function portalComparisonCards(items, emptyText) {
  return items.map(item => `
    <div class="number-item">
      <div>
        <strong>${escapeHtml(item.number)}</strong>
        <span>${escapeHtml(item.name || portalComparisonMemberText(item))}</span>
      </div>
      ${portalStatusPill(item)}
    </div>
  `).join("") || `<p class="muted">${escapeHtml(emptyText)}</p>`;
}

function renderPortalComparison(prefix = "portal") {
  const comparison = currentDashboard?.portalComparison || { registered: [], unregistered: [] };
  const isMember = prefix === "memberPortal";
  const query = document.getElementById(`${prefix}ComparisonSearch`)?.value || "";
  const registered = portalComparisonFilter(comparison.registered || [], query);
  const unregistered = portalComparisonFilter(comparison.unregistered || [], query);
  const total = (comparison.registered || []).length + (comparison.unregistered || []).length;
  document.getElementById(`${prefix}ComparisonCount`).textContent = total;
  document.getElementById(`${prefix}RegisteredCount`).textContent = registered.length;
  document.getElementById(`${prefix}UnregisteredCount`).textContent = unregistered.length;
  if (isMember) {
    document.getElementById(`${prefix}RegisteredRows`).innerHTML = portalComparisonCards(registered, "Kayitli numara yok.");
    document.getElementById(`${prefix}UnregisteredRows`).innerHTML = portalComparisonCards(unregistered, "Kayitsiz numara yok.");
  } else {
    document.getElementById(`${prefix}RegisteredRows`).innerHTML = portalComparisonTableRows(registered, "Kayitli numara yok.");
    document.getElementById(`${prefix}UnregisteredRows`).innerHTML = portalComparisonTableRows(unregistered, "Kayitsiz numara yok.");
  }
}

function renderSharedNumbers(numbers = currentDashboard?.sharedNumbers || []) {
  const query = document.getElementById("sharedNumberSearch")?.value || "";
  const rows = numbers.filter(item => {
    const memberText = (item.members || []).map(member => `${member.name} ${member.username}`).join(" ");
    const text = `${item.number} ${item.name || ""} ${memberText}`;
    return searchMatches(text, query);
  });
  document.getElementById("sharedNumberCount").textContent = numbers.length;
  document.getElementById("sharedNumberRows").innerHTML = rows.map(item => `
    <tr>
      <td data-label="Numara"><strong>${escapeHtml(item.number)}</strong><br><span class="muted">${escapeHtml(item.name || "-")}</span></td>
      <td data-label="Tipsterlar">${(item.members || []).map(member => `<span class="read-pill read">${escapeHtml(member.name)} (${escapeHtml(member.username)})</span>`).join("")}</td>
      <td data-label="Kisi">${item.memberCount}</td>
      <td data-label="Excel kayit">${item.rowCount}</td>
      <td data-label="Toplam oyun">${money.format(item.total || 0)}</td>
      <td data-label="Kisi basi">${money.format(item.sharedTotal || 0)}</td>
    </tr>
  `).join("") || `<tr><td colspan="6">Ortak numara bulunamadi.</td></tr>`;
}

function renderPassiveNumbers(numbers) {
  const list = document.getElementById("passiveNumberRows");
  document.getElementById("passiveNumberCount").textContent = numbers.length;
  if (!numbers.length) {
    list.innerHTML = `<p class="muted">Secili haftada pasif numara yok.</p>`;
    return;
  }
  const groups = [];
  const byMember = new Map();
  numbers.forEach(item => {
    const key = item.memberId || `${item.memberName || ""}:${item.memberUsername || ""}`;
    if (!byMember.has(key)) {
      byMember.set(key, {
        memberName: item.memberName || "Tipster",
        memberUsername: item.memberUsername || "",
        numbers: []
      });
      groups.push(byMember.get(key));
    }
    byMember.get(key).numbers.push(item);
  });
  groups.sort((a, b) => a.memberName.localeCompare(b.memberName, "tr"));
  list.innerHTML = groups.map(group => `
    <details class="passive-group">
      <summary>
        <span>
          <strong>${escapeHtml(group.memberName)}</strong>
          <small>${escapeHtml(group.memberUsername || "Tipster")}</small>
        </span>
        <b>${group.numbers.length}</b>
      </summary>
      <div class="passive-group-body">
        <div class="table-wrap compact-table">
          <table>
            <thead>
              <tr>
                <th>Isim</th>
                <th>Numara</th>
                <th>Ne zamandir pasif</th>
                <th>Son aktif</th>
              </tr>
            </thead>
            <tbody>
              ${group.numbers.map(item => `
                <tr>
                  <td data-label="Isim">${escapeHtml(item.name || "-")}</td>
                  <td data-label="Numara"><strong>${escapeHtml(item.number)}</strong></td>
                  <td data-label="Ne zamandir pasif">${escapeHtml(item.passiveSince || "-")}</td>
                  <td data-label="Son aktif">${escapeHtml(item.statusText || "-")}</td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>
      </div>
    </details>
  `).join("");
}

function renderUploadReports(reports) {
  document.getElementById("uploadReportRows").innerHTML = reports.map(report => `
    <article class="report-card">
      <div class="message-card-head">
        <div>
          <strong>${escapeHtml(report.uploadType === "daily" ? "Gunluk" : "Haftalik")}: ${escapeHtml(report.weekLabel || report.filename || "Excel")}</strong>
          <span>${escapeHtml(report.filename || "-")} - ${escapeHtml(report.uploadDate || "")} - ${new Date(report.createdAt).toLocaleString("tr-TR")}</span>
        </div>
      </div>
      <div class="report-grid">
        <div><span>Satir</span><strong>${report.rowCount}</strong></div>
        <div><span>Aktif numara</span><strong>${report.activeNumberCount}</strong></div>
        <div><span>Pasif</span><strong>${report.passiveCount}</strong></div>
        <div><span>Tipstersiz</span><strong>${report.unmatchedCount}</strong></div>
        <div><span>Toplam oyun</span><strong>${money.format(report.totalAmount || 0)}</strong></div>
        <div><span>Komisyon</span><strong>${money.format(report.totalCommission || 0)}</strong></div>
      </div>
    </article>
  `).join("") || `<p class="muted">Henuz Excel raporu yok.</p>`;
}

function auditMemberForLog(log, members) {
  if (log.memberId) {
    const member = members.find(item => item.id === log.memberId);
    return {
      key: `member:${log.memberId}`,
      name: member?.name || log.memberName || log.memberUsername || "Silinmis tipster",
      username: member?.username || log.memberUsername || "",
      isMember: true
    };
  }
  if (log.actorRole === "member") {
    const member = members.find(item => item.username === log.actorUsername || item.name === log.actorName);
    return {
      key: `member:${member?.id || log.actorUsername || log.actorName}`,
      name: member?.name || log.actorName || "Tipster",
      username: member?.username || log.actorUsername || "",
      isMember: true
    };
  }
  const haystack = `${log.details || ""} ${log.actorName || ""} ${log.actorUsername || ""}`.toLocaleLowerCase("tr");
  const member = members.find(item => {
    const name = String(item.name || "").toLocaleLowerCase("tr");
    const username = String(item.username || "").toLocaleLowerCase("tr");
    return (name && haystack.includes(name)) || (username && haystack.includes(username));
  });
  if (member) {
    return {
      key: `member:${member.id}`,
      name: member.name,
      username: member.username,
      isMember: true
    };
  }
  return {
    key: "general",
    name: "Genel islemler",
    username: "Giris, Excel ve panel islemleri",
    isMember: false
  };
}

function renderAuditLogs(logs) {
  const list = document.getElementById("auditLogRows");
  if (!logs.length) {
    list.innerHTML = `<p class="muted">Henuz islem gecmisi yok.</p>`;
    return;
  }
  const members = currentDashboard?.members || [];
  const groups = [];
  const byKey = new Map();
  logs.forEach(log => {
    const groupInfo = auditMemberForLog(log, members);
    if (!byKey.has(groupInfo.key)) {
      byKey.set(groupInfo.key, { ...groupInfo, logs: [] });
      groups.push(byKey.get(groupInfo.key));
    }
    byKey.get(groupInfo.key).logs.push(log);
  });
  groups.sort((a, b) => {
    if (a.key === "general") return 1;
    if (b.key === "general") return -1;
    return a.name.localeCompare(b.name, "tr");
  });
  list.innerHTML = groups.map(group => `
    <details class="audit-group">
      <summary>
        <span>
          <strong>${escapeHtml(group.name)}</strong>
          <small>${escapeHtml(group.username || (group.isMember ? "Tipster islemleri" : "Genel islemler"))}</small>
        </span>
        <b>${group.logs.length}</b>
      </summary>
      <div class="audit-group-body">
        ${group.logs.map(log => `
          <article class="message-card audit-card">
            <div class="message-card-head">
              <div>
                <strong>${escapeHtml(log.action)}</strong>
                <span>${escapeHtml(log.actorName || "-")} (${escapeHtml(log.actorUsername || "-")}) - ${new Date(log.createdAt).toLocaleString("tr-TR")}</span>
              </div>
            </div>
            <p>${escapeHtml(log.details || "-")}</p>
          </article>
        `).join("")}
      </div>
    </details>
  `).join("");
}

function renderMemberPassiveNumbers(numbers) {
  document.getElementById("memberPassiveNumberCount").textContent = numbers.length;
  document.getElementById("memberPassiveNumberRows").innerHTML = numbers.map(item => `
    <tr>
      <td data-label="Isim">${escapeHtml(item.name || "-")}</td>
      <td data-label="Numara"><strong>${escapeHtml(item.number)}</strong></td>
      <td data-label="Ne zamandir pasif">${escapeHtml(item.passiveSince || "-")}</td>
      <td data-label="Son aktif">${escapeHtml(item.statusText || "-")}</td>
    </tr>
  `).join("") || `<tr><td colspan="4">Secili haftada pasif numaran yok.</td></tr>`;
}

function renderMessageRecipients(members) {
  const list = document.getElementById("messageRecipients");
  const allChecked = document.getElementById("messageAllMembers").checked;
  const selectedIds = new Set(Array.from(list.querySelectorAll("input:checked")).map(input => input.value));
  list.classList.toggle("disabled", allChecked && !selectedIds.size);
  list.innerHTML = members.map(member => `
    <label class="recipient-item">
      <input type="checkbox" value="${member.id}" ${selectedIds.has(member.id) ? "checked" : ""}>
      <span>
        <strong>${escapeHtml(member.name)}</strong>
        <small>${escapeHtml(member.username)}</small>
      </span>
    </label>
  `).join("") || `<p class="muted">Once tipster olusturun.</p>`;
}

function renderAdminMessages(messages) {
  document.getElementById("adminMessageRows").innerHTML = messages.map(message => `
    <article class="message-card">
      <div class="message-card-head">
        <div>
          <strong>${escapeHtml(message.title)}</strong>
          <span>${new Date(message.createdAt).toLocaleString("tr-TR")} - ${message.targetType === "all" ? "Tum tipsterlar" : "Secili tipsterlar"}</span>
        </div>
        <div class="message-counts">
          <b>${message.readCount} okundu</b>
          <b class="${message.unreadCount ? "unread" : ""}">${message.unreadCount} okunmadi</b>
        </div>
      </div>
      <p>${escapeHtml(message.body)}</p>
      <div class="read-grid">
        ${message.recipients.map(recipient => `
          <span class="read-pill ${recipient.readAt ? "read" : "unread"}">
            ${escapeHtml(recipient.name)} - ${recipient.readAt ? "Okundu" : "Okunmadi"}
          </span>
        `).join("")}
      </div>
    </article>
  `).join("") || `<p class="muted">Henuz mesaj gonderilmedi.</p>`;
}

function renderOwnerFeedbacks(feedbacks) {
  const roleLabels = { owner: "Ana admin", admin: "Admin", member: "Tipster" };
  const typeLabels = { suggestion: "Oneri", complaint: "Sikayet" };
  document.getElementById("ownerFeedbackRows").innerHTML = feedbacks.map(feedback => `
    <article class="message-card feedback-card">
      <div class="message-card-head">
        <div>
          <strong>${escapeHtml(feedback.title)}</strong>
          <span>${escapeHtml(roleLabels[feedback.senderRole] || "Kullanici")} - ${escapeHtml(feedback.senderName || "-")} (${escapeHtml(feedback.senderUsername || "-")})</span>
          <span>${new Date(feedback.createdAt).toLocaleString("tr-TR")}</span>
        </div>
        <span class="status-pill ${feedback.type === "complaint" ? "passive" : "active"}">${escapeHtml(typeLabels[feedback.type] || "Oneri")}</span>
      </div>
      <p>${escapeHtml(feedback.body)}</p>
    </article>
  `).join("") || `<p class="muted">Henuz oneri veya sikayet yok.</p>`;
}

function renderMember(data) {
  currentDashboard = data;
  selectedUploadId = data.selectedUploadId;
  selectedDailyUploadId = data.selectedDailyUploadId || data.dailyUploads?.[0]?.id || "";
  adminPanel.classList.add("hidden");
  memberPanel.classList.remove("hidden");
  updatePushButton().then(() => maybeShowPushPrompt()).catch(() => {});
  const numbers = numberRecordsOf(data.member);
  renderUploadSelect("memberUploadSelect", data.uploads, data.selectedUploadId);
  renderDailyUploadSelect("memberDailyUploadSelect", data.dailyUploads || [], selectedDailyUploadId);
  document.getElementById("myGsm").textContent = numbers.length;
  document.getElementById("myTotal").textContent = money.format(data.total);
  document.getElementById("myCalculated").textContent = money.format(data.calculated);
  document.getElementById("myRate").textContent = `%${money.format(data.percentage || data.member.percentage || 0)}`;
  renderCommissionRows(data.numberSummaries || []);
  renderDailyEarnings(data.dailySummaries || []);
  renderMemberPassiveNumbers(data.passiveNumbers || []);
  renderNumbers(numbers);
  renderMyRows(data.rows || []);
  renderMemberMessages(data.messages || []);
}

function renderMemberMessages(messages) {
  const panel = document.getElementById("memberMessagesPanel");
  const unreadCount = messages.filter(message => message.unread).length;
  notificationBadge.classList.toggle("hidden", unreadCount === 0);
  notificationBadge.textContent = unreadCount ? `${unreadCount} yeni mesaj` : "Yeni mesaj";
  document.title = unreadCount ? `(${unreadCount}) Tipster Kontrol Paneli` : "Tipster Kontrol Paneli";
  document.getElementById("memberMessageSummary").textContent = messages.length
    ? `${unreadCount} okunmamis, ${messages.length} toplam mesaj`
    : "Mesaj bulunmuyor";
  if (unreadCount) panel.open = true;
  document.getElementById("memberMessageRows").innerHTML = messages.map(message => `
    <article class="message-card ${message.unread ? "is-unread" : ""}">
      <div class="message-card-head">
        <div>
          <strong>${escapeHtml(message.title)}</strong>
          <span>${escapeHtml(message.senderName)} - ${new Date(message.createdAt).toLocaleString("tr-TR")}</span>
        </div>
        <span class="status-pill ${message.unread ? "passive" : "active"}">${message.unread ? "Okunmadi" : "Okundu"}</span>
      </div>
      <p>${escapeHtml(message.body)}</p>
      ${message.unread ? `<button class="primary small" data-message-read="${message.id}" type="button">Okudum</button>` : `<span class="muted">Okuma zamani: ${new Date(message.readAt).toLocaleString("tr-TR")}</span>`}
    </article>
  `).join("") || `<p class="muted">Henuz mesaj yok.</p>`;
}

function withAllWeeklyTotals(rows) {
  const allWeekly = currentDashboard?.allWeeklyNumberSummaries || [];
  const totalsByNumber = new Map(allWeekly.map(row => [canonicalGsm(row.number), row]));
  return (rows || []).map(row => {
    const allRow = totalsByNumber.get(canonicalGsm(row.number)) || {};
    return {
      ...row,
      allWeeklyTotal: Number(row.allWeeklyTotal ?? allRow.total ?? 0),
      allWeeklyRowCount: Number(row.allWeeklyRowCount ?? allRow.rowCount ?? 0),
      allWeeklyCalculated: Number(row.allWeeklyCalculated ?? allRow.calculated ?? 0)
    };
  });
}

function renderMyRows(rows) {
  const sort = document.getElementById("myRowsSort").value;
  const visibleRows = [...rows];
  if (sort === "desc") visibleRows.sort((a, b) => Number(b.totalAmount || 0) - Number(a.totalAmount || 0));
  if (sort === "asc") visibleRows.sort((a, b) => Number(a.totalAmount || 0) - Number(b.totalAmount || 0));
  const total = rows.reduce((sum, row) => sum + Number(row.totalAmount || 0), 0);
  const commission = Number(currentDashboard?.calculated || 0);
  document.getElementById("myRowsSummary").innerHTML = `
    <div>
      <span>Kayit sayisi</span>
      <strong>${rows.length}</strong>
    </div>
    <div>
      <span>Toplam oyun</span>
      <strong>${money.format(total)}</strong>
    </div>
    <div>
      <span>Komisyon</span>
      <strong>${money.format(commission)}</strong>
    </div>
  `;
  document.getElementById("myRows").innerHTML = visibleRows.map(row => `
    <tr>
      <td data-label="Numara">${escapeHtml(row.gsmMasked || "-")}${numberDateHtml(row)}</td>
      <td data-label="Bayi Portal">${portalStatusPill(row)}</td>
      <td data-label="Islem tipi">${escapeHtml(row.processType || "-")}</td>
      <td data-label="Toplam tutar">${money.format(row.totalAmount)}</td>
      <td data-label="Aktarim">${new Date(row.importedAt).toLocaleString("tr-TR")}</td>
    </tr>
  `).join("") || `<tr><td colspan="5">Bu hafta icin kayit bulunamadi.</td></tr>`;
}

function renderCommissionRows(rows) {
  const sort = document.getElementById("commissionRowsSort")?.value || "default";
  const visibleRows = sortByAmount(withAllWeeklyTotals(rows), sort, "total");
  document.getElementById("commissionRows").innerHTML = visibleRows.map(row => `
    <tr>
      <td data-label="Isim">${escapeHtml(row.name || "-")}</td>
      <td data-label="Numara"><strong>${escapeHtml(row.number)}</strong>${numberDateHtml(row)}</td>
      <td data-label="Durum"><span class="status-pill ${row.active ? "active" : "passive"}">${row.active ? "Aktif" : "Pasif"}</span></td>
      <td data-label="Bayi Portal">${portalStatusPill(row)}</td>
      <td data-label="Kayit">${row.rowCount}</td>
      <td data-label="Toplam oyun">${money.format(row.total)}</td>
      <td data-label="Yuklu haftalar toplam">${money.format(row.allWeeklyTotal || 0)}<br><span class="muted">${row.allWeeklyRowCount || 0} kayit</span></td>
      <td data-label="Komisyon"><strong>${money.format(row.calculated)}</strong></td>
    </tr>
  `).join("") || `<tr><td colspan="8">Bu hafta icin kayitli numaralarda eslesme bulunamadi.</td></tr>`;
}

function renderDailyEarnings(rows) {
  const activeDailyUploadId = document.getElementById("memberDailyUploadSelect")?.value || selectedDailyUploadId;
  const visibleRows = activeDailyUploadId ? rows.filter(row => row.uploadId === activeDailyUploadId) : rows;
  const selectedRow = visibleRows[0] || null;
  document.getElementById("dailyEarningSummary").innerHTML = selectedRow
    ? `
      <span>Secili gun: ${escapeHtml(selectedRow.label || selectedRow.uploadDate || "-")}</span>
      <span>Toplam oyun: ${money.format(selectedRow.total || 0)}</span>
      <span>Kazanc: ${money.format(selectedRow.calculated || 0)}</span>
    `
    : `
      <span>Secili gun: -</span>
      <span>Toplam oyun: 0</span>
      <span>Kazanc: 0</span>
    `;
  document.getElementById("dailyEarningCount").textContent = visibleRows.length;
  document.getElementById("dailyEarningRows").innerHTML = visibleRows.map(row => `
    <tr>
      <td data-label="Gun"><strong>${escapeHtml(row.label || row.uploadDate || "-")}</strong><br><span class="muted">${escapeHtml(row.uploadDate || "-")}</span></td>
      <td data-label="Excel kayit">${row.rowCount}</td>
      <td data-label="Toplam oyun">${money.format(row.total || 0)}</td>
      <td data-label="Kazanc"><strong>${money.format(row.calculated || 0)}</strong></td>
    </tr>
  `).join("") || `<tr><td colspan="4">Henuz gunluk Excel kazanci bulunmuyor.</td></tr>`;
}

function applyMemberDailyUploadSelection() {
  selectedDailyUploadId = document.getElementById("memberDailyUploadSelect").value;
  renderDailyEarnings(currentDashboard?.dailySummaries || []);
}

function renderNumbers(records) {
  const query = document.getElementById("numberSearch")?.value || "";
  const sort = document.getElementById("numberListSort")?.value || "default";
  const rows = sortByAmount(withAllWeeklyTotals(records), sort, "allWeeklyTotal")
    .filter(record => searchMatches(`${record.name || ""} ${record.number || ""}`, query));
  document.getElementById("numberList").innerHTML = rows.map(record => `
    <div class="number-item">
      <div>
        <strong>${escapeHtml(record.name || "Isimsiz")}</strong>
        <span>${escapeHtml(record.number)}</span>
        ${numberDateHtml(record)}
        ${portalStatusPill(record)}
        <div class="number-total-box">
          <span>Yuklu haftalar toplam</span>
          <strong>${money.format(record.allWeeklyTotal || 0)}</strong>
          <small>${record.allWeeklyRowCount || 0} Excel kaydi</small>
        </div>
      </div>
      <button class="danger small" type="button" data-number-delete="${encodeURIComponent(record.number)}">Sil</button>
    </div>
  `).join("") || `<p class="muted">Henuz numara kaydedilmedi.</p>`;
}

function calculateAdminTool() {
  const amount = parseMoneyInput(document.getElementById("calculatorAmount").value);
  const percentInput = document.getElementById("calculatorPercent");
  const commissionInput = document.getElementById("calculatorCommissionInput");
  let percent = parseMoneyInput(percentInput.value);
  let commission = parseMoneyInput(commissionInput.value);
  if (calculatorMode === "commission") {
    percent = amount ? commission / amount * 100 : 0;
    percentInput.value = amount || commission ? money.format(percent) : "";
  } else {
    commission = amount * percent / 100;
    commissionInput.value = amount || percent ? money.format(commission) : "";
  }
  const remainder = amount - commission;
  document.getElementById("calculatorResult").textContent = money.format(commission);
  document.getElementById("calculatorAutoPercent").textContent = `%${money.format(percent)}`;
  document.getElementById("calculatorRemainder").textContent = money.format(remainder);
  document.getElementById("calculatorSummary").textContent = money.format(commission);
}

function setCalculatorTab(tab) {
  const isCommission = tab === "commission";
  document.getElementById("commissionCalcTab").classList.toggle("active", isCommission);
  document.getElementById("normalCalcTab").classList.toggle("active", !isCommission);
  document.getElementById("commissionCalcPane").classList.toggle("hidden", !isCommission);
  document.getElementById("normalCalcPane").classList.toggle("hidden", isCommission);
}

function updateNormalCalcDisplay() {
  document.getElementById("normalCalcDisplay").value = normalCalcValue.replace(".", ",");
}

function normalCalcNumber() {
  return Number(normalCalcValue) || 0;
}

function applyNormalCalc(left, right, operator) {
  if (operator === "+") return left + right;
  if (operator === "-") return left - right;
  if (operator === "*") return left * right;
  if (operator === "/") return right === 0 ? 0 : left / right;
  return right;
}

function inputNormalCalcValue(value) {
  if (normalCalcFresh) {
    normalCalcValue = value === "." ? "0." : value;
    normalCalcFresh = false;
  } else if (value === "." && normalCalcValue.includes(".")) {
    return;
  } else {
    normalCalcValue = normalCalcValue === "0" && value !== "." ? value : normalCalcValue + value;
  }
  updateNormalCalcDisplay();
}

function chooseNormalCalcOperator(operator) {
  const current = normalCalcNumber();
  if (normalCalcStored === null) normalCalcStored = current;
  else if (!normalCalcFresh) normalCalcStored = applyNormalCalc(normalCalcStored, current, normalCalcOperator);
  normalCalcOperator = operator;
  normalCalcValue = String(normalCalcStored);
  normalCalcFresh = true;
  updateNormalCalcDisplay();
}

function finishNormalCalc() {
  if (!normalCalcOperator || normalCalcStored === null) return;
  normalCalcValue = String(applyNormalCalc(normalCalcStored, normalCalcNumber(), normalCalcOperator));
  normalCalcStored = null;
  normalCalcOperator = "";
  normalCalcFresh = true;
  updateNormalCalcDisplay();
}

function clearNormalCalc() {
  normalCalcValue = "0";
  normalCalcStored = null;
  normalCalcOperator = "";
  normalCalcFresh = true;
  updateNormalCalcDisplay();
}

async function loadDashboard(uploadId = selectedUploadId, dailyUploadId = selectedDailyUploadId) {
  const params = new URLSearchParams();
  if (uploadId) params.set("uploadId", uploadId);
  if (dailyUploadId) params.set("dailyUploadId", dailyUploadId);
  const query = params.toString() ? `?${params.toString()}` : "";
  const data = await api(`/api/dashboard${query}`);
  if (data.role === "owner") renderOwner(data);
  else if (data.role === "admin") renderAdmin(data);
  else renderMember(data);
}

async function loadMemberDetail(memberId, uploadId = detailUploadId || selectedUploadId || "all") {
  detailMemberId = memberId;
  detailUploadId = uploadId;
  const data = await api(`/api/members/${encodeURIComponent(memberId)}/details?uploadId=${encodeURIComponent(uploadId)}`);
  detailUploadId = data.selectedUploadId;
  detailModal.classList.remove("hidden");
  document.getElementById("detailTitle").textContent = data.member.name;
  const detailCount = numberRecordsOf(data.member).length;
  document.getElementById("detailSubtitle").textContent = `${data.member.username} - ${detailCount} uye/numara - ${numberRecordText(data.member) || "Numara yok"}`;
  document.getElementById("detailName").value = data.member.name;
  document.getElementById("detailGsm").value = data.member.gsmMasked || data.member.gsmList[0] || "";
  document.getElementById("detailPercentage").value = data.member.percentage;
  document.getElementById("detailPassword").value = "";
  document.getElementById("detailTotal").textContent = money.format(data.total);
  document.getElementById("detailCalculated").textContent = money.format(data.calculated);
  renderUploadSelect("detailUploadSelect", data.uploads, data.selectedUploadId);
  document.getElementById("detailNumberRows").innerHTML = (data.numberSummaries || []).map(row => `
    <tr>
      <td data-label="Isim">${escapeHtml(row.name || "-")}</td>
      <td data-label="Numara"><strong>${escapeHtml(row.number)}</strong>${numberDateHtml(row)}</td>
      <td data-label="Durum"><span class="status-pill ${row.active ? "active" : "passive"}">${row.active ? "Aktif" : "Pasif"}</span></td>
      <td data-label="Bayi Portal">${portalStatusPill(row)}</td>
      <td data-label="Kayit">${row.rowCount}</td>
      <td data-label="Pay">${Number(row.shareCount || 1) > 1 ? `${row.shareCount} tipster` : "Tek"}</td>
      <td data-label="Toplam">${money.format(row.total)}</td>
      <td data-label="Komisyon"><strong>${money.format(row.calculated)}</strong></td>
    </tr>
  `).join("") || `<tr><td colspan="8">Bu hafta icin eslesme bulunamadi.</td></tr>`;
  document.getElementById("detailDailyRows").innerHTML = (data.dailySummaries || []).map(row => `
    <tr>
      <td data-label="Gun"><strong>${escapeHtml(row.label || row.uploadDate || "-")}</strong><br><span class="muted">${escapeHtml(row.uploadDate || "-")}</span></td>
      <td data-label="Excel kayit">${row.rowCount}</td>
      <td data-label="Toplam">${money.format(row.total || 0)}</td>
      <td data-label="Kazanc"><strong>${money.format(row.calculated || 0)}</strong></td>
    </tr>
  `).join("") || `<tr><td colspan="4">Bu tipster icin gunluk kazanc bulunmuyor.</td></tr>`;
}

async function submitFeedbackForm(event, prefix) {
  event.preventDefault();
  setMessage(`${prefix}FeedbackMessage`, "");
  try {
    await api("/api/feedbacks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: document.getElementById(`${prefix}FeedbackType`).value,
        title: document.getElementById(`${prefix}FeedbackTitle`).value,
        body: document.getElementById(`${prefix}FeedbackBody`).value
      })
    });
    event.target.reset();
    setMessage(`${prefix}FeedbackMessage`, "Mesaj ana admine gonderildi.", true);
    if (currentDashboard?.role === "owner") await loadDashboard(selectedUploadId);
  } catch (error) {
    setMessage(`${prefix}FeedbackMessage`, error.message);
  }
}

document.querySelectorAll("[data-login-type]").forEach(button => {
  button.addEventListener("click", () => {
    selectedLoginType = button.dataset.loginType;
    document.querySelectorAll("[data-login-type]").forEach(item => item.classList.remove("active"));
    button.classList.add("active");
    setMessage("loginMessage", "");
    resetOtpLogin();
    loginHint.textContent = selectedLoginType === "admin"
      ? "Admin hesabi icin size verilen guvenli sifreyi kullanin."
      : "Tipster girisi icin adminin olusturdugu kullanici adi ve sifre kullanilir.";
    const remembered = document.getElementById("rememberMe").checked;
    if (!remembered) document.getElementById("username").value = selectedLoginType === "admin" ? "admin" : "";
    document.getElementById("password").value = "";
  });
});

document.getElementById("loginForm").addEventListener("submit", async event => {
  event.preventDefault();
  if (loginSubmitting) return;
  loginSubmitting = true;
  const loginSubmitBtn = document.getElementById("loginSubmitBtn");
  const loginSubmitText = loginSubmitBtn.textContent;
  loginSubmitBtn.disabled = true;
  loginSubmitBtn.textContent = pendingLoginToken ? "Kod kontrol ediliyor..." : "Giris kontrol ediliyor...";
  setMessage("loginMessage", "");
  try {
    if (pendingLoginToken) {
      const data = await api("/api/login/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          loginToken: pendingLoginToken,
          code: document.getElementById("otpCode").value.trim(),
          rememberMe: pendingRememberMe
        })
      });

      const loginMatches = pendingLoginType === "admin"
        ? (data.user.role === "admin" || data.user.role === "owner")
        : data.user.role === "member";
      if (!loginMatches) throw new Error("Giris tipi hatali.");

      csrfToken = data.csrf;
      selectedUploadId = "";
      selectedDailyUploadId = "";
      rememberLoginChoice(data.user);
      resetOtpLogin();
      showApp(data.user);
      await loadDashboard("");
      return;
    }

    const data = await api("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: document.getElementById("username").value.trim(),
        password: document.getElementById("password").value,
        loginType: selectedLoginType,
        rememberMe: document.getElementById("rememberMe").checked
      })
    });

    if (data.requiresOtp) {
      pendingLoginToken = data.loginToken;
      pendingLoginType = selectedLoginType;
      pendingRememberMe = document.getElementById("rememberMe").checked;
      document.getElementById("otpPanel").classList.remove("hidden");
      document.getElementById("otpCode").required = true;
      document.getElementById("username").disabled = true;
      document.getElementById("password").disabled = true;
      document.querySelectorAll("[data-login-type]").forEach(item => item.disabled = true);
      document.getElementById("otpHint").textContent = `${data.email || "kayitli e-posta"} adresine gelen 6 haneli kodu gir.`;
      document.getElementById("otpCode").focus();
      setMessage("loginMessage", data.message || "Giris kodu e-posta adresine gonderildi.", true);
      return;
    }

    const loginMatches = selectedLoginType === "admin"
      ? (data.user.role === "admin" || data.user.role === "owner")
      : data.user.role === "member";
    if (!loginMatches) {
      await api("/api/logout", { method: "POST" }).catch(() => {});
      throw new Error(selectedLoginType === "admin" ? "Bu hesap admin hesabi degil." : "Bu hesap tipster hesabi degil.");
    }

    csrfToken = data.csrf;
    selectedUploadId = "";
    selectedDailyUploadId = "";
    rememberLoginChoice(data.user);
    showApp(data.user);
    await loadDashboard("");
  } catch (error) {
    setMessage("loginMessage", error.message);
  } finally {
    loginSubmitting = false;
    loginSubmitBtn.disabled = false;
    loginSubmitBtn.textContent = loginSubmitText;
  }
});

document.getElementById("restartLoginBtn").addEventListener("click", () => {
  resetOtpLogin();
  setMessage("loginMessage", "");
});

document.getElementById("pushEnableBtn").addEventListener("click", enablePushNotifications);
document.getElementById("pushTestBtn").addEventListener("click", sendTestPush);
document.getElementById("pushPromptEnableBtn").addEventListener("click", enablePushNotifications);
document.getElementById("pushPromptLaterBtn").addEventListener("click", () => closePushPrompt(true));

function openKvkk() {
  kvkkModal.classList.remove("hidden");
}

function closeKvkk() {
  kvkkModal.classList.add("hidden");
}

document.getElementById("openKvkkLoginBtn").addEventListener("click", openKvkk);
document.getElementById("openKvkkPanelBtn").addEventListener("click", openKvkk);
document.getElementById("closeKvkkBtn").addEventListener("click", closeKvkk);

document.getElementById("commissionCalcTab").addEventListener("click", () => setCalculatorTab("commission"));
document.getElementById("normalCalcTab").addEventListener("click", () => setCalculatorTab("normal"));
document.getElementById("calculatorAmount").addEventListener("input", calculateAdminTool);
document.getElementById("calculatorPercent").addEventListener("input", () => {
  calculatorMode = "percent";
  calculateAdminTool();
});
document.getElementById("calculatorCommissionInput").addEventListener("input", () => {
  calculatorMode = "commission";
  calculateAdminTool();
});
document.getElementById("calculatorClearBtn").addEventListener("click", () => {
  calculatorMode = "percent";
  document.getElementById("calculatorAmount").value = "";
  document.getElementById("calculatorPercent").value = "";
  document.getElementById("calculatorCommissionInput").value = "";
  calculateAdminTool();
});
document.getElementById("normalCalcPane").addEventListener("click", event => {
  const valueButton = event.target.closest("[data-calc-value]");
  const opButton = event.target.closest("[data-calc-op]");
  if (valueButton) inputNormalCalcValue(valueButton.dataset.calcValue);
  else if (opButton) chooseNormalCalcOperator(opButton.dataset.calcOp);
  else if (event.target.closest("[data-calc-equals]")) finishNormalCalc();
  else if (event.target.closest("[data-calc-clear]")) clearNormalCalc();
  else if (event.target.closest("[data-calc-back]")) {
    normalCalcValue = normalCalcFresh || normalCalcValue.length <= 1 ? "0" : normalCalcValue.slice(0, -1);
    normalCalcFresh = false;
    updateNormalCalcDisplay();
  }
});

document.getElementById("adminCreateForm").addEventListener("submit", async event => {
  event.preventDefault();
  setMessage("adminCreateMessage", "");
  try {
    await api("/api/admins", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: document.getElementById("adminName").value,
        username: document.getElementById("adminUsername").value,
        email: document.getElementById("adminCreateEmail").value,
        phone: document.getElementById("adminCreatePhone").value,
        password: document.getElementById("adminPassword").value,
        accessStartsAt: document.getElementById("adminAccessStartsAt").value,
        accessEndsAt: document.getElementById("adminAccessEndsAt").value
      })
    });
    event.target.reset();
    setDefaultAdminPeriod();
    setMessage("adminCreateMessage", "Admin olusturuldu.", true);
    await loadDashboard(selectedUploadId);
  } catch (error) {
    setMessage("adminCreateMessage", error.message);
  }
});

document.getElementById("adminRows").addEventListener("submit", async event => {
  const form = event.target.closest("form[data-admin-reset]");
  if (!form) return;
  event.preventDefault();
  const input = form.querySelector("input");
  try {
    await api(`/api/admins/${encodeURIComponent(form.dataset.adminReset)}/password`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: input.value })
    });
    input.value = "";
    setMessage("adminCreateMessage", "Admin sifresi yenilendi.", true);
  } catch (error) {
    setMessage("adminCreateMessage", error.message);
  }
});

document.getElementById("adminRows").addEventListener("click", async event => {
  const button = event.target.closest("button[data-admin-delete]");
  if (!button) return;
  const ok = confirm("Bu admin ve ona bagli tipster, Excel, mesaj ve rapor kayitlari silinsin mi?");
  if (!ok) return;
  setMessage("adminCreateMessage", "");
  try {
    await api(`/api/admins/${encodeURIComponent(button.dataset.adminDelete)}`, { method: "DELETE" });
    setMessage("adminCreateMessage", "Admin silindi.", true);
    await loadDashboard(selectedUploadId);
  } catch (error) {
    setMessage("adminCreateMessage", error.message);
  }
});

document.getElementById("adminRows").addEventListener("change", async event => {
  const input = event.target.closest("input[data-admin-shared]");
  if (!input) return;
  setMessage("adminCreateMessage", "");
  try {
    await api(`/api/admins/${encodeURIComponent(input.dataset.adminShared)}/shared-numbers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: input.checked })
    });
    setMessage("adminCreateMessage", input.checked ? "Ortak numara paylasimi acildi." : "Ortak numara paylasimi kapatildi.", true);
    await loadDashboard(selectedUploadId);
  } catch (error) {
    input.checked = !input.checked;
    setMessage("adminCreateMessage", error.message);
  }
});

document.getElementById("logoutBtn").addEventListener("click", async () => {
  await api("/api/logout", { method: "POST" }).catch(() => {});
  csrfToken = "";
  selectedUploadId = "";
  selectedDailyUploadId = "";
  showLogin();
});

document.getElementById("memberForm").addEventListener("submit", async event => {
  event.preventDefault();
  setMessage("memberMessage", "");
  try {
    await api("/api/members", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: document.getElementById("memberName").value,
        username: document.getElementById("memberUsername").value,
        password: document.getElementById("memberPassword").value,
        gsmMasked: document.getElementById("memberGsm").value,
        percentage: document.getElementById("memberPercentage").value
      })
    });
    event.target.reset();
    setMessage("memberMessage", "Tipster olusturuldu.", true);
    await loadDashboard();
  } catch (error) {
    setMessage("memberMessage", error.message);
  }
});

async function submitExcelUpload(event, config) {
  event.preventDefault();
  setMessage("uploadMessage", "");
  const files = Array.from(document.getElementById(config.fileId).files);
  const weekLabel = document.getElementById(config.labelId).value.trim();
  const uploadDate = config.dateId ? document.getElementById(config.dateId).value : "";
  if (!files.length) return;
  try {
    const form = new FormData();
    form.append("weekLabel", weekLabel);
    form.append("uploadType", config.uploadType);
    form.append("uploadDate", uploadDate);
    for (const file of files) form.append("excel", file);
    const data = await api("/api/upload", { method: "POST", body: form });
    event.target.reset();
    setDefaultUploadDate();
    if (config.uploadType === "daily") selectedDailyUploadId = data.uploadId;
    else selectedUploadId = data.uploadId;
    const typeText = config.uploadType === "daily" ? "Gunluk" : "Haftalik";
    setMessage("uploadMessage", `${data.uploads.length} ${typeText} Excel aktarildi, Bonus Disi Kupon Oynama icin ${data.rowCount} satir islendi.`, true);
    await loadDashboard(selectedUploadId, selectedDailyUploadId);
  } catch (error) {
    setMessage("uploadMessage", error.message);
  }
}

function updateFileHelp(event, helpId, emptyText) {
  const files = Array.from(event.target.files);
  document.getElementById(helpId).textContent = files.length
    ? `${files.length} Excel secildi: ${files.map(file => file.name).join(", ")}`
    : emptyText;
}

document.getElementById("weeklyUploadForm").addEventListener("submit", event => submitExcelUpload(event, {
  uploadType: "weekly",
  labelId: "weeklyWeekLabel",
  fileId: "weeklyExcelFile"
}));

document.getElementById("dailyUploadForm").addEventListener("submit", event => submitExcelUpload(event, {
  uploadType: "daily",
  labelId: "dailyWeekLabel",
  dateId: "dailyUploadDate",
  fileId: "dailyExcelFile"
}));

document.getElementById("portalListForm").addEventListener("submit", async event => {
  event.preventDefault();
  setMessage("uploadMessage", "");
  const fileInput = document.getElementById("portalExcelFile");
  const file = fileInput.files[0];
  if (!file) return;
  try {
    const form = new FormData();
    form.append("weekLabel", document.getElementById("portalWeekLabel").value.trim());
    form.append("excel", file);
    const data = await api("/api/portal-list", { method: "POST", body: form });
    event.target.reset();
    document.getElementById("portalFileHelp").textContent = "Bayi Portaldan aldigin telefon numaralari Excelini sec.";
    setMessage("uploadMessage", `${data.portalList.rowCount} numaralik Bayi Portal listesi aktarildi.`, true);
    await loadDashboard(selectedUploadId, selectedDailyUploadId);
  } catch (error) {
    setMessage("uploadMessage", error.message);
  }
});

document.getElementById("weeklyExcelFile").addEventListener("change", event => {
  updateFileHelp(event, "weeklyFileHelp", "Bir veya birden fazla haftalik .xlsx dosyasi secebilirsin.");
});

document.getElementById("dailyExcelFile").addEventListener("change", event => {
  updateFileHelp(event, "dailyFileHelp", "Bir veya birden fazla gunluk .xlsx dosyasi secebilirsin.");
});

document.getElementById("portalExcelFile").addEventListener("change", event => {
  updateFileHelp(event, "portalFileHelp", "Bayi Portaldan aldigin telefon numaralari Excelini sec.");
});

document.getElementById("clearUploadsBtn").addEventListener("click", async () => {
  if (!confirm("Tum Excel yuklemeleri ve Excel satirlari silinsin mi? Tipster hesaplari kalir.")) return;
  try {
    await api("/api/uploads", { method: "DELETE" });
    selectedUploadId = "";
    selectedDailyUploadId = "";
    setMessage("uploadMessage", "Tum Excel kayitlari temizlendi.", true);
    await loadDashboard("");
  } catch (error) {
    setMessage("uploadMessage", error.message);
  }
});

document.getElementById("uploads").addEventListener("click", async event => {
  const button = event.target.closest("button[data-upload-delete]");
  if (!button) return;
  const uploadName = button.dataset.uploadName || "secili Excel";
  if (!confirm(`${uploadName} silinsin mi? Sadece bu Excel ve ona bagli satirlar silinir.`)) return;
  try {
    await api(`/api/uploads/${encodeURIComponent(button.dataset.uploadDelete)}`, { method: "DELETE" });
    selectedUploadId = "";
    selectedDailyUploadId = "";
    setMessage("uploadMessage", "Secili Excel kaydi silindi.", true);
    await loadDashboard("");
  } catch (error) {
    setMessage("uploadMessage", error.message);
  }
});

document.getElementById("uploads").addEventListener("click", async event => {
  const button = event.target.closest("button[data-portal-delete]");
  if (!button) return;
  const listName = button.dataset.portalName || "secili Bayi Portal listesi";
  if (!confirm(`${listName} silinsin mi? Tipster numaralari silinmez.`)) return;
  try {
    await api(`/api/portal-lists/${encodeURIComponent(button.dataset.portalDelete)}`, { method: "DELETE" });
    setMessage("uploadMessage", "Bayi Portal listesi silindi.", true);
    await loadDashboard(selectedUploadId, selectedDailyUploadId);
  } catch (error) {
    setMessage("uploadMessage", error.message);
  }
});

document.getElementById("deleteSelectedDailyUploadBtn").addEventListener("click", async () => {
  if (!selectedDailyUploadId) {
    setMessage("uploadMessage", "Silinecek gunluk Excel secili degil.");
    return;
  }
  const dailyUpload = (currentDashboard?.dailyUploads || []).find(upload => upload.id === selectedDailyUploadId);
  const uploadName = dailyUpload?.weekLabel || dailyUpload?.filename || "secili gunluk Excel";
  if (!confirm(`${uploadName} silinsin mi? Sadece bu gunluk Excel ve ona bagli satirlar silinir.`)) return;
  try {
    await api(`/api/uploads/${encodeURIComponent(selectedDailyUploadId)}`, { method: "DELETE" });
    selectedDailyUploadId = "";
    setMessage("uploadMessage", "Secili gunluk Excel kaydi silindi.", true);
    await loadDashboard(selectedUploadId, "");
  } catch (error) {
    setMessage("uploadMessage", error.message);
  }
});

document.getElementById("paymentForm").addEventListener("submit", async event => {
  event.preventDefault();
  setMessage("paymentMessage", "");
  if (!selectedUploadId || selectedUploadId === "all") {
    setMessage("paymentMessage", "Odeme kaydi icin once belirli bir hafta sec.");
    return;
  }
  try {
    await api("/api/payments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        uploadId: selectedUploadId,
        memberId: document.getElementById("paymentMemberSelect").value,
        paidAmount: document.getElementById("paymentAmount").value,
        paymentDate: document.getElementById("paymentDate").value,
        note: document.getElementById("paymentNote").value
      })
    });
    document.getElementById("paymentAmount").value = "";
    document.getElementById("paymentNote").value = "";
    setDefaultPaymentDate();
    setMessage("paymentMessage", "Odeme kaydi eklendi.", true);
    await loadDashboard(selectedUploadId, selectedDailyUploadId);
  } catch (error) {
    setMessage("paymentMessage", error.message);
  }
});

document.getElementById("paymentRows").addEventListener("click", async event => {
  const button = event.target.closest("button[data-payment-delete]");
  if (!button) return;
  if (!confirm("Bu odeme kaydi silinsin mi?")) return;
  try {
    await api(`/api/payments/${encodeURIComponent(button.dataset.paymentDelete)}`, { method: "DELETE" });
    setMessage("paymentMessage", "Odeme kaydi silindi.", true);
    await loadDashboard(selectedUploadId, selectedDailyUploadId);
  } catch (error) {
    setMessage("paymentMessage", error.message);
  }
});

document.getElementById("createBackupBtn").addEventListener("click", async () => {
  setMessage("backupMessage", "");
  try {
    const data = await api("/api/backups", { method: "POST" });
    renderBackups(data.backups || []);
    setMessage("backupMessage", "Yedek alindi.", true);
    await loadDashboard(selectedUploadId);
  } catch (error) {
    setMessage("backupMessage", error.message);
  }
});

document.getElementById("backupRows").addEventListener("click", event => {
  const button = event.target.closest("button[data-backup-download]");
  if (!button) return;
  window.location.href = `/api/backups/download?file=${button.dataset.backupDownload}`;
});

document.getElementById("adminPasswordForm").addEventListener("submit", async event => {
  event.preventDefault();
  setMessage("passwordMessage", "");
  try {
    await api("/api/admin/password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        currentPassword: document.getElementById("currentAdminPassword").value,
        newPassword: document.getElementById("newAdminPassword").value
      })
    });
    event.target.reset();
    setMessage("passwordMessage", "Admin sifresi guncellendi.", true);
  } catch (error) {
    setMessage("passwordMessage", error.message);
  }
});

document.getElementById("adminEmailForm").addEventListener("submit", async event => {
  event.preventDefault();
  setMessage("emailMessage", "");
  try {
    await api("/api/admin/email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: document.getElementById("adminEmail").value
      })
    });
    setMessage("emailMessage", "Admin e-posta adresi kaydedildi.", true);
    await loadDashboard(selectedUploadId);
  } catch (error) {
    setMessage("emailMessage", error.message);
  }
});

document.getElementById("messageAllMembers").addEventListener("change", () => {
  if (document.getElementById("messageAllMembers").checked) {
    document.querySelectorAll("#messageRecipients input:checked").forEach(input => {
      input.checked = false;
    });
  }
  renderMessageRecipients(currentDashboard?.members || []);
});

document.getElementById("messageRecipients").addEventListener("change", event => {
  if (!event.target.matches("input[type='checkbox']")) return;
  const checkedCount = document.querySelectorAll("#messageRecipients input:checked").length;
  if (checkedCount) document.getElementById("messageAllMembers").checked = false;
  renderMessageRecipients(currentDashboard?.members || []);
});

document.getElementById("messageForm").addEventListener("submit", async event => {
  event.preventDefault();
  setMessage("messageSendMessage", "");
  const allMembers = document.getElementById("messageAllMembers").checked;
  const recipientIds = Array.from(document.querySelectorAll("#messageRecipients input:checked")).map(input => input.value);
  const targetType = recipientIds.length ? "selected" : allMembers ? "all" : "selected";
  try {
    const result = await api("/api/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: document.getElementById("messageTitle").value,
        body: document.getElementById("messageBody").value,
        targetType,
        recipientIds
      })
    });
    event.target.reset();
    document.getElementById("messageAllMembers").checked = true;
    setMessage("messageSendMessage", `Mesaj gonderildi. ${pushResultText(result.push)}`, true);
    await loadDashboard(selectedUploadId);
  } catch (error) {
    setMessage("messageSendMessage", error.message);
  }
});

document.getElementById("assignUnmatchedAdminBtn").addEventListener("click", async () => {
  setMessage("unmatchedNumberMessage", "");
  try {
    const data = await api("/api/unmatched-numbers/assign-admin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uploadId: selectedUploadId || "all", dailyUploadId: selectedDailyUploadId || "" })
    });
    setMessage("unmatchedNumberMessage", `${data.addedCount} numara admin kaydina eklendi.`, true);
    await loadDashboard(selectedUploadId, selectedDailyUploadId);
  } catch (error) {
    setMessage("unmatchedNumberMessage", error.message);
  }
});

document.getElementById("adminFeedbackForm").addEventListener("submit", event => submitFeedbackForm(event, "admin"));
document.getElementById("memberFeedbackForm").addEventListener("submit", event => submitFeedbackForm(event, "member"));

document.getElementById("memberPasswordForm").addEventListener("submit", async event => {
  event.preventDefault();
  setMessage("memberPasswordMessage", "");
  try {
    await api("/api/member/password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        currentPassword: document.getElementById("currentMemberPassword").value,
        newPassword: document.getElementById("newMemberPassword").value
      })
    });
    event.target.reset();
    setMessage("memberPasswordMessage", "Sifre guncellendi.", true);
  } catch (error) {
    setMessage("memberPasswordMessage", error.message);
  }
});

document.getElementById("numberForm").addEventListener("submit", async event => {
  event.preventDefault();
  setMessage("numberMessage", "");
  try {
    await api("/api/my-numbers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: document.getElementById("newGsmName").value,
        gsmMasked: document.getElementById("newGsm").value
      })
    });
    event.target.reset();
    setMessage("numberMessage", "Numara kaydedildi.", true);
    await loadDashboard();
  } catch (error) {
    setMessage("numberMessage", error.message);
  }
});

document.getElementById("numberList").addEventListener("click", async event => {
  const button = event.target.closest("button[data-number-delete]");
  if (!button) return;
  await api(`/api/my-numbers/${button.dataset.numberDelete}`, { method: "DELETE" });
  setMessage("numberMessage", "Numara silindi.", true);
  await loadDashboard();
});

document.getElementById("exportNumbersBtn").addEventListener("click", event => {
  event.preventDefault();
  event.stopPropagation();
  const query = selectedUploadId ? `?uploadId=${encodeURIComponent(selectedUploadId)}` : "";
  window.location.href = `/api/my-numbers/export${query}`;
});

document.getElementById("memberMessageRows").addEventListener("click", async event => {
  const button = event.target.closest("button[data-message-read]");
  if (!button) return;
  try {
    await api(`/api/messages/${encodeURIComponent(button.dataset.messageRead)}/read`, { method: "POST" });
    await loadDashboard(selectedUploadId);
  } catch (error) {
    setMessage("memberPasswordMessage", error.message);
  }
});

mobileSelectIds.forEach(selectId => {
  const select = document.getElementById(selectId);
  if (!select) return;
  select.addEventListener("pointerdown", event => {
    if (!isMobileSelectMode()) return;
    event.preventDefault();
    openMobileSelect(select);
  });
  select.addEventListener("keydown", event => {
    if (!isMobileSelectMode() || !["Enter", " "].includes(event.key)) return;
    event.preventDefault();
    openMobileSelect(select);
  });
  updateMobileSelectTrigger(select);
});

document.getElementById("mobileSelectSearch").addEventListener("input", renderMobileSelectOptions);
document.getElementById("mobileSelectBackBtn").addEventListener("click", () => closeMobileSelect());
document.getElementById("mobileSelectModal").addEventListener("click", event => {
  const option = event.target.closest("[data-mobile-select-value]");
  if (option && mobileSelectTarget) {
    mobileSelectTarget.value = option.dataset.mobileSelectValue;
    updateMobileSelectTrigger(mobileSelectTarget);
    mobileSelectTarget.dispatchEvent(new Event("change", { bubbles: true }));
    closeMobileSelect();
    return;
  }
  if (event.target.id === "mobileSelectModal") closeMobileSelect();
});
document.addEventListener("click", event => {
  const trigger = event.target.closest("[data-mobile-select-trigger]");
  if (!trigger) return;
  const select = document.getElementById(trigger.dataset.mobileSelectTrigger);
  if (openMobileSelect(select)) event.preventDefault();
});

document.addEventListener("toggle", event => {
  const details = event.target;
  if (!(details instanceof HTMLDetailsElement) || !details.classList.contains("collapsible")) return;
  if (details.open) {
    activateMobilePanel(details);
  } else {
    deactivateMobilePanel(details);
  }
}, true);

document.addEventListener("click", event => {
  const activePanel = event.target.closest("details.collapsible.mobile-panel-page");
  if (!activePanel || !isMobilePanelMode()) return;
  const summary = event.target.closest("summary");
  if (summary && summary.parentElement === activePanel && activePanel.open) {
    event.preventDefault();
    activePanel.open = false;
    deactivateMobilePanel(activePanel);
  }
});

window.addEventListener("resize", () => {
  if (isMobilePanelMode()) {
    refreshMobilePanelState();
    return;
  }
  document.querySelectorAll("details.collapsible.mobile-panel-page").forEach(panel => panel.classList.remove("mobile-panel-page"));
  document.body.classList.remove("mobile-panel-open");
});
window.addEventListener("popstate", () => {
  if (!mobileSelectModal.classList.contains("hidden")) closeMobileSelect(true);
});

document.getElementById("adminUploadSelect").addEventListener("change", event => {
  selectedUploadId = event.target.value;
  updateMobileSelectTrigger(event.target);
  loadDashboard(selectedUploadId, selectedDailyUploadId);
});
document.getElementById("adminDailyUploadSelect").addEventListener("change", event => {
  selectedDailyUploadId = event.target.value;
  updateMobileSelectTrigger(event.target);
  loadDashboard(selectedUploadId, selectedDailyUploadId);
});
document.getElementById("adminUploadApplyBtn").addEventListener("click", () => {
  selectedUploadId = document.getElementById("adminUploadSelect").value;
  loadDashboard(selectedUploadId, selectedDailyUploadId);
});
document.getElementById("adminDailyUploadApplyBtn").addEventListener("click", () => {
  selectedDailyUploadId = document.getElementById("adminDailyUploadSelect").value;
  loadDashboard(selectedUploadId, selectedDailyUploadId);
});
document.getElementById("memberUploadSelect").addEventListener("change", event => {
  selectedUploadId = event.target.value;
  updateMobileSelectTrigger(event.target);
  loadDashboard(selectedUploadId, selectedDailyUploadId);
});
document.getElementById("memberDailyUploadSelect").addEventListener("change", event => {
  selectedDailyUploadId = event.target.value;
  updateMobileSelectTrigger(event.target);
  applyMemberDailyUploadSelection();
});
document.getElementById("memberUploadApplyBtn").addEventListener("click", () => {
  selectedUploadId = document.getElementById("memberUploadSelect").value;
  loadDashboard(selectedUploadId, selectedDailyUploadId);
});
document.getElementById("memberDailyUploadApplyBtn").addEventListener("click", () => {
  applyMemberDailyUploadSelection();
});
document.getElementById("detailUploadSelect").addEventListener("change", event => {
  updateMobileSelectTrigger(event.target);
  loadMemberDetail(detailMemberId, event.target.value);
});
document.getElementById("search").addEventListener("input", () => {
  renderMembers();
  renderDailyMembers();
});
document.getElementById("search").addEventListener("keydown", event => {
  if (event.key === "Enter") {
    event.preventDefault();
    renderMembers();
    renderDailyMembers();
  }
});
document.getElementById("searchBtn").addEventListener("click", () => {
  renderMembers();
  renderDailyMembers();
});
document.getElementById("searchClearBtn").addEventListener("click", () => {
  document.getElementById("search").value = "";
  renderMembers();
  renderDailyMembers();
});
document.getElementById("sharedNumberSearch").addEventListener("input", () => renderSharedNumbers());
document.getElementById("sharedNumberSearch").addEventListener("keydown", event => {
  if (event.key === "Enter") {
    event.preventDefault();
    renderSharedNumbers();
  }
});
document.getElementById("sharedNumberSearchBtn").addEventListener("click", () => renderSharedNumbers());
document.getElementById("sharedNumberClearBtn").addEventListener("click", () => {
  document.getElementById("sharedNumberSearch").value = "";
  renderSharedNumbers();
});
document.getElementById("portalRegisteredExportBtn").addEventListener("click", () => {
  window.location.href = "/api/portal-comparison/export?status=registered";
});
document.getElementById("portalUnregisteredExportBtn").addEventListener("click", () => {
  window.location.href = "/api/portal-comparison/export?status=unregistered";
});
document.getElementById("numberSearch").addEventListener("input", () => {
  if (currentDashboard?.role === "member") renderNumbers(numberRecordsOf(currentDashboard.member));
});
document.getElementById("numberSearch").addEventListener("keydown", event => {
  if (event.key === "Enter") {
    event.preventDefault();
    if (currentDashboard?.role === "member") renderNumbers(numberRecordsOf(currentDashboard.member));
  }
});
document.getElementById("numberSearchBtn").addEventListener("click", () => {
  if (currentDashboard?.role === "member") renderNumbers(numberRecordsOf(currentDashboard.member));
});
document.getElementById("numberClearBtn").addEventListener("click", () => {
  document.getElementById("numberSearch").value = "";
  if (currentDashboard?.role === "member") renderNumbers(numberRecordsOf(currentDashboard.member));
});
document.getElementById("numberListSort").addEventListener("change", () => {
  if (currentDashboard?.role === "member") renderNumbers(numberRecordsOf(currentDashboard.member));
});
document.getElementById("memberPortalRegisteredExportBtn").addEventListener("click", () => {
  window.location.href = "/api/portal-comparison/export?status=registered";
});
document.getElementById("memberPortalUnregisteredExportBtn").addEventListener("click", () => {
  window.location.href = "/api/portal-comparison/export?status=unregistered";
});
document.getElementById("myRowsSort").addEventListener("change", () => {
  if (currentDashboard?.role === "member") renderMyRows(currentDashboard.rows || []);
});
document.getElementById("commissionRowsSort").addEventListener("change", () => {
  if (currentDashboard?.role === "member") renderCommissionRows(currentDashboard.numberSummaries || []);
});
document.getElementById("adminMemberSort").addEventListener("change", () => {
  if (currentDashboard?.role !== "member") renderMembers();
});
document.getElementById("adminDailyMemberSort").addEventListener("change", () => {
  if (currentDashboard?.role !== "member") renderDailyMembers();
});

function toggleAdminNumberList(button) {
  const key = button.dataset.numberToggle;
  if (!key) return;
  if (expandedAdminNumbers.has(key)) expandedAdminNumbers.delete(key);
  else expandedAdminNumbers.add(key);
  renderMembers();
  renderDailyMembers();
}

document.getElementById("memberRows").addEventListener("click", async event => {
  const toggleButton = event.target.closest("button[data-number-toggle]");
  if (toggleButton) {
    toggleAdminNumberList(toggleButton);
    return;
  }
  const detailButton = event.target.closest("button[data-detail]");
  if (detailButton) {
    setMessage("detailMessage", "");
    await loadMemberDetail(detailButton.dataset.detail, selectedUploadId || "all");
    return;
  }
  const deleteButton = event.target.closest("button[data-delete]");
  if (!deleteButton) return;
  if (!confirm("Bu tipster silinsin mi?")) return;
  await api(`/api/members/${deleteButton.dataset.delete}`, { method: "DELETE" });
  await loadDashboard();
});

document.getElementById("dailyMemberRows").addEventListener("click", event => {
  const toggleButton = event.target.closest("button[data-number-toggle]");
  if (toggleButton) toggleAdminNumberList(toggleButton);
});

document.getElementById("detailEditForm").addEventListener("submit", async event => {
  event.preventDefault();
  setMessage("detailMessage", "");
  try {
    const password = document.getElementById("detailPassword").value;
    await api(`/api/members/${encodeURIComponent(detailMemberId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: document.getElementById("detailName").value,
        gsmMasked: document.getElementById("detailGsm").value,
        percentage: document.getElementById("detailPercentage").value,
        ...(password ? { password } : {})
      })
    });
    setMessage("detailMessage", "Tipster bilgileri guncellendi.", true);
    await loadDashboard(selectedUploadId);
    await loadMemberDetail(detailMemberId, detailUploadId);
  } catch (error) {
    setMessage("detailMessage", error.message);
  }
});

document.getElementById("closeDetailBtn").addEventListener("click", () => {
  detailModal.classList.add("hidden");
});

detailModal.addEventListener("click", event => {
  if (event.target === detailModal) detailModal.classList.add("hidden");
});

kvkkModal.addEventListener("click", event => {
  if (event.target === kvkkModal) closeKvkk();
});

setDefaultAdminPeriod();
setDefaultUploadDate();
setDefaultPaymentDate();

api("/api/me").then(async data => {
  setDefaultAdminPeriod();
  setDefaultUploadDate();
  setDefaultPaymentDate();
  if (!data.user) {
    restoreRememberedLogin();
    document.getElementById("password").value = "";
    return;
  }
  csrfToken = data.csrf;
  showApp(data.user);
  await loadDashboard("");
}).catch(() => {});

setInterval(() => {
  if (currentDashboard?.role !== "member" || document.hidden) return;
  loadDashboard(selectedUploadId).catch(() => {});
}, 60000);
