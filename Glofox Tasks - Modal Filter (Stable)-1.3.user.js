// ==UserScript==
// @name         Glofox Tasks - Modal Filter (Stable)
// @namespace    glofox
// @version      1.3
// @description  Modal z pelna lista zadan, paginacja, filtry, sortowanie, edycja, usuwanie i nowy kalendarz dat.
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
  const CONTRACT_STORAGE_KEY = "glofoxTaskFilter:v1:updateContract";
  const STATIC_UPDATE_CONTRACT = true;
  const CALENDAR_MONTH_NAMES_PL = ["styczen", "luty", "marzec", "kwiecien", "maj", "czerwiec", "lipiec", "sierpien", "wrzesien", "pazdziernik", "listopad", "grudzien"];
  const CALENDAR_DAY_NAMES_PL = ["Pon", "Wt", "Sr", "Czw", "Pt", "Sob", "Nie"];

  const AUTH = { token: "", locationId: "", userId: "", patched: false };
  const STATE = {
    open: false,
    loading: false,
    inFlight: false,
    error: "",
    notice: "",
    fetchedAt: null,
    all: [],
    filtered: [],
    page: 1,
    pages: 1,
    renderQueued: false,
    dataVersion: 0,
    cache: {
      typesDataVersion: -1,
      typesValues: [],
    },
    ui: defaults(),
    edit: {
      open: false,
      taskId: "",
      saving: false,
      deleting: false,
      confirmDeleteOpen: false,
      deleteError: "",
      error: "",
      success: "",
      draft: {
        name: "",
        dueDateInput: "",
        notes: "",
        markDone: false,
      },
      dirty: false,
      blockedByApiTaskIds: {},
    },
    calendar: {
      open: false,
      targetField: "",
      month: 0,
      year: 0,
      error: "",
      suppressBlurCommit: false,
      anchorTop: 20,
      anchorLeft: 20,
    },
    contract: {
      status: "unknown",
      ready: false,
      method: "",
      url: "",
      sampleTaskId: "",
      bodyTemplate: null,
      fieldPaths: {
        name: "",
        dueDate: "",
        notes: "",
        done: "",
      },
      doneValueType: "",
      lastError: "",
      capturedAt: null,
      ownRequestInFlight: false,
    },
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
  function scheduleRender() {
    if (STATE.renderQueued) return;
    STATE.renderQueued = true;
    const flush = () => {
      STATE.renderQueued = false;
      render();
    };
    if (typeof window.requestAnimationFrame === "function") {
      window.requestAnimationFrame(flush);
      return;
    }
    setTimeout(flush, 0);
  }
  function markAllDataChanged() {
    STATE.dataVersion += 1;
    STATE.cache.typesDataVersion = -1;
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
  function toIsoDateValue(value) {
    const ms = toMillis(value);
    if (!Number.isFinite(ms)) return "";
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) return "";
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }
  function isLeapYear(year) {
    if (year % 400 === 0) return true;
    if (year % 100 === 0) return false;
    return year % 4 === 0;
  }
  function daysInMonth(year, month) {
    if (month === 2) return isLeapYear(year) ? 29 : 28;
    if ([4, 6, 9, 11].includes(month)) return 30;
    return 31;
  }
  function toIsoDateFromParts(day, month, year) {
    const d = Number(day);
    const m = Number(month);
    const y = Number(year);
    if (!Number.isFinite(d) || !Number.isFinite(m) || !Number.isFinite(y)) return "";
    if (y < 1900 || y > 2100) return "";
    if (m < 1 || m > 12) return "";
    const maxDay = daysInMonth(y, m);
    if (d < 1 || d > maxDay) return "";
    return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }
  function parseDmyToIso(value) {
    const raw = text(value);
    if (!raw) return "";
    if (/^\d{8}$/.test(raw)) {
      const dd = raw.slice(0, 2);
      const mm = raw.slice(2, 4);
      const yyyy = raw.slice(4, 8);
      return toIsoDateFromParts(dd, mm, yyyy);
    }
    if (/^\d{2}-\d{2}-\d{4}$/.test(raw)) {
      const parts = raw.split("-");
      return toIsoDateFromParts(parts[0], parts[1], parts[2]);
    }
    return "";
  }
  function formatIsoToDmy(isoValue) {
    const iso = text(isoValue);
    if (!iso) return "";
    const match = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return "";
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (!Number.isFinite(day) || !Number.isFinite(month) || !Number.isFinite(year)) return "";
    if (year < 1900 || year > 2100) return "";
    if (month < 1 || month > 12) return "";
    const maxDay = daysInMonth(year, month);
    if (day < 1 || day > maxDay) return "";
    return `${String(day).padStart(2, "0")}-${String(month).padStart(2, "0")}-${String(year).padStart(4, "0")}`;
  }
  function deepClone(value) {
    if (value === null || value === undefined) return value;
    try {
      return JSON.parse(JSON.stringify(value));
    } catch (_e) {
      return value;
    }
  }
  function normalizePath(path) {
    return String(path || "")
      .replace(/\[(\d+)\]/g, ".$1")
      .replace(/^\./, "")
      .trim();
  }
  function splitPath(path) {
    return normalizePath(path).split(".").filter(Boolean);
  }
  function getByPath(obj, path) {
    const parts = splitPath(path);
    if (!parts.length) return undefined;
    let cur = obj;
    for (const p of parts) {
      if (cur === null || cur === undefined) return undefined;
      cur = cur[p];
    }
    return cur;
  }
  function setByPath(obj, path, value) {
    const parts = splitPath(path);
    if (!parts.length) return false;
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const key = parts[i];
      if (cur[key] === null || cur[key] === undefined) return false;
      cur = cur[key];
    }
    cur[parts[parts.length - 1]] = value;
    return true;
  }
  function listAllPaths(obj, basePath) {
    const out = [];
    function walk(value, path) {
      if (value === null || value === undefined) return;
      if (Array.isArray(value)) {
        value.forEach((item, idx) => walk(item, path ? `${path}.${idx}` : String(idx)));
        return;
      }
      if (typeof value !== "object") {
        out.push(path);
        return;
      }
      Object.keys(value).forEach((k) => walk(value[k], path ? `${path}.${k}` : k));
    }
    walk(obj, basePath || "");
    return out.filter(Boolean);
  }
  function pathIncludesKey(path, keywords) {
    const p = lower(path);
    return keywords.some((kw) => p.includes(kw));
  }
  function findFirstPath(obj, keywords) {
    const paths = listAllPaths(obj);
    for (const p of paths) {
      if (pathIncludesKey(p, keywords)) return p;
    }
    return "";
  }
  function extractTaskIdFromUrl(url) {
    const s = String(url || "");
    const m = s.match(/\/tasks\/([a-f0-9]{24})(?:[/?#]|$)/i);
    return m && m[1] ? m[1] : "";
  }
  function findIdCandidatesInBody(body) {
    const out = [];
    const paths = listAllPaths(body);
    for (const p of paths) {
      if (!pathIncludesKey(p, ["id", "_id", "task"])) continue;
      const v = getByPath(body, p);
      if (typeof v !== "string") continue;
      if (/^[a-f0-9]{24}$/i.test(v)) out.push({ path: p, value: v });
    }
    return out;
  }
  function replaceIdRecursive(value, oldId, newId) {
    if (value === null || value === undefined) return value;
    if (typeof value === "string") return value === oldId ? newId : value;
    if (Array.isArray(value)) return value.map((x) => replaceIdRecursive(x, oldId, newId));
    if (typeof value === "object") {
      const out = {};
      Object.keys(value).forEach((k) => {
        out[k] = replaceIdRecursive(value[k], oldId, newId);
      });
      return out;
    }
    return value;
  }
  function guessFieldPaths(body) {
    return {
      name: findFirstPath(body, ["name", "title"]),
      dueDate: findFirstPath(body, ["due_date", "dueDate", "due", "execution_date", "executionDate", "date"]),
      notes: findFirstPath(body, ["notes", "note", "description", "comment", "remarks", "uwag"]),
      done: findFirstPath(body, ["done", "completed", "is_done", "isDone", "completion", "status"]),
    };
  }
  function parseJsonBody(body) {
    if (!body) return null;
    if (typeof body === "string") return safeJson(body);
    if (body instanceof FormData) {
      const out = {};
      for (const [k, v] of body.entries()) out[k] = v;
      return out;
    }
    if (body instanceof URLSearchParams) {
      const out = {};
      for (const [k, v] of body.entries()) out[k] = v;
      return out;
    }
    if (typeof body === "object") return deepClone(body);
    return null;
  }
  function persistContract() {
    try {
      const snapshot = {
        status: STATE.contract.status,
        ready: STATE.contract.ready,
        method: STATE.contract.method,
        url: STATE.contract.url,
        sampleTaskId: STATE.contract.sampleTaskId,
        bodyTemplate: STATE.contract.bodyTemplate,
        fieldPaths: STATE.contract.fieldPaths,
        doneValueType: STATE.contract.doneValueType,
        capturedAt: STATE.contract.capturedAt,
      };
      sessionStorage.setItem(CONTRACT_STORAGE_KEY, JSON.stringify(snapshot));
    } catch (_e) {
      // noop
    }
  }
  function loadContract() {
    try {
      const raw = sessionStorage.getItem(CONTRACT_STORAGE_KEY);
      if (!raw) return;
      const parsed = safeJson(raw);
      if (!parsed || typeof parsed !== "object") return;
      STATE.contract = {
        ...STATE.contract,
        ...parsed,
        fieldPaths: {
          ...STATE.contract.fieldPaths,
          ...(parsed.fieldPaths || {}),
        },
      };
    } catch (_e) {
      // noop
    }
    if (STATIC_UPDATE_CONTRACT && AUTH.locationId) {
      STATE.contract.status = "ready";
      STATE.contract.ready = true;
      STATE.contract.method = "PATCH";
      STATE.contract.url = `https://app.glofox.com/task-management-api/v1/locations/${AUTH.locationId}/tasks/__TASK_ID__`;
      STATE.contract.sampleTaskId = "__TASK_ID__";
      STATE.contract.bodyTemplate = null;
      STATE.contract.fieldPaths = {
        name: "name",
        dueDate: "due_date",
        notes: "notes",
        done: "completion_date",
      };
      STATE.contract.doneValueType = "number";
      STATE.contract.lastError = "";
      STATE.contract.capturedAt = new Date().toISOString();
    }
  }
  function registerDiscoveredContract({ method, url, body, taskId }) {
    if (!method || !url || !body) return;
    const guessed = guessFieldPaths(body);
    const doneValue = guessed.done ? getByPath(body, guessed.done) : undefined;
    STATE.contract.status = "ready";
    STATE.contract.ready = true;
    STATE.contract.method = String(method || "PATCH").toUpperCase();
    STATE.contract.url = String(url || "");
    STATE.contract.sampleTaskId = String(taskId || "");
    STATE.contract.bodyTemplate = deepClone(body);
    STATE.contract.fieldPaths = guessed;
    STATE.contract.doneValueType = typeof doneValue;
    STATE.contract.lastError = "";
    STATE.contract.capturedAt = new Date().toISOString();
    persistContract();
    debugLog("contract-ready", {
      method: STATE.contract.method,
      url: STATE.contract.url,
      sampleTaskId: STATE.contract.sampleTaskId,
      fields: STATE.contract.fieldPaths,
    });
  }
  function shouldCaptureAsTaskUpdate({ method, url, body }) {
    const m = String(method || "").toUpperCase();
    if (!["PATCH", "PUT", "POST"].includes(m)) return false;
    const u = String(url || "");
    if (!u.includes("task-management-api")) return false;
    if (!u.includes("/tasks")) return false;
    if (!body || typeof body !== "object") return false;
    const hasLikelyEditableField =
      Boolean(findFirstPath(body, ["name", "title"])) ||
      Boolean(findFirstPath(body, ["notes", "description", "comment", "uwag"])) ||
      Boolean(findFirstPath(body, ["due_date", "dueDate", "due", "execution", "date"])) ||
      Boolean(findFirstPath(body, ["status", "done", "completed", "completion"]));
    return hasLikelyEditableField;
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
    const userId = payload && payload.user ? payload.user._id : "";
    if (branchId) AUTH.locationId = String(branchId);
    if (userId) AUTH.userId = String(userId);
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
    window.fetch = async function patchedFetch(input, init) {
      let requestUrl = "";
      let requestMethod = "GET";
      let requestBodyParsed = null;
      try {
        if (init && init.headers) captureHeaders(init.headers);
        if (input && typeof input === "object" && input.headers) captureHeaders(input.headers);
        requestMethod = String(
          (init && init.method) ||
            (input && typeof input === "object" && input.method) ||
            "GET",
        ).toUpperCase();
        requestUrl = String(
          typeof input === "string"
            ? input
            : input && typeof input === "object" && input.url
              ? input.url
              : "",
        );
        const requestBodyRaw =
          (init && Object.prototype.hasOwnProperty.call(init, "body") ? init.body : undefined) ||
          (input && typeof input === "object" && Object.prototype.hasOwnProperty.call(input, "body")
            ? input.body
            : undefined);
        requestBodyParsed = parseJsonBody(requestBodyRaw);
      } catch (_e) {
        // noop
      }
      const response = await nativeFetch.apply(this, arguments);
      try {
        if (
          !STATE.contract.ownRequestInFlight &&
          response &&
          response.ok &&
          shouldCaptureAsTaskUpdate({
            method: requestMethod,
            url: requestUrl,
            body: requestBodyParsed,
          })
        ) {
          const fromUrl = extractTaskIdFromUrl(requestUrl);
          const candidates = findIdCandidatesInBody(requestBodyParsed || {});
          const fromBody = candidates.length ? candidates[0].value : "";
          registerDiscoveredContract({
            method: requestMethod,
            url: requestUrl,
            body: requestBodyParsed,
            taskId: fromUrl || fromBody,
          });
        }
      } catch (_e) {
        // noop
      }
      return response;
    };
    const nativeXhrOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function patchedXhrOpen(method, url) {
      this.__gfTaskFilterMeta = this.__gfTaskFilterMeta || {};
      this.__gfTaskFilterMeta.method = String(method || "GET").toUpperCase();
      this.__gfTaskFilterMeta.url = String(url || "");
      return nativeXhrOpen.apply(this, arguments);
    };
    const nativeSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
    XMLHttpRequest.prototype.setRequestHeader = function patchedSetRequestHeader(name, value) {
      if (String(name || "").toLowerCase() === "authorization") captureAuth(value);
      this.__gfTaskFilterMeta = this.__gfTaskFilterMeta || {};
      const key = String(name || "").toLowerCase();
      this.__gfTaskFilterMeta.headers = this.__gfTaskFilterMeta.headers || {};
      this.__gfTaskFilterMeta.headers[key] = value;
      return nativeSetRequestHeader.apply(this, arguments);
    };
    const nativeXhrSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function patchedXhrSend(body) {
      this.__gfTaskFilterMeta = this.__gfTaskFilterMeta || {};
      this.__gfTaskFilterMeta.body = parseJsonBody(body);
      this.addEventListener(
        "loadend",
        () => {
          try {
            const meta = this.__gfTaskFilterMeta || {};
            if (STATE.contract.ownRequestInFlight) return;
            if (this.status < 200 || this.status >= 300) return;
            if (
              shouldCaptureAsTaskUpdate({
                method: meta.method,
                url: meta.url,
                body: meta.body,
              })
            ) {
              const fromUrl = extractTaskIdFromUrl(meta.url);
              const candidates = findIdCandidatesInBody(meta.body || {});
              const fromBody = candidates.length ? candidates[0].value : "";
              registerDiscoveredContract({
                method: meta.method,
                url: meta.url,
                body: meta.body,
                taskId: fromUrl || fromBody,
              });
            }
          } catch (_e) {
            // noop
          }
        },
        { once: true },
      );
      return nativeXhrSend.apply(this, arguments);
    };
  }
  function getAuth() {
    if (!AUTH.token || !AUTH.locationId) scanStorage();
    return { token: AUTH.token || "", locationId: AUTH.locationId || "", userId: AUTH.userId || "" };
  }

  function mapStatus(s) {
    if (s === "DONE" || s === "COMPLETED" || s === "COMPLETE") return "DONE";
    if (s === "TODAY") return "TODAY";
    if (s === "OVERDUE") return "OVERDUE";
    return "PENDING";
  }
  function firstNonEmpty(values) {
    for (const v of values) {
      const t = text(v);
      if (t) return t;
    }
    return "";
  }
  function extractNotesFromRaw(raw) {
    if (!raw || typeof raw !== "object") return "";
    return firstNonEmpty([
      raw.notes,
      raw.note,
      raw.description,
      raw.comment,
      raw.remarks,
      raw.details,
      raw.message,
      raw.body,
      raw.meta && raw.meta.notes,
      raw.metadata && raw.metadata.notes,
    ]);
  }
  function deriveDoneFromRaw(raw) {
    if (!raw || typeof raw !== "object") return false;
    if (raw.completion_date || raw.completed_at || raw.closed_at) return true;
    if (typeof raw.completed === "boolean") return raw.completed;
    if (typeof raw.done === "boolean") return raw.done;
    const status = upper(text(raw.status));
    if (["DONE", "COMPLETED", "COMPLETE", "CLOSED"].includes(status)) return true;
    return false;
  }
  function deriveId(rawValue) {
    if (!rawValue) return "";
    if (typeof rawValue === "string") return rawValue;
    if (typeof rawValue === "object") {
      return text(rawValue._id || rawValue.id || rawValue.original_user_id || "");
    }
    return "";
  }
  function deriveCustomerIdFromTask(task) {
    if (!task) return "";
    const raw = task.raw || {};
    return (
      text(raw.customer_id || raw.original_customer_id) ||
      text(raw.customer && (raw.customer.original_user_id || raw.customer._id || raw.customer.id)) ||
      text(task.customerId) ||
      ""
    );
  }
  function deriveStaffIdFromTask(task, authUserId) {
    if (!task) return "";
    const raw = task.raw || {};
    return (
      text(authUserId) ||
      text(task.staffId) ||
      text(raw.staff_id) ||
      text(raw.original_staff_id) ||
      deriveId(raw.staff) ||
      deriveId(raw.created_by) ||
      ""
    );
  }
  function upper(v) {
    return text(v).toUpperCase();
  }
  function personName(person) {
    if (!person) return "-";
    if (typeof person === "string") return text(person) || "-";
    if (person.name) return text(person.name) || "-";
    const full = `${text(person.first_name)} ${text(person.last_name)}`.trim();
    return full || "-";
  }
  function normalizeTask(raw) {
    const customerObj = raw ? raw.customer : null;
    const customerId =
      text(raw && (raw.customer_id || raw.original_customer_id)) ||
      text(customerObj && (customerObj.original_user_id || customerObj._id || customerObj.id)) ||
      "";
    const customerFirstName = text(raw && raw.customer_first_name) || text(customerObj && customerObj.first_name);
    const customerLastName = text(raw && raw.customer_last_name) || text(customerObj && customerObj.last_name);
    const staffObj = raw ? raw.staff : null;
    const staffId =
      text(raw && (raw.original_staff_id || raw.staff_id)) ||
      deriveId(staffObj) ||
      deriveId(raw && raw.created_by);
    return {
      id: text(raw && raw._id),
      name: text(raw && raw.name),
      type: text(raw && raw.type) || "Unknown",
      statusRaw: text(raw && raw.status),
      statusUi: mapStatus(raw ? raw.status : ""),
      dueDate: raw ? raw.due_date || "" : "",
      completionDate: raw ? raw.completion_date || "" : "",
      notes: extractNotesFromRaw(raw),
      isDone: deriveDoneFromRaw(raw),
      customerId: customerId,
      customerFirstName: customerFirstName,
      customerLastName: customerLastName,
      staffId: staffId,
      customerName: personName(raw ? raw.customer : null),
      createdByName: personName(raw ? raw.created_by : null),
      staffName: personName(raw ? raw.staff : null),
      raw: deepClone(raw || {}),
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
    const qName = lower(f.qName);
    const qCustomer = lower(f.qCustomer);
    const qCreator = lower(f.qCreator);
    const qAssignee = lower(f.qAssignee);
    const statusSet = f.statuses.length ? new Set(f.statuses) : null;
    const typeSet = f.types.length ? new Set(f.types) : null;

    let dueFromMs = Number.NaN;
    if (f.dueFrom) {
      const from = new Date(f.dueFrom);
      if (!Number.isNaN(from.getTime())) dueFromMs = from.getTime();
    }
    let dueToMs = Number.NaN;
    if (f.dueTo) {
      const to = new Date(f.dueTo);
      to.setHours(23, 59, 59, 999);
      if (!Number.isNaN(to.getTime())) dueToMs = to.getTime();
    }
    const hasDueFrom = Number.isFinite(dueFromMs);
    const hasDueTo = Number.isFinite(dueToMs);

    const out = STATE.all.filter((x) => {
      if (qName && !lower(x.name).includes(qName)) return false;
      if (qCustomer && !lower(x.customerName).includes(qCustomer)) return false;
      if (qCreator && !lower(x.createdByName).includes(qCreator)) return false;
      if (qAssignee && !lower(x.staffName).includes(qAssignee)) return false;
      if (statusSet && !statusSet.has(x.statusUi)) return false;
      if (typeSet && !typeSet.has(x.type)) return false;
      if (hasDueFrom || hasDueTo) {
        const dueMs = toMillis(x.dueDate);
        if (!Number.isFinite(dueMs)) return false;
        if (hasDueFrom && dueMs < dueFromMs) return false;
        if (hasDueTo && dueMs > dueToMs) return false;
      }
      return true;
    });
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
    if (STATE.cache.typesDataVersion === STATE.dataVersion) return STATE.cache.typesValues;
    const next = [...new Set(STATE.all.map((x) => x.type || "Unknown"))].sort((a, b) => a.localeCompare(b, "pl"));
    STATE.cache.typesDataVersion = STATE.dataVersion;
    STATE.cache.typesValues = next;
    return next;
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
      markAllDataChanged();
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
.gf-btn.gf-danger{border-color:#d64545;background:#d64545;color:#fff}
.gf-btn.gf-danger:hover:not(:disabled){filter:brightness(.95)}
.gf-main{display:flex;flex-direction:column;min-height:0;flex:1}
.gf-panel{padding:10px 14px;border-bottom:1px solid #ececf6}.gf-grid{display:grid;grid-template-columns:repeat(4,minmax(160px,1fr));gap:8px}
.gf-field{display:flex;flex-direction:column;gap:4px}.gf-field label{font-size:11px;color:#5a5f82;font-weight:600}
.gf-field input,.gf-field select{border:1px solid #d8dcf4;border-radius:7px;min-height:32px;padding:5px 8px;font-size:12px}
.gf-wrap{flex:1;min-height:0;overflow:auto}.gf-table{width:100%;border-collapse:collapse;font-size:12px}
.gf-table th,.gf-table td{border-bottom:1px solid #eef0f9;padding:9px 10px;text-align:left;vertical-align:top;white-space:nowrap}
.gf-row-clickable{cursor:pointer}
.gf-row-clickable:hover td{background:#f4f6ff}
.gf-table th{position:sticky;top:0;background:#fbfbff;z-index:1;font-weight:700;color:#2b2f62}
.gf-th{border:none;background:transparent;color:inherit;font-weight:inherit;cursor:pointer;padding:0}
.gf-tag{display:inline-block;border-radius:999px;padding:3px 8px;font-size:11px;font-weight:700}
.gf-pending{background:#eef1ff;color:#444bb5}.gf-today{background:#fff4df;color:#b26a00}.gf-overdue{background:#ffe6ea;color:#b4233f}
.gf-foot{border-top:1px solid #ececf6;padding:10px 14px;display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;background:#fbfbff}
.gf-pages{display:flex;gap:6px;align-items:center;flex-wrap:wrap}.gf-page{border:1px solid #d6daf4;background:#fff;color:#2d3164;border-radius:6px;min-width:30px;height:28px;padding:0 6px;cursor:pointer}
.gf-page[aria-current="page"]{background:#5f63e9;color:#fff;border-color:#5f63e9}.gf-msg{padding:18px;font-size:13px}.gf-err{color:#b4233f}.gf-ok{color:#1e7d3f}
.gf-debug{margin:8px 14px;padding:8px 10px;border:1px dashed #9ea3d3;border-radius:8px;background:#f7f8ff;color:#2d3164;font-size:11px;line-height:1.3}
.gf-safe-list{margin:0;padding:8px 18px 16px 30px;font-size:13px;line-height:1.45}
.gf-safe-list li{margin:2px 0;color:#1f2340}
.gf-edit-overlay{position:fixed;inset:0;background:rgba(10,14,28,.42);display:flex;align-items:center;justify-content:center;padding:20px;z-index:100001}
.gf-edit-modal{width:min(760px,96vw);max-height:90vh;overflow:auto;background:#fff;border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.25)}
.gf-edit-head{display:flex;justify-content:space-between;gap:10px;align-items:flex-start;padding:14px 16px;border-bottom:1px solid #ececf6}
.gf-edit-title{font-size:16px;font-weight:700;color:#202442}
.gf-edit-sub{font-size:12px;color:#6a7096;margin-top:2px}
.gf-edit-body{padding:14px 16px;display:grid;grid-template-columns:1fr 1fr;gap:10px}
.gf-edit-full{grid-column:1 / -1}
.gf-edit-field{display:flex;flex-direction:column;gap:4px}
.gf-edit-field label{font-size:12px;font-weight:600;color:#50567e}
.gf-edit-field input,.gf-edit-field textarea{border:1px solid #d8dcf4;border-radius:8px;padding:8px 10px;font-size:13px}
.gf-edit-field textarea{min-height:96px;resize:vertical}
.gf-edit-ro{border:1px solid #ececf6;background:#f8f9ff;border-radius:8px;padding:8px 10px;font-size:12px;color:#4b5076;min-height:36px;display:flex;align-items:center}
.gf-edit-foot{padding:12px 16px;border-top:1px solid #ececf6;display:flex;justify-content:space-between;align-items:center;gap:8px}
.gf-edit-status{font-size:12px;color:#5a6088}
.gf-edit-status.err{color:#b4233f}
.gf-edit-status.ok{color:#1e7d3f}
.gf-check{display:flex;align-items:center;gap:8px;font-size:13px;color:#2b2f62}
.gf-confirm-overlay{position:fixed;inset:0;background:rgba(6,10,20,.5);display:flex;align-items:center;justify-content:center;padding:20px;z-index:100002}
.gf-confirm-modal{width:min(520px,94vw);background:#fff;border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.25);padding:16px}
.gf-confirm-title{font-size:16px;font-weight:700;color:#202442}
.gf-confirm-text{margin-top:8px;font-size:13px;color:#40466f;line-height:1.4}
.gf-confirm-actions{margin-top:14px;display:flex;justify-content:flex-end;gap:8px}
.gf-date-input{font-variant-numeric:tabular-nums}
.gf-cal{position:fixed;z-index:100003;background:#fff;border:1px solid #d8dcf4;border-radius:10px;box-shadow:0 12px 28px rgba(0,0,0,.2);padding:10px;width:280px;display:inline-block;height:auto;min-height:0;max-height:none;overflow:hidden}
.gf-cal-head{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:8px}
.gf-cal-nav{border:1px solid #d6daf4;background:#fff;color:#2d3164;border-radius:6px;min-width:30px;height:28px;cursor:pointer}
.gf-cal-title{font-size:13px;font-weight:700;color:#2b2f62;text-transform:capitalize}
.gf-cal-table{width:100%;border-collapse:collapse}
.gf-cal-table th,.gf-cal-table td{text-align:center;width:14.28%;height:30px;font-size:12px}
.gf-cal-table th{color:#596089;font-weight:700}
.gf-cal-empty{color:transparent}
.gf-cal-day{border:none;background:#fff;color:#2d3164;border-radius:6px;cursor:pointer;width:28px;height:28px}
.gf-cal-day:hover{background:#eef1ff}
.gf-cal-day.is-today{outline:1px solid #b8bef8}
.gf-cal-day.is-selected{background:#5f63e9;color:#fff}
.gf-cal-actions{margin-top:8px;display:flex;justify-content:flex-end;gap:8px}
.gf-cal-today{border:1px solid #d6daf4;background:#fff;color:#2d3164;border-radius:6px;height:28px;padding:0 10px;cursor:pointer;font-size:12px;font-weight:600}
.gf-cal-today:hover{background:#eef1ff}
.gf-cal-error{margin-top:8px;font-size:12px;color:#b4233f}
@media (max-width:1100px){.gf-grid{grid-template-columns:repeat(2,minmax(160px,1fr))}}
@media (max-width:700px){.gf-grid{grid-template-columns:1fr}}
@media (max-width:760px){.gf-edit-body{grid-template-columns:1fr}}
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
  function isDateFilterKey(key) {
    return key === "dueFrom" || key === "dueTo";
  }
  function isDateEditField(field) {
    return field === "dueDateInput";
  }
  function isCalendarDateField(field) {
    return isDateFilterKey(field) || isDateEditField(field);
  }
  function closeCalendar() {
    STATE.calendar.open = false;
    STATE.calendar.targetField = "";
    STATE.calendar.error = "";
    STATE.calendar.suppressBlurCommit = false;
  }
  function calendarFieldIsoValue(field) {
    if (isDateFilterKey(field)) return text(STATE.ui.filters[field]);
    if (isDateEditField(field)) return text(STATE.edit.draft[field]);
    return "";
  }
  function setCalendarMonthFromIso(iso) {
    const match = text(iso).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (match) {
      STATE.calendar.year = Number(match[1]);
      STATE.calendar.month = Number(match[2]) - 1;
      return;
    }
    const now = new Date();
    STATE.calendar.year = now.getFullYear();
    STATE.calendar.month = now.getMonth();
  }
  function setCalendarAnchorFromElement(anchorEl) {
    if (!(anchorEl instanceof HTMLElement)) return;
    const rect = anchorEl.getBoundingClientRect();
    const popupWidth = 280;
    const popupHeight = 330;
    const margin = 12;
    let left = Math.round(rect.left);
    let top = Math.round(rect.bottom + 6);
    const maxLeft = Math.max(margin, window.innerWidth - popupWidth - margin);
    const maxTop = Math.max(margin, window.innerHeight - popupHeight - margin);
    if (left > maxLeft) left = maxLeft;
    if (left < margin) left = margin;
    if (top > maxTop) {
      const above = Math.round(rect.top - popupHeight - 6);
      top = above >= margin ? above : maxTop;
    }
    if (top < margin) top = margin;
    STATE.calendar.anchorLeft = left;
    STATE.calendar.anchorTop = top;
  }
  function calendarPopupStyle() {
    const top = Number(STATE.calendar.anchorTop);
    const left = Number(STATE.calendar.anchorLeft);
    const safeTop = Number.isFinite(top) ? Math.max(8, top) : 20;
    const safeLeft = Number.isFinite(left) ? Math.max(8, left) : 20;
    return `top:${safeTop}px;left:${safeLeft}px;`;
  }
  function openCalendarForField(field, anchorEl) {
    if (!isCalendarDateField(field)) return;
    setCalendarAnchorFromElement(anchorEl);
    const sameField = STATE.calendar.open && STATE.calendar.targetField === field;
    if (sameField) return;
    setCalendarMonthFromIso(calendarFieldIsoValue(field));
    STATE.calendar.targetField = field;
    STATE.calendar.open = true;
    STATE.calendar.error = "";
    STATE.calendar.suppressBlurCommit = false;
    scheduleRender();
  }
  function applyDateFieldIso(field, isoValue) {
    if (!isCalendarDateField(field)) return;
    const iso = text(isoValue);
    if (isDateFilterKey(field)) {
      setFilter(field, iso);
      return;
    }
    if (isDateEditField(field)) {
      updateEditDraft(field, iso);
    }
  }
  function commitDateFieldText(field, rawText) {
    if (!isCalendarDateField(field)) return;
    const txt = text(rawText);
    if (!txt) {
      STATE.calendar.error = "";
      applyDateFieldIso(field, "");
      return;
    }
    const parsed = parseDmyToIso(txt);
    if (!parsed) {
      STATE.calendar.error = "Niepoprawny format daty. Uzyj DD-MM-RRRR.";
      scheduleRender();
      return;
    }
    STATE.calendar.error = "";
    applyDateFieldIso(field, parsed);
  }
  function calendarGridData(year, month) {
    const firstDay = new Date(year, month, 1);
    let firstWeekday = firstDay.getDay();
    if (firstWeekday === 0) firstWeekday = 7;
    const leading = firstWeekday - 1;
    const totalDays = daysInMonth(year, month + 1);
    const cells = [];
    for (let i = 0; i < leading; i += 1) cells.push(0);
    for (let d = 1; d <= totalDays; d += 1) cells.push(d);
    while (cells.length % 7 !== 0) cells.push(0);
    return cells;
  }
  function onCalendarPrevMonth() {
    STATE.calendar.month -= 1;
    if (STATE.calendar.month < 0) {
      STATE.calendar.month = 11;
      STATE.calendar.year -= 1;
    }
    scheduleRender();
  }
  function onCalendarNextMonth() {
    STATE.calendar.month += 1;
    if (STATE.calendar.month > 11) {
      STATE.calendar.month = 0;
      STATE.calendar.year += 1;
    }
    scheduleRender();
  }
  function onCalendarToday() {
    const now = new Date();
    STATE.calendar.year = now.getFullYear();
    STATE.calendar.month = now.getMonth();
    STATE.calendar.error = "";
    STATE.calendar.suppressBlurCommit = false;
    scheduleRender();
  }
  function onCalendarClear() {
    const targetField = STATE.calendar.targetField;
    if (!isCalendarDateField(targetField)) return;
    STATE.calendar.error = "";
    STATE.calendar.suppressBlurCommit = false;
    closeCalendar();
    applyDateFieldIso(targetField, "");
  }
  function onCalendarSelectDay(day) {
    if (!STATE.calendar.open || !STATE.calendar.targetField) return;
    const iso = toIsoDateFromParts(day, STATE.calendar.month + 1, STATE.calendar.year);
    if (!iso) return;
    STATE.calendar.error = "";
    STATE.calendar.suppressBlurCommit = false;
    const targetField = STATE.calendar.targetField;
    closeCalendar();
    applyDateFieldIso(targetField, iso);
  }
  function areSameFilterValue(prev, next) {
    if (Array.isArray(prev) && Array.isArray(next)) {
      if (prev.length !== next.length) return false;
      for (let i = 0; i < prev.length; i += 1) {
        if (prev[i] !== next[i]) return false;
      }
      return true;
    }
    return prev === next;
  }
  function setFilter(key, value) {
    const prev = STATE.ui.filters[key];
    if (areSameFilterValue(prev, value)) return;
    STATE.ui.filters[key] = value;
    STATE.page = 1;
    applyQuery();
    saveUi();
    scheduleRender();
  }
  function setFilterMulti(key, select) {
    const arr = [...select.options].filter((o) => o.selected).map((o) => o.value);
    setFilter(key, arr);
  }
  function toggleSort(field) {
    if (STATE.ui.sort.field === field) STATE.ui.sort.direction = STATE.ui.sort.direction === "asc" ? "desc" : "asc";
    else { STATE.ui.sort.field = field; STATE.ui.sort.direction = "asc"; }
    applyQuery(); saveUi(); scheduleRender();
  }
  function resetFilters() {
    const d = defaults();
    STATE.ui.filters = d.filters;
    STATE.ui.sort = d.sort;
    closeCalendar();
    STATE.page = 1;
    applyQuery();
    saveUi();
    scheduleRender();
  }
  function findTaskById(taskId) {
    return STATE.all.find((task) => task.id === taskId) || null;
  }
  function contractStatusText() {
    if (STATIC_UPDATE_CONTRACT) return "Gotowy (statyczny)";
    if (STATE.contract.ready) return "Gotowy";
    if (STATE.contract.status === "capturing") return "Nasluchiwanie";
    if (STATE.contract.status === "failed") return "Blad";
    return "Niegotowy";
  }
  function openEditModal(taskId) {
    const task = findTaskById(taskId);
    if (!task) return;
    STATE.edit.open = true;
    STATE.edit.taskId = task.id;
    STATE.edit.saving = false;
    STATE.edit.deleting = false;
    STATE.edit.confirmDeleteOpen = false;
    STATE.edit.deleteError = "";
    STATE.edit.error = "";
    STATE.edit.success = "";
    STATE.edit.draft = {
      name: task.name || "",
      dueDateInput: toIsoDateValue(task.dueDate),
      notes: task.notes || "",
      markDone: Boolean(task.isDone),
    };
    closeCalendar();
    STATE.edit.dirty = false;
    render();
  }
  function closeEditModal() {
    STATE.edit.open = false;
    STATE.edit.taskId = "";
    STATE.edit.saving = false;
    STATE.edit.deleting = false;
    STATE.edit.confirmDeleteOpen = false;
    STATE.edit.deleteError = "";
    STATE.edit.error = "";
    STATE.edit.success = "";
    STATE.edit.dirty = false;
    STATE.edit.draft = {
      name: "",
      dueDateInput: "",
      notes: "",
      markDone: false,
    };
    closeCalendar();
    render();
  }
  function openDeleteConfirm() {
    if (!STATE.edit.open || STATE.edit.saving || STATE.edit.deleting) return;
    STATE.edit.deleteError = "";
    STATE.edit.confirmDeleteOpen = true;
    render();
  }
  function closeDeleteConfirm() {
    if (STATE.edit.deleting) return;
    if (!STATE.edit.confirmDeleteOpen) return;
    STATE.edit.confirmDeleteOpen = false;
    STATE.edit.deleteError = "";
    render();
  }
  function updateEditDraft(field, value) {
    if (!STATE.edit.open) return;
    if (STATE.edit.draft[field] === value) return;
    STATE.edit.draft[field] = value;
    STATE.edit.dirty = true;
    STATE.edit.error = "";
    STATE.edit.success = "";
    scheduleRender();
  }
  function applyLocalTaskPatch(taskId, patch) {
    if (!taskId || !patch) return;
    const task = findTaskById(taskId);
    if (!task) return;
    Object.keys(patch).forEach((k) => {
      task[k] = patch[k];
    });
  }
  function convertDueDateBySample(sampleValue, draftDate) {
    if (!draftDate) return sampleValue === null ? null : "";
    const dateMidnightIso = `${draftDate}T00:00:00.000Z`;
    if (typeof sampleValue === "number") {
      const ms = toMillis(dateMidnightIso);
      if (!Number.isFinite(ms)) return sampleValue;
      return sampleValue < 1e12 ? Math.floor(ms / 1000) : ms;
    }
    if (typeof sampleValue === "string") {
      if (/^\d+$/.test(sampleValue)) {
        const n = Number(sampleValue);
        const ms = toMillis(dateMidnightIso);
        if (!Number.isFinite(ms)) return sampleValue;
        return n < 1e12 ? String(Math.floor(ms / 1000)) : String(ms);
      }
      if (sampleValue.includes("T")) return dateMidnightIso;
      return draftDate;
    }
    return dateMidnightIso;
  }
  function convertDoneBySample(sampleValue, markDone) {
    if (typeof sampleValue === "boolean") return Boolean(markDone);
    if (typeof sampleValue === "number") return markDone ? 1 : 0;
    if (typeof sampleValue === "string") {
      const up = sampleValue.toUpperCase();
      if (["DONE", "COMPLETED", "COMPLETE", "CLOSED"].includes(up)) return markDone ? sampleValue : "OPEN";
      if (["OPEN", "PENDING", "TODAY", "OVERDUE", "TODO"].includes(up)) return markDone ? "DONE" : sampleValue;
      if (up === "TRUE" || up === "FALSE") return markDone ? "true" : "false";
      return markDone ? "DONE" : sampleValue;
    }
    return markDone;
  }
  function toUnixSecondsFromDateInput(dateInput, fallbackValue) {
    if (!dateInput) {
      const fallbackMs = toMillis(fallbackValue);
      return Number.isFinite(fallbackMs) ? Math.floor(fallbackMs / 1000) : null;
    }
    const parsed = new Date(`${dateInput}T23:59:59`);
    if (Number.isNaN(parsed.getTime())) {
      const fallbackMs = toMillis(fallbackValue);
      return Number.isFinite(fallbackMs) ? Math.floor(fallbackMs / 1000) : null;
    }
    return Math.floor(parsed.getTime() / 1000);
  }
  function buildUpdateUrl(taskId) {
    if (STATIC_UPDATE_CONTRACT && AUTH.locationId) {
      return `https://app.glofox.com/task-management-api/v1/locations/${AUTH.locationId}/tasks/${taskId}`;
    }
    const sampleUrl = String(STATE.contract.url || "");
    const sampleId = String(STATE.contract.sampleTaskId || "");
    if (!sampleUrl) return "";
    if (sampleId && taskId) return sampleUrl.replace(sampleId, taskId);
    return sampleUrl;
  }
  function buildStaticUpdatePayload(task, draft, authUserId) {
    const dueSeconds = toUnixSecondsFromDateInput(draft.dueDateInput, task.dueDate);
    const customerId = deriveCustomerIdFromTask(task);
    const staffId = deriveStaffIdFromTask(task, authUserId);
    const payload = {
      name: text(draft.name),
      type: text(task.type) || "To-Do",
      notes: text(draft.notes),
      due_date: dueSeconds,
      customer_id: customerId,
      customer_first_name: text(task.customerFirstName || (task.raw && task.raw.customer && task.raw.customer.first_name)),
      customer_last_name: text(task.customerLastName || (task.raw && task.raw.customer && task.raw.customer.last_name)),
      staff_id: staffId,
    };

    if (draft.markDone && !task.isDone) {
      payload.completion_date = Math.floor(Date.now() / 1000);
      payload.completed_by = text(authUserId);
    }
    return payload;
  }
  function buildStaticUpdatePayloadMinimal(task, draft, authUserId) {
    const dueSeconds = toUnixSecondsFromDateInput(draft.dueDateInput, task.dueDate);
    const staffId = deriveStaffIdFromTask(task, authUserId);
    const payload = {
      name: text(draft.name),
      type: text(task.type) || "To-Do",
      notes: text(draft.notes),
      due_date: dueSeconds,
      staff_id: staffId,
    };
    if (draft.markDone && !task.isDone) {
      payload.completion_date = Math.floor(Date.now() / 1000);
      payload.completed_by = text(authUserId);
    }
    return payload;
  }
  function buildUpdatePayload(taskId, draft) {
    if (STATIC_UPDATE_CONTRACT) {
      const task = findTaskById(taskId);
      if (!task) return null;
      return buildStaticUpdatePayload(task, draft, AUTH.userId);
    }
    const template = deepClone(STATE.contract.bodyTemplate);
    if (!template || typeof template !== "object") return null;

    let payload = replaceIdRecursive(template, STATE.contract.sampleTaskId, taskId);
    const idsInBody = findIdCandidatesInBody(payload);
    idsInBody.forEach((entry) => {
      if (entry.value === STATE.contract.sampleTaskId) {
        setByPath(payload, entry.path, taskId);
      }
    });

    const paths = STATE.contract.fieldPaths || {};
    if (paths.name) {
      const current = getByPath(payload, paths.name);
      if (current !== undefined) setByPath(payload, paths.name, draft.name);
    }
    if (paths.notes) {
      const current = getByPath(payload, paths.notes);
      if (current !== undefined) setByPath(payload, paths.notes, draft.notes);
    }
    if (paths.dueDate) {
      const current = getByPath(payload, paths.dueDate);
      if (current !== undefined) {
        setByPath(payload, paths.dueDate, convertDueDateBySample(current, draft.dueDateInput));
      }
    }
    if (paths.done) {
      const current = getByPath(payload, paths.done);
      if (current !== undefined) {
        setByPath(payload, paths.done, convertDoneBySample(current, draft.markDone));
      }
    }
    return payload;
  }
  function validateEditDraft(draft) {
    if (!draft) return "Brak danych formularza.";
    if (!text(draft.name)) return "Nazwa zadania nie moze byc pusta.";
    if (draft.dueDateInput && Number.isNaN(new Date(draft.dueDateInput).getTime())) {
      return "Niepoprawna data terminu.";
    }
    return "";
  }
  async function executeUpdateRequest(url, method, token, payload) {
    const res = await fetch(url, {
      method: method || "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      credentials: "include",
      body: JSON.stringify(payload),
    });

    if (res.ok) {
      let json = null;
      try {
        json = await res.json();
      } catch (_e) {
        // noop
      }
      return { ok: true, status: res.status, data: json, code: "", message: "" };
    }

    let parsed = null;
    let textBody = "";
    try {
      parsed = await res.json();
    } catch (_e) {
      try {
        textBody = await res.text();
      } catch (_e2) {
        // noop
      }
    }
    const code = text(parsed && parsed.code);
    const message = text(parsed && parsed.message) || textBody;
    return { ok: false, status: res.status, data: parsed, code: code, message: message, sentPayload: payload };
  }
  async function executeCompletionRequest(task) {
    if (!task || !text(task.id)) {
      return { ok: false, status: 0, data: null, code: "", message: "Brak ID taska." };
    }
    const { token, locationId, userId } = getAuth();
    if (!token) return { ok: false, status: 0, data: null, code: "", message: "Brak tokena sesji." };
    if (!locationId) return { ok: false, status: 0, data: null, code: "", message: "Brak location_id." };
    const completionDate = Math.floor(Date.now() / 1000);
    const url = `https://app.glofox.com/task-management-api/v1/locations/${locationId}/tasks/${task.id}/completion`;
    const payload = {
      _id: task.id,
      location_id: locationId,
      completion_date: completionDate,
      completed_by: text(userId),
    };
    return executeUpdateRequest(url, "PATCH", token, payload);
  }
  async function confirmDeleteTask() {
    if (!STATE.edit.open || !STATE.edit.confirmDeleteOpen) return;
    if (STATE.edit.saving || STATE.edit.deleting) return;
    const task = findTaskById(STATE.edit.taskId);
    if (!task) {
      STATE.edit.deleteError = "Nie znaleziono taska do usuniecia.";
      render();
      return;
    }

    STATE.edit.deleting = true;
    STATE.edit.error = "";
    STATE.edit.success = "";
    STATE.edit.deleteError = "";
    render();
    try {
      STATE.contract.ownRequestInFlight = true;
      const result = await executeCompletionRequest(task);
      if (!result.ok) {
        if (result.status === 401 || result.status === 403) {
          throw new Error("Brak autoryzacji (401/403). Odswiez sesje i sprobuj ponownie.");
        }
        const details = text(result.message);
        throw new Error(`Usuniecie nie powiodlo sie (HTTP ${result.status || "-"}). ${details || result.code || ""}`.trim());
      }

      STATE.all = STATE.all.filter((x) => x.id !== task.id);
      markAllDataChanged();
      applyQuery();
      STATE.notice = "Zadanie usuniete.";
      closeEditModal();
    } catch (e) {
      STATE.edit.deleting = false;
      STATE.edit.deleteError = e && e.message ? e.message : "Blad usuwania.";
      render();
    } finally {
      STATE.contract.ownRequestInFlight = false;
    }
  }
  function hasAnyEditablePath() {
    const p = STATE.contract.fieldPaths || {};
    return Boolean(p.name || p.dueDate || p.notes || p.done);
  }
  async function saveTaskEdit() {
    if (!STATE.edit.open) return;
    if (STATE.edit.saving) return;
    const task = findTaskById(STATE.edit.taskId);
    if (!task) {
      STATE.edit.error = "Nie znaleziono taska do zapisu.";
      render();
      return;
    }
    const validationError = validateEditDraft(STATE.edit.draft);
    if (validationError) {
      STATE.edit.error = validationError;
      render();
      return;
    }
    if (!STATIC_UPDATE_CONTRACT && !STATE.contract.ready) {
      STATE.edit.error = "Brak kontraktu zapisu. Wykonaj jedna edycje w natywnym panelu Glofox i zapisz.";
      render();
      return;
    }
    if (!STATIC_UPDATE_CONTRACT && !hasAnyEditablePath()) {
      STATE.edit.error = "Wykryty kontrakt nie zawiera mapowania pol edycji. Zapisz inny task w natywnym edytorze i sprobuj ponownie.";
      render();
      return;
    }

    const { token } = getAuth();
    if (!token) {
      STATE.edit.error = "Brak tokena sesji.";
      render();
      return;
    }
    const url = buildUpdateUrl(task.id);
    const payload = buildUpdatePayload(task.id, STATE.edit.draft);
    if (!url || !payload) {
      STATE.edit.error = "Nie udalo sie zbudowac requestu zapisu.";
      render();
      return;
    }

    STATE.edit.saving = true;
    STATE.edit.error = "";
    STATE.edit.success = "";
    render();
    try {
      STATE.contract.ownRequestInFlight = true;
      let result = await executeUpdateRequest(url, STATE.contract.method || "PATCH", token, payload);
      if (!result.ok && result.code === "TASKS_CORE_API_MEMBER_DELETED" && STATIC_UPDATE_CONTRACT) {
        const minimalPayload = buildStaticUpdatePayloadMinimal(task, STATE.edit.draft, AUTH.userId);
        result = await executeUpdateRequest(url, STATE.contract.method || "PATCH", token, minimalPayload);
      }
      if (!result.ok) {
        if (result.code === "TASKS_CORE_API_MEMBER_DELETED") {
          STATE.edit.blockedByApiTaskIds[task.id] = true;
          const sentCustomerId = text(result.sentPayload && result.sentPayload.customer_id);
          throw new Error(`API odrzucilo zapis kodem TASKS_CORE_API_MEMBER_DELETED. Wyslany customer_id=${sentCustomerId || "-"}.`);
        }
        if (result.code === "TASKS_CORE_API_STAFF_DELETED") {
          const sentStaffId = text(result.sentPayload && result.sentPayload.staff_id);
          throw new Error(`API odrzucilo zapis kodem TASKS_CORE_API_STAFF_DELETED. Wyslany staff_id=${sentStaffId || "-"}, auth_user_id=${AUTH.userId || "-"}.`);
        }
        const details = text(result.message);
        throw new Error(`Zapis nie powiodl sie (HTTP ${result.status}). ${details || result.code || ""}`.trim());
      }

      const updatedDueSeconds = toUnixSecondsFromDateInput(STATE.edit.draft.dueDateInput, task.dueDate);
      applyLocalTaskPatch(task.id, {
        name: text(STATE.edit.draft.name),
        dueDate: Number.isFinite(updatedDueSeconds) ? updatedDueSeconds : task.dueDate,
        notes: text(STATE.edit.draft.notes),
        isDone: Boolean(STATE.edit.draft.markDone),
        completionDate: STATE.edit.draft.markDone ? Math.floor(Date.now() / 1000) : null,
        statusUi: STATE.edit.draft.markDone ? "DONE" : "PENDING",
      });
      applyQuery();
      STATE.edit.saving = false;
      STATE.edit.success = "Zapisano.";
      STATE.edit.dirty = false;
      render();
      setTimeout(() => {
        if (STATE.edit.open && STATE.edit.taskId === task.id && !STATE.edit.dirty) {
          closeEditModal();
        }
      }, 250);
    } catch (e) {
      STATE.edit.saving = false;
      STATE.edit.error = e && e.message ? e.message : "Blad zapisu.";
      render();
    } finally {
      STATE.contract.ownRequestInFlight = false;
    }
  }
  function closeModal() {
    STATE.open = false;
    STATE.notice = "";
    closeCalendar();
    STATE.edit.open = false;
    STATE.edit.taskId = "";
    STATE.edit.saving = false;
    STATE.edit.deleting = false;
    STATE.edit.confirmDeleteOpen = false;
    STATE.edit.deleteError = "";
    STATE.edit.error = "";
    STATE.edit.success = "";
    STATE.edit.dirty = false;
    const shadow = ensureShadowRoot();
    shadow.innerHTML = "";
    document.body.style.overflow = "";
    document.body.classList.remove("gf-task-filter-debug");
  }
  async function openModal() {
    STATE.open = true;
    STATE.error = "";
    STATE.notice = "";
    closeCalendar();
    STATE.safeMode = false;
    STATE.debug.lastReason = "";
    document.body.style.overflow = "hidden";
    if (DEBUG) document.body.classList.add("gf-task-filter-debug");
    ensureShadowRoot();
    getAuth();
    loadContract();
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
    if (status === "DONE") return "gf-tag gf-pending";
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
  function calendarSelectedParts() {
    const iso = calendarFieldIsoValue(STATE.calendar.targetField);
    const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return null;
    return {
      year: Number(m[1]),
      month: Number(m[2]),
      day: Number(m[3]),
    };
  }
  function miniCalendarHtml() {
    if (!STATE.calendar.open) return "";
    const cells = calendarGridData(STATE.calendar.year, STATE.calendar.month);
    const today = new Date();
    const selected = calendarSelectedParts();
    const rows = [];
    for (let r = 0; r < cells.length; r += 7) {
      const chunk = cells.slice(r, r + 7);
      const tds = chunk.map((day) => {
        if (!day) return '<td class="gf-cal-empty">.</td>';
        const isToday =
          today.getFullYear() === STATE.calendar.year &&
          today.getMonth() === STATE.calendar.month &&
          today.getDate() === day;
        const isSelected =
          selected &&
          selected.year === STATE.calendar.year &&
          selected.month === STATE.calendar.month + 1 &&
          selected.day === day;
        const classes = [
          "gf-cal-day",
          isToday ? "is-today" : "",
          isSelected ? "is-selected" : "",
        ].join(" ").trim();
        return `<td><button class="${classes}" data-a="cal-day" data-day="${day}" type="button">${day}</button></td>`;
      }).join("");
      rows.push(`<tr>${tds}</tr>`);
    }
    const title = `${CALENDAR_MONTH_NAMES_PL[STATE.calendar.month]} ${STATE.calendar.year}`;
    const errorHtml = STATE.calendar.error ? `<div class="gf-cal-error">${escapeHtml(STATE.calendar.error)}</div>` : "";
    return `
<div class="gf-cal" data-a="cal-root" style="${calendarPopupStyle()}">
  <div class="gf-cal-head">
    <button class="gf-cal-nav" data-a="cal-prev" type="button">&lt;</button>
    <div class="gf-cal-title">${escapeHtml(title)}</div>
    <button class="gf-cal-nav" data-a="cal-next" type="button">&gt;</button>
  </div>
  <table class="gf-cal-table">
    <thead><tr>${CALENDAR_DAY_NAMES_PL.map((n) => `<th>${n}</th>`).join("")}</tr></thead>
    <tbody>${rows.join("")}</tbody>
  </table>
  <div class="gf-cal-actions">
    <button class="gf-cal-today" data-a="cal-clear" type="button">Wyczysc</button>
    <button class="gf-cal-today" data-a="cal-today" type="button">Dzisiaj</button>
  </div>
  ${errorHtml}
</div>`;
  }
  function html(forceSafe) {
    if (!STATE.open) return "";
    const safe = Boolean(forceSafe || STATE.safeMode);
    const total = STATE.filtered.length;
    const from = total ? (STATE.page - 1) * STATE.ui.pageSize + 1 : 0;
    const to = Math.min(STATE.page * STATE.ui.pageSize, total);
    const rows = pageItems().map((t) => `
<tr class="gf-row-clickable" data-a="open-edit" data-task-id="${escapeHtml(t.id)}">
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
    const statusOptions = ["PENDING", "TODAY", "OVERDUE", "DONE"].map((v) => `<option value="${v}" ${STATE.ui.filters.statuses.includes(v) ? "selected" : ""}>${v}</option>`).join("");
    const contractHelp = STATIC_UPDATE_CONTRACT
      ? "Kontrakt zapisu: Gotowy (PATCH /tasks/{taskId})"
      : STATE.contract.ready
        ? `Kontrakt zapisu: ${escapeHtml(contractStatusText())} (${escapeHtml(STATE.contract.method)}).`
        : "Kontrakt zapisu: Niegotowy. Zapisz raz task w natywnym edytorze Glofox, a skrypt automatycznie wykryje endpoint.";
    const tableContent = `
${STATE.loading ? '<div class="gf-msg">Ladowanie danych...</div>' : ""}
${STATE.error ? `<div class="gf-msg gf-err">${escapeHtml(STATE.error)}</div>` : ""}
${STATE.notice ? `<div class="gf-msg gf-ok">${escapeHtml(STATE.notice)}</div>` : ""}
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
<div class="gf-sub" style="padding:8px 16px;border-bottom:1px solid #ececf6;background:#fff;">${escapeHtml(contractHelp)}</div>
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
    <div class="gf-field"><label>Termin od</label><input class="gf-date-input" type="text" inputmode="numeric" maxlength="10" placeholder="DD-MM-RRRR" data-date-input="dueFrom" data-f="dueFrom" value="${escapeHtml(formatIsoToDmy(STATE.ui.filters.dueFrom))}"></div>
    <div class="gf-field"><label>Termin do</label><input class="gf-date-input" type="text" inputmode="numeric" maxlength="10" placeholder="DD-MM-RRRR" data-date-input="dueTo" data-f="dueTo" value="${escapeHtml(formatIsoToDmy(STATE.ui.filters.dueTo))}"></div>
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
${miniCalendarHtml()}
${editModalHtml()}
</div>`;
  }
  function editModalHtml() {
    if (!STATE.edit.open) return "";
    const task = findTaskById(STATE.edit.taskId);
    if (!task) return "";
    const canSave = STATE.contract.ready && !STATE.edit.saving && !STATE.edit.deleting;
    const saveDisabled = !canSave || !STATE.edit.dirty;
    const deleteDisabled = STATE.edit.saving || STATE.edit.deleting || !text(task.id);
    const statusClass = STATE.edit.error ? "gf-edit-status err" : STATE.edit.success ? "gf-edit-status ok" : "gf-edit-status";
    const statusText = STATE.edit.error || STATE.edit.success || (STATE.contract.ready ? "Mozesz zapisac zmiany." : "Brak kontraktu zapisu. Uzyj natywnego edytora raz.");
    const confirmHtml = STATE.edit.confirmDeleteOpen ? deleteConfirmModalHtml() : "";
    return `
<div class="gf-edit-overlay" data-a="edit-overlay">
  <div class="gf-edit-modal">
    <div class="gf-edit-head">
      <div>
        <div class="gf-edit-title">Edycja zadania</div>
        <div class="gf-edit-sub">ID: ${escapeHtml(task.id)} | Kontrakt: ${escapeHtml(contractStatusText())}</div>
      </div>
      <div class="gf-actions">
        <button class="gf-btn gf-danger" data-a="edit-delete" ${deleteDisabled ? "disabled" : ""}>Usun</button>
        <button class="gf-btn" data-a="edit-cancel">Anuluj</button>
        <button class="gf-btn gf-primary" data-a="edit-save" ${saveDisabled ? "disabled" : ""}>${STATE.edit.saving ? "Zapisywanie..." : "Zapisz"}</button>
      </div>
    </div>
    <div class="gf-edit-body">
      <div class="gf-edit-field gf-edit-full">
        <label>Nazwa zadania</label>
        <input data-edit-field="name" value="${escapeHtml(STATE.edit.draft.name)}">
      </div>
      <div class="gf-edit-field">
        <label>Termin wykonalosci</label>
        <input class="gf-date-input" type="text" inputmode="numeric" maxlength="10" placeholder="DD-MM-RRRR" data-date-input="dueDateInput" data-edit-field="dueDateInput" value="${escapeHtml(formatIsoToDmy(STATE.edit.draft.dueDateInput))}">
      </div>
      <div class="gf-edit-field">
        <label>Typ zadania</label>
        <div class="gf-edit-ro">${escapeHtml(task.type || "-")}</div>
      </div>
      <div class="gf-edit-field">
        <label>Klient</label>
        <div class="gf-edit-ro">${escapeHtml(task.customerName || "-")}</div>
      </div>
      <div class="gf-edit-field">
        <label>Przypisano do</label>
        <div class="gf-edit-ro">${escapeHtml(task.staffName || "-")}</div>
      </div>
      <div class="gf-edit-field gf-edit-full">
        <label>Uwagi</label>
        <textarea data-edit-field="notes">${escapeHtml(STATE.edit.draft.notes || "")}</textarea>
      </div>
      <div class="gf-edit-full">
        <label class="gf-check">
          <input type="checkbox" data-edit-field="markDone" ${STATE.edit.draft.markDone ? "checked" : ""}>
          Ustaw jako wykonane
        </label>
      </div>
    </div>
    <div class="gf-edit-foot">
      <div class="${statusClass}">${escapeHtml(statusText)}</div>
      <div class="gf-edit-status">${STATE.edit.dirty ? "Zmiany oczekuja na zapis." : "Brak zmian."}</div>
    </div>
  </div>
</div>
${confirmHtml}`;
  }
  function deleteConfirmModalHtml() {
    const busy = STATE.edit.deleting;
    const err = text(STATE.edit.deleteError);
    return `
<div class="gf-confirm-overlay" data-a="delete-overlay">
  <div class="gf-confirm-modal">
    <div class="gf-confirm-title">Potwierdzenie usuniecia</div>
    <div class="gf-confirm-text">Czy na pewno chcesz usunac to zadanie?!</div>
    ${err ? `<div class="gf-edit-status err" style="margin-top:10px;">${escapeHtml(err)}</div>` : ""}
    <div class="gf-confirm-actions">
      <button class="gf-btn" data-a="delete-cancel" ${busy ? "disabled" : ""}>Anuluj</button>
      <button class="gf-btn gf-danger" data-a="delete-confirm" ${busy ? "disabled" : ""}>${busy ? "Usuwanie..." : "Tak, usun"}</button>
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

  function getActionTarget(root, event) {
    const target = event.target instanceof HTMLElement ? event.target : null;
    if (!target) return null;
    const actionEl = target.closest("[data-a]");
    if (!actionEl) return null;
    return root.contains(actionEl) ? actionEl : null;
  }

  function bind(root) {
    const overlay = root.querySelector('[data-role="overlay"]');
    if (overlay) overlay.addEventListener("click", (e) => { if (e.target === overlay) closeModal(); });
    const modal = root.querySelector(".gf-modal");
    if (modal) {
      modal.addEventListener("click", (e) => {
        if (!STATE.calendar.open) return;
        const target = e.target instanceof HTMLElement ? e.target : null;
        if (!target) return;
        if (target.closest("[data-a='cal-root']")) return;
        if (target.closest("[data-date-input]")) return;
        closeCalendar();
        scheduleRender();
      });
    }
    root.addEventListener("mousedown", (e) => {
      const actionEl = getActionTarget(root, e);
      if (!actionEl) return;
      const action = actionEl.getAttribute("data-a");
      if (action === "cal-prev" || action === "cal-next" || action === "cal-today" || action === "cal-clear" || action === "cal-day") {
        STATE.calendar.suppressBlurCommit = true;
      }
    });
    root.addEventListener("click", (e) => {
      const actionEl = getActionTarget(root, e);
      if (!actionEl) return;
      const action = actionEl.getAttribute("data-a");
      if (!action) return;

      if (action === "edit-overlay") {
        if (e.target === actionEl && !STATE.edit.saving && !STATE.edit.deleting) closeEditModal();
        return;
      }
      if (action === "delete-overlay") {
        if (e.target === actionEl && !STATE.edit.deleting) closeDeleteConfirm();
        return;
      }

      if (action === "close") {
        closeModal();
        return;
      }
      if (action === "refresh") {
        fetchTasks(true);
        return;
      }
      if (action === "reset") {
        resetFilters();
        return;
      }
      if (action === "sort") {
        toggleSort(actionEl.getAttribute("data-sort"));
        return;
      }
      if (action === "open-edit") {
        const id = actionEl.getAttribute("data-task-id");
        if (id) openEditModal(id);
        return;
      }
      if (action === "edit-cancel") {
        if (STATE.edit.saving || STATE.edit.deleting) return;
        closeEditModal();
        return;
      }
      if (action === "edit-delete") {
        openDeleteConfirm();
        return;
      }
      if (action === "edit-save") {
        saveTaskEdit();
        return;
      }
      if (action === "delete-cancel") {
        closeDeleteConfirm();
        return;
      }
      if (action === "delete-confirm") {
        confirmDeleteTask();
        return;
      }
      if (action === "cal-prev") {
        onCalendarPrevMonth();
        STATE.calendar.suppressBlurCommit = false;
        return;
      }
      if (action === "cal-next") {
        onCalendarNextMonth();
        STATE.calendar.suppressBlurCommit = false;
        return;
      }
      if (action === "cal-today") {
        onCalendarToday();
        STATE.calendar.suppressBlurCommit = false;
        return;
      }
      if (action === "cal-clear") {
        onCalendarClear();
        STATE.calendar.suppressBlurCommit = false;
        return;
      }
      if (action === "cal-day") {
        const day = Number(actionEl.getAttribute("data-day"));
        if (Number.isFinite(day) && day > 0) onCalendarSelectDay(day);
        STATE.calendar.suppressBlurCommit = false;
        return;
      }
      if (action === "first") {
        if (STATE.page === 1) return;
        STATE.page = 1;
        scheduleRender();
        return;
      }
      if (action === "prev") {
        const nextPage = Math.max(1, STATE.page - 1);
        if (nextPage === STATE.page) return;
        STATE.page = nextPage;
        scheduleRender();
        return;
      }
      if (action === "next") {
        const nextPage = Math.min(STATE.pages, STATE.page + 1);
        if (nextPage === STATE.page) return;
        STATE.page = nextPage;
        scheduleRender();
        return;
      }
      if (action === "last") {
        if (STATE.page === STATE.pages) return;
        STATE.page = STATE.pages;
        scheduleRender();
        return;
      }
      if (action === "page") {
        const targetPage = Number(actionEl.getAttribute("data-page")) || 1;
        if (targetPage === STATE.page) return;
        STATE.page = targetPage;
        scheduleRender();
      }
    });

    const dateInputs = root.querySelectorAll("[data-date-input]");
    dateInputs.forEach((el) => {
      const field = el.getAttribute("data-date-input");
      if (!field || !isCalendarDateField(field)) return;
      el.addEventListener("focus", (e) => openCalendarForField(field, e.currentTarget));
      el.addEventListener("click", () => {
        openCalendarForField(field, el);
      });
      el.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          commitDateFieldText(field, e.target.value);
          return;
        }
        if (e.key === "Escape") {
          closeCalendar();
          scheduleRender();
        }
      });
      el.addEventListener("blur", (e) => {
        if (STATE.calendar.suppressBlurCommit) {
          STATE.calendar.suppressBlurCommit = false;
          return;
        }
        commitDateFieldText(field, e.target.value);
      });
    });
    const editFields = root.querySelectorAll("[data-edit-field]");
    editFields.forEach((el) => {
      const field = el.getAttribute("data-edit-field");
      if (!field) return;
      if (field === "markDone") {
        el.addEventListener("change", (e) => updateEditDraft(field, Boolean(e.target.checked)));
      } else if (isDateEditField(field)) {
        // Date text inputs are handled by [data-date-input] flow.
      } else {
        el.addEventListener("input", (e) => updateEditDraft(field, e.target.value));
      }
    });

    const filterFields = root.querySelectorAll("[data-f]");
    filterFields.forEach((el) => {
      const key = el.getAttribute("data-f");
      if (!key) return;
      if (isDateFilterKey(key)) return;
      el.addEventListener("input", (e) => setFilter(key, e.target.value));
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
      scheduleRender();
    });
  }
  function captureFocusState(root) {
    if (!root) return null;
    const active = root.activeElement;
    if (!active || !(active instanceof HTMLElement)) return null;
    if (!active.matches("[data-f], [data-fm], [data-a='size'], [data-edit-field]")) return null;

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
    } else if (active.hasAttribute("data-edit-field")) {
      state.key = `ef:${active.getAttribute("data-edit-field")}`;
    } else if (active.getAttribute("data-a") === "size") {
      state.key = "a:size";
    } else {
      return null;
    }

    if ("value" in active) state.value = active.value;
    if (
      (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) &&
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
    } else if (state.key.startsWith("ef:")) {
      const key = state.key.slice(3);
      target = root.querySelector(`[data-edit-field="${CSS.escape(key)}"]`);
    } else if (state.key === "a:size") {
      target = root.querySelector('[data-a="size"]');
    }
    if (!target || !(target instanceof HTMLElement)) return;
    target.focus();
    if (
      (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) &&
      typeof state.start === "number" &&
      typeof state.end === "number"
    ) {
      target.setSelectionRange(state.start, state.end);
    }
  }

  function render() {
    STATE.renderQueued = false;
    const root = ensureShadowRoot();
    if (!STATE.open) { root.innerHTML = ""; return; }
    const focusState = captureFocusState(root);
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
    loadContract();
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      if (STATE.edit.open) {
        if (STATE.edit.confirmDeleteOpen) {
          if (!STATE.edit.deleting) closeDeleteConfirm();
          return;
        }
        if (!STATE.edit.saving && !STATE.edit.deleting) closeEditModal();
        return;
      }
      if (STATE.open) closeModal();
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

