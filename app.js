const STORAGE_KEY = "ss2do_actionables_v1";
const RESOLVED_LOG_KEY = "ss2do_resolved_log_v1";
const MAX_IMAGE_SIZE_BYTES = 10 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp"]);

const ACTIONS = [
  {
    key: "find_download_paper",
    label: "Find and download paper",
    createUrl: (query) => `https://scholar.google.com/scholar?q=${encodeURIComponent(query)}`,
  },
  {
    key: "web_search",
    label: "Open web search",
    createUrl: (query) => `https://www.google.com/search?q=${encodeURIComponent(query)}`,
  },
  {
    key: "set_reminder",
    label: "Set reminder / task",
    createUrl: null,
  },
  {
    key: "summarize_notes",
    label: "Summarize and store notes",
    createUrl: null,
  },
];

const ACTION_FALLBACK_LABEL = "General follow-up";
const NOTIF_TITLE = "SS2do reminder";

const state = {
  file: null,
  imageSource: null,
  ocrText: "",
  querySuggestions: [],
  items: loadItems(),
  resolvedLog: loadResolvedLog(),
  notificationsEnabled: false,
};

const screenshotInput = document.querySelector("#screenshotInput");
const cameraInput = document.querySelector("#cameraInput");
const previewImage = document.querySelector("#previewImage");
const emptyPreviewText = document.querySelector("#emptyPreviewText");
const analyzeBtn = document.querySelector("#analyzeBtn");
const ocrStatus = document.querySelector("#ocrStatus");
const queryInput = document.querySelector("#queryInput");
const querySuggestions = document.querySelector("#querySuggestions");
const actionInput = document.querySelector("#actionInput");
const actionSuggestions = document.querySelector("#actionSuggestions");
const tagsInput = document.querySelector("#tagsInput");
const deadlineDateInput = document.querySelector("#deadlineDateInput");
const deadlineModeSelect = document.querySelector("#deadlineModeSelect");
const ocrText = document.querySelector("#ocrText");
const saveItemBtn = document.querySelector("#saveItemBtn");
const itemsList = document.querySelector("#itemsList");
const resolvedLogList = document.querySelector("#resolvedLogList");
const clearAllBtn = document.querySelector("#clearAllBtn");

bootstrapActions();
renderItems();
renderResolvedLog();
syncSaveButtonState();
consumePendingSharedImageUri();
initNotificationSupport();

screenshotInput.addEventListener("change", onFileSelected);
cameraInput.addEventListener("change", onFileSelected);
analyzeBtn.addEventListener("click", analyzeScreenshot);
saveItemBtn.addEventListener("click", saveItem);
clearAllBtn.addEventListener("click", clearAll);
queryInput.addEventListener("input", syncSaveButtonState);
actionInput.addEventListener("input", syncSaveButtonState);
window.addEventListener("ss2do-share-image", (event) => {
  const maybeUri = event?.detail?.uri;
  if (typeof maybeUri === "string" && maybeUri) {
    setSharedImageUri(maybeUri);
  }
});

function bootstrapActions() {
  actionSuggestions.innerHTML = ACTIONS.map(
    (a) => `<option value="${a.label}"></option>`
  ).join("");

  renderSuggestedQueries([]);
}

function syncSaveButtonState() {
  const query = queryInput.value.trim();
  saveItemBtn.disabled = !query;
}

function onFileSelected(event) {
  const [file] = event.target.files || [];
  if (!file) {
    return;
  }

  if (!ALLOWED_IMAGE_TYPES.has(file.type)) {
    ocrStatus.textContent = "Unsupported file type. Use png, jpeg, or webp.";
    return;
  }

  if (file.size > MAX_IMAGE_SIZE_BYTES) {
    ocrStatus.textContent = "Image too large. Max size is 10 MB.";
    return;
  }

  state.file = file;
  state.imageSource = file;
  analyzeBtn.disabled = false;
  syncSaveButtonState();
  ocrStatus.textContent = "Ready to analyze";

  const reader = new FileReader();
  reader.onload = () => {
    previewImage.src = reader.result;
    previewImage.style.display = "block";
    emptyPreviewText.style.display = "none";
  };
  reader.readAsDataURL(file);
}

async function analyzeScreenshot() {
  if (!state.imageSource) {
    return;
  }

  ocrStatus.textContent = "Running OCR...";
  analyzeBtn.disabled = true;

  try {
    const result = await Tesseract.recognize(state.imageSource, "eng+spa", {
      workerPath: "https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/worker.min.js",
      corePath: "https://cdn.jsdelivr.net/npm/tesseract.js-core@5/tesseract-core-simd.wasm.js",
      langPath: "https://tessdata.projectnaptha.com/4.0.0",
      logger: (m) => {
        if (m.status === "recognizing text") {
          const pct = Math.round((m.progress || 0) * 100);
          ocrStatus.textContent = `OCR ${pct}%`;
        }
      },
    });

    state.ocrText = (result.data.text || "").trim();
    ocrText.value = state.ocrText;

    const suggestion = suggestAction(state.ocrText);
    state.querySuggestions = suggestion.queryCandidates;
    renderSuggestedQueries(state.querySuggestions);
    actionInput.value = suggestion.actionLabel;

    const detectedDate = detectDateFromText(state.ocrText);
    if (detectedDate) {
      deadlineDateInput.value = detectedDate;
      ocrStatus.textContent = "OCR complete. Pick a query and optionally configure deadline reminder.";
    } else {
      ocrStatus.textContent = "OCR complete. Pick a suggested query or type your own title.";
    }

    syncSaveButtonState();
  } catch (error) {
    console.error(error);
    const detail = error?.message ? ` (${error.message})` : "";
    ocrStatus.textContent = `OCR failed${detail}. You can still write query/action manually and save.`;
    syncSaveButtonState();
  } finally {
    analyzeBtn.disabled = false;
  }
}

function suggestAction(rawText) {
  const text = rawText.toLowerCase();
  const compact = text.replace(/\s+/g, " ").trim();
  const title = suggestTitleFromText(compact);

  if (/doi|abstract|references|journal|vol\.|arxiv|conference/.test(text)) {
    return {
      actionLabel: "Find and download paper",
      queryCandidates: [
        `Download paper: ${title}`,
        `${title} pdf`,
        `Find source for ${title}`,
      ],
    };
  }

  if (/meeting|call|agenda|tomorrow|today|deadline|deliverable/.test(text)) {
    return {
      actionLabel: "Set reminder / task",
      queryCandidates: [
        `Follow up: ${title}`,
        `Prepare for: ${title}`,
        `Schedule task: ${title}`,
      ],
    };
  }

  if (/invoice|receipt|total|payment|mxn|usd|\$\d/.test(text)) {
    return {
      actionLabel: "Summarize and store notes",
      queryCandidates: [
        `Review expense: ${title}`,
        "Extract expenses and save summary",
        `Validate payment details: ${title}`,
      ],
    };
  }

  return {
    actionLabel: "Open web search",
    queryCandidates: [
      `Research: ${title}`,
      `Find context for: ${title}`,
      "Search screenshot context",
    ],
  };
}

function suggestTitleFromText(compactText) {
  if (!compactText) {
    return "screenshot topic";
  }

  const cleaned = compactText.replace(/[^a-z0-9\s]/gi, " ");
  const words = cleaned
    .split(/\s+/)
    .filter(Boolean)
    .filter((w) => w.length > 2)
    .slice(0, 8);

  if (!words.length) {
    return "screenshot topic";
  }

  return words
    .slice(0, 5)
    .map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

function renderSuggestedQueries(list) {
  if (!list.length) {
    querySuggestions.innerHTML = '<p class="query-suggestion-empty">Analyze an image to get suggestions.</p>';
    return;
  }

  const unique = [...new Set(list.map((s) => String(s).trim()).filter(Boolean))];
  querySuggestions.innerHTML = unique
    .map(
      (s) =>
        `<button type="button" class="query-chip" data-query="${escapeHtml(s)}">${escapeHtml(s)}</button>`
    )
    .join("");

  for (const chip of querySuggestions.querySelectorAll(".query-chip")) {
    chip.addEventListener("click", () => {
      queryInput.value = chip.dataset.query || "";
      syncSaveButtonState();
    });
  }
}

async function saveItem() {
  const query = queryInput.value.trim();
  const action = normalizeActionLabel(actionInput.value);
  const extracted = ocrText.value.trim();
  const tags = parseTags(tagsInput.value);
  const deadlineDate = normalizeDeadlineDate(deadlineDateInput.value);
  const deadlineMode = normalizeDeadlineMode(deadlineModeSelect.value);

  if (!query) {
    ocrStatus.textContent = "Query is required.";
    return;
  }

  if (deadlineMode !== "none" && !deadlineDate) {
    ocrStatus.textContent = "Pick a valid deadline date or select No reminder.";
    return;
  }

  const reminderAt = computeReminderAt(deadlineDate, deadlineMode);

  const screenshotThumb = await buildScreenshotThumbnail();

  const item = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    query,
    action,
    tags,
    ocrSnippet: extracted.slice(0, 280),
    screenshotThumb,
    deadlineDate,
    deadlineMode,
    reminderAt,
    notificationId: reminderAt ? notificationIdFromItem(query + Date.now()) : null,
    done: false,
    resolvedAt: null,
  };

  state.items.unshift(item);
  const ok = saveItems(state.items);
  if (!ok) {
    state.items.shift();
    ocrStatus.textContent = "Could not save this item due to local storage size. Try a smaller screenshot.";
    return;
  }
  await scheduleReminderForItem(item);
  renderItems();

  ocrStatus.textContent = "Saved to queue.";
}

function renderItems() {
  if (!state.items.length) {
    itemsList.innerHTML = '<p class="item-snippet">No actionables yet.</p>';
    return;
  }

  const grouped = {};
  for (const item of state.items) {
    const bucket = normalizeActionLabel(item.action);
    if (!grouped[bucket]) {
      grouped[bucket] = [];
    }
    grouped[bucket].push(item);
  }

  itemsList.innerHTML = Object.entries(grouped)
    .map(([bucketLabel, bucketItems]) => {
      const cards = bucketItems
        .map((item) => {
          const created = new Date(item.createdAt).toLocaleString();
          return `
          <article class="item-card ${item.done ? "done" : ""}">
            ${item.screenshotThumb ? `<img class="item-thumb" src="${escapeHtml(item.screenshotThumb)}" alt="Saved screenshot" />` : ""}
            <p class="item-title">${escapeHtml(item.query)}</p>
            <p class="item-meta">${escapeHtml(created)}</p>
            ${renderTags(item.tags)}
            ${renderDeadline(item)}
            <p class="item-snippet">${escapeHtml(item.ocrSnippet || "No OCR snippet")}</p>
            <div class="item-actions">
              <button data-id="${item.id}" data-type="toggle">${item.done ? "Mark pending" : "Mark done"}</button>
              <button data-id="${item.id}" data-type="delete" class="danger-btn">Delete</button>
            </div>
          </article>`;
        })
        .join("");

      return `
      <section class="bucket-card">
        <h3 class="bucket-title">${escapeHtml(bucketLabel)} <span>${bucketItems.length}</span></h3>
        <div class="bucket-items">${cards}</div>
      </section>`;
    })
    .join("");

  for (const button of itemsList.querySelectorAll("button")) {
    button.addEventListener("click", handleItemAction);
  }
}

async function handleItemAction(event) {
  const id = event.target.dataset.id;
  const type = event.target.dataset.type;
  const index = state.items.findIndex((item) => item.id === id);
  if (index < 0) {
    return;
  }

  if (type === "delete") {
    await cancelReminderForItem(state.items[index]);
    state.items.splice(index, 1);
  }

  if (type === "toggle") {
    const item = state.items[index];
    const wasDone = item.done;
    item.done = !item.done;
    if (!wasDone && item.done) {
      await cancelReminderForItem(item);
      const resolvedAt = new Date().toISOString();
      item.resolvedAt = resolvedAt;
      state.resolvedLog.unshift({
        id: crypto.randomUUID(),
        itemId: item.id,
        query: item.query,
        action: item.action,
        resolvedAt,
      });
      saveResolvedLog(state.resolvedLog);
    }
    if (wasDone && !item.done) {
      item.resolvedAt = null;
      await scheduleReminderForItem(item);
    }
  }

  saveItems(state.items);
  renderItems();
  renderResolvedLog();
}

function clearAll() {
  if (!confirm("Clear all actionables?")) {
    return;
  }
  state.items = [];
  saveItems(state.items);
  renderItems();
}

function renderResolvedLog() {
  if (!state.resolvedLog.length) {
    resolvedLogList.innerHTML = '<p class="item-snippet">No resolved entries yet.</p>';
    return;
  }

  resolvedLogList.innerHTML = state.resolvedLog
    .slice(0, 100)
    .map((entry) => {
      const when = new Date(entry.resolvedAt).toLocaleString();
      return `
      <article class="resolved-log-item">
        <p class="item-title">${escapeHtml(entry.query)}</p>
        <p class="item-meta">${escapeHtml(normalizeActionLabel(entry.action))} | Resolved: ${escapeHtml(when)}</p>
      </article>`;
    })
    .join("");
}

function saveItems(items) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
    return true;
  } catch (error) {
    console.error(error);
    return false;
  }
}

async function initNotificationSupport() {
  if (!isNativeNotificationAvailable()) {
    return;
  }

  try {
    const LocalNotifications = window.Capacitor.Plugins.LocalNotifications;
    const permission = await LocalNotifications.checkPermissions();
    if (permission.display === "granted") {
      state.notificationsEnabled = true;
      return;
    }

    const requested = await LocalNotifications.requestPermissions();
    state.notificationsEnabled = requested.display === "granted";
  } catch (error) {
    console.error(error);
    state.notificationsEnabled = false;
  }
}

function isNativeNotificationAvailable() {
  return Boolean(
    window.Capacitor &&
      typeof window.Capacitor.isNativePlatform === "function" &&
      window.Capacitor.isNativePlatform() &&
      window.Capacitor.Plugins &&
      window.Capacitor.Plugins.LocalNotifications
  );
}

function notificationIdFromItem(seed) {
  let hash = 0;
  const text = String(seed || "ss2do");
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  }
  const normalized = Math.abs(hash) % 2147483000;
  return normalized + 1;
}

async function scheduleReminderForItem(item) {
  if (!item || item.done || !item.reminderAt || !item.notificationId) {
    return;
  }
  if (!isNativeNotificationAvailable()) {
    return;
  }

  if (!state.notificationsEnabled) {
    await initNotificationSupport();
  }
  if (!state.notificationsEnabled) {
    ocrStatus.textContent = "Reminder saved, but notification permission is not granted.";
    return;
  }

  const at = new Date(item.reminderAt);
  if (Number.isNaN(at.getTime()) || at.getTime() <= Date.now()) {
    return;
  }

  try {
    const LocalNotifications = window.Capacitor.Plugins.LocalNotifications;
    await LocalNotifications.cancel({
      notifications: [{ id: item.notificationId }],
    });
    await LocalNotifications.schedule({
      notifications: [
        {
          id: item.notificationId,
          title: NOTIF_TITLE,
          body: item.query,
          schedule: { at, allowWhileIdle: true },
          extra: { itemId: item.id, action: item.action },
        },
      ],
    });
  } catch (error) {
    console.error(error);
    ocrStatus.textContent = "Saved, but could not schedule device notification.";
  }
}

async function cancelReminderForItem(item) {
  if (!item || !item.notificationId || !isNativeNotificationAvailable()) {
    return;
  }

  try {
    const LocalNotifications = window.Capacitor.Plugins.LocalNotifications;
    await LocalNotifications.cancel({
      notifications: [{ id: item.notificationId }],
    });
  } catch (error) {
    console.error(error);
  }
}

function loadItems() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]").map((item) => ({
      ...item,
      action: normalizeActionLabel(item.action),
      tags: Array.isArray(item.tags) ? item.tags : [],
      deadlineDate: normalizeDeadlineDate(item.deadlineDate),
      deadlineMode: normalizeDeadlineMode(item.deadlineMode),
      reminderAt: item.reminderAt || null,
      notificationId: Number.isInteger(item.notificationId)
        ? item.notificationId
        : item.reminderAt
          ? notificationIdFromItem(item.id || item.query || Date.now())
          : null,
    }));
  } catch (error) {
    console.error(error);
    return [];
  }
}

function saveResolvedLog(entries) {
  try {
    localStorage.setItem(RESOLVED_LOG_KEY, JSON.stringify(entries));
    return true;
  } catch (error) {
    console.error(error);
    return false;
  }
}

function loadResolvedLog() {
  try {
    return JSON.parse(localStorage.getItem(RESOLVED_LOG_KEY) || "[]");
  } catch (error) {
    console.error(error);
    return [];
  }
}

function normalizeActionLabel(value) {
  const text = String(value || "").trim();
  return text || ACTION_FALLBACK_LABEL;
}

function parseTags(value) {
  return [...new Set(
    String(value || "")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean)
      .slice(0, 12)
  )];
}

function renderTags(tags) {
  if (!Array.isArray(tags) || !tags.length) {
    return "";
  }

  return `<div class="tag-list">${tags
    .map((tag) => `<span class="tag-chip">#${escapeHtml(tag)}</span>`)
    .join("")}</div>`;
}

function normalizeDeadlineDate(value) {
  const v = String(value || "").trim();
  if (!v) {
    return "";
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    return "";
  }
  return v;
}

function normalizeDeadlineMode(value) {
  const mode = String(value || "none").trim().toLowerCase();
  if (mode === "before" || mode === "on" || mode === "after") {
    return mode;
  }
  return "none";
}

function computeReminderAt(deadlineDate, deadlineMode) {
  if (!deadlineDate || deadlineMode === "none") {
    return null;
  }

  const base = new Date(`${deadlineDate}T08:00:00`);
  if (Number.isNaN(base.getTime())) {
    return null;
  }

  if (deadlineMode === "before") {
    base.setDate(base.getDate() - 1);
  }
  if (deadlineMode === "after") {
    base.setDate(base.getDate() + 1);
  }

  return base.toISOString();
}

function renderDeadline(item) {
  const deadlineDate = normalizeDeadlineDate(item.deadlineDate);
  const deadlineMode = normalizeDeadlineMode(item.deadlineMode);
  if (!deadlineDate || deadlineMode === "none") {
    return "";
  }

  const reminderText = item.reminderAt
    ? new Date(item.reminderAt).toLocaleString()
    : "not set";
  return `<p class="deadline-note">Deadline ${escapeHtml(deadlineDate)} | ${escapeHtml(deadlineMode)} | Reminder: ${escapeHtml(reminderText)}</p>`;
}

function detectDateFromText(text) {
  if (!text) {
    return "";
  }

  const tokens = [];
  const ymd = text.match(/\b\d{4}[-\/]\d{1,2}[-\/]\d{1,2}\b/g) || [];
  const dmy = text.match(/\b\d{1,2}[-\/]\d{1,2}[-\/]\d{2,4}\b/g) || [];
  tokens.push(...ymd, ...dmy);

  for (const token of tokens) {
    const iso = normalizeDateTokenToIso(token);
    if (iso) {
      return iso;
    }
  }

  return "";
}

function normalizeDateTokenToIso(token) {
  const cleaned = String(token).trim();
  const ymdMatch = cleaned.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})$/);
  if (ymdMatch) {
    const y = Number(ymdMatch[1]);
    const m = Number(ymdMatch[2]);
    const d = Number(ymdMatch[3]);
    return validateDateParts(y, m, d);
  }

  const dmyMatch = cleaned.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{2,4})$/);
  if (dmyMatch) {
    const d = Number(dmyMatch[1]);
    const m = Number(dmyMatch[2]);
    let y = Number(dmyMatch[3]);
    if (y < 100) {
      y = 2000 + y;
    }
    return validateDateParts(y, m, d);
  }

  return "";
}

function validateDateParts(year, month, day) {
  if (year < 2000 || year > 2100) {
    return "";
  }
  const date = new Date(year, month - 1, day);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return "";
  }

  const mm = String(month).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return `${year}-${mm}-${dd}`;
}

function consumePendingSharedImageUri() {
  if (typeof window.__SS2DO_PENDING_SHARED_IMAGE_URI === "string" && window.__SS2DO_PENDING_SHARED_IMAGE_URI) {
    setSharedImageUri(window.__SS2DO_PENDING_SHARED_IMAGE_URI);
    window.__SS2DO_PENDING_SHARED_IMAGE_URI = "";
  }
}

function setSharedImageUri(uri) {
  state.file = null;
  state.imageSource = uri;
  previewImage.src = uri;
  previewImage.style.display = "block";
  emptyPreviewText.style.display = "none";
  analyzeBtn.disabled = false;
  ocrStatus.textContent = "Shared image loaded. Tap Analyze Screenshot.";
}

async function buildScreenshotThumbnail() {
  if (!previewImage.src) {
    return "";
  }

  try {
    return await createThumbnailDataUrl(previewImage.src, 420);
  } catch (error) {
    console.error(error);
    return "";
  }
}

function createThumbnailDataUrl(src, maxSide) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const ratio = Math.min(1, maxSide / Math.max(img.width, img.height));
      const width = Math.max(1, Math.round(img.width * ratio));
      const height = Math.max(1, Math.round(img.height * ratio));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        reject(new Error("Canvas context unavailable"));
        return;
      }
      ctx.drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL("image/jpeg", 0.75));
    };
    img.onerror = () => reject(new Error("Could not create screenshot thumbnail"));
    img.src = src;
  });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
