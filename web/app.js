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
  selectedCount: document.getElementById("selectedCount"),
  bulkShiftInput: document.getElementById("bulkShiftInput"),
  bulkShiftBtn: document.getElementById("bulkShiftBtn"),
  clearSelectionBtn: document.getElementById("clearSelectionBtn"),
  editModal: document.getElementById("editModal"),
  editForm: document.getElementById("editForm"),
  editPostId: document.getElementById("editPostId"),
  editCaption: document.getElementById("editCaption"),
  editTime: document.getElementById("editTime"),
  editAccountWrap: document.getElementById("editAccountWrap"),
  editCancelBtn: document.getElementById("editCancelBtn"),
};

let state = { profiles: [], posts: [], targets: [] };
let selectedImage = null;
let lastApiFailure = "";
const selectedPostIds = new Set();

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

function defaultDateTimeLocal(ts = Date.now() + 10 * 60 * 1000) {
  const d = new Date(ts);
  d.setSeconds(0, 0);
  const offset = d.getTimezoneOffset();
  return new Date(d.getTime() - offset * 60000).toISOString().slice(0, 16);
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

function getTargetCounts(postId) {
  const counts = { pending: 0, running: 0, done: 0, failed: 0 };
  for (const target of getPostTargets(postId)) {
    counts[target.status] = Number(counts[target.status] || 0) + 1;
  }
  return counts;
}

function syncSelectedPostIds() {
  const validIds = new Set(state.posts.map(post => post.id));
  for (const id of [...selectedPostIds]) {
    if (!validIds.has(id)) selectedPostIds.delete(id);
  }
}

function updateBulkToolbar() {
  syncSelectedPostIds();
  const count = selectedPostIds.size;
  els.selectedCount.textContent = count === 1 ? "1 post selected" : `${count} posts selected`;
  els.bulkShiftBtn.disabled = count === 0;
  els.clearSelectionBtn.disabled = count === 0;
}

function renderAccounts() {
  els.accountsList.innerHTML = "";
  els.checkboxWrap.innerHTML = "";

  if (!state.profiles.length) {
    els.accountsEmpty.classList.remove("hidden");
  } else {
    els.accountsEmpty.classList.add("hidden");
  }

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
          ${pending ? '<span> Finish Instagram login in the opened browser window.</span>' : ""}
        </div>
      </div>
      <div class="account-actions">
        <button class="button ghost" data-action="rename" data-id="${profile.id}" ${pending ? "disabled" : ""}>Rename</button>
        <button class="button ghost danger" data-action="remove" data-id="${profile.id}">Remove</button>
      </div>
    `;
    els.accountsList.appendChild(card);

    if (pending) return;

    const row = document.createElement("label");
    row.className = "checkbox-row";
    row.innerHTML = `
      <input type="checkbox" name="profileBox" value="${profile.id}" />
      <span>${escapeHtml(profile.name || profile.id)}</span>
    `;
    els.checkboxWrap.appendChild(row);
  });

  if (!els.checkboxWrap.children.length) {
    els.checkboxWrap.innerHTML = `<div class="empty-mini">No ready accounts yet.</div>`;
  }
}

function renderEditAccountOptions(selectedIds = []) {
  const readyProfiles = state.profiles.filter(profile => !profile.pending);
  els.editAccountWrap.innerHTML = "";
  if (!readyProfiles.length) {
    els.editAccountWrap.innerHTML = `<div class="empty-mini">No ready accounts yet.</div>`;
    return;
  }
  for (const profile of readyProfiles) {
    const row = document.createElement("label");
    row.className = "checkbox-row";
    row.innerHTML = `
      <input type="checkbox" name="editProfileBox" value="${profile.id}" ${selectedIds.includes(profile.id) ? "checked" : ""} />
      <span>${escapeHtml(profile.name || profile.id)}</span>
    `;
    els.editAccountWrap.appendChild(row);
  }
}

function renderPosts() {
  els.postsList.innerHTML = "";
  syncSelectedPostIds();
  if (!state.posts.length) {
    els.postsEmpty.classList.remove("hidden");
    updateBulkToolbar();
    return;
  }
  els.postsEmpty.classList.add("hidden");

  state.posts.forEach(post => {
    const targets = getPostTargets(post.id);
    const counts = getTargetCounts(post.id);
    const now = Date.now();
    const isOverdue = Number(post.scheduledAt) <= now && ["scheduled", "partial"].includes(post.status);
    const isLocked = post.status === "running";
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
      <div class="post-select-bar">
        <label class="select-post-row">
          <input type="checkbox" data-post-select="${post.id}" ${selectedPostIds.has(post.id) ? "checked" : ""} />
          <span>Select</span>
        </label>
      </div>
      <div class="post-media-wrap">
        <img class="post-media" src="${post.imageUrl}" alt="scheduled media" />
      </div>
      <div class="post-body">
        <div class="post-meta">
          <span class="pill ${post.status}">${escapeHtml(post.status)}</span>
          ${isOverdue ? '<span class="pill warning">overdue</span>' : ""}
          <span>${fmtTime(post.scheduledAt)}</span>
        </div>
        <div class="post-summary">done ${counts.done} · failed ${counts.failed} · waiting ${counts.pending} · running ${counts.running}</div>
        <pre class="caption">${escapeHtml(post.caption || "")}</pre>
        <div class="post-actions">
          <button class="button" data-action="post-now" data-id="${post.id}" ${isLocked ? "disabled" : ""}>Post now</button>
          <button class="button ghost" data-action="toggle-pause" data-id="${post.id}" ${post.status === "done" || isLocked ? "disabled" : ""}>${post.status === "paused" ? "Resume" : "Pause"}</button>
          <button class="button ghost" data-action="edit-post" data-id="${post.id}" ${isLocked ? "disabled" : ""}>Edit</button>
          <button class="button ghost danger" data-action="delete-post" data-id="${post.id}" ${isLocked ? "disabled" : ""}>Delete</button>
        </div>
        <div class="targets-box">${statuses || "<div class='empty-mini'>No targets</div>"}</div>
      </div>
    `;
    els.postsList.appendChild(card);
  });
  updateBulkToolbar();
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

async function togglePause(postId) {
  const result = await apiFetch(`/api/post/${postId}/toggle-pause`, { method: "POST" });
  showToast(result.status === "paused" ? "Post paused." : "Post resumed.", "success");
  await refreshState(true);
}

function openEditModal(postId) {
  const post = state.posts.find(item => item.id === postId);
  if (!post) return;
  const profileIds = getPostTargets(postId).map(target => target.profileId);
  els.editPostId.value = post.id;
  els.editCaption.value = post.caption || "";
  els.editTime.value = defaultDateTimeLocal(post.scheduledAt);
  renderEditAccountOptions(profileIds);
  els.editModal.classList.remove("hidden");
}

function closeEditModal() {
  els.editModal.classList.add("hidden");
  els.editForm.reset();
  els.editAccountWrap.innerHTML = "";
}

async function savePostEdit(event) {
  event.preventDefault();
  const postId = els.editPostId.value;
  const selectedProfiles = [...document.querySelectorAll('input[name="editProfileBox"]:checked')].map(el => el.value);
  if (!selectedProfiles.length) {
    showToast("Choose at least one account.", "error");
    return;
  }
  const when = new Date(els.editTime.value).getTime();
  if (!Number.isFinite(when)) {
    showToast("Pick a valid time.", "error");
    return;
  }
  await apiFetch(`/api/post/${postId}/update`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      caption: els.editCaption.value,
      scheduledAt: when,
      profileIds: selectedProfiles,
    })
  });
  closeEditModal();
  showToast("Scheduled post updated.", "success");
  await refreshState(true);
}

async function deletePost(postId) {
  if (!confirm("Delete this scheduled post?")) return;

  await apiFetch(`/api/post/${postId}/delete`, { method: "POST" });
  selectedPostIds.delete(postId);
  await refreshState(true);
}

async function bulkReschedule() {
  const minutes = Number(els.bulkShiftInput.value);
  if (!Number.isFinite(minutes) || minutes === 0) {
    showToast("Enter a non-zero minute shift.", "error");
    return;
  }
  const postIds = [...selectedPostIds];
  const result = await apiFetch("/api/posts/bulk-reschedule", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ postIds, minutes })
  });
  showToast(`Rescheduled ${result.changed} posts.`, "success");
  await refreshState(true);
}

async function schedulePost(event) {
  event.preventDefault();

  if (!els.fileInput.files[0]) {
    showToast("Choose an image first.", "error");
    return;
  }

  const selectedProfiles = [...document.querySelectorAll('input[name="profileBox"]:checked')].map(el => el.value);
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
els.refreshBtn.addEventListener("click", refreshState);
els.postForm.addEventListener("submit", schedulePost);
els.editForm.addEventListener("submit", savePostEdit);
els.editCancelBtn.addEventListener("click", closeEditModal);
els.bulkShiftBtn.addEventListener("click", bulkReschedule);
els.clearSelectionBtn.addEventListener("click", () => {
  selectedPostIds.clear();
  renderPosts();
});
els.fileInput.addEventListener("change", () => {
  const file = els.fileInput.files[0];
  if (!file) {
    selectedImage = null;
  } else {
    selectedImage = { url: URL.createObjectURL(file) };
  }
  renderPreview();
});
els.captionInput.addEventListener("input", renderPreview);

els.editModal.addEventListener("click", event => {
  if (event.target === els.editModal) closeEditModal();
});

document.body.addEventListener("change", event => {
  const selector = event.target.closest("input[data-post-select]");
  if (!selector) return;
  const postId = selector.dataset.postSelect;
  if (selector.checked) selectedPostIds.add(postId);
  else selectedPostIds.delete(postId);
  updateBulkToolbar();
});

document.body.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const action = button.dataset.action;
  const id = button.dataset.id;

  if (action === "rename") return renameAccount(id);
  if (action === "remove") return removeAccount(id);
  if (action === "retry") return retryTarget(id);
  if (action === "post-now") return postNow(id);
  if (action === "toggle-pause") return togglePause(id);
  if (action === "edit-post") return openEditModal(id);
  if (action === "delete-post") return deletePost(id);
});

els.timeInput.value = defaultDateTimeLocal();
renderPreview();
updateBulkToolbar();
refreshState(true).catch(() => {});
setInterval(() => refreshState(false).catch(() => {}), 10000);
