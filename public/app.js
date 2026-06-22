let csrfToken = "";
let currentDashboard = null;
let selectedLoginType = "admin";
let selectedUploadId = "";
let detailMemberId = "";
let detailUploadId = "";

const loginView = document.getElementById("loginView");
const appView = document.getElementById("appView");
const adminPanel = document.getElementById("adminPanel");
const memberPanel = document.getElementById("memberPanel");
const loginHint = document.getElementById("loginHint");
const detailModal = document.getElementById("memberDetailModal");

const money = new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 2 });

function setMessage(id, text, ok = false) {
  const el = document.getElementById(id);
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

function api(path, options = {}) {
  const headers = options.headers || {};
  if (csrfToken && options.method && options.method !== "GET") headers["X-CSRF-Token"] = csrfToken;
  return fetch(path, { ...options, headers }).then(async response => {
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Islem basarisiz.");
    return data;
  });
}

function showApp(user) {
  loginView.classList.add("hidden");
  appView.classList.remove("hidden");
  document.getElementById("panelTitle").textContent = user.role === "admin" ? "Admin Paneli" : user.name;
  document.getElementById("panelSubtitle").textContent = user.role === "admin"
    ? "Tipsterlar, Excel haftalari ve hesaplamalar burada yonetilir."
    : "Numaralarini ve haftalik hesaplarini buradan takip ediyorsun.";
}

function showLogin() {
  appView.classList.add("hidden");
  loginView.classList.remove("hidden");
  adminPanel.classList.add("hidden");
  memberPanel.classList.add("hidden");
  detailModal.classList.add("hidden");
}

function uploadLabel(upload) {
  if (!upload) return "Tum haftalar";
  return `${upload.weekLabel || upload.filename} (${upload.rowCount} satir)`;
}

function renderUploadSelect(selectId, uploads, selected) {
  const select = document.getElementById(selectId);
  select.innerHTML = uploads.length
    ? `<option value="all">Tum haftalar</option>` + uploads.map(upload => `<option value="${upload.id}">${escapeHtml(uploadLabel(upload))}</option>`).join("")
    : `<option value="all">Excel yuklenmedi</option>`;
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
  document.getElementById("totalCommission").textContent = money.format(data.summary.totalCommission || 0);
  renderMembers();
  document.getElementById("uploads").innerHTML = data.uploads.map(upload => `
    <div class="upload-item">
      <strong>${escapeHtml(upload.weekLabel || upload.filename)}</strong><br>
      ${escapeHtml(upload.filename)} - ${upload.rowCount} satir - ${new Date(upload.createdAt).toLocaleString("tr-TR")}
    </div>
  `).join("") || `<p class="muted">Henuz Excel yuklenmedi.</p>`;
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
      <td class="action-cell">
        <button class="ghost small" data-detail="${member.id}" type="button">Detay</button>
        <button class="danger small" data-delete="${member.id}" type="button">Sil</button>
      </td>
    </tr>
  `).join("") || `<tr><td colspan="7">Tipster bulunamadi.</td></tr>`;
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
  `).join("") || `<tr><td colspan="4">Bu hafta icin kayit bulunamadi.</td></tr>`;
}

function renderCommissionRows(rows) {
  document.getElementById("commissionRows").innerHTML = rows.map(row => `
    <tr>
      <td><strong>${escapeHtml(row.number)}</strong></td>
      <td>${row.rowCount}</td>
      <td>${money.format(row.total)}</td>
      <td><strong>${money.format(row.calculated)}</strong></td>
    </tr>
  `).join("") || `<tr><td colspan="4">Bu hafta icin kayitli numaralarda eslesme bulunamadi.</td></tr>`;
}

function renderNumbers(numbers) {
  document.getElementById("numberList").innerHTML = numbers.map(number => `
    <div class="number-item">
      <strong>${escapeHtml(number)}</strong>
      <button class="danger small" type="button" data-number-delete="${encodeURIComponent(number)}">Sil</button>
    </div>
  `).join("") || `<p class="muted">Henuz numara kaydedilmedi.</p>`;
}

async function loadDashboard(uploadId = selectedUploadId) {
  const query = uploadId ? `?uploadId=${encodeURIComponent(uploadId)}` : "";
  const data = await api(`/api/dashboard${query}`);
  if (data.role === "admin") renderAdmin(data);
  else renderMember(data);
}

async function loadMemberDetail(memberId, uploadId = detailUploadId || selectedUploadId || "all") {
  detailMemberId = memberId;
  detailUploadId = uploadId;
  const data = await api(`/api/members/${encodeURIComponent(memberId)}/details?uploadId=${encodeURIComponent(uploadId)}`);
  detailUploadId = data.selectedUploadId;
  detailModal.classList.remove("hidden");
  document.getElementById("detailTitle").textContent = data.member.name;
  document.getElementById("detailSubtitle").textContent = `${data.member.username} - ${data.member.gsmList.join(", ") || "Numara yok"}`;
  document.getElementById("detailName").value = data.member.name;
  document.getElementById("detailGsm").value = data.member.gsmMasked || data.member.gsmList[0] || "";
  document.getElementById("detailPercentage").value = data.member.percentage;
  document.getElementById("detailPassword").value = "";
  document.getElementById("detailTotal").textContent = money.format(data.total);
  document.getElementById("detailCalculated").textContent = money.format(data.calculated);
  renderUploadSelect("detailUploadSelect", data.uploads, data.selectedUploadId);
  document.getElementById("detailNumberRows").innerHTML = (data.numberSummaries || []).map(row => `
    <tr>
      <td><strong>${escapeHtml(row.number)}</strong></td>
      <td>${row.rowCount}</td>
      <td>${money.format(row.total)}</td>
      <td><strong>${money.format(row.calculated)}</strong></td>
    </tr>
  `).join("") || `<tr><td colspan="4">Bu hafta icin eslesme bulunamadi.</td></tr>`;
}

document.querySelectorAll("[data-login-type]").forEach(button => {
  button.addEventListener("click", () => {
    selectedLoginType = button.dataset.loginType;
    document.querySelectorAll("[data-login-type]").forEach(item => item.classList.remove("active"));
    button.classList.add("active");
    setMessage("loginMessage", "");
    loginHint.textContent = selectedLoginType === "admin"
      ? "Admin hesabi icin size verilen guvenli sifreyi kullanin."
      : "Tipster girisi icin adminin olusturdugu kullanici adi ve sifre kullanilir.";
    document.getElementById("username").value = selectedLoginType === "admin" ? "admin" : "";
    document.getElementById("password").value = "";
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
      throw new Error(selectedLoginType === "admin" ? "Bu hesap admin hesabi degil." : "Bu hesap tipster hesabi degil.");
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
    setMessage("memberMessage", "Tipster olusturuldu.", true);
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
    for (const file of files) form.append("excel", file);
    const data = await api("/api/upload", { method: "POST", body: form });
    event.target.reset();
    selectedUploadId = data.uploadId;
    setMessage("uploadMessage", `${data.uploads.length} Excel aktarildi, toplam ${data.rowCount} satir islendi.`, true);
    await loadDashboard(data.uploadId);
  } catch (error) {
    setMessage("uploadMessage", error.message);
  }
});

document.getElementById("excelFile").addEventListener("change", event => {
  const files = Array.from(event.target.files);
  document.getElementById("fileHelp").textContent = files.length
    ? `${files.length} Excel secildi: ${files.map(file => file.name).join(", ")}`
    : "Bir veya birden fazla .xlsx dosyasi secebilirsin.";
});

document.getElementById("clearUploadsBtn").addEventListener("click", async () => {
  if (!confirm("Tum Excel yuklemeleri ve Excel satirlari silinsin mi? Tipster hesaplari kalir.")) return;
  try {
    await api("/api/uploads", { method: "DELETE" });
    selectedUploadId = "";
    setMessage("uploadMessage", "Tum Excel kayitlari temizlendi.", true);
    await loadDashboard("");
  } catch (error) {
    setMessage("uploadMessage", error.message);
  }
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

document.getElementById("numberForm").addEventListener("submit", async event => {
  event.preventDefault();
  setMessage("numberMessage", "");
  try {
    await api("/api/my-numbers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ gsmMasked: document.getElementById("newGsm").value })
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

document.getElementById("adminUploadSelect").addEventListener("change", event => loadDashboard(event.target.value));
document.getElementById("memberUploadSelect").addEventListener("change", event => loadDashboard(event.target.value));
document.getElementById("detailUploadSelect").addEventListener("change", event => loadMemberDetail(detailMemberId, event.target.value));
document.getElementById("search").addEventListener("input", renderMembers);

document.getElementById("memberRows").addEventListener("click", async event => {
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

api("/api/me").then(async data => {
  if (!data.user) {
    document.getElementById("username").value = "admin";
    document.getElementById("password").value = "";
    return;
  }
  csrfToken = data.csrf;
  showApp(data.user);
  await loadDashboard("");
}).catch(() => {});
