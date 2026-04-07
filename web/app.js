const els = {
  accountsList: document.getElementById("accountsList"),
  accountsEmpty: document.getElementById("accountsEmpty"),
  checkboxWrap: document.getElementById("checkboxWrap"),
  postsList: document.getElementById("postsList"),
  postsEmpty: document.getElementById("postsEmpty"),
  addAccountBtn: document.getElementById("addAccountBtn"),
  refreshBtn: document.getElementById("refreshBtn"),
  postForm: document.getElementById("postForm"),
  fileInput: document.getElementById("fileInput"),
  captionInput: document.getElementById("captionInput"),
  timeInput: document.getElementById("timeInput"),
  previewMedia: document.getElementById("previewMedia"),
  previewCaption: document.getElementById("previewCaption"),
  toast: document.getElementById("toast"),
  bulkRescheduleBtn: document.getElementById("bulkRescheduleBtn"),
  clearSelectionBtn: document.getElementById("clearSelectionBtn"),
  selectedCount: document.getElementById("selectedCount"),
  importOpenBtn: document.getElementById("importOpenBtn"),
  importModal: document.getElementById("importModal"),
  importCsvText: document.getElementById("importCsvText"),
  importCsvFile: document.getElementById("importCsvFile"),
  importImageFiles: document.getElementById("importImageFiles"),
  importDefaultAccounts: document.getElementById("importDefaultAccounts"),
  importSummary: document.getElementById("importSummary"),
  importRunBtn: document.getElementById("importRunBtn"),
  editModal: document.getElementById("editModal"),
  editPostId: document.getElementById("editPostId"),
  editCaptionInput: document.getElementById("editCaptionInput"),
  editTimeInput: document.getElementById("editTimeInput"),
  editAccountsWrap: document.getElementById("editAccountsWrap"),
  editSaveBtn: document.getElementById("editSaveBtn"),
};

let state = { profiles: [], posts: [], targets: [] };
let selectedImage = null;
let lastApiFailure = "";
let selectedPostIds = new Set();
let editingPostId = "";

async function apiFetch(url, options = {}) {
  const res = await fetch(url, options);
  const contentType = (res.headers.get("content-type") || "").toLowerCase();
  const text = await res.text();

  if (!contentType.includes("application/json")) {
    const preview = text.startsWith("<!DOCTYPE") || text.startsWith("<html")
      ? `Expected JSON from ${url}, but got HTML. The server may have failed or restarted badly.`
      : `Expected JSON from ${url}, but got: ${text.slice(0, 180)}`;
    throw new Error(preview);
  }

  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch (error) {
    throw new Error(`Invalid JSON from ${url}: ${error.message}`);
  }

  if (!res.ok) {
    throw new Error(payload.error || `Request failed (${res.status})`);
  }

  return payload;
}

function showToast(message, kind = "info") {
  els.toast.textContent = message;
  els.toast.className = `toast ${kind}`;
  els.toast.classList.remove("hidden");
  setTimeout(() => els.toast.classList.add("hidden"), 3500);
}

function fmtTime(ts) {
  return new Date(ts).toLocaleString();
}

function toDateTimeLocal(ts) {
  const d = new Date(ts);
  d.setSeconds(0, 0);
  const offset = d.getTimezoneOffset();
  return new Date(d.getTime() - offset * 60000).toISOString().slice(0, 16);
}

function defaultDateTimeLocal() {
  return toDateTimeLocal(Date.now() + 10 * 60 * 1000);
}

function escapeHtml(text) {
  return String(text || "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function targetProfileName(id) {
  return state.profiles.find(p => p.id === id)?.name || id;
}

function getPostTargets(postId) {
  return state.targets.filter(t => t.postId === postId);
}

function countTargetStatuses(targets) {
  const counts = { pending: 0, running: 0, done: 0, failed: 0 };
  for (const target of targets) counts[target.status] = (counts[target.status] || 0) + 1;
  return counts;
}

function renderAccounts() {
  els.accountsList.innerHTML = "";
  els.checkboxWrap.innerHTML = "";
  els.importDefaultAccounts.innerHTML = "";
  els.editAccountsWrap.innerHTML = "";

  els.accountsEmpty.classList.toggle("hidden", !!state.profiles.length);

  state.profiles.forEach(profile => {
    const pending = !!profile.pending;
    const card = document.createElement("div");
    card.className = "account-card";
    card.innerHTML = `
      <div>
        <div class="account-name">${escapeHtml(profile.name || profile.id)}</div>
        <div class="account-id">${escapeHtml(profile.id)}</div>
        <div class="account-id">
          <span class="pill ${pending ? "pending" : "done"}">${pending ? "login pending" : "ready"}</span>
          ${pending ? "<span> Finish Instagram login in the opened browser window.</span>" : ""}
        </div>
      </div>
      <div class="account-actions">
        <button class="button ghost" data-action="rename" data-id="${profile.id}" ${pending ? "disabled" : ""}>Rename</button>
        <button class="button ghost danger" data-action="remove" data-id="${profile.id}">Remove</button>
      </div>
    `;
    els.accountsList.appendChild(card);

    if (pending) return;

    const label = `<label class="checkbox-row"><input type="checkbox" name="profileBox" value="${profile.id}" /><span>${escapeHtml(profile.name || profile.id)}</span></label>`;
    els.checkboxWrap.insertAdjacentHTML("beforeend", label);
    els.importDefaultAccounts.insertAdjacentHTML("beforeend", label.replace('name="profileBox"', 'name="importDefaultAccountsBox"'));
    els.editAccountsWrap.insertAdjacentHTML("beforeend", label.replace('name="profileBox"', 'name="editProfileBox"'));
  });

  if (!els.checkboxWrap.children.length) {
    els.checkboxWrap.innerHTML = `<div class="empty-mini">No ready accounts yet.</div>`;
  }
  if (!els.importDefaultAccounts.children.length) {
    els.importDefaultAccounts.innerHTML = `<div class="empty-mini">No ready accounts yet.</div>`;
  }
  if (!els.editAccountsWrap.children.length) {
    els.editAccountsWrap.innerHTML = `<div class="empty-mini">No ready accounts yet.</div>`;
  }
}

function renderPosts() {
  els.postsList.innerHTML = "";
  els.postsEmpty.classList.toggle("hidden", !!state.posts.length);
  if (!state.posts.length) return;

  state.posts.forEach(post => {
    const targets = getPostTargets(post.id);
    const counts = countTargetStatuses(targets);
    const isSelected = selectedPostIds.has(post.id);
    const overdue = (post.status === "scheduled" || post.status === "partial") && Number(post.scheduledAt) < Date.now();
    const busy = post.status === "running";
    const pauseLabel = post.status === "paused" ? "Resume" : "Pause";

    const statuses = targets.map(t => {
      const retryBtn = t.status === "failed"
        ? `<button class="button ghost" data-action="retry" data-id="${t.id}">Retry</button>`
        : "";
      const error = t.error ? `<div class="target-error">${escapeHtml(t.error)}</div>` : "";
      return `
        <div class="target-row">
          <div>
            <strong>${escapeHtml(targetProfileName(t.profileId))}</strong>
            <span class="pill ${t.status}">${escapeHtml(t.status)}</span>
            ${error}
          </div>
          <div>${retryBtn}</div>
        </div>
      `;
    }).join("");

    const card = document.createElement("article");
    card.className = "post-card";
    card.innerHTML = `
      <div class="post-media-wrap">
        <img class="post-media" src="${post.imageUrl}" alt="scheduled media" />
      </div>
      <div class="post-body">
        <div class="post-meta">
          <label class="select-post">
            <input type="checkbox" data-action="select-post" data-id="${post.id}" ${isSelected ? "checked" : ""} />
            <span>Select</span>
          </label>
          <span class="pill ${post.status}">${escapeHtml(post.status)}</span>
          ${overdue ? `<span class="pill failed">overdue</span>` : ""}
          <span>${fmtTime(post.scheduledAt)}</span>
        </div>
        <div class="status-strip">
          <span>done ${counts.done || 0}</span>
          <span>failed ${counts.failed || 0}</span>
          <span>waiting ${counts.pending || 0}</span>
          <span>running ${counts.running || 0}</span>
        </div>
        <pre class="caption">${escapeHtml(post.caption || "")}</pre>
        <div class="post-actions">
          <button class="button" data-action="post-now" data-id="${post.id}" ${busy ? "disabled" : ""}>Post now</button>
          <button class="button ghost" data-action="toggle-pause" data-id="${post.id}" ${busy || post.status === "done" ? "disabled" : ""}>${pauseLabel}</button>
          <button class="button ghost" data-action="edit-post" data-id="${post.id}" ${busy ? "disabled" : ""}>Edit</button>
          <button class="button ghost danger" data-action="delete-post" data-id="${post.id}" ${busy ? "disabled" : ""}>Delete</button>
        </div>
        <div class="targets-box">${statuses || "<div class='empty-mini'>No targets</div>"}</div>
      </div>
    `;
    els.postsList.appendChild(card);
  });

  updateSelectedCount();
}

function updateSelectedCount() {
  const count = selectedPostIds.size;
  els.selectedCount.textContent = count ? `${count} selected` : "No posts selected";
  els.bulkRescheduleBtn.disabled = !count;
  els.clearSelectionBtn.disabled = !count;
}

function renderPreview() {
  els.previewCaption.textContent = els.captionInput.value || "Nothing yet.";
  if (selectedImage?.url) {
    els.previewMedia.innerHTML = `<img class="preview-img" src="${selectedImage.url}" alt="preview" />`;
  } else {
    els.previewMedia.textContent = "Image preview";
  }
}

async function refreshState(showErrors = false) {
  try {
    state = await apiFetch("/api/state");
    lastApiFailure = "";
    renderAccounts();
    renderPosts();
  } catch (error) {
    if (showErrors || lastApiFailure !== error.message) {
      showToast(error.message || "Could not refresh app state.", "error");
      lastApiFailure = error.message || "refresh-failed";
    }
    throw error;
  }
}

async function addAccount() {
  els.addAccountBtn.disabled = true;
  try {
    await apiFetch("/api/profile/start", { method: "POST" });
    showToast("Instagram login window opened. Finish logging in there.", "info");
    await refreshState(true);
  } catch (error) {
    showToast(error.message || "Could not open Instagram login window.", "error");
  } finally {
    els.addAccountBtn.disabled = false;
  }
}

async function renameAccount(id) {
  const current = state.profiles.find(p => p.id === id);
  const name = prompt("Account name", current?.name || "");
  if (!name) return;

  await apiFetch("/api/profile/rename", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, name })
  });
  await refreshState(true);
}

async function removeAccount(id) {
  if (!confirm("Remove this account from the app?")) return;
  await apiFetch(`/api/profile/${id}`, { method: "DELETE" });
  await refreshState(true);
}

async function retryTarget(id) {
  await apiFetch(`/api/target/${id}/retry`, { method: "POST" });
  showToast("Retry queued.", "success");
  await refreshState();
}

async function postNow(postId) {
  showToast("Posting now. Instagram may open and take over for a moment.", "info");
  await apiFetch(`/api/post/${postId}/post-now`, { method: "POST" });
  setTimeout(() => refreshState(true).catch(() => {}), 1000);
}

async function deletePost(postId) {
  if (!confirm("Delete this scheduled post?")) return;
  await apiFetch(`/api/post/${postId}/delete`, { method: "POST" });
  selectedPostIds.delete(postId);
  await refreshState(true);
}

async function togglePause(postId) {
  const data = await apiFetch(`/api/post/${postId}/toggle-pause`, { method: "POST" });
  showToast(data.status === "paused" ? "Post paused." : "Post resumed.", "success");
  await refreshState(true);
}

function openModal(modal) {
  modal.classList.remove("hidden");
}

function closeModal(modal) {
  modal.classList.add("hidden");
}

function selectedIdsFrom(name) {
  return [...document.querySelectorAll(`input[name="${name}"]:checked`)].map(el => el.value);
}

function openEditModal(postId) {
  const post = state.posts.find(p => p.id === postId);
  if (!post) return;
  editingPostId = postId;
  els.editPostId.textContent = postId;
  els.editCaptionInput.value = post.caption || "";
  els.editTimeInput.value = toDateTimeLocal(post.scheduledAt);
  const targetIds = new Set(getPostTargets(postId).map(t => t.profileId));
  document.querySelectorAll('input[name="editProfileBox"]').forEach(input => {
    input.checked = targetIds.has(input.value);
  });
  openModal(els.editModal);
}

async function saveEditModal() {
  const scheduledAt = new Date(els.editTimeInput.value).getTime();
  const profileIds = selectedIdsFrom("editProfileBox");
  if (!Number.isFinite(scheduledAt)) {
    showToast("Pick a valid time.", "error");
    return;
  }
  if (!profileIds.length) {
    showToast("Choose at least one account.", "error");
    return;
  }

  await apiFetch(`/api/post/${editingPostId}/update`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      caption: els.editCaptionInput.value,
      scheduledAt,
      profileIds,
    })
  });

  closeModal(els.editModal);
  showToast("Scheduled post updated.", "success");
  await refreshState(true);
}

async function bulkReschedule() {
  if (!selectedPostIds.size) return;
  const raw = prompt("Shift selected posts by how many minutes? Use negative numbers to move earlier.", "15");
  if (raw === null) return;
  const minuteOffset = Number(raw);
  if (!Number.isFinite(minuteOffset)) {
    showToast("Enter a real number of minutes.", "error");
    return;
  }
  const data = await apiFetch("/api/posts/bulk-reschedule", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ postIds: [...selectedPostIds], minuteOffset })
  });
  showToast(`Rescheduled ${data.changed} posts.`, "success");
  await refreshState(true);
}

function clearSelection() {
  selectedPostIds.clear();
  renderPosts();
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;
  const input = String(text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    const next = input[i + 1];
    if (inQuotes) {
      if (ch === '"' && next === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(cell);
      cell = "";
    } else if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += ch;
    }
  }
  if (cell.length || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter(r => r.some(c => String(c || "").trim()));
}

function resolveProfileIds(raw, fallbackIds = []) {
  const source = String(raw || "").trim();
  if (!source) return fallbackIds;
  const pieces = source.split(/[|;]+/).map(part => part.trim()).filter(Boolean);
  const ids = [];
  for (const piece of pieces) {
    const match = state.profiles.find(profile => profile.id === piece || profile.name.toLowerCase() === piece.toLowerCase());
    if (!match || match.pending) throw new Error(`Unknown account in import: ${piece}`);
    if (!ids.includes(match.id)) ids.push(match.id);
  }
  return ids;
}

function summarizeImportRows(rows) {
  const imageNames = new Set();
  const accountNames = new Set();
  for (const row of rows) {
    if (row.imageFile) imageNames.add(row.imageFile);
    if (row.accounts) String(row.accounts).split(/[|;]+/).map(s => s.trim()).filter(Boolean).forEach(name => accountNames.add(name));
  }
  els.importSummary.innerHTML = rows.length
    ? `<strong>${rows.length}</strong> rows parsed. <strong>${imageNames.size}</strong> image names. <strong>${accountNames.size}</strong> account entries.`
    : "No rows parsed yet.";
}

async function readImportCsvText() {
  const file = els.importCsvFile.files[0];
  if (file) {
    return await file.text();
  }
  return els.importCsvText.value;
}

async function importSchedule() {
  const csvText = await readImportCsvText();
  if (!String(csvText || "").trim()) {
    showToast("Paste CSV text or choose a CSV file first.", "error");
    return;
  }

  const matrix = parseCsv(csvText);
  if (matrix.length < 2) {
    showToast("CSV needs a header row and at least one data row.", "error");
    return;
  }

  const headers = matrix[0].map(x => String(x || "").trim());
  const rows = matrix.slice(1).map(values => Object.fromEntries(headers.map((header, index) => [header, String(values[index] || "").trim()])));
  summarizeImportRows(rows);

  const fallbackProfileIds = selectedIdsFrom("importDefaultAccountsBox");
  const imagesByName = new Map([...els.importImageFiles.files].map(file => [file.name, file]));
  const uploadCache = new Map();
  const payloadRows = [];

  els.importRunBtn.disabled = true;
  try {
    for (const row of rows) {
      const scheduledRaw = row.scheduledAt || row.time || row.datetime;
      const caption = row.caption || row.text || "";
      const imageFile = row.imageFile || row.image || row.media || "";
      const accountsRaw = row.accounts || row.account || row.profileIds || row.profiles || "";
      const profileIds = resolveProfileIds(accountsRaw, fallbackProfileIds);
      if (!profileIds.length) throw new Error(`No accounts resolved for row scheduled at ${scheduledRaw || "unknown time"}`);
      const scheduledAt = new Date(scheduledRaw).getTime();
      if (!Number.isFinite(scheduledAt)) throw new Error(`Invalid scheduledAt value: ${scheduledRaw}`);

      let upload = null;
      const existingPath = row.imagePath || "";
      if (existingPath) {
        upload = { path: existingPath, url: row.imageUrl || `/${existingPath.replaceAll("\\", "/")}` };
      } else {
        if (!imageFile) throw new Error(`Missing imageFile for row scheduled at ${scheduledRaw}`);
        if (!imagesByName.has(imageFile)) throw new Error(`Could not find image file named ${imageFile} in the selected import images.`);
        if (!uploadCache.has(imageFile)) {
          const fd = new FormData();
          fd.append("file", imagesByName.get(imageFile));
          uploadCache.set(imageFile, await apiFetch("/api/upload", { method: "POST", body: fd }));
        }
        upload = uploadCache.get(imageFile);
      }

      payloadRows.push({
        caption,
        imagePath: upload.path,
        imageUrl: upload.url,
        scheduledAt,
        profileIds,
      });
    }

    const result = await apiFetch("/api/posts/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rows: payloadRows })
    });

    showToast(`Imported ${result.count} scheduled posts.`, "success");
    els.importCsvText.value = "";
    els.importCsvFile.value = "";
    els.importImageFiles.value = "";
    document.querySelectorAll('input[name="importDefaultAccountsBox"]').forEach(input => { input.checked = false; });
    summarizeImportRows([]);
    closeModal(els.importModal);
    await refreshState(true);
  } catch (error) {
    showToast(error.message || "Import failed.", "error");
  } finally {
    els.importRunBtn.disabled = false;
  }
}

async function schedulePost(event) {
  event.preventDefault();

  if (!els.fileInput.files[0]) {
    showToast("Choose an image first.", "error");
    return;
  }

  const selectedProfiles = selectedIdsFrom("profileBox");
  if (!selectedProfiles.length) {
    showToast("Choose at least one account.", "error");
    return;
  }

  const fd = new FormData();
  fd.append("file", els.fileInput.files[0]);
  const upload = await apiFetch("/api/upload", { method: "POST", body: fd });

  const when = new Date(els.timeInput.value).getTime();
  if (!Number.isFinite(when)) {
    showToast("Pick a valid time.", "error");
    return;
  }

  await apiFetch("/api/post", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      caption: els.captionInput.value,
      imagePath: upload.path,
      imageUrl: upload.url,
      scheduledAt: when,
      profileIds: selectedProfiles
    })
  });

  showToast("Post scheduled.", "success");
  els.postForm.reset();
  els.timeInput.value = defaultDateTimeLocal();
  selectedImage = null;
  renderPreview();
  await refreshState();
}

els.addAccountBtn.addEventListener("click", addAccount);
els.refreshBtn.addEventListener("click", () => refreshState(true).catch(() => {}));
els.postForm.addEventListener("submit", schedulePost);
els.fileInput.addEventListener("change", () => {
  const file = els.fileInput.files[0];
  selectedImage = file ? { url: URL.createObjectURL(file) } : null;
  renderPreview();
});
els.captionInput.addEventListener("input", renderPreview);
els.bulkRescheduleBtn.addEventListener("click", bulkReschedule);
els.clearSelectionBtn.addEventListener("click", clearSelection);
els.importOpenBtn.addEventListener("click", () => openModal(els.importModal));
els.importRunBtn.addEventListener("click", importSchedule);
els.editSaveBtn.addEventListener("click", saveEditModal);
els.importCsvText.addEventListener("input", () => {
  try {
    const matrix = parseCsv(els.importCsvText.value);
    const headers = matrix[0] ? matrix[0].map(x => String(x || "").trim()) : [];
    const rows = matrix.slice(1).map(values => Object.fromEntries(headers.map((header, index) => [header, String(values[index] || "").trim()])));
    summarizeImportRows(rows);
  } catch {
    els.importSummary.textContent = "Could not parse import text yet.";
  }
});
els.importCsvFile.addEventListener("change", async () => {
  const file = els.importCsvFile.files[0];
  if (!file) return summarizeImportRows([]);
  const text = await file.text();
  const matrix = parseCsv(text);
  const headers = matrix[0] ? matrix[0].map(x => String(x || "").trim()) : [];
  const rows = matrix.slice(1).map(values => Object.fromEntries(headers.map((header, index) => [header, String(values[index] || "").trim()])));
  summarizeImportRows(rows);
});

document.body.addEventListener("click", async (event) => {
  const closeBtn = event.target.closest("[data-close-modal]");
  if (closeBtn) {
    closeModal(document.getElementById(closeBtn.dataset.closeModal));
    return;
  }

  if (event.target.classList.contains("modal")) {
    closeModal(event.target);
    return;
  }

  const checkbox = event.target.closest('input[data-action="select-post"]');
  if (checkbox) {
    if (checkbox.checked) selectedPostIds.add(checkbox.dataset.id);
    else selectedPostIds.delete(checkbox.dataset.id);
    updateSelectedCount();
    return;
  }

  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const action = button.dataset.action;
  const id = button.dataset.id;

  try {
    if (action === "rename") return renameAccount(id);
    if (action === "remove") return removeAccount(id);
    if (action === "retry") return retryTarget(id);
    if (action === "post-now") return postNow(id);
    if (action === "delete-post") return deletePost(id);
    if (action === "toggle-pause") return togglePause(id);
    if (action === "edit-post") return openEditModal(id);
  } catch (error) {
    showToast(error.message || "Action failed.", "error");
  }
});

els.timeInput.value = defaultDateTimeLocal();
renderPreview();
updateSelectedCount();
summarizeImportRows([]);
refreshState(true).catch(() => {});
setInterval(() => refreshState(false).catch(() => {}), 10000);
