let csrfToken = "";
let currentDashboard = null;
let selectedLoginType = "admin";
let selectedUploadId = "";

const loginView = document.getElementById("loginView");
const appView = document.getElementById("appView");
const adminPanel = document.getElementById("adminPanel");
const memberPanel = document.getElementById("memberPanel");
const loginHint = document.getElementById("loginHint");

const money = new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 2 });

function setMessage(id, text, ok = false) {
  const el = document.getElementById(id);
  el.textContent = text || "";
  el.style.color = ok ? "var(--ok)" : "var(--danger)";
}

function api(path, options = {}) {
  const headers = options.headers || {};
  if (csrfToken && options.method && options.method !== "GET") headers["X-CSRF-Token"] = csrfToken;
  return fetch(path, { ...options, headers }).then(async response => {
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "İşlem başarısız.");
    return data;
  });
}

function showApp(user) {
  loginView.classList.add("hidden");
  appView.classList.remove("hidden");
  document.getElementById("panelTitle").textContent = user.role === "admin" ? "Admin Paneli" : user.name;
  document.getElementById("panelSubtitle").textContent = user.role === "admin"
    ? "Tipsterlar, Excel haftaları ve hesaplamalar burada yönetilir."
    : "Numaralarını ve haftalık hesaplarını buradan takip ediyorsun.";
}

function showLogin() {
  appView.classList.add("hidden");
  loginView.classList.remove("hidden");
  adminPanel.classList.add("hidden");
  memberPanel.classList.add("hidden");
}

function uploadLabel(upload) {
  if (!upload) return "Tüm haftalar";
  return `${upload.weekLabel || upload.filename} (${upload.rowCount} satır)`;
}

function renderUploadSelect(selectId, uploads, selected) {
  const select = document.getElementById(selectId);
  select.innerHTML = uploads.length
    ? `<option value="all">Tüm haftalar</option>` + uploads.map(upload => `<option value="${upload.id}">${escapeHtml(uploadLabel(upload))}</option>`).join("")
    : `<option value="all">Excel yüklenmedi</option>`;
  select.value = selected || uploads[0]?.id || "all";
}

function renderAdmin(data) {
  currentDashboard = data;
  selectedUploadId = data.selectedUploadId;
  adminPanel.classList.remove("hidden");
  memberPanel.classList.add("hidden");
  renderUploadSelect("adminUploadSelect", data.uploads, data.selectedUploadId);
  document.getElementById("memberCount").textContent = data.summary.memberCount;
  document.getElementById("rowCount").textContent = data.summary.rowCount;
  document.getElementById("totalAmount").textContent = money.format(data.summary.totalAmount);
  renderMembers();
  document.getElementById("uploads").innerHTML = data.uploads.map(upload => `
    <div class="upload-item">
      <strong>${escapeHtml(upload.weekLabel || upload.filename)}</strong><br>
      ${escapeHtml(upload.filename)} - ${upload.rowCount} satır - ${new Date(upload.createdAt).toLocaleString("tr-TR")}
    </div>
  `).join("") || `<p class="muted">Henüz Excel yüklenmedi.</p>`;
}

function renderMembers() {
  const query = document.getElementById("search").value.trim().toLocaleLowerCase("tr");
  const rows = currentDashboard.members.filter(member => {
    const text = `${member.name} ${member.username} ${member.gsmList?.join(" ") || ""}`.toLocaleLowerCase("tr");
    return text.includes(query);
  });
  document.getElementById("memberRows").innerHTML = rows.map(member => `
    <tr>
      <td><strong>${escapeHtml(member.name)}</strong><br><span class="muted">${escapeHtml(member.username)}</span></td>
      <td>${escapeHtml((member.gsmList || []).join(", ") || "-")}</td>
      <td>%${money.format(member.percentage)}</td>
      <td>${member.rowCount}</td>
      <td>${money.format(member.total)}</td>
      <td><strong>${money.format(member.calculated)}</strong></td>
      <td><button class="danger" data-delete="${member.id}" type="button">Sil</button></td>
    </tr>
  `).join("") || `<tr><td colspan="7">Tipster bulunamadı.</td></tr>`;
}

function renderMember(data) {
  selectedUploadId = data.selectedUploadId;
  adminPanel.classList.add("hidden");
  memberPanel.classList.remove("hidden");
  const numbers = data.member.gsmList || [];
  renderUploadSelect("memberUploadSelect", data.uploads, data.selectedUploadId);
  document.getElementById("myGsm").textContent = numbers.length;
  document.getElementById("myTotal").textContent = money.format(data.total);
  document.getElementById("myCalculated").textContent = money.format(data.calculated);
  document.getElementById("myRate").textContent = `%${money.format(data.percentage || data.member.percentage || 0)}`;
  renderCommissionRows(data.numberSummaries || []);
  renderNumbers(numbers);
  document.getElementById("myRows").innerHTML = data.rows.map(row => `
    <tr>
      <td>${escapeHtml(row.gsmMasked || "-")}</td>
      <td>${escapeHtml(row.processType || "-")}</td>
      <td>${money.format(row.totalAmount)}</td>
      <td>${new Date(row.importedAt).toLocaleString("tr-TR")}</td>
    </tr>
  `).join("") || `<tr><td colspan="4">Bu hafta için kayıt bulunamadı.</td></tr>`;
}

function renderCommissionRows(rows) {
  document.getElementById("commissionRows").innerHTML = rows.map(row => `
    <tr>
      <td><strong>${escapeHtml(row.number)}</strong></td>
      <td>${row.rowCount}</td>
      <td>${money.format(row.total)}</td>
      <td><strong>${money.format(row.calculated)}</strong></td>
    </tr>
  `).join("") || `<tr><td colspan="4">Bu hafta için kayıtlı numaralarda eşleşme bulunamadı.</td></tr>`;
}

function renderNumbers(numbers) {
  document.getElementById("numberList").innerHTML = numbers.map(number => `
    <div class="number-item">
      <strong>${escapeHtml(number)}</strong>
      <button class="danger" type="button" data-number-delete="${encodeURIComponent(number)}">Sil</button>
    </div>
  `).join("") || `<p class="muted">Henüz numara kaydedilmedi.</p>`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

async function loadDashboard(uploadId = selectedUploadId) {
  const query = uploadId ? `?uploadId=${encodeURIComponent(uploadId)}` : "";
  const data = await api(`/api/dashboard${query}`);
  if (data.role === "admin") renderAdmin(data);
  else renderMember(data);
}

document.querySelectorAll("[data-login-type]").forEach(button => {
  button.addEventListener("click", () => {
    selectedLoginType = button.dataset.loginType;
    document.querySelectorAll("[data-login-type]").forEach(item => item.classList.remove("active"));
    button.classList.add("active");
    setMessage("loginMessage", "");
    loginHint.innerHTML = selectedLoginType === "admin"
      ? "Admin başlangıç bilgisi: <strong>admin</strong> / <strong>1234</strong>"
      : "Tipster girişi için adminin oluşturduğu kullanıcı adı ve şifre kullanılır.";
    document.getElementById("username").value = selectedLoginType === "admin" ? "admin" : "";
    document.getElementById("password").value = selectedLoginType === "admin" ? "1234" : "";
  });
});

document.getElementById("loginForm").addEventListener("submit", async event => {
  event.preventDefault();
  setMessage("loginMessage", "");
  try {
    const data = await api("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: document.getElementById("username").value.trim(),
        password: document.getElementById("password").value
      })
    });

    if (data.user.role !== selectedLoginType) {
      await api("/api/logout", { method: "POST" }).catch(() => {});
      throw new Error(selectedLoginType === "admin" ? "Bu hesap admin hesabı değil." : "Bu hesap tipster hesabı değil.");
    }

    csrfToken = data.csrf;
    selectedUploadId = "";
    showApp(data.user);
    await loadDashboard("");
  } catch (error) {
    setMessage("loginMessage", error.message);
  }
});

document.getElementById("logoutBtn").addEventListener("click", async () => {
  await api("/api/logout", { method: "POST" }).catch(() => {});
  csrfToken = "";
  selectedUploadId = "";
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
    setMessage("memberMessage", "Tipster oluşturuldu.", true);
    await loadDashboard();
  } catch (error) {
    setMessage("memberMessage", error.message);
  }
});

document.getElementById("uploadForm").addEventListener("submit", async event => {
  event.preventDefault();
  setMessage("uploadMessage", "");
  const files = Array.from(document.getElementById("excelFile").files);
  const weekLabel = document.getElementById("weekLabel").value.trim();
  if (!files.length) return;
  try {
    const form = new FormData();
    form.append("weekLabel", weekLabel);
    for (const file of files) {
      form.append("excel", file);
    }
    const data = await api("/api/upload", { method: "POST", body: form });
    event.target.reset();
    selectedUploadId = data.uploadId;
    setMessage("uploadMessage", `${data.uploads.length} Excel aktar?ld?, toplam ${data.rowCount} sat?r i?lendi.`, true);
    await loadDashboard(data.uploadId);
  } catch (error) {
    setMessage("uploadMessage", error.message);
  }
});

document.getElementById("excelFile").addEventListener("change", event => {
  const files = Array.from(event.target.files);
  document.getElementById("fileHelp").textContent = files.length
    ? `${files.length} Excel seçildi: ${files.map(file => file.name).join(", ")}`
    : "Bir veya birden fazla `.xlsx` dosyası seçebilirsin.";
});

document.getElementById("copyPhoneLink").addEventListener("click", async () => {
  const input = document.getElementById("phoneLink");
  try {
    await navigator.clipboard.writeText(input.value);
    setMessage("uploadMessage", "Telefon giriş linki kopyalandı.", true);
  } catch {
    input.select();
    document.execCommand("copy");
    setMessage("uploadMessage", "Telefon giriş linki kopyalandı.", true);
  }
});

document.getElementById("clearUploadsBtn").addEventListener("click", async () => {
  if (!confirm("Tüm Excel yüklemeleri ve Excel satırları silinsin mi? Tipster hesapları kalır.")) return;
  try {
    await api("/api/uploads", { method: "DELETE" });
    selectedUploadId = "";
    setMessage("uploadMessage", "Tüm Excel kayıtları temizlendi.", true);
    await loadDashboard("");
  } catch (error) {
    setMessage("uploadMessage", error.message);
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

document.getElementById("adminUploadSelect").addEventListener("change", event => {
  loadDashboard(event.target.value);
});

document.getElementById("memberUploadSelect").addEventListener("change", event => {
  loadDashboard(event.target.value);
});

document.getElementById("search").addEventListener("input", renderMembers);

document.getElementById("memberRows").addEventListener("click", async event => {
  const button = event.target.closest("button[data-delete]");
  if (!button) return;
  if (!confirm("Bu tipster silinsin mi?")) return;
  await api(`/api/members/${button.dataset.delete}`, { method: "DELETE" });
  await loadDashboard();
});

api("/api/me").then(async data => {
  if (!data.user) {
    document.getElementById("username").value = "admin";
    document.getElementById("password").value = "1234";
    return;
  }
  csrfToken = data.csrf;
  showApp(data.user);
  await loadDashboard("");
}).catch(() => {});
