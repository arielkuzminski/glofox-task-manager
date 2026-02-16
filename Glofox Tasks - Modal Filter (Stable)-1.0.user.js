// ==UserScript==
// @name         Glofox Tasks - Modal Filter (Stable)
// @namespace    glofox
// @version      1.0
// @description  Modal z pelna lista zadan, paginacja, filtry i sortowanie.
// @match        https://app.glofox.com/*
// @run-at       document-idle
// @grant        none
// @author       Ariel Kuzminski (ariel.kuzminski@gmail.com)
// @github       https://github.com/arielkuzminski/glofox-task-filter
// ==/UserScript==

(function () {
  "use strict";

  const BTN_ID = "gf-task-filter-open";
  const MODAL_ROOT_ID = "gf-task-filter-root";
  const STYLE_ID = "gf-task-filter-style";
  const SHADOW_STYLE_ID = "gf-task-filter-shadow-style";
  const STORAGE_KEY_PREFIX = "glofoxTaskFilter:v1:uiState:";
  const PAGE_SIZES = [25, 50, 100, 200];
  const DEFAULT_PAGE_SIZE = 100;
  const API_TIMEOUT_MS = 15000;
  const DEBUG = false;
  const DEBUG_PANEL = false;

  const AUTH = { token: "", locationId: "", patched: false };
  const STATE = {
    open: false,
    loading: false,
    inFlight: false,
    error: "",
    fetchedAt: null,
    all: [],
    filtered: [],
    page: 1,
    pages: 1,
    ui: defaults(),
    safeMode: false,
    payloadMeta: {
      rootKeys: [],
      listSource: "none",
      listCount: 0,
      httpStatus: "",
    },
    debug: {
      lastRenderAt: null,
      htmlLength: 0,
      hasHeaderNode: false,
      hasModalNode: false,
      rowCount: 0,
      textLength: 0,
      modalRect: "",
      computedModalStyles: "",
      lastReason: "",
    },
  };

  function defaults() {
    return {
      filters: {
        qName: "",
        qCustomer: "",
        qCreator: "",
        qAssignee: "",
        statuses: [],
        types: [],
        dueFrom: "",
        dueTo: "",
      },
      sort: { field: "dueDate", direction: "asc" },
      pageSize: DEFAULT_PAGE_SIZE,
    };
  }

  function isTasksPage() {
    return (location.hash || "").includes("/tasks");
  }
  function text(v) {
    return String(v || "").trim();
  }
  function lower(v) {
    return text(v).toLowerCase();
  }
  function escapeHtml(v) {
    return String(v || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }
  function safeJson(v) {
    try {
      return JSON.parse(v);
    } catch (_e) {
      return null;
    }
  }
  function formatDate(v) {
    const ms = toMillis(v);
    if (!Number.isFinite(ms)) return "-";
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) return "-";
    return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
  }
  function formatDateTime(v) {
    if (!v) return "-";
    try {
      return new Intl.DateTimeFormat("pl-PL", {
        year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
      }).format(v);
    } catch (_e) {
      return String(v);
    }
  }
  function debugLog() {
    if (!DEBUG) return;
    try {
      // eslint-disable-next-line no-console
      console.log("[GF-TASK-FILTER]", ...arguments);
    } catch (_e) {
      // noop
    }
  }
  function ensureUiStateSanity() {
    if (!STATE.ui || typeof STATE.ui !== "object") STATE.ui = defaults();
    if (!STATE.ui.filters || typeof STATE.ui.filters !== "object") STATE.ui.filters = defaults().filters;
    if (!Array.isArray(STATE.ui.filters.statuses)) STATE.ui.filters.statuses = [];
    if (!Array.isArray(STATE.ui.filters.types)) STATE.ui.filters.types = [];
    if (!STATE.ui.sort || typeof STATE.ui.sort !== "object") STATE.ui.sort = defaults().sort;
    if (!["asc", "desc"].includes(STATE.ui.sort.direction)) STATE.ui.sort.direction = "asc";
    if (!PAGE_SIZES.includes(Number(STATE.ui.pageSize))) STATE.ui.pageSize = DEFAULT_PAGE_SIZE;
  }
  function toStyleSnapshot(el) {
    if (!el) return "missing";
    const s = window.getComputedStyle(el);
    return `display=${s.display};visibility=${s.visibility};opacity=${s.opacity};color=${s.color};bg=${s.backgroundColor};z=${s.zIndex}`;
  }
  function isHiddenStyleSnapshot(snapshot) {
    if (!snapshot || snapshot === "missing") return true;
    return snapshot.includes("display=none") || snapshot.includes("visibility=hidden") || snapshot.includes("opacity=0");
  }
  function toMillis(value) {
    if (value === null || value === undefined || value === "") return Number.NaN;
    if (typeof value === "number" && Number.isFinite(value)) {
      return value < 1e12 ? value * 1000 : value;
    }
    if (typeof value === "string") {
      const raw = value.trim();
      if (!raw) return Number.NaN;
      if (/^\d+$/.test(raw)) {
        const n = Number(raw);
        if (!Number.isFinite(n)) return Number.NaN;
        return n < 1e12 ? n * 1000 : n;
      }
      const parsed = Date.parse(raw);
      return Number.isNaN(parsed) ? Number.NaN : parsed;
    }
    if (value instanceof Date) {
      const t = value.getTime();
      return Number.isNaN(t) ? Number.NaN : t;
    }
    return Number.NaN;
  }

  function pickJwt(raw) {
    const s = String(raw || "");
    const m1 = s.match(/Bearer\s+([A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+)/i);
    if (m1 && m1[1]) return m1[1];
    const m2 = s.match(/\b([A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+)\b/);
    return m2 && m2[1] ? m2[1] : "";
  }
  function jwtPayload(token) {
    const p = String(token || "").split(".");
    if (p.length < 2) return null;
    try {
      const b64 = p[1].replace(/-/g, "+").replace(/_/g, "/");
      const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
      return JSON.parse(atob(padded));
    } catch (_e) {
      return null;
    }
  }
  function captureAuth(v) {
    const token = pickJwt(v);
    if (!token) return;
    AUTH.token = token;
    const payload = jwtPayload(token);
    const branchId = payload && payload.user ? payload.user.branch_id : "";
    if (branchId) AUTH.locationId = String(branchId);
  }
  function captureHeaders(headersLike) {
    if (!headersLike) return;
    try {
      if (headersLike instanceof Headers) {
        captureAuth(headersLike.get("authorization") || headersLike.get("Authorization"));
        return;
      }
      if (Array.isArray(headersLike)) {
        headersLike.forEach((pair) => {
          if (Array.isArray(pair) && String(pair[0]).toLowerCase() === "authorization") captureAuth(pair[1]);
        });
        return;
      }
      if (typeof headersLike === "object") {
        Object.keys(headersLike).forEach((k) => {
          if (k.toLowerCase() === "authorization") captureAuth(headersLike[k]);
        });
      }
    } catch (_e) {
      // noop
    }
  }
  function scanStorage() {
    [localStorage, sessionStorage].forEach((store) => {
      try {
        for (let i = 0; i < store.length; i += 1) {
          const val = store.getItem(store.key(i));
          if (!val) continue;
          captureAuth(val);
          if (AUTH.token && AUTH.locationId) return;
          const obj = safeJson(val);
          if (!obj || typeof obj !== "object") continue;
          captureAuth(obj.token || obj.accessToken || obj.access_token || obj.id_token || "");
          if (AUTH.token && AUTH.locationId) return;
        }
      } catch (_e) {
        // noop
      }
    });
  }
  function ensureAuthHooks() {
    if (AUTH.patched) return;
    AUTH.patched = true;
    const nativeFetch = window.fetch;
    window.fetch = function patchedFetch(input, init) {
      try {
        if (init && init.headers) captureHeaders(init.headers);
        if (input && typeof input === "object" && input.headers) captureHeaders(input.headers);
      } catch (_e) {
        // noop
      }
      return nativeFetch.apply(this, arguments);
    };
    const nativeSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
    XMLHttpRequest.prototype.setRequestHeader = function patchedSetRequestHeader(name, value) {
      if (String(name || "").toLowerCase() === "authorization") captureAuth(value);
      return nativeSetRequestHeader.apply(this, arguments);
    };
  }
  function getAuth() {
    if (!AUTH.token || !AUTH.locationId) scanStorage();
    return { token: AUTH.token || "", locationId: AUTH.locationId || "" };
  }

  function mapStatus(s) {
    if (s === "TODAY") return "TODAY";
    if (s === "OVERDUE") return "OVERDUE";
    return "PENDING";
  }
  function personName(person) {
    if (!person) return "-";
    if (typeof person === "string") return text(person) || "-";
    if (person.name) return text(person.name) || "-";
    const full = `${text(person.first_name)} ${text(person.last_name)}`.trim();
    return full || "-";
  }
  function normalizeTask(raw) {
    return {
      id: text(raw && raw._id),
      name: text(raw && raw.name),
      type: text(raw && raw.type) || "Unknown",
      statusUi: mapStatus(raw ? raw.status : ""),
      dueDate: raw ? raw.due_date || "" : "",
      completionDate: raw ? raw.completion_date || "" : "",
      customerName: personName(raw ? raw.customer : null),
      createdByName: personName(raw ? raw.created_by : null),
      staffName: personName(raw ? raw.staff : null),
    };
  }
  function extractList(payload) {
    if (!payload) return { list: [], source: "none", rootKeys: [] };
    if (Array.isArray(payload)) return { list: payload, source: "array", rootKeys: [] };
    const rootKeys = Object.keys(payload || {});
    if (Array.isArray(payload.items)) return { list: payload.items, source: "items", rootKeys: rootKeys };
    if (Array.isArray(payload.tasks)) return { list: payload.tasks, source: "tasks", rootKeys: rootKeys };
    if (Array.isArray(payload.data)) return { list: payload.data, source: "data", rootKeys: rootKeys };
    return { list: [], source: "unknown", rootKeys: rootKeys };
  }
  function storageKey() {
    return `${STORAGE_KEY_PREFIX}${AUTH.locationId || "unknown"}`;
  }
  function loadUi() {
    try {
      const raw = localStorage.getItem(storageKey());
      if (!raw) {
        ensureUiStateSanity();
        return;
      }
      const parsed = safeJson(raw);
      if (!parsed || typeof parsed !== "object") {
        ensureUiStateSanity();
        return;
      }
      const d = defaults();
      STATE.ui = {
        filters: { ...d.filters, ...(parsed.filters || {}) },
        sort: { ...d.sort, ...(parsed.sort || {}) },
        pageSize: Number(parsed.pageSize) || d.pageSize,
      };
      ensureUiStateSanity();
    } catch (_e) {
      STATE.ui = defaults();
      ensureUiStateSanity();
    }
  }
  function saveUi() {
    try {
      localStorage.setItem(storageKey(), JSON.stringify(STATE.ui));
    } catch (_e) {
      // noop
    }
  }

  function cmpText(a, b, dir) {
    const c = lower(a).localeCompare(lower(b), "pl");
    return dir === "desc" ? -c : c;
  }
  function cmpDate(a, b, dir) {
    const ax = toMillis(a);
    const bx = toMillis(b);
    const aa = Number.isFinite(ax) ? ax : Number.POSITIVE_INFINITY;
    const bb = Number.isFinite(bx) ? bx : Number.POSITIVE_INFINITY;
    return dir === "desc" ? bb - aa : aa - bb;
  }
  function applyQuery() {
    const f = STATE.ui.filters;
    let out = STATE.all.slice();
    if (f.qName) out = out.filter((x) => lower(x.name).includes(lower(f.qName)));
    if (f.qCustomer) out = out.filter((x) => lower(x.customerName).includes(lower(f.qCustomer)));
    if (f.qCreator) out = out.filter((x) => lower(x.createdByName).includes(lower(f.qCreator)));
    if (f.qAssignee) out = out.filter((x) => lower(x.staffName).includes(lower(f.qAssignee)));
    if (f.statuses.length) out = out.filter((x) => f.statuses.includes(x.statusUi));
    if (f.types.length) out = out.filter((x) => f.types.includes(x.type));
    if (f.dueFrom) {
      const from = new Date(f.dueFrom);
      if (!Number.isNaN(from.getTime())) {
        const fromMs = from.getTime();
        out = out.filter((x) => {
          const dueMs = toMillis(x.dueDate);
          return Number.isFinite(dueMs) && dueMs >= fromMs;
        });
      }
    }
    if (f.dueTo) {
      const to = new Date(f.dueTo);
      to.setHours(23, 59, 59, 999);
      if (!Number.isNaN(to.getTime())) {
        const toMs = to.getTime();
        out = out.filter((x) => {
          const dueMs = toMillis(x.dueDate);
          return Number.isFinite(dueMs) && dueMs <= toMs;
        });
      }
    }
    const sf = STATE.ui.sort.field;
    const sd = STATE.ui.sort.direction;
    out.sort((a, b) => {
      if (sf === "dueDate") return cmpDate(a.dueDate, b.dueDate, sd);
      if (sf === "name") return cmpText(a.name, b.name, sd);
      if (sf === "customerName") return cmpText(a.customerName, b.customerName, sd);
      if (sf === "createdByName") return cmpText(a.createdByName, b.createdByName, sd);
      if (sf === "type") return cmpText(a.type, b.type, sd);
      if (sf === "statusUi") return cmpText(a.statusUi, b.statusUi, sd);
      return 0;
    });
    STATE.filtered = out;
    STATE.pages = Math.max(1, Math.ceil(out.length / STATE.ui.pageSize));
    if (STATE.page > STATE.pages) STATE.page = STATE.pages;
    if (STATE.page < 1) STATE.page = 1;
  }
  function pageItems() {
    const start = (STATE.page - 1) * STATE.ui.pageSize;
    return STATE.filtered.slice(start, start + STATE.ui.pageSize);
  }
  function types() {
    return [...new Set(STATE.all.map((x) => x.type || "Unknown"))].sort((a, b) => a.localeCompare(b, "pl"));
  }
  function pagesWindow() {
    const max = 7;
    if (STATE.pages <= max) return Array.from({ length: STATE.pages }, (_, i) => i + 1);
    const half = Math.floor(max / 2);
    let start = STATE.page - half;
    let end = STATE.page + half;
    if (start < 1) { end += 1 - start; start = 1; }
    if (end > STATE.pages) { start -= end - STATE.pages; end = STATE.pages; }
    return Array.from({ length: end - start + 1 }, (_, i) => start + i);
  }

  async function fetchTasks(force) {
    if (STATE.inFlight && !force) return;
    STATE.inFlight = true;
    STATE.loading = true;
    STATE.error = "";
    render();
    try {
      const { token, locationId } = getAuth();
      if (!token || !locationId) throw new Error("Brak tokena sesji lub location_id. Otworz natywny widok tasks i sprobuj ponownie.");
      const url = `https://app.glofox.com/task-management-api/v1/locations/${encodeURIComponent(locationId)}/tasks?offset=0&limit=10000`;
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), API_TIMEOUT_MS);
      const res = await fetch(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        credentials: "include",
        signal: ctl.signal,
      });
      clearTimeout(t);
      STATE.payloadMeta.httpStatus = String(res.status || "");
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) throw new Error("Brak autoryzacji (401/403). Odswiez sesje i sproboj ponownie.");
        throw new Error(`API zwrocilo blad HTTP ${res.status}.`);
      }
      const payload = await res.json();
      const extracted = extractList(payload);
      STATE.payloadMeta.rootKeys = extracted.rootKeys || [];
      STATE.payloadMeta.listSource = extracted.source || "none";
      STATE.payloadMeta.listCount = Array.isArray(extracted.list) ? extracted.list.length : 0;
      STATE.all = (extracted.list || []).map(normalizeTask);
      STATE.page = 1;
      STATE.fetchedAt = new Date();
      applyQuery();
      debugLog("fetch-ok", {
        source: STATE.payloadMeta.listSource,
        listCount: STATE.payloadMeta.listCount,
        mappedCount: STATE.all.length,
      });
    } catch (e) {
      STATE.error = e && e.message ? e.message : "Nieznany blad pobierania.";
      STATE.filtered = [];
      STATE.page = 1;
      STATE.pages = 1;
      STATE.payloadMeta.listSource = "error";
      STATE.payloadMeta.listCount = 0;
      debugLog("fetch-error", STATE.error);
    } finally {
      STATE.loading = false;
      STATE.inFlight = false;
      render();
    }
  }

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = `
#${BTN_ID}{margin-left:8px;padding:8px 12px;border-radius:8px;border:1px solid #5f63e9;background:#5f63e9;color:#fff;font-weight:600;cursor:pointer}
#${BTN_ID}:hover{filter:brightness(.95)}
`;
    document.head.appendChild(s);
  }
  function modalCssText() {
    return `
.gf-over{position:fixed;inset:0;z-index:99999;background:rgba(8,12,24,.55);display:flex;align-items:center;justify-content:center;padding:12px}
.gf-sandbox{all:initial;font-family:Arial,sans-serif;color:#222245;display:block;width:100%;height:100%}
.gf-sandbox *{box-sizing:border-box;font-family:inherit}
.gf-modal{width:min(1500px,100%);height:min(90vh,100%);display:flex;flex-direction:column;border-radius:12px;background:#fff;overflow:hidden;font-family:Arial,sans-serif;color:#222245;visibility:visible;opacity:1;isolation:isolate}
.gf-head{display:flex;justify-content:space-between;gap:8px;padding:12px 16px;border-bottom:1px solid #ececf6;background:#f9f9ff}
.gf-title{font-size:16px;font-weight:700;color:#222245}.gf-sub{font-size:12px;color:#666b8e;margin-top:4px}
.gf-actions{display:flex;gap:8px}.gf-btn{border:1px solid #d6daf4;background:#fff;color:#2d3164;border-radius:8px;padding:7px 10px;font-size:12px;font-weight:600;cursor:pointer}
.gf-btn.gf-primary{border-color:#5f63e9;background:#5f63e9;color:#fff}.gf-btn:disabled{opacity:.55;cursor:not-allowed}
.gf-main{display:flex;flex-direction:column;min-height:0;flex:1}
.gf-panel{padding:10px 14px;border-bottom:1px solid #ececf6}.gf-grid{display:grid;grid-template-columns:repeat(4,minmax(160px,1fr));gap:8px}
.gf-field{display:flex;flex-direction:column;gap:4px}.gf-field label{font-size:11px;color:#5a5f82;font-weight:600}
.gf-field input,.gf-field select{border:1px solid #d8dcf4;border-radius:7px;min-height:32px;padding:5px 8px;font-size:12px}
.gf-wrap{flex:1;min-height:0;overflow:auto}.gf-table{width:100%;border-collapse:collapse;font-size:12px}
.gf-table th,.gf-table td{border-bottom:1px solid #eef0f9;padding:9px 10px;text-align:left;vertical-align:top;white-space:nowrap}
.gf-table th{position:sticky;top:0;background:#fbfbff;z-index:1;font-weight:700;color:#2b2f62}
.gf-th{border:none;background:transparent;color:inherit;font-weight:inherit;cursor:pointer;padding:0}
.gf-tag{display:inline-block;border-radius:999px;padding:3px 8px;font-size:11px;font-weight:700}
.gf-pending{background:#eef1ff;color:#444bb5}.gf-today{background:#fff4df;color:#b26a00}.gf-overdue{background:#ffe6ea;color:#b4233f}
.gf-foot{border-top:1px solid #ececf6;padding:10px 14px;display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;background:#fbfbff}
.gf-pages{display:flex;gap:6px;align-items:center;flex-wrap:wrap}.gf-page{border:1px solid #d6daf4;background:#fff;color:#2d3164;border-radius:6px;min-width:30px;height:28px;padding:0 6px;cursor:pointer}
.gf-page[aria-current="page"]{background:#5f63e9;color:#fff;border-color:#5f63e9}.gf-msg{padding:18px;font-size:13px}.gf-err{color:#b4233f}
.gf-debug{margin:8px 14px;padding:8px 10px;border:1px dashed #9ea3d3;border-radius:8px;background:#f7f8ff;color:#2d3164;font-size:11px;line-height:1.3}
.gf-safe-list{margin:0;padding:8px 18px 16px 30px;font-size:13px;line-height:1.45}
.gf-safe-list li{margin:2px 0;color:#1f2340}
@media (max-width:1100px){.gf-grid{grid-template-columns:repeat(2,minmax(160px,1fr))}}
@media (max-width:700px){.gf-grid{grid-template-columns:1fr}}
`;
  }
  function ensureShadowStyle(shadowRoot) {
    if (!shadowRoot) return;
    if (shadowRoot.getElementById(SHADOW_STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = SHADOW_STYLE_ID;
    s.textContent = modalCssText();
    shadowRoot.appendChild(s);
  }
  function host() {
    const sels = ['[data-testid="tasks-page-header"]', '[data-testid="tasks-header"]', ".TasksHeader", ".task-list-header", ".PageHeader", "main"];
    for (const sel of sels) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return document.body;
  }
  function ensureButton() {
    if (!isTasksPage()) return;
    if (document.getElementById(BTN_ID)) return;
    const h = host();
    const btn = document.createElement("button");
    btn.id = BTN_ID;
    btn.type = "button";
    btn.textContent = "Wyswietl w modalu";
    btn.addEventListener("click", openModal);
    if (h === document.body) {
      btn.style.position = "fixed";
      btn.style.top = "72px";
      btn.style.right = "16px";
      btn.style.zIndex = "9999";
    }
    h.appendChild(btn);
  }
  function removeButton() {
    const b = document.getElementById(BTN_ID);
    if (b) b.remove();
  }
  function ensureRoot() {
    let r = document.getElementById(MODAL_ROOT_ID);
    if (!r) {
      r = document.createElement("div");
      r.id = MODAL_ROOT_ID;
      r.style.position = "relative";
      r.style.zIndex = "2147483600";
      document.body.appendChild(r);
    }
    return r;
  }
  function ensureShadowRoot() {
    const hostEl = ensureRoot();
    if (!hostEl.shadowRoot) {
      hostEl.attachShadow({ mode: "open" });
    }
    return hostEl.shadowRoot;
  }
  function setFilter(key, value) {
    STATE.ui.filters[key] = value;
    STATE.page = 1;
    applyQuery();
    saveUi();
    render();
  }
  function setFilterMulti(key, select) {
    const arr = [...select.options].filter((o) => o.selected).map((o) => o.value);
    setFilter(key, arr);
  }
  function toggleSort(field) {
    if (STATE.ui.sort.field === field) STATE.ui.sort.direction = STATE.ui.sort.direction === "asc" ? "desc" : "asc";
    else { STATE.ui.sort.field = field; STATE.ui.sort.direction = "asc"; }
    applyQuery(); saveUi(); render();
  }
  function resetFilters() {
    const d = defaults();
    STATE.ui.filters = d.filters;
    STATE.ui.sort = d.sort;
    STATE.page = 1;
    applyQuery();
    saveUi();
    render();
  }
  function closeModal() {
    STATE.open = false;
    const shadow = ensureShadowRoot();
    shadow.innerHTML = "";
    document.body.style.overflow = "";
    document.body.classList.remove("gf-task-filter-debug");
  }
  async function openModal() {
    STATE.open = true;
    STATE.error = "";
    STATE.safeMode = false;
    STATE.debug.lastReason = "";
    document.body.style.overflow = "hidden";
    if (DEBUG) document.body.classList.add("gf-task-filter-debug");
    ensureShadowRoot();
    getAuth();
    loadUi();
    ensureUiStateSanity();
    applyQuery();
    render();
    await fetchTasks(true);
  }

  function th(label, field) {
    const active = STATE.ui.sort.field === field;
    const arrow = active ? (STATE.ui.sort.direction === "asc" ? " ^" : " v") : "";
    return `<th><button class="gf-th" data-a="sort" data-sort="${field}">${label}${arrow}</button></th>`;
  }
  function badgeClass(status) {
    if (status === "TODAY") return "gf-tag gf-today";
    if (status === "OVERDUE") return "gf-tag gf-overdue";
    return "gf-tag gf-pending";
  }
  function debugPanelHtml() {
    if (!DEBUG_PANEL) return "";
    const rootKeys = (STATE.payloadMeta.rootKeys || []).join(", ") || "-";
    const reason = STATE.debug.lastReason || "-";
    return `<div class="gf-debug">
<strong>Debug</strong><br>
status=${escapeHtml(STATE.payloadMeta.httpStatus || "-")} | source=${escapeHtml(STATE.payloadMeta.listSource || "-")} | listCount=${STATE.payloadMeta.listCount} | mapped=${STATE.all.length} | filtered=${STATE.filtered.length}<br>
rootKeys=${escapeHtml(rootKeys)}<br>
render: htmlLen=${STATE.debug.htmlLength} | header=${STATE.debug.hasHeaderNode} | modal=${STATE.debug.hasModalNode} | rows=${STATE.debug.rowCount}<br>
modalStyle=${escapeHtml(STATE.debug.computedModalStyles || "-")}<br>
safeMode=${STATE.safeMode} | reason=${escapeHtml(reason)}
</div>`;
  }
  function safeListHtml() {
    const sample = STATE.filtered.slice(0, 20);
    if (!sample.length) return '<div class="gf-msg">SAFE_MODE: brak rekordow do wyswietlenia.</div>';
    return `<ul class="gf-safe-list">${sample.map((t) => `<li>${escapeHtml(t.name || "-")} | ${escapeHtml(t.customerName)} | ${escapeHtml(formatDate(t.dueDate))}</li>`).join("")}</ul>`;
  }
  function html(forceSafe) {
    if (!STATE.open) return "";
    const safe = Boolean(forceSafe || STATE.safeMode);
    const total = STATE.filtered.length;
    const from = total ? (STATE.page - 1) * STATE.ui.pageSize + 1 : 0;
    const to = Math.min(STATE.page * STATE.ui.pageSize, total);
    const rows = pageItems().map((t) => `
<tr>
<td title="${escapeHtml(t.name)}">${escapeHtml(t.name || "-")}</td>
<td>${escapeHtml(t.customerName)}</td>
<td>${escapeHtml(t.type)}</td>
<td><span class="${badgeClass(t.statusUi)}">${escapeHtml(t.statusUi)}</span></td>
<td>${escapeHtml(formatDate(t.dueDate))}</td>
<td>${escapeHtml(t.createdByName)}</td>
<td>${escapeHtml(t.staffName)}</td>
</tr>`).join("");
    const pages = pagesWindow().map((p) => `<button class="gf-page" data-a="page" data-page="${p}" ${p === STATE.page ? 'aria-current="page"' : ""}>${p}</button>`).join("");
    const typeOptions = types().map((v) => `<option value="${escapeHtml(v)}" ${STATE.ui.filters.types.includes(v) ? "selected" : ""}>${escapeHtml(v)}</option>`).join("");
    const statusOptions = ["PENDING", "TODAY", "OVERDUE"].map((v) => `<option value="${v}" ${STATE.ui.filters.statuses.includes(v) ? "selected" : ""}>${v}</option>`).join("");
    const tableContent = `
${STATE.loading ? '<div class="gf-msg">Ladowanie danych...</div>' : ""}
${STATE.error ? `<div class="gf-msg gf-err">${escapeHtml(STATE.error)}</div>` : ""}
${!STATE.loading && !STATE.error && !total ? '<div class="gf-msg">Brak zadan dla aktualnych filtrow.</div>' : ""}
${!STATE.loading && !STATE.error && total ? `<table class="gf-table"><thead><tr>${th("Nazwa", "name")}${th("Klient", "customerName")}${th("Typ", "type")}${th("Status", "statusUi")}${th("Termin", "dueDate")}${th("Utworzone przez", "createdByName")}<th>Przypisano do</th></tr></thead><tbody>${rows}</tbody></table>` : ""}`;
    const safeContent = `
<div class="gf-msg">SAFE_MODE aktywny: uproszczony renderer anty-whiteout.</div>
${STATE.error ? `<div class="gf-msg gf-err">${escapeHtml(STATE.error)}</div>` : ""}
${safeListHtml()}`;

    return `
<div class="gf-over" data-role="overlay">
<div class="gf-sandbox">
<div class="gf-modal" role="dialog" aria-modal="true">
<div class="gf-head">
  <div><div class="gf-title">Tasks Explorer (Modal)</div><div class="gf-sub">Rekordy po filtrach: ${total} / ${STATE.all.length} | Ostatni fetch: ${escapeHtml(formatDateTime(STATE.fetchedAt))}</div></div>
  <div class="gf-actions">
    <button class="gf-btn gf-primary" data-a="refresh" ${STATE.loading ? "disabled" : ""}>Odswiez dane</button>
    <button class="gf-btn" data-a="reset">Reset filtrow</button>
    <button class="gf-btn" data-a="close">Zamknij</button>
  </div>
</div>
${debugPanelHtml()}
<div class="gf-main">
${safe ? "" : `<div class="gf-panel">
  <div class="gf-grid">
    <div class="gf-field"><label>Nazwa zadania</label><input data-f="qName" value="${escapeHtml(STATE.ui.filters.qName)}"></div>
    <div class="gf-field"><label>Klient</label><input data-f="qCustomer" value="${escapeHtml(STATE.ui.filters.qCustomer)}"></div>
    <div class="gf-field"><label>Utworzone przez</label><input data-f="qCreator" value="${escapeHtml(STATE.ui.filters.qCreator)}"></div>
    <div class="gf-field"><label>Przypisano do</label><input data-f="qAssignee" value="${escapeHtml(STATE.ui.filters.qAssignee)}"></div>
    <div class="gf-field"><label>Status (multi)</label><select multiple data-fm="statuses">${statusOptions}</select></div>
    <div class="gf-field"><label>Typ (multi)</label><select multiple data-fm="types">${typeOptions}</select></div>
    <div class="gf-field"><label>Termin od</label><input type="date" data-f="dueFrom" value="${escapeHtml(STATE.ui.filters.dueFrom)}"></div>
    <div class="gf-field"><label>Termin do</label><input type="date" data-f="dueTo" value="${escapeHtml(STATE.ui.filters.dueTo)}"></div>
  </div>
</div>`}
<div class="gf-wrap">
${safe ? safeContent : tableContent}
</div>
<div class="gf-foot">
  <div>Widok: ${from}-${to} z ${total}</div>
  <div class="gf-pages">
    ${safe ? "" : `<select data-a="size">${PAGE_SIZES.map((n) => `<option value="${n}" ${n === STATE.ui.pageSize ? "selected" : ""}>${n}/str</option>`).join("")}</select>
    <button class="gf-page" data-a="first" ${STATE.page === 1 ? "disabled" : ""}>&lt;&lt;</button>
    <button class="gf-page" data-a="prev" ${STATE.page === 1 ? "disabled" : ""}>&lt;</button>
    ${pages}
    <button class="gf-page" data-a="next" ${STATE.page === STATE.pages ? "disabled" : ""}>&gt;</button>
    <button class="gf-page" data-a="last" ${STATE.page === STATE.pages ? "disabled" : ""}>&gt;&gt;</button>`}
  </div>
</div>
</div>
</div>
</div>
</div>`;
  }
  function collectRenderDebug(root) {
    const modal = root.querySelector(".gf-modal");
    const header = root.querySelector(".gf-head");
    const rows = root.querySelectorAll("tbody tr");
    const rect = modal ? modal.getBoundingClientRect() : null;
    const textLen = modal ? text(modal.innerText || "").length : 0;
    STATE.debug.lastRenderAt = new Date();
    STATE.debug.htmlLength = root.innerHTML.length;
    STATE.debug.hasModalNode = Boolean(modal);
    STATE.debug.hasHeaderNode = Boolean(header);
    STATE.debug.rowCount = rows.length;
    STATE.debug.textLength = textLen;
    STATE.debug.modalRect = rect ? `${Math.round(rect.width)}x${Math.round(rect.height)}` : "0x0";
    STATE.debug.computedModalStyles = toStyleSnapshot(modal);
  }
  function shouldEnableSafeMode() {
    if (STATE.safeMode) return false;
    if (!STATE.open) return false;
    if (STATE.loading) return false;
    if (STATE.error) return false;
    if (STATE.debug.htmlLength <= 0) return true;
    if (!STATE.debug.hasModalNode || !STATE.debug.hasHeaderNode) return true;
    if (isHiddenStyleSnapshot(STATE.debug.computedModalStyles)) return true;
    if (STATE.debug.modalRect === "0x0") return true;
    if (STATE.debug.textLength < 10) return true;
    if (STATE.all.length > 0 && STATE.filtered.length > 0 && STATE.debug.rowCount === 0) return true;
    return false;
  }
  function renderHardFallback(root) {
    const top = STATE.filtered.slice(0, 20);
    const listHtml = top.length
      ? `<ul style="margin:8px 0 0 18px;padding:0;line-height:1.45;">${top.map((t) => `<li>${escapeHtml(t.name || "-")} | ${escapeHtml(t.customerName)} | ${escapeHtml(formatDate(t.dueDate))}</li>`).join("")}</ul>`
      : '<div style="margin-top:8px;">Brak rekordow do podgladu.</div>';
    root.innerHTML = `
<div data-hard="overlay" style="position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.65);display:flex;align-items:center;justify-content:center;padding:16px;">
  <div style="width:min(1100px,96vw);max-height:90vh;overflow:auto;background:#fff;color:#111;border-radius:12px;padding:14px 16px;box-shadow:0 12px 30px rgba(0,0,0,.35);font:14px/1.35 Arial,sans-serif;">
    <div style="display:flex;justify-content:space-between;gap:10px;align-items:center;">
      <strong style="font-size:16px;">Tasks Explorer (HARD FALLBACK)</strong>
      <div style="display:flex;gap:8px;">
        <button data-hard="refresh" style="padding:6px 10px;border:1px solid #5f63e9;background:#5f63e9;color:#fff;border-radius:6px;cursor:pointer;">Odswiez dane</button>
        <button data-hard="close" style="padding:6px 10px;border:1px solid #bbb;background:#fff;color:#111;border-radius:6px;cursor:pointer;">Zamknij</button>
      </div>
    </div>
    <div style="margin-top:8px;font-size:12px;color:#333;">
      status=${escapeHtml(STATE.payloadMeta.httpStatus || "-")} | source=${escapeHtml(STATE.payloadMeta.listSource || "-")} | listCount=${STATE.payloadMeta.listCount} | mapped=${STATE.all.length} | filtered=${STATE.filtered.length}<br>
      htmlLen=${STATE.debug.htmlLength} | header=${STATE.debug.hasHeaderNode} | modal=${STATE.debug.hasModalNode} | rows=${STATE.debug.rowCount} | textLen=${STATE.debug.textLength} | rect=${escapeHtml(STATE.debug.modalRect || "-")}<br>
      style=${escapeHtml(STATE.debug.computedModalStyles || "-")}
    </div>
    ${listHtml}
  </div>
</div>`;

    const overlay = root.querySelector('[data-hard="overlay"]');
    if (overlay) {
      overlay.addEventListener("click", (e) => {
        if (e.target === overlay) closeModal();
      });
    }
    const close = root.querySelector('[data-hard="close"]');
    if (close) close.addEventListener("click", closeModal);
    const refresh = root.querySelector('[data-hard="refresh"]');
    if (refresh) refresh.addEventListener("click", () => fetchTasks(true));
  }

  function bind(root) {
    const overlay = root.querySelector('[data-role="overlay"]');
    if (overlay) overlay.addEventListener("click", (e) => { if (e.target === overlay) closeModal(); });
    const close = root.querySelector('[data-a="close"]');
    if (close) close.addEventListener("click", closeModal);
    const refresh = root.querySelector('[data-a="refresh"]');
    if (refresh) refresh.addEventListener("click", () => fetchTasks(true));
    const reset = root.querySelector('[data-a="reset"]');
    if (reset) reset.addEventListener("click", resetFilters);

    root.querySelectorAll("[data-f]").forEach((el) => {
      el.addEventListener("input", (e) => setFilter(e.target.getAttribute("data-f"), e.target.value));
    });
    root.querySelectorAll("[data-fm]").forEach((el) => {
      el.addEventListener("change", (e) => setFilterMulti(e.target.getAttribute("data-fm"), e.target));
    });
    const size = root.querySelector('[data-a="size"]');
    if (size) size.addEventListener("change", (e) => {
      const next = Number(e.target.value);
      if (!PAGE_SIZES.includes(next)) return;
      STATE.ui.pageSize = next;
      STATE.page = 1;
      applyQuery();
      saveUi();
      render();
    });
    root.querySelectorAll("[data-a]").forEach((el) => {
      const a = el.getAttribute("data-a");
      if (a === "sort") el.addEventListener("click", (e) => toggleSort(e.currentTarget.getAttribute("data-sort")));
      if (a === "first") el.addEventListener("click", () => { STATE.page = 1; render(); });
      if (a === "prev") el.addEventListener("click", () => { STATE.page = Math.max(1, STATE.page - 1); render(); });
      if (a === "next") el.addEventListener("click", () => { STATE.page = Math.min(STATE.pages, STATE.page + 1); render(); });
      if (a === "last") el.addEventListener("click", () => { STATE.page = STATE.pages; render(); });
      if (a === "page") el.addEventListener("click", (e) => { STATE.page = Number(e.currentTarget.getAttribute("data-page")) || 1; render(); });
    });
  }
  function captureFocusState(root) {
    if (!root) return null;
    const active = root.activeElement;
    if (!active || !(active instanceof HTMLElement)) return null;
    if (!active.matches("[data-f], [data-fm], [data-a='size']")) return null;

    const state = {
      key: "",
      value: "",
      start: null,
      end: null,
    };

    if (active.hasAttribute("data-f")) {
      state.key = `f:${active.getAttribute("data-f")}`;
    } else if (active.hasAttribute("data-fm")) {
      state.key = `fm:${active.getAttribute("data-fm")}`;
    } else if (active.getAttribute("data-a") === "size") {
      state.key = "a:size";
    } else {
      return null;
    }

    if ("value" in active) state.value = active.value;
    if (
      active instanceof HTMLInputElement &&
      typeof active.selectionStart === "number" &&
      typeof active.selectionEnd === "number"
    ) {
      state.start = active.selectionStart;
      state.end = active.selectionEnd;
    }
    return state;
  }
  function restoreFocusState(root, state) {
    if (!root || !state || !state.key) return;
    let target = null;
    if (state.key.startsWith("f:")) {
      const key = state.key.slice(2);
      target = root.querySelector(`[data-f="${CSS.escape(key)}"]`);
    } else if (state.key.startsWith("fm:")) {
      const key = state.key.slice(3);
      target = root.querySelector(`[data-fm="${CSS.escape(key)}"]`);
    } else if (state.key === "a:size") {
      target = root.querySelector('[data-a="size"]');
    }
    if (!target || !(target instanceof HTMLElement)) return;
    target.focus();
    if (
      target instanceof HTMLInputElement &&
      typeof state.start === "number" &&
      typeof state.end === "number"
    ) {
      target.setSelectionRange(state.start, state.end);
    }
  }

  function render() {
    const root = ensureShadowRoot();
    if (!STATE.open) { root.innerHTML = ""; return; }
    const focusState = captureFocusState(root);
    ensureShadowStyle(root);
    root.innerHTML = html(false);
    ensureShadowStyle(root);
    collectRenderDebug(root);
    debugLog("render-snapshot", {
      htmlLength: STATE.debug.htmlLength,
      hasHeader: STATE.debug.hasHeaderNode,
      hasModal: STATE.debug.hasModalNode,
      rows: STATE.debug.rowCount,
      textLength: STATE.debug.textLength,
      rect: STATE.debug.modalRect,
      styles: STATE.debug.computedModalStyles,
    });
    if (shouldEnableSafeMode()) {
      STATE.safeMode = true;
      STATE.debug.lastReason = "whiteout_guard";
      debugLog("safe-mode-enabled", {
        htmlLength: STATE.debug.htmlLength,
        hasModal: STATE.debug.hasModalNode,
        hasHeader: STATE.debug.hasHeaderNode,
        rows: STATE.debug.rowCount,
        styles: STATE.debug.computedModalStyles,
      });
      root.innerHTML = html(true);
      ensureShadowStyle(root);
      collectRenderDebug(root);
      if (shouldEnableSafeMode()) {
        STATE.debug.lastReason = "hard_fallback";
        debugLog("hard-fallback-enabled", {
          htmlLength: STATE.debug.htmlLength,
          hasHeader: STATE.debug.hasHeaderNode,
          textLength: STATE.debug.textLength,
          rect: STATE.debug.modalRect,
          styles: STATE.debug.computedModalStyles,
        });
        renderHardFallback(root);
        ensureShadowStyle(root);
        return;
      }
    }
    bind(root);
    restoreFocusState(root, focusState);
  }

  function bootstrap() {
    if (window.__GF_TASK_FILTER_BOOTSTRAPPED__) return;
    window.__GF_TASK_FILTER_BOOTSTRAPPED__ = true;
    ensureStyle();
    ensureAuthHooks();
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && STATE.open) closeModal();
    });
    const obs = new MutationObserver(() => { if (isTasksPage()) ensureButton(); else removeButton(); });
    obs.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("hashchange", () => { if (isTasksPage()) ensureButton(); else removeButton(); });
    let last = location.href;
    setInterval(() => {
      if (last === location.href) return;
      last = location.href;
      if (isTasksPage()) ensureButton(); else removeButton();
    }, 500);
    if (isTasksPage()) ensureButton();
  }

  bootstrap();
})();
