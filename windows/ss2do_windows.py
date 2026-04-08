"""
SS2do Windows — Screenshot-to-Action Workflow
"""

import json
import os
import re
import uuid
import tkinter as tk
from tkinter import ttk, filedialog, messagebox, scrolledtext
from datetime import date, datetime, timedelta
from pathlib import Path
import subprocess
import tempfile
import threading

# ── Optional imports ─────────────────────────────────────────────────────────
try:
    from PIL import Image, ImageTk
    PIL_AVAILABLE = True
except ImportError:
    PIL_AVAILABLE = False

try:
    import pytesseract
    for _p in [
        r"C:\Program Files\Tesseract-OCR\tesseract.exe",
        r"C:\Program Files (x86)\Tesseract-OCR\tesseract.exe",
    ]:
        if os.path.isfile(_p):
            pytesseract.pytesseract.tesseract_cmd = _p
            break
    TESSERACT_AVAILABLE = True
except ImportError:
    TESSERACT_AVAILABLE = False

# ── Storage paths ─────────────────────────────────────────────────────────────
DATA_DIR   = Path(os.environ.get("APPDATA", Path.home())) / "SS2do"
THUMB_DIR  = DATA_DIR / "thumbs"
DATA_DIR.mkdir(parents=True, exist_ok=True)
THUMB_DIR.mkdir(parents=True, exist_ok=True)
STORAGE_FILE  = DATA_DIR / "actionables.json"
RESOLVED_FILE = DATA_DIR / "resolved_log.json"

MAX_IMAGE_BYTES    = 10 * 1024 * 1024
ALLOWED_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".bmp"}

ACTIONS = [
    "Find and download paper",
    "Open web search",
    "Set reminder / task",
    "Summarize and store notes",
    "General follow-up",
]
ACTION_FALLBACK = "General follow-up"

# ── Palette ───────────────────────────────────────────────────────────────────
BG        = "#F5F0E8"
PANEL     = "#FFFFFF"
BORDER    = "#D8D0C0"
TEXT      = "#1A2E2F"
MUTED     = "#6B8080"
ACCENT    = "#E07820"        # orange — browse/analyze
SAVE_CLR  = "#0A9E8A"        # teal  — save
DANGER    = "#C0392B"        # red   — delete
DONE_BG   = "#EAF6F2"
TAG_BG    = "#FEE8C8"
TAG_FG    = "#7A4010"
BUCKET_FG = "#0A6060"
HDR_BG    = "#1A2E2F"        # dark header bar
CHIP_BG   = "#D0EFEC"
CHIP_FG   = "#0A5050"

FONT_UI   = ("Segoe UI", 10)
FONT_BOLD = ("Segoe UI", 10, "bold")
FONT_H1   = ("Segoe UI", 12, "bold")
FONT_MONO = ("Consolas", 9)
FONT_TINY = ("Segoe UI", 8)


# ── Helpers ───────────────────────────────────────────────────────────────────

def load_json(path, default):
    try:
        if path.exists():
            with path.open("r", encoding="utf-8") as f:
                return json.load(f)
    except Exception:
        pass
    return default


def save_json(path, data):
    try:
        with path.open("w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
        return True
    except Exception:
        return False


def run_ocr(image_path: str) -> str:
    if not (TESSERACT_AVAILABLE and PIL_AVAILABLE):
        return ""
    try:
        return pytesseract.image_to_string(Image.open(image_path), lang="eng+spa").strip()
    except Exception:
        try:
            return pytesseract.image_to_string(Image.open(image_path), lang="eng").strip()
        except Exception:
            return ""


def suggest_action(ocr_text: str) -> dict:
    t = ocr_text.lower()
    title = _title_from(t)
    if re.search(r"doi|abstract|references|journal|vol\.|arxiv|conference", t):
        return {"action": "Find and download paper", "suggestions": [
            f"Download paper: {title}", f"{title} pdf", f"Find source for {title}"]}
    if re.search(r"meeting|call|agenda|tomorrow|today|deadline|deliverable", t):
        return {"action": "Set reminder / task", "suggestions": [
            f"Follow up: {title}", f"Prepare for: {title}", f"Schedule task: {title}"]}
    if re.search(r"invoice|receipt|total|payment|mxn|usd|\$\d", t):
        return {"action": "Summarize and store notes", "suggestions": [
            f"Review expense: {title}", "Extract expenses and save summary",
            f"Validate payment details: {title}"]}
    return {"action": "Open web search", "suggestions": [
        f"Research: {title}", f"Find context for: {title}", "Search screenshot context"]}


def _title_from(text: str) -> str:
    words = [w for w in re.sub(r"[^a-z0-9\s]", " ", text).split() if len(w) > 2][:8]
    return " ".join(w.capitalize() for w in words[:5]) or "screenshot topic"


def detect_date(text: str) -> str:
    for tok in (re.findall(r"\b\d{4}[-/]\d{1,2}[-/]\d{1,2}\b", text) +
                re.findall(r"\b\d{1,2}[-/]\d{1,2}[-/]\d{2,4}\b", text)):
        iso = _tok_to_iso(tok)
        if iso:
            return iso
    return ""


def _tok_to_iso(tok: str) -> str:
    m = re.match(r"^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$", tok)
    if m:
        return _validate_ymd(int(m[1]), int(m[2]), int(m[3]))
    m = re.match(r"^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})$", tok)
    if m:
        d, mo, y = int(m[1]), int(m[2]), int(m[3])
        return _validate_ymd(y + 2000 if y < 100 else y, mo, d)
    return ""


def _validate_ymd(y, m, d) -> str:
    if not (2000 <= y <= 2100):
        return ""
    try:
        return date(y, m, d).strftime("%Y-%m-%d")
    except ValueError:
        return ""


def compute_reminder(deadline: str, mode: str):
    if not deadline or mode == "none":
        return None
    try:
        base = datetime.strptime(deadline, "%Y-%m-%d").replace(hour=8)
        if mode == "before":
            base -= timedelta(days=1)
        elif mode == "after":
            base += timedelta(days=1)
        return base.isoformat()
    except ValueError:
        return None


def save_thumb(image_path: str, item_id: str) -> str:
    if not (PIL_AVAILABLE and image_path):
        return ""
    try:
        img = Image.open(image_path)
        r = min(1.0, 480 / max(img.width, img.height))
        img = img.resize((max(1, int(img.width * r)), max(1, int(img.height * r))),
                          Image.LANCZOS)
        fname = f"{item_id}.jpg"
        img.save(THUMB_DIR / fname, "JPEG", quality=80)
        return fname
    except Exception:
        return ""


def load_thumb(fname: str, max_w=440, max_h=220):
    if not (PIL_AVAILABLE and fname):
        return None
    p = THUMB_DIR / fname
    if not p.exists():
        return None
    try:
        img = Image.open(p)
        r = min(1.0, max_w / img.width, max_h / img.height)
        img = img.resize((max(1, int(img.width * r)), max(1, int(img.height * r))),
                          Image.LANCZOS)
        return ImageTk.PhotoImage(img)
    except Exception:
        return None


# ═════════════════════════════════════════════════════════════════════════════
#  Main window
# ═════════════════════════════════════════════════════════════════════════════

class SS2doApp(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("SS2do — Screenshot to Actionable")
        self.geometry("1150x820")
        self.minsize(900, 640)
        self.configure(bg=BG)

        # ── App state ────────────────────────────────────────────────────────
        self._img_path: str | None = None
        self._thumb_refs: list = []
        self.items: list       = load_json(STORAGE_FILE, [])
        self.resolved: list    = load_json(RESOLVED_FILE, [])

        self._build_ui()
        self._refresh_queue()
        self._refresh_resolved()

    # ─────────────────────────────────────────────────────────────────────────
    #  UI construction
    # ─────────────────────────────────────────────────────────────────────────

    def _build_ui(self):
        # Header bar
        hdr = tk.Frame(self, bg=HDR_BG, height=52)
        hdr.pack(fill="x")
        hdr.pack_propagate(False)
        tk.Label(hdr, text="SS2do", bg=HDR_BG, fg=ACCENT,
                 font=("Segoe UI", 16, "bold"), padx=18).pack(side="left", pady=8)
        tk.Label(hdr, text="screenshot → actionable", bg=HDR_BG, fg="#90AFAF",
                 font=("Segoe UI", 10), padx=0).pack(side="left", pady=8)

        # Notebook tabs
        style = ttk.Style(self)
        style.theme_use("clam")
        style.configure("TNotebook",        background=BG,    borderwidth=0)
        style.configure("TNotebook.Tab",    background=BORDER, foreground=TEXT,
                         font=("Segoe UI", 10), padding=[18, 7])
        style.map("TNotebook.Tab",
                  background=[("selected", PANEL)],
                  foreground=[("selected", ACCENT)])
        style.configure("TScrollbar", background=BORDER, troughcolor=BG,
                         arrowcolor=MUTED)
        style.configure("TCombobox", fieldbackground=PANEL,
                         background=PANEL, foreground=TEXT)

        self._nb = ttk.Notebook(self)
        self._nb.pack(fill="both", expand=True, padx=0, pady=0)

        tab_new      = tk.Frame(self._nb, bg=BG)
        tab_queue    = tk.Frame(self._nb, bg=BG)
        tab_resolved = tk.Frame(self._nb, bg=BG)
        self._nb.add(tab_new,      text="  New Item  ")
        self._nb.add(tab_queue,    text="  Queue  ")
        self._nb.add(tab_resolved, text="  Resolved  ")

        self._build_new_tab(tab_new)
        self._build_queue_tab(tab_queue)
        self._build_resolved_tab(tab_resolved)

        # Status bar
        self._status = tk.StringVar(value="Ready.")
        tk.Label(self, textvariable=self._status, anchor="w",
                 bg=HDR_BG, fg="#90AFAF", font=FONT_TINY,
                 padx=14, pady=5).pack(fill="x", side="bottom")

    # ── New Item tab ──────────────────────────────────────────────────────────

    def _build_new_tab(self, parent):
        """Two-column layout: left = image, right = form + Save button."""
        parent.columnconfigure(0, weight=1, minsize=380)
        parent.columnconfigure(1, weight=1, minsize=420)
        parent.rowconfigure(0, weight=1)

        # ── LEFT: image capture ───────────────────────────────────────────
        left = tk.Frame(parent, bg=BG)
        left.grid(row=0, column=0, sticky="nsew", padx=(12, 6), pady=12)

        self._section(left, "Capture")

        # Buttons
        btn_row = tk.Frame(left, bg=BG)
        btn_row.pack(fill="x", pady=(0, 10))
        self._btn(btn_row, "Browse image…", self._browse_image,
                  bg=ACCENT).pack(side="left", padx=(0, 8))
        self._btn(btn_row, "Paste clipboard", self._paste_clipboard,
                  bg=MUTED).pack(side="left")

        # Preview box
        prev_outer = tk.Frame(left, bg=BORDER, bd=0)
        prev_outer.pack(fill="both", expand=True)
        self._prev_inner = tk.Frame(prev_outer, bg="#E8E4DC")
        self._prev_inner.pack(fill="both", expand=True, padx=1, pady=1)

        self._prev_label = tk.Label(
            self._prev_inner,
            text="No image loaded yet.\n\nBrowse or paste a screenshot.",
            bg="#E8E4DC", fg=MUTED, font=("Segoe UI", 10), justify="center")
        self._prev_label.pack(expand=True)

        # Analyze button
        self._analyze_btn = self._btn(
            left, "Analyze with OCR", self._analyze,
            bg=ACCENT, big=True, state="disabled")
        self._analyze_btn.pack(fill="x", pady=(10, 0))

        # ── RIGHT: form ───────────────────────────────────────────────────
        right = tk.Frame(parent, bg=BG)
        right.grid(row=0, column=1, sticky="nsew", padx=(6, 12), pady=12)
        right.rowconfigure(1, weight=1)    # OCR text grows
        right.columnconfigure(0, weight=1)

        self._section(right, "Assign Query & Action")

        form = tk.Frame(right, bg=BG)
        form.grid(row=1, column=0, sticky="nsew")
        form.columnconfigure(0, weight=1)

        # Query title
        self._lbl(form, "Query title  *  (required)").grid(
            row=0, column=0, sticky="w", pady=(0, 2))
        self._query_var = tk.StringVar()
        self._query_var.trace_add("write", lambda *_: self._sync_save())
        self._query_entry = self._entry(form, self._query_var, font=("Segoe UI", 11))
        self._query_entry.grid(row=1, column=0, sticky="ew")

        # Suggestion chips
        self._lbl(form, "Suggested titles — click to fill:").grid(
            row=2, column=0, sticky="w", pady=(8, 2))
        self._chips_frame = tk.Frame(form, bg=BG)
        self._chips_frame.grid(row=3, column=0, sticky="ew")
        self._render_chips([])

        # Action bucket
        self._lbl(form, "Action bucket").grid(row=4, column=0, sticky="w", pady=(10, 2))
        self._action_var = tk.StringVar(value=ACTION_FALLBACK)
        ttk.Combobox(form, textvariable=self._action_var, values=ACTIONS,
                     state="normal", font=FONT_UI).grid(
            row=5, column=0, sticky="ew")

        # Tags + Deadline in a 2-col sub-grid
        sub = tk.Frame(form, bg=BG)
        sub.grid(row=6, column=0, sticky="ew", pady=(10, 0))
        sub.columnconfigure(0, weight=1)
        sub.columnconfigure(1, weight=1)

        self._lbl(sub, "Tags  (comma-separated)").grid(
            row=0, column=0, sticky="w", pady=(0, 2), padx=(0, 6))
        self._tags_var = tk.StringVar()
        self._entry(sub, self._tags_var).grid(row=1, column=0, sticky="ew", padx=(0, 6))

        self._lbl(sub, "Deadline  (YYYY-MM-DD)").grid(
            row=0, column=1, sticky="w", pady=(0, 2))
        self._deadline_var = tk.StringVar()
        self._entry(sub, self._deadline_var).grid(row=1, column=1, sticky="ew")

        self._lbl(sub, "Reminder").grid(
            row=2, column=1, sticky="w", pady=(6, 2))
        self._mode_var = tk.StringVar(value="none")
        ttk.Combobox(sub, textvariable=self._mode_var,
                     values=["none", "before (1 day)", "on (8 AM)", "after (1 day)"],
                     state="readonly", font=FONT_UI).grid(row=3, column=1, sticky="ew")

        # OCR text box
        self._lbl(form, "OCR text  (editable)").grid(
            row=7, column=0, sticky="w", pady=(10, 2))
        self._ocr_box = scrolledtext.ScrolledText(
            form, height=6, font=FONT_MONO, wrap="word",
            bg=PANEL, relief="solid", bd=1, fg=TEXT)
        self._ocr_box.grid(row=8, column=0, sticky="ew")

        # ── SAVE BUTTON ── big, always visible, green
        self._save_btn = tk.Button(
            right,
            text="SAVE TO ACTIONABLES",
            command=self._save_item,
            bg=SAVE_CLR, fg="white", activebackground="#088070",
            font=("Segoe UI", 12, "bold"),
            relief="flat", cursor="hand2",
            pady=14, bd=0,
        )
        self._save_btn.grid(row=2, column=0, sticky="ew", pady=(12, 0))
        self._sync_save()   # set initial state

    # ── Queue tab ─────────────────────────────────────────────────────────────

    def _build_queue_tab(self, parent):
        # Top bar
        bar = tk.Frame(parent, bg=BG)
        bar.pack(fill="x", padx=12, pady=(10, 4))
        tk.Label(bar, text="Actionables Queue",
                 bg=BG, fg=TEXT, font=FONT_H1).pack(side="left")
        self._btn(bar, "Clear all", self._clear_all,
                  bg=DANGER).pack(side="right")

        # Scrollable list
        outer = tk.Frame(parent, bg=BORDER, bd=0)
        outer.pack(fill="both", expand=True, padx=12, pady=(0, 12))

        self._q_canvas = tk.Canvas(outer, bg=BG, highlightthickness=0)
        vsb = ttk.Scrollbar(outer, orient="vertical", command=self._q_canvas.yview)
        self._q_canvas.configure(yscrollcommand=vsb.set)
        vsb.pack(side="right", fill="y")
        self._q_canvas.pack(fill="both", expand=True, padx=1, pady=1)

        self._q_frame = tk.Frame(self._q_canvas, bg=BG)
        self._q_win = self._q_canvas.create_window((0, 0), window=self._q_frame,
                                                    anchor="nw")
        self._q_frame.bind("<Configure>",
                           lambda e: self._q_canvas.configure(
                               scrollregion=self._q_canvas.bbox("all")))
        self._q_canvas.bind("<Configure>",
                            lambda e: self._q_canvas.itemconfig(
                                self._q_win, width=e.width))
        self._q_canvas.bind("<MouseWheel>",
                            lambda e: self._q_canvas.yview_scroll(
                                int(-1 * e.delta / 120), "units"))

    # ── Resolved tab ─────────────────────────────────────────────────────────

    def _build_resolved_tab(self, parent):
        tk.Label(parent, text="Resolved Log", bg=BG, fg=TEXT,
                 font=FONT_H1).pack(anchor="w", padx=12, pady=(10, 4))

        outer = tk.Frame(parent, bg=BORDER)
        outer.pack(fill="both", expand=True, padx=12, pady=(0, 12))

        self._r_canvas = tk.Canvas(outer, bg=BG, highlightthickness=0)
        vsb = ttk.Scrollbar(outer, orient="vertical", command=self._r_canvas.yview)
        self._r_canvas.configure(yscrollcommand=vsb.set)
        vsb.pack(side="right", fill="y")
        self._r_canvas.pack(fill="both", expand=True, padx=1, pady=1)

        self._r_frame = tk.Frame(self._r_canvas, bg=BG)
        self._r_canvas.create_window((0, 0), window=self._r_frame, anchor="nw")
        self._r_frame.bind("<Configure>",
                           lambda e: self._r_canvas.configure(
                               scrollregion=self._r_canvas.bbox("all")))
        self._r_canvas.bind("<MouseWheel>",
                            lambda e: self._r_canvas.yview_scroll(
                                int(-1 * e.delta / 120), "units"))

    # ─────────────────────────────────────────────────────────────────────────
    #  Reusable widget builders
    # ─────────────────────────────────────────────────────────────────────────

    def _section(self, parent, text: str):
        tk.Label(parent, text=text, bg=BG, fg=MUTED,
                 font=("Segoe UI", 9, "bold")).pack(anchor="w", pady=(0, 6))
        tk.Frame(parent, bg=BORDER, height=1).pack(fill="x", pady=(0, 10))

    def _lbl(self, parent, text: str):
        return tk.Label(parent, text=text, bg=BG, fg=MUTED,
                        font=("Segoe UI", 8, "bold"))

    def _entry(self, parent, var, font=FONT_UI):
        e = tk.Entry(parent, textvariable=var, font=font,
                     bg=PANEL, fg=TEXT, insertbackground=TEXT,
                     relief="solid", bd=1, highlightthickness=2,
                     highlightbackground=BORDER,
                     highlightcolor=SAVE_CLR)
        return e

    def _btn(self, parent, text, cmd, bg=ACCENT, big=False, state="normal"):
        return tk.Button(
            parent, text=text, command=cmd,
            bg=bg, fg="white", activebackground=bg,
            font=("Segoe UI", 11 if big else 9, "bold"),
            relief="flat", cursor="hand2",
            padx=14, pady=8 if big else 5,
            state=state, bd=0,
        )

    # ─────────────────────────────────────────────────────────────────────────
    #  Capture actions
    # ─────────────────────────────────────────────────────────────────────────

    def _browse_image(self):
        path = filedialog.askopenfilename(
            title="Select screenshot or image",
            filetypes=[("Images", "*.png *.jpg *.jpeg *.webp *.bmp"),
                       ("All files", "*.*")])
        if not path:
            return
        if Path(path).suffix.lower() not in ALLOWED_EXTENSIONS:
            messagebox.showerror("Invalid file", "Unsupported file type.")
            return
        if Path(path).stat().st_size > MAX_IMAGE_BYTES:
            messagebox.showerror("File too large", "Max size is 10 MB.")
            return
        self._load_img(path)

    def _paste_clipboard(self):
        if not PIL_AVAILABLE:
            messagebox.showinfo("Missing library", "Run: pip install pillow")
            return
        try:
            tmp = Path(tempfile.mktemp(suffix=".png"))
            script = (
                "Add-Type -AssemblyName System.Windows.Forms; "
                "$img=[System.Windows.Forms.Clipboard]::GetImage(); "
                f"if($img){{$img.Save('{tmp}')}}else{{exit 1}}"
            )
            r = subprocess.run(["powershell", "-Command", script],
                               capture_output=True, timeout=10)
            if r.returncode == 0 and tmp.exists():
                self._load_img(str(tmp))
                return
        except Exception:
            pass
        messagebox.showinfo("No image in clipboard",
                            "Copy an image first, then paste.")

    def _load_img(self, path: str):
        self._img_path = path
        self._analyze_btn.configure(state="normal")
        self._status.set(f"Loaded: {Path(path).name}")
        self._show_preview(path)
        # Switch to New Item tab
        self._nb.select(0)

    def _show_preview(self, path: str):
        if not PIL_AVAILABLE:
            self._prev_label.configure(
                text=f"[{Path(path).name}]\n(install Pillow for preview)", image="")
            return
        try:
            w = self._prev_inner.winfo_width() or 440
            h = self._prev_inner.winfo_height() or 280
            img = Image.open(path)
            r = min(1.0, (w - 8) / img.width, (h - 8) / img.height)
            img = img.resize((max(1, int(img.width * r)),
                              max(1, int(img.height * r))), Image.LANCZOS)
            photo = ImageTk.PhotoImage(img)
            self._prev_label.configure(image=photo, text="")
            self._prev_label._photo = photo
        except Exception as ex:
            self._prev_label.configure(text=f"Preview error: {ex}", image="")

    # ─────────────────────────────────────────────────────────────────────────
    #  OCR
    # ─────────────────────────────────────────────────────────────────────────

    def _analyze(self):
        if not self._img_path:
            return
        if not TESSERACT_AVAILABLE:
            messagebox.showinfo(
                "Tesseract not found",
                "Install Tesseract-OCR:\n"
                "https://github.com/UB-Mannheim/tesseract/wiki\n\n"
                "Then:  pip install pytesseract\n\n"
                "You can still type the query manually and save.")
            return
        self._analyze_btn.configure(state="disabled", text="Running OCR…")
        self._status.set("OCR running…")

        def _work():
            text = run_ocr(self._img_path)
            self.after(0, lambda: self._ocr_done(text))

        threading.Thread(target=_work, daemon=True).start()

    def _ocr_done(self, text: str):
        self._ocr_box.delete("1.0", "end")
        self._ocr_box.insert("1.0", text)

        if text:
            s = suggest_action(text)
            self._action_var.set(s["action"])
            self._render_chips(s["suggestions"])
            d = detect_date(text)
            if d:
                self._deadline_var.set(d)
            self._status.set("OCR complete — pick a suggested title or type your own.")
        else:
            self._status.set("OCR found no text. Type your query manually.")

        self._analyze_btn.configure(state="normal", text="Analyze with OCR")
        self._sync_save()

    # ─────────────────────────────────────────────────────────────────────────
    #  Suggestion chips
    # ─────────────────────────────────────────────────────────────────────────

    def _render_chips(self, suggestions: list):
        for w in self._chips_frame.winfo_children():
            w.destroy()
        if not suggestions:
            tk.Label(self._chips_frame,
                     text="Analyze an image to see suggestions.",
                     bg=BG, fg=MUTED, font=FONT_TINY).pack(anchor="w")
            return
        for s in dict.fromkeys(s.strip() for s in suggestions if s.strip()):
            tk.Button(
                self._chips_frame, text=s,
                bg=CHIP_BG, fg=CHIP_FG,
                font=FONT_TINY, relief="solid", bd=1,
                padx=8, pady=3, cursor="hand2",
                command=lambda v=s: self._apply_chip(v)
            ).pack(side="left", padx=(0, 6), pady=2)

    def _apply_chip(self, text: str):
        self._query_var.set(text)
        self._query_entry.focus_set()

    # ─────────────────────────────────────────────────────────────────────────
    #  Save
    # ─────────────────────────────────────────────────────────────────────────

    def _sync_save(self):
        has_query = bool(self._query_var.get().strip())
        self._save_btn.configure(
            state="normal" if has_query else "disabled",
            bg=SAVE_CLR if has_query else "#A0BFBB",
        )

    def _save_item(self):
        query = self._query_var.get().strip()
        if not query:
            self._status.set("Query title is required.")
            return

        action = self._action_var.get().strip() or ACTION_FALLBACK
        # Normalise reminder mode (strip description text)
        raw_mode = self._mode_var.get().split()[0]
        mode = raw_mode if raw_mode in ("before", "on", "after") else "none"
        deadline = self._parse_deadline(self._deadline_var.get().strip())
        if mode != "none" and not deadline:
            self._status.set("Set a valid deadline date or change reminder to 'none'.")
            return

        tags = list(dict.fromkeys(
            t.strip() for t in self._tags_var.get().split(",") if t.strip()
        ))[:12]
        snippet = self._ocr_box.get("1.0", "end").strip()[:280]
        item_id = str(uuid.uuid4())
        thumb   = save_thumb(self._img_path or "", item_id)

        item = {
            "id": item_id,
            "createdAt": datetime.now().isoformat(),
            "query": query,
            "action": action,
            "tags": tags,
            "ocrSnippet": snippet,
            "thumbFile": thumb,
            "deadlineDate": deadline,
            "deadlineMode": mode,
            "reminderAt": compute_reminder(deadline, mode),
            "done": False,
            "resolvedAt": None,
        }

        self.items.insert(0, item)
        if not save_json(STORAGE_FILE, self.items):
            self.items.pop(0)
            self._status.set("Could not save — check disk space.")
            return

        # Clear form
        self._query_var.set("")
        self._tags_var.set("")
        self._deadline_var.set("")
        self._mode_var.set("none")
        self._ocr_box.delete("1.0", "end")
        self._render_chips([])

        self._refresh_queue()
        self._status.set(f'Saved: "{query}"  —  switching to Queue tab.')
        self._nb.select(1)   # jump to queue

    def _parse_deadline(self, value: str) -> str:
        if not re.match(r"^\d{4}-\d{2}-\d{2}$", value):
            return ""
        parts = value.split("-")
        return _validate_ymd(int(parts[0]), int(parts[1]), int(parts[2]))

    # ─────────────────────────────────────────────────────────────────────────
    #  Queue rendering
    # ─────────────────────────────────────────────────────────────────────────

    def _refresh_queue(self):
        self._thumb_refs.clear()
        for w in self._q_frame.winfo_children():
            w.destroy()

        if not self.items:
            tk.Label(self._q_frame, text="No actionables yet.",
                     bg=BG, fg=MUTED, font=("Segoe UI", 11)).pack(pady=30)
            return

        grouped: dict[str, list] = {}
        for item in self.items:
            grouped.setdefault(item.get("action") or ACTION_FALLBACK, []).append(item)

        for bucket, bucket_items in grouped.items():
            self._draw_bucket(bucket, bucket_items)

    def _draw_bucket(self, bucket: str, items: list):
        # Bucket header strip
        hdr = tk.Frame(self._q_frame, bg=BUCKET_FG)
        hdr.pack(fill="x", pady=(10, 0), padx=8)
        tk.Label(hdr, text=f"  {bucket.upper()}",
                 bg=BUCKET_FG, fg="white",
                 font=("Segoe UI", 8, "bold"), pady=6).pack(side="left")
        tk.Label(hdr, text=f"{len(items)} item{'s' if len(items) != 1 else ''}  ",
                 bg=BUCKET_FG, fg="#90C8C8",
                 font=("Segoe UI", 8)).pack(side="right")

        for item in items:
            self._draw_card(item)

    def _draw_card(self, item: dict):
        done    = item.get("done", False)
        card_bg = DONE_BG if done else PANEL

        card = tk.Frame(self._q_frame, bg=card_bg, relief="solid", bd=1)
        card.pack(fill="x", padx=8, pady=(0, 4))

        # Thumbnail
        if PIL_AVAILABLE and item.get("thumbFile"):
            photo = load_thumb(item["thumbFile"])
            if photo:
                self._thumb_refs.append(photo)
                tk.Label(card, image=photo, bg=card_bg,
                         anchor="center").pack(fill="x", padx=8, pady=(8, 0))

        inner = tk.Frame(card, bg=card_bg)
        inner.pack(fill="x", padx=10, pady=8)

        # Title
        title_font = ("Segoe UI", 10, "bold")
        title_fg   = MUTED if done else TEXT
        tk.Label(inner, text=item.get("query", ""),
                 bg=card_bg, fg=title_fg, font=title_font,
                 anchor="w", wraplength=480, justify="left").pack(fill="x")

        # Date + tags row
        meta_row = tk.Frame(inner, bg=card_bg)
        meta_row.pack(fill="x", pady=(2, 0))
        try:
            dt = datetime.fromisoformat(item["createdAt"]).strftime("%Y-%m-%d  %H:%M")
        except Exception:
            dt = ""
        tk.Label(meta_row, text=dt, bg=card_bg, fg=MUTED,
                 font=FONT_MONO).pack(side="left")

        for tag in item.get("tags", []):
            tk.Label(meta_row, text=f"#{tag}",
                     bg=TAG_BG, fg=TAG_FG, font=FONT_TINY,
                     padx=5, pady=1, relief="solid", bd=1).pack(
                side="left", padx=(6, 0))

        # Deadline
        dl, dm = item.get("deadlineDate", ""), item.get("deadlineMode", "none")
        if dl and dm != "none":
            r = item.get("reminderAt", "")
            try:
                r = datetime.fromisoformat(r).strftime("%Y-%m-%d %H:%M")
            except Exception:
                r = "—"
            tk.Label(inner, text=f"Deadline: {dl}  |  {dm}  |  reminder: {r}",
                     bg=card_bg, fg="#1E7070", font=FONT_TINY).pack(
                anchor="w", pady=(2, 0))

        # OCR snippet
        snip = item.get("ocrSnippet", "")
        if snip:
            tk.Label(inner, text=snip[:200] + ("…" if len(snip) > 200 else ""),
                     bg=card_bg, fg=MUTED, font=FONT_TINY,
                     wraplength=480, justify="left").pack(
                anchor="w", pady=(2, 0))

        # Action buttons
        btn_row = tk.Frame(inner, bg=card_bg)
        btn_row.pack(anchor="w", pady=(6, 0))

        toggle_lbl = "Mark pending" if done else "Mark done"
        tk.Button(btn_row, text=toggle_lbl,
                  command=lambda i=item: self._toggle(i),
                  bg=SAVE_CLR, fg="white", relief="flat",
                  font=FONT_TINY, padx=10, pady=4,
                  cursor="hand2", bd=0).pack(side="left", padx=(0, 8))

        tk.Button(btn_row, text="Delete",
                  command=lambda i=item: self._delete(i),
                  bg=DANGER, fg="white", relief="flat",
                  font=FONT_TINY, padx=10, pady=4,
                  cursor="hand2", bd=0).pack(side="left")

    # ─────────────────────────────────────────────────────────────────────────
    #  Resolved log
    # ─────────────────────────────────────────────────────────────────────────

    def _refresh_resolved(self):
        for w in self._r_frame.winfo_children():
            w.destroy()
        if not self.resolved:
            tk.Label(self._r_frame, text="No resolved entries yet.",
                     bg=BG, fg=MUTED, font=("Segoe UI", 11)).pack(pady=30)
            return
        for entry in self.resolved[:100]:
            row = tk.Frame(self._r_frame, bg=PANEL, relief="solid", bd=1)
            row.pack(fill="x", padx=8, pady=2)
            tk.Label(row, text=entry.get("query", ""),
                     bg=PANEL, fg=TEXT, font=FONT_BOLD,
                     anchor="w", wraplength=600).pack(
                anchor="w", padx=10, pady=(6, 0))
            try:
                when = datetime.fromisoformat(entry["resolvedAt"]).strftime(
                    "%Y-%m-%d  %H:%M")
            except Exception:
                when = "—"
            tk.Label(row,
                     text=f'{entry.get("action", ACTION_FALLBACK)}  |  Resolved: {when}',
                     bg=PANEL, fg=MUTED, font=FONT_TINY).pack(
                anchor="w", padx=10, pady=(0, 6))

    # ─────────────────────────────────────────────────────────────────────────
    #  Item actions
    # ─────────────────────────────────────────────────────────────────────────

    def _toggle(self, item: dict):
        idx = next((i for i, x in enumerate(self.items) if x["id"] == item["id"]), -1)
        if idx < 0:
            return
        was_done = self.items[idx].get("done", False)
        self.items[idx]["done"] = not was_done
        if not was_done:
            resolved_at = datetime.now().isoformat()
            self.items[idx]["resolvedAt"] = resolved_at
            self.resolved.insert(0, {
                "id": str(uuid.uuid4()),
                "itemId": item["id"],
                "query": item["query"],
                "action": item.get("action", ACTION_FALLBACK),
                "resolvedAt": resolved_at,
            })
            save_json(RESOLVED_FILE, self.resolved)
        else:
            self.items[idx]["resolvedAt"] = None
        save_json(STORAGE_FILE, self.items)
        self._refresh_queue()
        self._refresh_resolved()

    def _delete(self, item: dict):
        if not messagebox.askyesno("Delete", f'Delete "{item.get("query")}"?'):
            return
        idx = next((i for i, x in enumerate(self.items) if x["id"] == item["id"]), -1)
        if idx < 0:
            return
        self.items.pop(idx)
        if thumb := item.get("thumbFile"):
            (THUMB_DIR / thumb).unlink(missing_ok=True)
        save_json(STORAGE_FILE, self.items)
        self._refresh_queue()

    def _clear_all(self):
        if not self.items:
            return
        if not messagebox.askyesno("Clear all",
                                    "Delete all actionables? This cannot be undone."):
            return
        for item in self.items:
            if thumb := item.get("thumbFile"):
                (THUMB_DIR / thumb).unlink(missing_ok=True)
        self.items.clear()
        save_json(STORAGE_FILE, self.items)
        self._refresh_queue()


# ── Entry point ───────────────────────────────────────────────────────────────
if __name__ == "__main__":
    app = SS2doApp()
    app.mainloop()
