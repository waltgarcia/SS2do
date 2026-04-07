const STORAGE_KEY = "ss2do_actionables_v1";
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

const state = {
  file: null,
  imageSource: null,
  ocrText: "",
  items: loadItems(),
};

const screenshotInput = document.querySelector("#screenshotInput");
const cameraInput = document.querySelector("#cameraInput");
const previewImage = document.querySelector("#previewImage");
const emptyPreviewText = document.querySelector("#emptyPreviewText");
const analyzeBtn = document.querySelector("#analyzeBtn");
const ocrStatus = document.querySelector("#ocrStatus");
const queryInput = document.querySelector("#queryInput");
const actionInput = document.querySelector("#actionInput");
const actionSuggestions = document.querySelector("#actionSuggestions");
const ocrText = document.querySelector("#ocrText");
const saveItemBtn = document.querySelector("#saveItemBtn");
const itemsList = document.querySelector("#itemsList");
const clearAllBtn = document.querySelector("#clearAllBtn");

bootstrapActions();
renderItems();
syncSaveButtonState();
consumePendingSharedImageUri();

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
    queryInput.value = suggestion.query;
    actionInput.value = suggestion.actionLabel;

    ocrStatus.textContent = "OCR complete. Review and save.";
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

  if (/doi|abstract|references|journal|vol\.|arxiv|conference/.test(text)) {
    const titleGuess = compact.slice(0, 140) || "paper title";
    return {
      actionLabel: "Find and download paper",
      query: `${titleGuess} pdf`,
    };
  }

  if (/meeting|call|agenda|tomorrow|today|deadline|deliverable/.test(text)) {
    return {
      actionLabel: "Set reminder / task",
      query: compact.slice(0, 120) || "Follow up this screenshot",
    };
  }

  if (/invoice|receipt|total|payment|mxn|usd|\$\d/.test(text)) {
    return {
      actionLabel: "Summarize and store notes",
      query: "Extract expenses and save summary",
    };
  }

  return {
    actionLabel: "Open web search",
    query: compact.slice(0, 130) || "Search screenshot context",
  };
}

async function saveItem() {
  const query = queryInput.value.trim();
  const action = normalizeActionLabel(actionInput.value);
  const extracted = ocrText.value.trim();

  if (!query) {
    ocrStatus.textContent = "Query is required.";
    return;
  }

  const screenshotThumb = await buildScreenshotThumbnail();

  const item = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    query,
    action,
    ocrSnippet: extracted.slice(0, 280),
    screenshotThumb,
    done: false,
  };

  state.items.unshift(item);
  const ok = saveItems(state.items);
  if (!ok) {
    state.items.shift();
    ocrStatus.textContent = "Could not save this item due to local storage size. Try a smaller screenshot.";
    return;
  }
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
            <p class="item-snippet">${escapeHtml(item.ocrSnippet || "No OCR snippet")}</p>
            <div class="item-actions">
              <button data-id="${item.id}" data-type="toggle">${item.done ? "Mark pending" : "Mark done"}</button>
              <button data-id="${item.id}" data-type="run">Run action</button>
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

function handleItemAction(event) {
  const id = event.target.dataset.id;
  const type = event.target.dataset.type;
  const index = state.items.findIndex((item) => item.id === id);
  if (index < 0) {
    return;
  }

  if (type === "delete") {
    state.items.splice(index, 1);
  }

  if (type === "toggle") {
    state.items[index].done = !state.items[index].done;
  }

  if (type === "run") {
    const item = state.items[index];
    const actionObj = ACTIONS.find((a) => a.label.toLowerCase() === normalizeActionLabel(item.action).toLowerCase());
    if (actionObj?.createUrl) {
      window.open(actionObj.createUrl(item.query), "_blank", "noopener");
    } else {
      ocrStatus.textContent = `Manual action: ${normalizeActionLabel(item.action)}`;
    }
  }

  saveItems(state.items);
  renderItems();
}

function clearAll() {
  if (!confirm("Clear all actionables?")) {
    return;
  }
  state.items = [];
  saveItems(state.items);
  renderItems();
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

function loadItems() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]").map((item) => ({
      ...item,
      action: normalizeActionLabel(item.action),
    }));
  } catch (error) {
    console.error(error);
    return [];
  }
}

function normalizeActionLabel(value) {
  const text = String(value || "").trim();
  return text || ACTION_FALLBACK_LABEL;
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
