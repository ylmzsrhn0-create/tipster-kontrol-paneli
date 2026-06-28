let csrfToken = "";
let currentDashboard = null;
let selectedLoginType = "admin";
let selectedUploadId = "";
let detailMemberId = "";
let detailUploadId = "";
let pendingLoginToken = "";
let pendingLoginType = "";

const loginView = document.getElementById("loginView");
const appView = document.getElementById("appView");
const adminPanel = document.getElementById("adminPanel");
const ownerPanel = document.getElementById("ownerPanel");
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
  ownerPanel.classList.add("hidden");
  adminPanel.classList.add("hidden");
  memberPanel.classList.add("hidden");
  detailModal.classList.add("hidden");
}

function resetOtpLogin() {
  pendingLoginToken = "";
  pendingLoginType = "";
  document.getElementById("otpPanel").classList.add("hidden");
  document.getElementById("otpCode").required = false;
  document.getElementById("otpCode").value = "";
  document.getElementById("username").disabled = false;
  document.getElementById("password").disabled = false;
  document.querySelectorAll("[data-login-type]").forEach(item => item.disabled = false);
}

function uploadLabel(upload) {
  if (!upload) return "Tum haftalar";
  return `${upload.weekLabel || upload.filename} (${upload.rowCount} satir)`;
}

function numberRecordsOf(member) {
  if (Array.isArray(member.numberRecords)) return member.numberRecords;
  return (member.gsmList || []).map(number => ({ number, name: "" }));
}

function numberRecordText(member) {
  return numberRecordsOf(member).map(record => record.name ? `${record.name} (${record.number})` : record.number).join(", ");
}

function renderUploadSelect(selectId, uploads, selected) {
  const select = document.getElementById(selectId);
  select.innerHTML = uploads.length
    ? `<option value="all">Tum haftalar</option>` + uploads.map(upload => `<option value="${upload.id}">${escapeHtml(uploadLabel(upload))}</option>`).join("")
    : `<option value="all">Excel yuklenmedi</option>`;
  select.value = selected || uploads[0]?.id || "all";
}

function renderAdmin(data, keepOwnerPanel = false) {
  currentDashboard = data;
  selectedUploadId = data.selectedUploadId;
  if (!keepOwnerPanel) ownerPanel.classList.add("hidden");
  adminPanel.classList.remove("hidden");
  memberPanel.classList.add("hidden");
  renderUploadSelect("adminUploadSelect", data.uploads, data.selectedUploadId);
  document.getElementById("adminEmail").value = data.currentAdmin?.email || "";
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

function renderOwner(data) {
  ownerPanel.classList.remove("hidden");
  renderAdmin(data, true);
  renderAdmins(data.admins || []);
}

function renderAdmins(admins) {
  document.getElementById("adminRows").innerHTML = admins.map(admin => `
    <div class="admin-item">
      <div>
        <strong>${escapeHtml(admin.name)}</strong>
        <span>${escapeHtml(admin.username)}</span>
        <span>${escapeHtml(admin.email || "E-posta yok")}</span>
      </div>
      <form class="reset-admin-form" data-admin-reset="${admin.id}">
        <input type="password" minlength="8" placeholder="Yeni sifre" required>
        <button class="ghost small" type="submit">Sifre yenile</button>
      </form>
    </div>
  `).join("") || `<p class="muted">Henuz alt admin olusturulmadi.</p>`;
}

function renderMembers() {
  const query = document.getElementById("search").value.trim().toLocaleLowerCase("tr");
  const rows = currentDashboard.members.filter(member => {
    const text = `${member.name} ${member.username} ${numberRecordText(member)}`.toLocaleLowerCase("tr");
    return text.includes(query);
  });
  document.getElementById("memberRows").innerHTML = rows.map(member => `
    <tr>
      <td><strong>${escapeHtml(member.name)}</strong><br><span class="muted">${escapeHtml(member.username)}</span></td>
      <td>${escapeHtml(numberRecordText(member) || "-")}</td>
      <td><strong>${member.numberCount ?? numberRecordsOf(member).length}</strong></td>
      <td>%${money.format(member.percentage)}</td>
      <td>${member.rowCount}</td>
      <td>${money.format(member.total)}</td>
      <td><strong>${money.format(member.calculated)}</strong></td>
      <td class="action-cell">
        <button class="ghost small" data-detail="${member.id}" type="button">Detay</button>
        <button class="danger small" data-delete="${member.id}" type="button">Sil</button>
      </td>
    </tr>
  `).join("") || `<tr><td colspan="8">Tipster bulunamadi.</td></tr>`;
}

function renderMember(data) {
  selectedUploadId = data.selectedUploadId;
  adminPanel.classList.add("hidden");
  memberPanel.classList.remove("hidden");
  const numbers = numberRecordsOf(data.member);
  renderUploadSelect("memberUploadSelect", data.uploads, data.selectedUploadId);
  document.getElementById("myGsm").textContent = numbers.length;
  document.getElementById("myTotal").textContent = money.format(data.total);
  document.getElementById("myCalculated").textContent = money.format(data.calculated);
  document.getElementById("myRate").textContent = `%${money.format(data.percentage || data.member.percentage || 0)}`;
  renderCommissionRows(data.numberSummaries || []);
  renderNumbers(numbers);
  renderMyRows(data.rows || []);
}

function renderMyRows(rows) {
  const sort = document.getElementById("myRowsSort").value;
  const visibleRows = [...rows];
  if (sort === "desc") visibleRows.sort((a, b) => Number(b.totalAmount || 0) - Number(a.totalAmount || 0));
  if (sort === "asc") visibleRows.sort((a, b) => Number(a.totalAmount || 0) - Number(b.totalAmount || 0));
  document.getElementById("myRows").innerHTML = visibleRows.map(row => `
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
      <td>${escapeHtml(row.name || "-")}</td>
      <td><strong>${escapeHtml(row.number)}</strong></td>
      <td><span class="status-pill ${row.active ? "active" : "passive"}">${row.active ? "Aktif" : "Pasif"}</span></td>
      <td>${row.rowCount}</td>
      <td>${money.format(row.total)}</td>
      <td><strong>${money.format(row.calculated)}</strong></td>
    </tr>
  `).join("") || `<tr><td colspan="6">Bu hafta icin kayitli numaralarda eslesme bulunamadi.</td></tr>`;
}

function renderNumbers(records) {
  document.getElementById("numberList").innerHTML = records.map(record => `
    <div class="number-item">
      <div>
        <strong>${escapeHtml(record.name || "Isimsiz")}</strong>
        <span>${escapeHtml(record.number)}</span>
      </div>
      <button class="danger small" type="button" data-number-delete="${encodeURIComponent(record.number)}">Sil</button>
    </div>
  `).join("") || `<p class="muted">Henuz numara kaydedilmedi.</p>`;
}

async function loadDashboard(uploadId = selectedUploadId) {
  const query = uploadId ? `?uploadId=${encodeURIComponent(uploadId)}` : "";
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
      <td>${escapeHtml(row.name || "-")}</td>
      <td><strong>${escapeHtml(row.number)}</strong></td>
      <td><span class="status-pill ${row.active ? "active" : "passive"}">${row.active ? "Aktif" : "Pasif"}</span></td>
      <td>${row.rowCount}</td>
      <td>${money.format(row.total)}</td>
      <td><strong>${money.format(row.calculated)}</strong></td>
    </tr>
  `).join("") || `<tr><td colspan="6">Bu hafta icin eslesme bulunamadi.</td></tr>`;
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
    document.getElementById("username").value = selectedLoginType === "admin" ? "admin" : "";
    document.getElementById("password").value = "";
  });
});

document.getElementById("loginForm").addEventListener("submit", async event => {
  event.preventDefault();
  setMessage("loginMessage", "");
  try {
    if (pendingLoginToken) {
      const data = await api("/api/login/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          loginToken: pendingLoginToken,
          code: document.getElementById("otpCode").value.trim()
        })
      });

      const loginMatches = pendingLoginType === "admin"
        ? (data.user.role === "admin" || data.user.role === "owner")
        : data.user.role === "member";
      if (!loginMatches) throw new Error("Giris tipi hatali.");

      csrfToken = data.csrf;
      selectedUploadId = "";
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
        loginType: selectedLoginType
      })
    });

    if (data.requiresOtp) {
      pendingLoginToken = data.loginToken;
      pendingLoginType = selectedLoginType;
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
    showApp(data.user);
    await loadDashboard("");
  } catch (error) {
    setMessage("loginMessage", error.message);
  }
});

document.getElementById("restartLoginBtn").addEventListener("click", () => {
  resetOtpLogin();
  setMessage("loginMessage", "");
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
        password: document.getElementById("adminPassword").value
      })
    });
    event.target.reset();
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
    setMessage("uploadMessage", `${data.uploads.length} Excel aktarildi, Bonus Disi Kupon Oynama icin ${data.rowCount} satir islendi.`, true);
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

document.getElementById("adminUploadSelect").addEventListener("change", event => loadDashboard(event.target.value));
document.getElementById("memberUploadSelect").addEventListener("change", event => loadDashboard(event.target.value));
document.getElementById("detailUploadSelect").addEventListener("change", event => loadMemberDetail(detailMemberId, event.target.value));
document.getElementById("search").addEventListener("input", renderMembers);
document.getElementById("myRowsSort").addEventListener("change", () => {
  if (currentDashboard?.role === "member") renderMyRows(currentDashboard.rows || []);
});

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
