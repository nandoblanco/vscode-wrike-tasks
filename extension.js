"use strict";

const vscode = require("vscode");
const crypto = require("crypto");

const SECRET_KEY = "wrikeTasks.token";
const SECRET_OAUTH_KEY = "wrikeTasks.oauth";
const OAUTH_REDIRECT_URI = "https://localhost";

const WRIKE_COLORS = {
  Blue: "#2196f3",
  DarkBlue: "#1565c0",
  Turquoise: "#00bcd4",
  DarkCyan: "#00838f",
  Green: "#4caf50",
  YellowGreen: "#8bc34a",
  Yellow: "#fbc02d",
  Orange: "#ff9800",
  Red: "#e53935",
  DarkRed: "#b71c1c",
  Purple: "#9c27b0",
  Indigo: "#3f51b5",
  Brown: "#795548",
  Gray: "#757575"
};

let secretStorage = null;
let cachedMe = null;
let contactsById = new Map();
let activeContactsList = [];
let statusesById = new Map();
let foldersById = new Map();
let cachedTasks = [];
let hasLoadedOnce = false;
let lastLoadError = null;
let detailPanel = null;
let activeDetailTaskId = null;
let activeDetailTitle = "";
let activeDetailMarkdown = "";
let activeFilterQuery = "";
let currentTaskSort = "dueDate";
let currentClientSort = "alpha";
let starredTaskIds = new Set();
let starredClientIds = new Set();
let inflightLoadPromise = null;
let inflightRefreshPromise = null;
let taskSearchIndexCache = new Map();
let treeProviderInstance = null;
let recentProviderInstance = null;

function clearMemoryCaches() {
  cachedMe = null;
  statusesById.clear();
  contactsById.clear();
  activeContactsList = [];
  foldersById.clear();
  taskSearchIndexCache.clear();
}

function isValidWrikeHost(host) {
  return /^(?:www|login|app-[a-z0-9-]+)\.wrike\.com$/i.test(String(host || "").trim());
}

function isSafeHttpsUrl(url) {
  return typeof url === "string" && /^https:\/\//i.test(url.trim());
}

function isTaskStarred(taskId) {
  return Boolean(taskId && starredTaskIds.has(taskId));
}

function isClientStarred(clientId) {
  return Boolean(clientId && starredClientIds.has(clientId));
}

function isTaskActiveNotCompleted(task) {
  if (!task) {
    return false;
  }
  if (task.status && task.status !== "Active") {
    return false;
  }
  const st = resolveStatusInfo(task);
  return st.group !== "Completed" && st.group !== "Cancelled";
}

function getRecentAndStarredTasks(tasks, maxCount) {
  const limit = typeof maxCount === "number" && maxCount > 0 ? maxCount : 20;
  const activeList = (tasks || []).filter(isTaskActiveNotCompleted);
  const starred = [];
  const unstarred = [];

  for (const task of activeList) {
    if (isTaskStarred(task.id)) {
      starred.push(task);
    } else {
      unstarred.push(task);
    }
  }

  const sortByUpdatedDesc = function (a, b) {
    return (b.updatedDate || "").localeCompare(a.updatedDate || "");
  };
  starred.sort(sortByUpdatedDesc);
  unstarred.sort(sortByUpdatedDesc);

  const remainingSlots = Math.max(0, limit - starred.length);
  return starred.concat(unstarred.slice(0, remainingSlots));
}

const TASK_SORT_LABELS = {
  dueDate: "Due Date (Soonest first)",
  updatedDate: "Recently Updated",
  importance: "Importance (High first)",
  title: "Task Title (A-Z)",
  createdDate: "Created Date (Newest first)"
};

const CLIENT_SORT_LABELS = {
  alpha: "Client Name (A-Z)",
  soonestDue: "Client with Soonest Due Task",
  mostTasks: "Client with Most Tasks"
};

function getApiBase(oauthData) {
  if (oauthData && isValidWrikeHost(oauthData.host)) {
    return "https://" + oauthData.host.trim() + "/api/v4";
  }
  const cfg = vscode.workspace.getConfiguration("wrikeTasks");
  const raw = String(cfg.get("apiBaseUrl", "https://www.wrike.com/api/v4") || "").trim().replace(/\/+$/, "");
  try {
    const parsed = new URL(raw);
    if (parsed.protocol === "https:" && isValidWrikeHost(parsed.hostname)) {
      return "https://" + parsed.hostname + (parsed.pathname && parsed.pathname !== "/" ? parsed.pathname.replace(/\/+$/, "") : "/api/v4");
    }
  } catch (_err) {
    // Fall back to default Wrike API endpoint
  }
  return "https://www.wrike.com/api/v4";
}

async function getOAuthState() {
  const raw = await secretStorage.get(SECRET_OAUTH_KEY);
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.error("Invalid OAuth JSON in secretStorage:", err);
    return null;
  }
}

async function refreshOAuthToken(oauth) {
  if (inflightRefreshPromise) {
    return inflightRefreshPromise;
  }
  inflightRefreshPromise = (async function () {
    try {
      if (!oauth || !oauth.refreshToken || !oauth.clientId || !oauth.clientSecret) {
        throw new Error("Missing OAuth refresh credentials. Please sign in again.");
      }
      const tokenHost = isValidWrikeHost(oauth.host) ? oauth.host.trim() : "login.wrike.com";
      const tokenUrl = "https://" + tokenHost + "/oauth2/token";
      console.log("refreshOAuthToken:", tokenUrl);

      const params = new URLSearchParams({
        client_id: oauth.clientId,
        client_secret: oauth.clientSecret,
        grant_type: "refresh_token",
        refresh_token: oauth.refreshToken
      });

      const res = await fetch(tokenUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json"
        },
        body: params.toString()
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error("OAuth token refresh failed (" + res.status + "): " + body.slice(0, 200));
      }

      const data = await res.json();
      const nextHost = isValidWrikeHost(data.host)
        ? data.host.trim()
        : isValidWrikeHost(oauth.host)
        ? oauth.host.trim()
        : "www.wrike.com";
      const updated = {
        clientId: oauth.clientId,
        clientSecret: oauth.clientSecret,
        accessToken: data.access_token,
        refreshToken: data.refresh_token || oauth.refreshToken,
        host: nextHost,
        expiresAt: Date.now() + Number(data.expires_in || 3600) * 1000 - 60000
      };
      await secretStorage.store(SECRET_OAUTH_KEY, JSON.stringify(updated));
      await secretStorage.store(SECRET_KEY, updated.accessToken);
      return updated;
    } finally {
      inflightRefreshPromise = null;
    }
  })();
  return inflightRefreshPromise;
}

async function getValidAuth() {
  const oauth = await getOAuthState();
  if (oauth && oauth.accessToken) {
    if (oauth.expiresAt && Date.now() >= oauth.expiresAt && oauth.refreshToken) {
      const refreshed = await refreshOAuthToken(oauth);
      return { token: refreshed.accessToken, oauth: refreshed };
    }
    return { token: oauth.accessToken, oauth: oauth };
  }
  const token = await secretStorage.get(SECRET_KEY);
  if (token) {
    return { token: token, oauth: null };
  }
  return null;
}

async function wrikeRequest(method, endpoint, paramsObj, tokenOrAuth) {
  let auth =
    tokenOrAuth && typeof tokenOrAuth === "object"
      ? tokenOrAuth
      : { token: tokenOrAuth, oauth: await getOAuthState() };

  let bodyStr;
  const baseHeaders = {
    Accept: "application/json"
  };

  if (method !== "GET" && paramsObj) {
    const bodyParams = new URLSearchParams();
    for (const key of Object.keys(paramsObj)) {
      if (paramsObj[key] !== undefined && paramsObj[key] !== null) {
        bodyParams.set(key, String(paramsObj[key]));
      }
    }
    bodyStr = bodyParams.toString();
    baseHeaders["Content-Type"] = "application/x-www-form-urlencoded";
  }

  const sendOnce = function (currentAuth) {
    const url = getApiBase(currentAuth.oauth) + endpoint;
    console.log("wrikeRequest:", method, url);
    return fetch(url, {
      method: method,
      headers: Object.assign({}, baseHeaders, {
        Authorization: "Bearer " + currentAuth.token
      }),
      body: bodyStr
    });
  };

  let res = await sendOnce(auth);

  if (res.status === 401 && auth.oauth && auth.oauth.refreshToken) {
    const refreshed = await refreshOAuthToken(auth.oauth);
    auth = { token: refreshed.accessToken, oauth: refreshed };
    res = await sendOnce(auth);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error("HTTP " + res.status + " (" + res.statusText + ") " + body.slice(0, 200));
  }
  const json = await res.json();
  return json.data || [];
}

async function wrikeGet(endpoint, tokenOrAuth) {
  return wrikeRequest("GET", endpoint, null, tokenOrAuth);
}

async function wrikeWrite(method, endpoint, paramsObj, tokenOrAuth) {
  return wrikeRequest(method, endpoint, paramsObj, tokenOrAuth);
}

async function ensureMetadata(token, forceRefresh) {
  if (!forceRefresh && cachedMe && statusesById.size > 0) {
    return;
  }

  const [contacts, workflows] = await Promise.all([
    wrikeGet("/contacts", token),
    wrikeGet("/workflows", token)
  ]);

  contactsById = new Map();
  const people = [];
  cachedMe = null;
  for (const contact of contacts) {
    const fullName = [contact.firstName, contact.lastName]
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    const label = fullName || contact.primaryEmail || contact.id;
    contactsById.set(contact.id, label);
    if (contact.me === true) {
      cachedMe = contact;
    }
    if (!contact.deleted && contact.type === "Person" && fullName) {
      people.push({
        id: contact.id,
        name: fullName,
        email: contact.primaryEmail || ""
      });
    }
  }
  people.sort(function (a, b) {
    return a.name.localeCompare(b.name);
  });
  activeContactsList = people;

  if (!cachedMe) {
    const meList = await wrikeGet("/contacts?me=true", token);
    cachedMe = meList[0] || null;
  }
  if (!cachedMe || !cachedMe.id) {
    throw new Error("Could not determine your Wrike user profile from /contacts.");
  }

  statusesById = new Map();
  let order = 0;
  for (const wf of workflows) {
    const list = wf.customStatuses || [];
    for (const cs of list) {
      order += 1;
      statusesById.set(cs.id, {
        id: cs.id,
        name: cs.name || cs.standardName || "Active",
        group: cs.group || "Active",
        color: cs.color || "Blue",
        workflowId: wf.id,
        workflowName: wf.name || "Workflow",
        hidden: Boolean(cs.hidden),
        order: order
      });
    }
  }
}

async function loadMyTasks(forceMetadata) {
  if (inflightLoadPromise) {
    return inflightLoadPromise;
  }
  inflightLoadPromise = (async function () {
    try {
      return await performLoadMyTasks(forceMetadata);
    } finally {
      inflightLoadPromise = null;
    }
  })();
  return inflightLoadPromise;
}

async function performLoadMyTasks(forceMetadata) {
  let auth = null;
  try {
    auth = await getValidAuth();
  } catch (authErr) {
    console.error("Failed to refresh Wrike OAuth token:", authErr);
    lastLoadError = authErr.message;
    return { noToken: false, error: lastLoadError, tasks: [] };
  }

  if (!auth || !auth.token) {
    cachedTasks = [];
    lastLoadError = null;
    return { noToken: true, tasks: [] };
  }
  const token = auth.token;

  try {
    await ensureMetadata(token, forceMetadata);

    const includeDeferred = vscode.workspace
      .getConfiguration("wrikeTasks")
      .get("includeDeferred", false);
    const statusParam = includeDeferred
      ? encodeURIComponent(JSON.stringify(["Active", "Deferred"]))
      : "Active";
    const responsiblesParam = encodeURIComponent(JSON.stringify([cachedMe.id]));
    const fieldsParam = encodeURIComponent(
      JSON.stringify([
        "responsibleIds",
        "briefDescription",
        "parentIds",
        "superParentIds",
        "superTaskIds"
      ])
    );

    const query =
      "/tasks?responsibles=" +
      responsiblesParam +
      "&status=" +
      statusParam +
      "&subTasks=true&sortField=UpdatedDate&sortOrder=Desc&fields=" +
      fieldsParam;

    const rawTasks = await wrikeGet(query, token);

    // Guarantee strictly tasks assigned to the current user
    cachedTasks = rawTasks.filter(function (task) {
      return Array.isArray(task.responsibleIds) && task.responsibleIds.includes(cachedMe.id);
    });

    await ensureFoldersForTasks(cachedTasks, token, forceMetadata);

    hasLoadedOnce = true;
    lastLoadError = null;
    return { noToken: false, tasks: cachedTasks };
  } catch (err) {
    console.error("Failed to load Wrike tasks:", err);
    lastLoadError = err.message;
    return { noToken: false, error: lastLoadError, tasks: [] };
  }
}

async function ensureFoldersForTasks(tasks, token, forceRefresh) {
  if (forceRefresh) {
    foldersById.clear();
    taskSearchIndexCache.clear();
  }
  const missingIds = new Set();
  for (const task of tasks) {
    const parents = (task.parentIds || []).concat(task.superParentIds || []);
    for (const fid of parents) {
      if (fid && !foldersById.has(fid)) {
        missingIds.add(fid);
      }
    }
  }
  const idList = Array.from(missingIds);
  if (idList.length === 0) {
    return;
  }

  for (let i = 0; i < idList.length; i += 100) {
    const chunk = idList.slice(i, i + 100);
    const encodedIds = chunk.map(encodeURIComponent).join(",");
    const folders = await wrikeGet("/folders/" + encodedIds, token);
    for (const folder of folders) {
      foldersById.set(folder.id, folder);
    }
  }
  taskSearchIndexCache.clear();
}

function resolveClientInfo(task) {
  const allIds = (task.parentIds || []).concat(task.superParentIds || []);
  for (const fid of allIds) {
    const folder = foldersById.get(fid);
    if (folder && folder.scope !== "WsRoot" && folder.scope !== "RbRoot" && !folder.space) {
      return {
        id: folder.id,
        title: folder.title || "Untitled Client",
        isProject: Boolean(folder.project)
      };
    }
  }

  for (const fid of allIds) {
    const folder = foldersById.get(fid);
    if (folder && folder.scope !== "WsRoot" && folder.scope !== "RbRoot") {
      return {
        id: folder.id,
        title: folder.title || "Untitled Space",
        isProject: Boolean(folder.project)
      };
    }
  }

  return {
    id: "unassigned-client",
    title: "Other / Unfiled",
    isProject: false
  };
}

function resolveStatusInfo(task) {
  if (task.customStatusId && statusesById.has(task.customStatusId)) {
    return statusesById.get(task.customStatusId);
  }
  return {
    id: task.customStatusId || task.status || "Active",
    name: task.status || "Active",
    group: task.status || "Active",
    color: "Blue",
    workflowName: "Standard",
    order: 9999
  };
}

function getDueTimestamp(task) {
  const due = task.dates && task.dates.due;
  if (!due) {
    return Number.POSITIVE_INFINITY;
  }
  const ts = Date.parse(due);
  return Number.isNaN(ts) ? Number.POSITIVE_INFINITY : ts;
}

function getImportanceRank(task) {
  if (task.importance === "High") {
    return 0;
  }
  if (task.importance === "Low") {
    return 2;
  }
  return 1;
}

function compareTasks(a, b) {
  const starA = isTaskStarred(a.id) ? 1 : 0;
  const starB = isTaskStarred(b.id) ? 1 : 0;
  if (starA !== starB) {
    return starB - starA;
  }
  if (currentTaskSort === "title") {
    return (a.title || "").localeCompare(b.title || "");
  }
  if (currentTaskSort === "updatedDate") {
    return (b.updatedDate || "").localeCompare(a.updatedDate || "");
  }
  if (currentTaskSort === "createdDate") {
    return (b.createdDate || "").localeCompare(a.createdDate || "");
  }
  if (currentTaskSort === "importance") {
    const impDiff = getImportanceRank(a) - getImportanceRank(b);
    if (impDiff !== 0) {
      return impDiff;
    }
  }
  const dueA = getDueTimestamp(a);
  const dueB = getDueTimestamp(b);
  if (dueA !== dueB) {
    return dueA - dueB;
  }
  return (b.updatedDate || "").localeCompare(a.updatedDate || "");
}

function stripBriefText(text) {
  return String(text || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getAllFolderTitles(task) {
  const titles = [];
  const primary = resolveClientInfo(task).title;
  if (primary) {
    titles.push(primary);
  }
  const allIds = (task.parentIds || []).concat(task.superParentIds || []);
  for (const fid of allIds) {
    const folder = foldersById.get(fid);
    if (folder && folder.title && folder.scope !== "WsRoot" && folder.scope !== "RbRoot") {
      if (titles.indexOf(folder.title) === -1) {
        titles.push(folder.title);
      }
    }
  }
  return titles.join(" ");
}

function stemWord(word) {
  let w = String(word || "").toLowerCase();
  if (w.length <= 3) {
    return w;
  }
  if (w.endsWith("ies") && w.length > 4) {
    return w.slice(0, -3) + "y";
  }
  if (w.endsWith("ing") && w.length > 5) {
    w = w.slice(0, -3);
    if (w.length >= 3 && w[w.length - 1] === w[w.length - 2]) {
      w = w.slice(0, -1);
    }
    return w;
  }
  if (w.endsWith("ed") && w.length > 4) {
    w = w.slice(0, -2);
    if (w.length >= 3 && w[w.length - 1] === w[w.length - 2]) {
      w = w.slice(0, -1);
    }
    return w;
  }
  if (w.endsWith("es") && w.length > 4) {
    if (
      w.endsWith("ches") ||
      w.endsWith("shes") ||
      w.endsWith("xes") ||
      w.endsWith("zes") ||
      w.endsWith("ses")
    ) {
      return w.slice(0, -2);
    }
    return w.slice(0, -1);
  }
  if (w.endsWith("s") && !w.endsWith("ss") && !w.endsWith("us") && !w.endsWith("is")) {
    return w.slice(0, -1);
  }
  return w;
}

function tokenizeWords(text) {
  return String(text || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function boundedEditDistance(a, b, maxDist) {
  const lenA = a.length;
  const lenB = b.length;
  if (Math.abs(lenA - lenB) > maxDist) {
    return maxDist + 1;
  }
  const prev = new Array(lenB + 1);
  const curr = new Array(lenB + 1);
  for (let j = 0; j <= lenB; j++) {
    prev[j] = j;
  }
  for (let i = 1; i <= lenA; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= lenB; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        curr[j] = Math.min(curr[j], curr[j] - 1 + cost);
      }
      if (curr[j] < rowMin) {
        rowMin = curr[j];
      }
    }
    if (rowMin > maxDist) {
      return maxDist + 1;
    }
    for (let j = 0; j <= lenB; j++) {
      prev[j] = curr[j];
    }
  }
  return prev[lenB];
}

function isSubsequence(needle, haystack) {
  if (needle.length > haystack.length) {
    return false;
  }
  let i = 0;
  for (let j = 0; j < haystack.length && i < needle.length; j++) {
    if (needle[i] === haystack[j]) {
      i++;
    }
  }
  return i === needle.length;
}

function scoreSingleTerm(qTerm, fields) {
  const qStem = stemWord(qTerm);

  if (fields.title.indexOf(qTerm) !== -1 || fields.clientText.indexOf(qTerm) !== -1) {
    return 120;
  }
  if (fields.statusName.indexOf(qTerm) !== -1 || fields.brief.indexOf(qTerm) !== -1) {
    return 95;
  }

  if (qStem.length >= 2) {
    if (fields.title.indexOf(qStem) !== -1 || fields.clientText.indexOf(qStem) !== -1) {
      return 105;
    }
    if (fields.statusName.indexOf(qStem) !== -1 || fields.brief.indexOf(qStem) !== -1) {
      return 85;
    }
    for (let i = 0; i < fields.wordStems.length; i++) {
      const wStem = fields.wordStems[i];
      if (wStem === qStem || (wStem.length >= 3 && (wStem.indexOf(qStem) !== -1 || qStem.indexOf(wStem) !== -1))) {
        return 90;
      }
    }
  }

  const maxDist = qTerm.length >= 6 ? 2 : qTerm.length >= 4 ? 1 : 0;
  if (maxDist > 0) {
    for (let i = 0; i < fields.words.length; i++) {
      const w = fields.words[i];
      const wStem = fields.wordStems[i];
      if (
        boundedEditDistance(qTerm, w, maxDist) <= maxDist ||
        boundedEditDistance(qStem, wStem, maxDist) <= maxDist ||
        (w.length > qTerm.length && boundedEditDistance(qTerm, w.slice(0, qTerm.length), maxDist) <= maxDist)
      ) {
        return 65;
      }
    }
  }

  if (qTerm.length >= 3) {
    for (let i = 0; i < fields.words.length; i++) {
      if (isSubsequence(qTerm, fields.words[i])) {
        return 45;
      }
    }
  }

  return 0;
}

function getTaskSearchFields(task) {
  const cacheKey =
    (task.id || "") +
    "|" +
    (task.updatedDate || "") +
    "|" +
    (task.customStatusId || task.status || "");
  if (task.id && taskSearchIndexCache.has(cacheKey)) {
    return taskSearchIndexCache.get(cacheKey);
  }

  const title = String(task.title || "").toLowerCase();
  const clientText = getAllFolderTitles(task).toLowerCase();
  const statusName = resolveStatusInfo(task).name.toLowerCase();
  const brief = stripBriefText(task.briefDescription).toLowerCase();
  const combined = title + " " + clientText + " " + statusName + " " + brief;
  const words = tokenizeWords(combined);
  const wordStems = words.map(stemWord);

  const fields = {
    title: title,
    clientText: clientText,
    statusName: statusName,
    brief: brief,
    words: words,
    wordStems: wordStems
  };

  if (task.id) {
    taskSearchIndexCache.set(cacheKey, fields);
  }
  return fields;
}

function scoreTaskMatch(task, queryOrTerms) {
  let queryTerms;
  if (Array.isArray(queryOrTerms)) {
    queryTerms = queryOrTerms;
  } else {
    const rawQuery = String(queryOrTerms || "").trim().toLowerCase();
    if (!rawQuery) {
      return 1;
    }
    queryTerms = tokenizeWords(rawQuery);
  }
  if (queryTerms.length === 0) {
    return 1;
  }

  const fields = getTaskSearchFields(task);

  let totalScore = 0;
  for (const qTerm of queryTerms) {
    const termScore = scoreSingleTerm(qTerm, fields);
    if (termScore === 0) {
      return 0;
    }
    totalScore += termScore;
  }
  return totalScore;
}

function filterTasksByQuery(tasks, query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) {
    return tasks;
  }
  const queryTerms = tokenizeWords(q);
  if (queryTerms.length === 0) {
    return tasks;
  }
  return tasks.filter(function (task) {
    return scoreTaskMatch(task, queryTerms) > 0;
  });
}

function groupTasksByStatus(tasks) {
  const groupsMap = new Map();

  for (const task of tasks) {
    const statusInfo = resolveStatusInfo(task);
    const key = statusInfo.id;
    if (!groupsMap.has(key)) {
      groupsMap.set(key, {
        statusInfo: statusInfo,
        tasks: []
      });
    }
    groupsMap.get(key).tasks.push(task);
  }

  const groups = Array.from(groupsMap.values());
  groups.sort(function (a, b) {
    return a.statusInfo.order - b.statusInfo.order;
  });

  for (const group of groups) {
    group.tasks.sort(compareTasks);
  }

  return groups;
}

function groupTasksByClientAndStatus(tasks) {
  const clientsMap = new Map();

  for (const task of tasks) {
    const clientInfo = resolveClientInfo(task);
    let group = clientsMap.get(clientInfo.id);
    if (!group) {
      group = {
        clientInfo: clientInfo,
        tasks: [],
        soonestDue: Number.POSITIVE_INFINITY
      };
      clientsMap.set(clientInfo.id, group);
    }
    group.tasks.push(task);
    const dueTs = getDueTimestamp(task);
    if (dueTs < group.soonestDue) {
      group.soonestDue = dueTs;
    }
  }

  const clients = Array.from(clientsMap.values());
  clients.sort(function (a, b) {
    const starA = isClientStarred(a.clientInfo.id) ? 1 : 0;
    const starB = isClientStarred(b.clientInfo.id) ? 1 : 0;
    if (starA !== starB) {
      return starB - starA;
    }
    if (currentClientSort === "mostTasks") {
      const countDiff = b.tasks.length - a.tasks.length;
      if (countDiff !== 0) {
        return countDiff;
      }
    } else if (currentClientSort === "soonestDue") {
      if (a.soonestDue !== b.soonestDue) {
        return a.soonestDue - b.soonestDue;
      }
    }
    return a.clientInfo.title.localeCompare(b.clientInfo.title);
  });

  return clients.map(function (entry) {
    return {
      clientInfo: entry.clientInfo,
      totalTasks: entry.tasks.length,
      statusGroups: groupTasksByStatus(entry.tasks)
    };
  });
}

function formatShortDate(iso) {
  if (!iso) {
    return "";
  }
  const datePart = iso.slice(0, 10);
  const parts = datePart.split("-");
  if (parts.length !== 3) {
    return datePart;
  }
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const monthIdx = parseInt(parts[1], 10) - 1;
  return (months[monthIdx] || parts[1]) + " " + parseInt(parts[2], 10);
}

function formatDateTime(iso) {
  if (!iso) {
    return "None";
  }
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return iso;
  }
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

async function resolveProviderLoadState(providerInstance) {
  if (!providerInstance._forceReloadNext && hasLoadedOnce) {
    return { noToken: false, error: lastLoadError, tasks: cachedTasks };
  }
  const state = await loadMyTasks(providerInstance._forceMetadataNext);
  providerInstance._forceMetadataNext = false;
  providerInstance._forceReloadNext = false;
  return state;
}

function buildAuthOrErrorTreeItems(state) {
  if (state.noToken) {
    const oauthItem = new vscode.TreeItem(
      "Sign in with OAuth (Google / SSO)",
      vscode.TreeItemCollapsibleState.None
    );
    oauthItem.iconPath = new vscode.ThemeIcon("sign-in");
    oauthItem.command = {
      command: "wrikeTasks.signInOAuth",
      title: "Sign In with Wrike OAuth"
    };

    const setTokenItem = new vscode.TreeItem(
      "Or paste a Permanent Access Token",
      vscode.TreeItemCollapsibleState.None
    );
    setTokenItem.iconPath = new vscode.ThemeIcon("key");
    setTokenItem.command = {
      command: "wrikeTasks.setToken",
      title: "Set Wrike API Token"
    };
    return [oauthItem, setTokenItem];
  }

  if (state.error) {
    const errItem = new vscode.TreeItem(
      "Error: " + state.error,
      vscode.TreeItemCollapsibleState.None
    );
    errItem.iconPath = new vscode.ThemeIcon("error");
    errItem.tooltip = state.error;
    return [errItem];
  }

  const allTasks = state.tasks || [];
  if (allTasks.length === 0) {
    const emptyItem = new vscode.TreeItem(
      "No active tasks assigned to you",
      vscode.TreeItemCollapsibleState.None
    );
    emptyItem.iconPath = new vscode.ThemeIcon("check");
    return [emptyItem];
  }

  return null;
}

function buildFilterBannerItem(query, matchCount) {
  const filterBanner = new vscode.TreeItem(
    'Filter: "' + query + '" (' + matchCount + ')',
    vscode.TreeItemCollapsibleState.None
  );
  filterBanner.description = "Click to clear";
  filterBanner.iconPath = new vscode.ThemeIcon("clear-all");
  filterBanner.command = {
    command: "wrikeTasks.clearFilter",
    title: "Clear Filter"
  };
  return filterBanner;
}

class WrikeRecentTreeProvider {
  constructor() {
    this._emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._emitter.event;
    this._forceMetadataNext = false;
    this._forceReloadNext = true;
  }

  _refreshSelf(forceMetadata) {
    this._forceMetadataNext = Boolean(forceMetadata);
    this._forceReloadNext = true;
    this._emitter.fire();
  }

  _rerenderSelf() {
    this._forceReloadNext = false;
    this._emitter.fire();
  }

  refresh(forceMetadata) {
    this._refreshSelf(forceMetadata);
    if (treeProviderInstance) {
      treeProviderInstance._refreshSelf(forceMetadata);
    }
  }

  rerenderLocal() {
    this._rerenderSelf();
    if (treeProviderInstance) {
      treeProviderInstance._rerenderSelf();
    }
  }

  getTreeItem(element) {
    return element;
  }

  async getChildren(element) {
    if (element && element.children) {
      return element.children;
    }

    const state = await resolveProviderLoadState(this);
    const earlyItems = buildAuthOrErrorTreeItems(state);
    if (earlyItems) {
      return earlyItems;
    }

    const filteredTasks = filterTasksByQuery(state.tasks || [], activeFilterQuery);
    const recentList = getRecentAndStarredTasks(filteredTasks, 20);
    const headerItems = activeFilterQuery
      ? [buildFilterBannerItem(activeFilterQuery, recentList.length)]
      : [];

    if (recentList.length === 0) {
      const noMatchItem = new vscode.TreeItem(
        activeFilterQuery
          ? 'No active tasks match "' + activeFilterQuery + '"'
          : "No active tasks assigned to you",
        vscode.TreeItemCollapsibleState.None
      );
      noMatchItem.iconPath = new vscode.ThemeIcon("search-stop");
      return headerItems.concat([noMatchItem]);
    }

    const items = recentList.map(function (task) {
      const statusInfo = resolveStatusInfo(task);
      const clientInfo = resolveClientInfo(task);
      return createTaskTreeItem(task, statusInfo, clientInfo, { showClientInline: true });
    });

    return headerItems.concat(items);
  }
}

class WrikeTreeProvider {
  constructor() {
    this._emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._emitter.event;
    this._forceMetadataNext = false;
    this._forceReloadNext = true;
  }

  _refreshSelf(forceMetadata) {
    this._forceMetadataNext = Boolean(forceMetadata);
    this._forceReloadNext = true;
    this._emitter.fire();
  }

  _rerenderSelf() {
    this._forceReloadNext = false;
    this._emitter.fire();
  }

  refresh(forceMetadata) {
    this._refreshSelf(forceMetadata);
    if (recentProviderInstance) {
      recentProviderInstance._refreshSelf(forceMetadata);
    }
  }

  rerenderLocal() {
    this._rerenderSelf();
    if (recentProviderInstance) {
      recentProviderInstance._rerenderSelf();
    }
  }

  getTreeItem(element) {
    return element;
  }

  async getChildren(element) {
    if (element && element.children) {
      return element.children;
    }

    const state = await resolveProviderLoadState(this);
    const earlyItems = buildAuthOrErrorTreeItems(state);
    if (earlyItems) {
      return earlyItems;
    }

    const filteredTasks = filterTasksByQuery(state.tasks || [], activeFilterQuery);
    const groups = groupTasksByClientAndStatus(filteredTasks);
    const headerItems = activeFilterQuery
      ? [buildFilterBannerItem(activeFilterQuery, filteredTasks.length)]
      : [];

    if (groups.length === 0) {
      const noMatchItem = new vscode.TreeItem(
        'No tasks match "' + activeFilterQuery + '"',
        vscode.TreeItemCollapsibleState.None
      );
      noMatchItem.iconPath = new vscode.ThemeIcon("search-stop");
      return headerItems.concat([noMatchItem]);
    }

    const clientItems = groups.map(function (clientGroup) {
      const clientStarred = isClientStarred(clientGroup.clientInfo.id);
      const clientItem = new vscode.TreeItem(
        clientGroup.clientInfo.title,
        vscode.TreeItemCollapsibleState.Expanded
      );
      clientItem.description = String(clientGroup.totalTasks);
      clientItem.contextValue = clientStarred ? "wrikeClientGroupStarred" : "wrikeClientGroup";
      clientItem.clientInfo = clientGroup.clientInfo;
      clientItem.iconPath = clientStarred
        ? new vscode.ThemeIcon("star-full", new vscode.ThemeColor("charts.yellow"))
        : new vscode.ThemeIcon(
            clientGroup.clientInfo.isProject ? "briefcase" : "folder-library"
          );
      clientItem.children = clientGroup.statusGroups.map(function (statusGroup) {
        const statusItem = new vscode.TreeItem(
          statusGroup.statusInfo.name,
          vscode.TreeItemCollapsibleState.Expanded
        );
        statusItem.description = String(statusGroup.tasks.length);
        statusItem.contextValue = "wrikeStatusGroup";
        statusItem.iconPath = new vscode.ThemeIcon("folder-opened");
        statusItem.children = statusGroup.tasks.map(function (task) {
          return createTaskTreeItem(task, statusGroup.statusInfo, clientGroup.clientInfo);
        });
        return statusItem;
      });
      return clientItem;
    });

    return headerItems.concat(clientItems);
  }
}

function createTaskTreeItem(task, statusInfo, clientInfo, options) {
  const showClientInline = Boolean(options && options.showClientInline);
  const taskStarred = isTaskStarred(task.id);
  const item = new vscode.TreeItem(task.title, vscode.TreeItemCollapsibleState.None);
  const due = task.dates && task.dates.due ? formatShortDate(task.dates.due) : "";
  const descParts = [];
  if (showClientInline) {
    if (clientInfo && clientInfo.title) {
      descParts.push(clientInfo.title);
    }
    if (statusInfo && statusInfo.name) {
      descParts.push(statusInfo.name);
    }
  }
  if (task.importance === "High") {
    descParts.push("High");
  }
  if (due) {
    descParts.push("Due " + due);
  }
  item.description = descParts.join(" \u2022 ");
  item.contextValue = taskStarred ? "wrikeTaskStarred" : "wrikeTask";
  item.task = task;
  item.iconPath = taskStarred
    ? new vscode.ThemeIcon("star-full", new vscode.ThemeColor("charts.yellow"))
    : new vscode.ThemeIcon(
        task.importance === "High" ? "flame" : "circle-large-outline"
      );
  const updatedStr = task.updatedDate ? formatDateTime(task.updatedDate) : "";
  item.tooltip =
    task.title +
    (taskStarred ? " (Starred)" : "") +
    (clientInfo && clientInfo.title ? "\nClient: " + clientInfo.title : "") +
    "\nStatus: " +
    statusInfo.name +
    (due ? "\nDue: " + due : "") +
    (updatedStr ? "\nUpdated: " + updatedStr : "") +
    "\nClick to view task details and comments";
  item.command = {
    command: "wrikeTasks.openTaskDetail",
    title: "View Task Details",
    arguments: [task]
  };
  return item;
}

// HTML sanitization and escaping for read-only webview
function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function sanitizeWrikeHtml(rawHtml) {
  if (!rawHtml) {
    return "";
  }
  let html = String(rawHtml);

  // Strip dangerous containers and unclosed dangerous tags first
  html = html.replace(/<(script|style|iframe|object|embed|form|input|button|textarea)\b[^>]*>[\s\S]*?<\/\1>/gi, "");
  html = html.replace(/<\/?(script|style|iframe|object|embed|form|input|button|textarea)\b[^>]*\/?>/gi, "");
  html = html.replace(/<(script|style|iframe|object|embed|form|input|button|textarea)\b/gi, "&lt;$1");

  // Fill in Wrike @mention links (<a class="stream-user-id..." rel="USERID">...</a>)
  html = html.replace(
    /<a\b[^>]*\brel=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
    function (match, relId, inner) {
      if (match.indexOf("stream-user-id") === -1) {
        return match;
      }
      const cleanInner = decodeHtmlEntities(inner.replace(/<[^>]+>/g, "").trim());
      const resolvedName = cleanInner || "@" + (contactsById.get(relId) || relId);
      return '<span class="mention">' + escapeHtml(resolvedName) + "</span>";
    }
  );

  // Sanitize tags: keep only safe formatting tags and safe https/mailto links
  const allowedTags = new Set([
    "p", "br", "div", "span", "b", "strong", "i", "em", "u", "s", "strike",
    "ul", "ol", "li", "blockquote", "pre", "code", "hr",
    "h1", "h2", "h3", "h4", "h5", "h6",
    "table", "thead", "tbody", "tr", "th", "td", "a", "img"
  ]);

  html = html.replace(/<\/?([a-zA-Z0-9]+)\b([^>]*)>/g, function (full, tagName, attrs) {
    const tag = tagName.toLowerCase();
    if (!allowedTags.has(tag)) {
      return "";
    }
    if (full.startsWith("</")) {
      return "</" + tag + ">";
    }
    if (tag === "br" || tag === "hr") {
      return "<" + tag + ">";
    }
    if (tag === "span" && attrs.indexOf('class="mention"') !== -1) {
      return '<span class="mention">';
    }
    if (tag === "a") {
      const hrefMatch = attrs.match(/\bhref=["']([^"']+)["']/i);
      const href = hrefMatch ? hrefMatch[1].trim() : "";
      if (/^(https?:\/\/|mailto:)/i.test(href)) {
        return '<a href="' + escapeHtml(href) + '" target="_blank" rel="noopener noreferrer">';
      }
      return "<span>";
    }
    if (tag === "img") {
      const srcMatch = attrs.match(/\bsrc=["']([^"']+)["']/i);
      const src = srcMatch ? srcMatch[1].trim() : "";
      if (/^https:\/\//i.test(src)) {
        return '<img src="' + escapeHtml(src) + '" alt="Task image">';
      }
      return "";
    }
    return "<" + tag + ">";
  });

  return html;
}

function resolveCommentAuthor(comment) {
  if (comment.authorId && contactsById.has(comment.authorId)) {
    return contactsById.get(comment.authorId);
  }
  if (comment.externalRequester) {
    const req = comment.externalRequester;
    const name = [req.firstName, req.lastName].filter(Boolean).join(" ").trim();
    return name ? name + (req.email ? " (" + req.email + ")" : "") : req.email || "External User";
  }
  return comment.authorId || "Unknown Author";
}

function decodeHtmlEntities(str) {
  if (!str) {
    return "";
  }
  return String(str)
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#x([0-9a-fA-F]+);/g, function (_m, code) {
      return String.fromCharCode(parseInt(code, 16));
    })
    .replace(/&#(\d+);/g, function (_m, code) {
      return String.fromCharCode(Number(code));
    })
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function wrikeHtmlToMarkdown(rawHtml) {
  if (!rawHtml) {
    return "";
  }
  let text = String(rawHtml).replace(/\r\n/g, "\n");

  text = text.replace(
    /<a\b[^>]*class=["'][^"']*stream-user-id[^"']*["'][^>]*rel=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
    function (_match, relId, innerText) {
      const resolved = contactsById.get(relId);
      const cleanInner = decodeHtmlEntities(innerText.replace(/<[^>]+>/g, "").trim());
      if (resolved) {
        return "**@" + resolved + "**";
      }
      if (cleanInner) {
        return "**" + (cleanInner.startsWith("@") ? cleanInner : "@" + cleanInner) + "**";
      }
      return "**@" + relId + "**";
    }
  );

  text = text.replace(
    /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
    function (_match, href, inner) {
      const cleanInner = decodeHtmlEntities(inner.replace(/<[^>]+>/g, "").trim());
      const cleanHref = decodeHtmlEntities(href.trim());
      if (!cleanInner || cleanInner === cleanHref) {
        return cleanHref;
      }
      return "[" + cleanInner + "](" + cleanHref + ")";
    }
  );

  text = text
    .replace(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi, "\n# $1\n")
    .replace(/<h2\b[^>]*>([\s\S]*?)<\/h2>/gi, "\n## $1\n")
    .replace(/<h3\b[^>]*>([\s\S]*?)<\/h3>/gi, "\n### $1\n")
    .replace(/<h[4-6]\b[^>]*>([\s\S]*?)<\/h[4-6]>/gi, "\n#### $1\n")
    .replace(/<(?:strong|b)\b[^>]*>([\s\S]*?)<\/(?:strong|b)>/gi, "**$1**")
    .replace(/<(?:em|i)\b[^>]*>([\s\S]*?)<\/(?:em|i)>/gi, "*$1*")
    .replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, "`$1`")
    .replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, function (_m, codeBlock) {
      return "\n```\n" + decodeHtmlEntities(codeBlock.replace(/<[^>]+>/g, "")) + "\n```\n";
    })
    .replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, function (_m, quoteInner) {
      const lines = quoteInner
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<[^>]+>/g, "")
        .trim()
        .split("\n");
      return (
        "\n" +
        lines
          .map(function (l) {
            return "> " + decodeHtmlEntities(l.trim());
          })
          .join("\n") +
        "\n"
      );
    })
    .replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, function (_m, liInner) {
      const cleanLi = liInner
        .replace(/<br\s*\/?>/gi, " ")
        .replace(/<[^>]+>/g, "")
        .trim();
      return "\n- " + decodeHtmlEntities(cleanLi);
    })
    .replace(/<\/(?:ul|ol|p|div|table)>/gi, "\n\n")
    .replace(/<\/tr>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<hr\s*\/?>/gi, "\n---\n")
    .replace(/<[^>]+>/g, "");

  text = decodeHtmlEntities(text);

  return text
    .split("\n")
    .map(function (line) {
      return line.replace(/[ \t]+$/g, "");
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function buildTaskMarkdown(task, statusInfo, comments, clientInfo) {
  const clientTitle =
    clientInfo && clientInfo.title
      ? clientInfo.title
      : resolveClientInfo(task).title;
  const resolvedStatus = statusInfo || resolveStatusInfo(task);
  const dueDate =
    task.dates && task.dates.due ? formatShortDate(task.dates.due) : "No due date";
  const startDate =
    task.dates && task.dates.start ? formatShortDate(task.dates.start) : "Not set";
  const updated = formatDateTime(task.updatedDate);
  const assignees = Array.isArray(task.responsibleIds)
    ? task.responsibleIds
        .map(function (id) {
          return contactsById.get(id) || id;
        })
        .join(", ")
    : "You";

  const lines = [
    "# Wrike Task: " + (task.title || "Untitled Task"),
    "",
    "- **Client / Project:** " + clientTitle,
    "- **Status:** " + resolvedStatus.name + " (" + (task.status || "Active") + ")",
    "- **Importance:** " + (task.importance || "Normal"),
    "- **Assigned To:** " + (assignees || "You"),
    "- **Start Date:** " + startDate,
    "- **Due Date:** " + dueDate,
    "- **Updated:** " + updated
  ];

  if (task.permalink && /^https?:\/\//i.test(task.permalink)) {
    lines.push("- **Permalink:** " + task.permalink);
  }

  lines.push("", "## Description", "");
  const descMd = wrikeHtmlToMarkdown(task.description || task.briefDescription || "");
  lines.push(descMd || "_No description provided._");

  const safeComments = Array.isArray(comments) ? comments : [];
  lines.push("", "## Comments (" + safeComments.length + ")", "");

  if (safeComments.length === 0) {
    lines.push("_No comments on this task._");
  } else {
    safeComments.forEach(function (c, idx) {
      const author = resolveCommentAuthor(c);
      const date = formatDateTime(c.createdDate);
      lines.push("### " + (idx + 1) + ". " + author + " (" + date + ")");
      if (c.emailSubject) {
        lines.push("**Subject:** " + c.emailSubject);
      }
      lines.push("");
      const bodyMd = wrikeHtmlToMarkdown(c.text || "");
      lines.push(bodyMd || "_Empty comment_");
      lines.push("");
    });
  }

  return lines.join("\n").trim() + "\n";
}

async function copyTaskMarkdownById(taskSummary) {
  if (!taskSummary || !taskSummary.id) {
    return;
  }
  const auth = await getValidAuth().catch(() => null);
  if (!auth || !auth.token) {
    vscode.window.showWarningMessage("Sign in to Wrike first.");
    return;
  }

  await ensureMetadata(auth, false);
  const [fullTasks, comments] = await Promise.all([
    wrikeGet("/tasks/" + encodeURIComponent(taskSummary.id), auth),
    wrikeGet("/tasks/" + encodeURIComponent(taskSummary.id) + "/comments", auth)
  ]);

  const fullTask = fullTasks[0] || taskSummary;
  await ensureFoldersForTasks([fullTask], auth, false);
  const statusInfo = resolveStatusInfo(fullTask);
  const clientInfo = resolveClientInfo(fullTask);
  const markdown = buildTaskMarkdown(fullTask, statusInfo, comments, clientInfo);

  await vscode.env.clipboard.writeText(markdown);
  vscode.window.showInformationMessage(
    "Copied Markdown for \"" + (fullTask.title || taskSummary.title) + "\" to clipboard."
  );
  return markdown;
}

function getWorkflowStatusesForTask(task) {
  const currentId = task && task.customStatusId ? task.customStatusId : "";
  const currentStatus = currentId ? statusesById.get(currentId) : null;
  const targetWorkflowId = currentStatus && currentStatus.workflowId ? currentStatus.workflowId : null;

  const matching = [];
  const allVisible = [];
  statusesById.forEach(function (st) {
    if (st.hidden && st.id !== currentId) {
      return;
    }
    allVisible.push(st);
    if (targetWorkflowId && st.workflowId === targetWorkflowId) {
      matching.push(st);
    }
  });

  const list = matching.length > 0 ? matching : allVisible;
  list.sort(function (a, b) {
    return a.order - b.order;
  });
  return list;
}

function buildCommentHtmlFromText(rawText, mentionsList) {
  const text = String(rawText || "");
  if (!text.trim()) {
    return "";
  }
  const textLower = text.toLowerCase();

  const validMentions = [];
  const seenTokens = new Set();
  const inputMentions = Array.isArray(mentionsList) ? mentionsList : [];
  for (let i = 0; i < inputMentions.length; i++) {
    const m = inputMentions[i];
    if (!m || !m.id || !m.name) {
      continue;
    }
    const cleanName = String(m.name).replace(/^@/, "").replace(/\s+/g, " ").trim();
    const token = "@" + cleanName;
    const tokenLower = token.toLowerCase();
    if (!seenTokens.has(tokenLower)) {
      seenTokens.add(tokenLower);
      validMentions.push({
        id: String(m.id),
        token: token,
        tokenLower: tokenLower,
        quasi: Boolean(m.quasi) || m.id === "@assignees" || m.id === "@followers"
      });
    }
  }

  // Also scan activeContactsList case-insensitively for any typed @FirstName LastName
  for (let i = 0; i < activeContactsList.length; i++) {
    const c = activeContactsList[i];
    const token = "@" + c.name;
    const tokenLower = token.toLowerCase();
    if (textLower.indexOf(tokenLower) !== -1 && !seenTokens.has(tokenLower)) {
      seenTokens.add(tokenLower);
      validMentions.push({
        id: c.id,
        token: token,
        tokenLower: tokenLower,
        quasi: false
      });
    }
  }
  if (textLower.indexOf("@assignees") !== -1 && !seenTokens.has("@assignees")) {
    seenTokens.add("@assignees");
    validMentions.push({
      id: "@assignees",
      token: "@assignees",
      tokenLower: "@assignees",
      quasi: true
    });
  }
  if (textLower.indexOf("@followers") !== -1 && !seenTokens.has("@followers")) {
    seenTokens.add("@followers");
    validMentions.push({
      id: "@followers",
      token: "@followers",
      tokenLower: "@followers",
      quasi: true
    });
  }

  validMentions.sort(function (a, b) {
    return b.token.length - a.token.length;
  });

  let cursor = 0;
  let html = "";
  while (cursor < text.length) {
    let matched = null;
    if (text[cursor] === "@") {
      for (let i = 0; i < validMentions.length; i++) {
        const m = validMentions[i];
        if (textLower.startsWith(m.tokenLower, cursor)) {
          const nextChar = text[cursor + m.token.length] || "";
          if (!nextChar || /[\s.,!?;:)\]\-]/.test(nextChar)) {
            matched = m;
            break;
          }
        }
      }
    }

    if (matched) {
      const cls = matched.quasi
        ? "stream-user-id avatar quasi-contact"
        : "stream-user-id avatar";
      html +=
        '<a class="' +
        cls +
        '" rel="' +
        escapeHtml(matched.id) +
        '">' +
        escapeHtml(matched.token) +
        "</a>";
      cursor += matched.token.length;
    } else if (text[cursor] === "\r" && text[cursor + 1] === "\n") {
      html += "<br />";
      cursor += 2;
    } else if (text[cursor] === "\n") {
      html += "<br />";
      cursor += 1;
    } else {
      html += escapeHtml(text[cursor]);
      cursor += 1;
    }
  }

  return html;
}

function buildTaskDetailHtml(task, statusInfo, comments, clientInfo, options) {
  const opts = options || {};
  const nonce = opts.nonce || crypto.randomBytes(16).toString("hex");
  const workflowStatuses = opts.workflowStatuses || getWorkflowStatusesForTask(task);
  const contacts = opts.contacts || activeContactsList;
  const badgeColor = WRIKE_COLORS[statusInfo.color] || "#2196f3";
  const clientTitle = (clientInfo && clientInfo.title) || resolveClientInfo(task).title;
  const startDate = task.dates && task.dates.start ? formatShortDate(task.dates.start) : "None";
  const dueDate = task.dates && task.dates.due ? formatShortDate(task.dates.due) : "None";
  const created = formatDateTime(task.createdDate);
  const updated = formatDateTime(task.updatedDate);
  const permalink =
    task.permalink && /^https:\/\//i.test(task.permalink) ? task.permalink : "";

  const assignees = (task.responsibleIds || [])
    .map(function (id) {
      return contactsById.get(id) || id;
    })
    .join(", ");

  const descriptionHtml = sanitizeWrikeHtml(task.description);

  const statusOptionsHtml = workflowStatuses
    .map(function (st) {
      const selected =
        st.id === task.customStatusId ? ' selected="selected"' : "";
      const groupSuffix = st.group && st.group !== "Active" ? " (" + st.group + ")" : "";
      return (
        '<option value="' +
        escapeHtml(st.id) +
        '"' +
        selected +
        ">" +
        escapeHtml(st.name + groupSuffix) +
        "</option>"
      );
    })
    .join("");

  const commentsHtml =
    comments.length === 0
      ? '<p class="empty-msg">No comments on this task yet.</p>'
      : comments
          .map(function (c) {
            const author = escapeHtml(resolveCommentAuthor(c));
            const dateStr = escapeHtml(formatDateTime(c.createdDate));
            const emailSubj = c.emailSubject
              ? '<div class="comment-subj">Subject: ' + escapeHtml(c.emailSubject) + "</div>"
              : "";
            const body = sanitizeWrikeHtml(c.text);
            return (
              '<article class="comment-card">' +
              '<header class="comment-header">' +
              '<strong class="comment-author">' +
              author +
              "</strong>" +
              '<time class="comment-date">' +
              dateStr +
              "</time>" +
              "</header>" +
              emailSubj +
              '<div class="comment-body">' +
              body +
              "</div>" +
              "</article>"
            );
          })
          .join("\n");

  const contactsJsonSafe = JSON.stringify(contacts).replace(/</g, "\\u003c");
  const taskIsStarred = Boolean(
    opts.starred !== undefined ? opts.starred : isTaskStarred(task.id)
  );

  return (
    "<!DOCTYPE html>\n" +
    '<html lang="en">\n' +
    "<head>\n" +
    '<meta charset="UTF-8" />\n' +
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src https: data:; script-src \'nonce-' +
    escapeHtml(nonce) +
    "';\" />\n" +
    '<meta name="viewport" content="width=device-width, initial-scale=1.0" />\n' +
    "<title>" +
    escapeHtml(task.title) +
    "</title>\n" +
    "<style>\n" +
    "  :root {\n" +
    "    --focus-ring: 2px solid var(--vscode-focusBorder, #0078d4);\n" +
    "    --z-dropdown: 100;\n" +
    "  }\n" +
    "  * {\n" +
    "    box-sizing: border-box;\n" +
    "  }\n" +
    "  body {\n" +
    "    font-family: var(--vscode-font-family, system-ui, sans-serif);\n" +
    "    font-size: var(--vscode-font-size, 0.875rem);\n" +
    "    color: var(--vscode-editor-foreground, #1f2328);\n" +
    "    background-color: var(--vscode-editor-background, #ffffff);\n" +
    "    line-height: 1.55;\n" +
    "    margin: 0;\n" +
    "    padding: 1.5rem 1.75rem 3rem;\n" +
    "    max-width: 58rem;\n" +
    "  }\n" +
    "  .top-bar {\n" +
    "    display: flex;\n" +
    "    align-items: center;\n" +
    "    justify-content: space-between;\n" +
    "    gap: 0.75rem;\n" +
    "    flex-wrap: wrap;\n" +
    "    margin-bottom: 0.875rem;\n" +
    "  }\n" +
    "  .badges {\n" +
    "    display: flex;\n" +
    "    align-items: center;\n" +
    "    gap: 0.625rem;\n" +
    "    flex-wrap: wrap;\n" +
    "  }\n" +
    "  .status-control {\n" +
    "    display: inline-flex;\n" +
    "    align-items: center;\n" +
    "    gap: 0.5rem;\n" +
    "  }\n" +
    "  .status-dot {\n" +
    "    width: 0.75rem;\n" +
    "    height: 0.75rem;\n" +
    "    border-radius: 999px;\n" +
    "    background-color: " +
    badgeColor +
    ";\n" +
    "    flex-shrink: 0;\n" +
    "  }\n" +
    "  .status-label {\n" +
    "    font-size: 0.75rem;\n" +
    "    font-weight: 600;\n" +
    "    text-transform: uppercase;\n" +
    "    letter-spacing: 0.04em;\n" +
    "  }\n" +
    "  .status-select {\n" +
    "    min-height: 2.75rem;\n" +
    "    padding: 0.375rem 0.75rem;\n" +
    "    border-radius: 0.375rem;\n" +
    "    border: 1px solid var(--vscode-dropdown-border, var(--vscode-panel-border, #8c959f));\n" +
    "    background-color: var(--vscode-dropdown-background, var(--vscode-editorWidget-background, #ffffff));\n" +
    "    color: var(--vscode-dropdown-foreground, var(--vscode-editor-foreground, #1f2328));\n" +
    "    font-family: inherit;\n" +
    "    font-size: 0.8125rem;\n" +
    "    font-weight: 600;\n" +
    "    cursor: pointer;\n" +
    "  }\n" +
    "  .status-select:hover {\n" +
    "    border-color: var(--vscode-focusBorder, #0078d4);\n" +
    "  }\n" +
    "  .status-select:focus-visible {\n" +
    "    outline: var(--focus-ring);\n" +
    "    outline-offset: 2px;\n" +
    "  }\n" +
    "  .importance-badge {\n" +
    "    display: inline-flex;\n" +
    "    align-items: center;\n" +
    "    min-height: 2rem;\n" +
    "    padding: 0.25rem 0.625rem;\n" +
    "    border-radius: 0.25rem;\n" +
    "    font-size: 0.75rem;\n" +
    "    font-weight: 600;\n" +
    "    border: 1px solid var(--vscode-panel-border, #444);\n" +
    "  }\n" +
    "  .open-btn {\n" +
    "    display: inline-flex;\n" +
    "    align-items: center;\n" +
    "    justify-content: center;\n" +
    "    min-height: 2.75rem;\n" +
    "    min-width: 2.75rem;\n" +
    "    padding: 0.5rem 0.875rem;\n" +
    "    border-radius: 0.25rem;\n" +
    "    background-color: var(--vscode-button-background, #0078d4);\n" +
    "    color: var(--vscode-button-foreground, #ffffff);\n" +
    "    text-decoration: none;\n" +
    "    font-size: 0.8125rem;\n" +
    "    font-weight: 600;\n" +
    "  }\n" +
    "  .open-btn:hover {\n" +
    "    background-color: var(--vscode-button-hoverBackground, #106ebe);\n" +
    "  }\n" +
    "  .open-btn:focus-visible {\n" +
    "    outline: var(--focus-ring);\n" +
    "    outline-offset: 2px;\n" +
    "  }\n" +
    "  h1 {\n" +
    "    font-size: 1.25rem;\n" +
    "    margin: 0 0 1rem;\n" +
    "    line-height: 1.35;\n" +
    "  }\n" +
    "  .meta-grid {\n" +
    "    display: grid;\n" +
    "    grid-template-columns: repeat(auto-fit, minmax(10.5rem, 1fr));\n" +
    "    gap: 0.625rem 1rem;\n" +
    "    padding: 0.75rem 1rem;\n" +
    "    border-radius: 0.375rem;\n" +
    "    background-color: var(--vscode-editorWidget-background, rgba(128,128,128,0.08));\n" +
    "    border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.2));\n" +
    "    margin-bottom: 1.5rem;\n" +
    "  }\n" +
    "  .meta-label {\n" +
    "    font-size: 0.6875rem;\n" +
    "    text-transform: uppercase;\n" +
    "    letter-spacing: 0.04em;\n" +
    "    opacity: 0.78;\n" +
    "  }\n" +
    "  .meta-value {\n" +
    "    font-weight: 500;\n" +
    "    margin-top: 0.125rem;\n" +
    "  }\n" +
    "  h2 {\n" +
    "    font-size: 0.875rem;\n" +
    "    text-transform: uppercase;\n" +
    "    letter-spacing: 0.05em;\n" +
    "    border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.25));\n" +
    "    padding-bottom: 0.375rem;\n" +
    "    margin: 1.75rem 0 0.875rem;\n" +
    "  }\n" +
    "  .description-box {\n" +
    "    padding: 0.25rem 0;\n" +
    "    overflow-wrap: break-word;\n" +
    "  }\n" +
    "  .description-box table, .comment-body table {\n" +
    "    border-collapse: collapse;\n" +
    "    width: 100%;\n" +
    "    margin: 0.625rem 0;\n" +
    "  }\n" +
    "  .description-box th, .description-box td, .comment-body th, .comment-body td {\n" +
    "    border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.3));\n" +
    "    padding: 0.375rem 0.5rem;\n" +
    "    text-align: left;\n" +
    "  }\n" +
    "  .description-box img, .comment-body img {\n" +
    "    max-width: 100%;\n" +
    "    height: auto;\n" +
    "    border-radius: 0.25rem;\n" +
    "  }\n" +
    "  .mention {\n" +
    "    display: inline-block;\n" +
    "    padding: 0 0.3125rem;\n" +
    "    border-radius: 0.1875rem;\n" +
    "    background-color: rgba(33, 150, 243, 0.14);\n" +
    "    color: var(--vscode-textLink-foreground, #0550ae);\n" +
    "    font-weight: 600;\n" +
    "  }\n" +
    "  .composer-box {\n" +
    "    position: relative;\n" +
    "    border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.28));\n" +
    "    background-color: var(--vscode-editorWidget-background, rgba(128,128,128,0.06));\n" +
    "    border-radius: 0.375rem;\n" +
    "    padding: 0.875rem 1rem;\n" +
    "    margin-bottom: 1.25rem;\n" +
    "  }\n" +
    "  .composer-label {\n" +
    "    display: block;\n" +
    "    font-weight: 600;\n" +
    "    margin-bottom: 0.375rem;\n" +
    "    font-size: 0.8125rem;\n" +
    "  }\n" +
    "  .composer-hint {\n" +
    "    font-size: 0.75rem;\n" +
    "    opacity: 0.78;\n" +
    "    margin-bottom: 0.5rem;\n" +
    "  }\n" +
    "  .composer-textarea {\n" +
    "    width: 100%;\n" +
    "    min-height: 5.25rem;\n" +
    "    padding: 0.625rem 0.75rem;\n" +
    "    border-radius: 0.25rem;\n" +
    "    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border, #8c959f));\n" +
    "    background-color: var(--vscode-input-background, var(--vscode-editor-background, #ffffff));\n" +
    "    color: var(--vscode-input-foreground, var(--vscode-editor-foreground, #1f2328));\n" +
    "    font-family: inherit;\n" +
    "    font-size: 0.875rem;\n" +
    "    line-height: 1.45;\n" +
    "    resize: vertical;\n" +
    "  }\n" +
    "  .composer-textarea:focus-visible {\n" +
    "    outline: var(--focus-ring);\n" +
    "    outline-offset: 1px;\n" +
    "  }\n" +
    "  .mention-popup {\n" +
    "    position: absolute;\n" +
    "    left: 1rem;\n" +
    "    right: 1rem;\n" +
    "    z-index: var(--z-dropdown);\n" +
    "    max-height: 13.5rem;\n" +
    "    overflow-y: auto;\n" +
    "    margin-top: 0.25rem;\n" +
    "    border-radius: 0.375rem;\n" +
    "    border: 1px solid var(--vscode-editorWidget-border, var(--vscode-panel-border, #8c959f));\n" +
    "    background-color: var(--vscode-editorWidget-background, #ffffff);\n" +
    "    color: var(--vscode-editorWidget-foreground, var(--vscode-editor-foreground, #1f2328));\n" +
    "    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.2);\n" +
    "  }\n" +
    "  .mention-popup[hidden] {\n" +
    "    display: none;\n" +
    "  }\n" +
    "  .mention-option {\n" +
    "    display: flex;\n" +
    "    align-items: center;\n" +
    "    justify-content: space-between;\n" +
    "    width: 100%;\n" +
    "    min-height: 2.75rem;\n" +
    "    padding: 0.5rem 0.75rem;\n" +
    "    border: 0;\n" +
    "    background: transparent;\n" +
    "    color: var(--vscode-editorWidget-foreground, var(--vscode-editor-foreground, #1f2328));\n" +
    "    font-family: inherit;\n" +
    "    font-size: 0.8125rem;\n" +
    "    text-align: left;\n" +
    "    cursor: pointer;\n" +
    "  }\n" +
    "  .mention-option:hover, .mention-option.is-active {\n" +
    "    background-color: var(--vscode-list-hoverBackground, rgba(0, 120, 212, 0.22));\n" +
    "  }\n" +
    "  .mention-option:focus-visible {\n" +
    "    outline: var(--focus-ring);\n" +
    "    outline-offset: -2px;\n" +
    "  }\n" +
    "  .mention-option-meta {\n" +
    "    font-size: 0.75rem;\n" +
    "    opacity: 0.75;\n" +
    "  }\n" +
    "  .composer-actions {\n" +
    "    display: flex;\n" +
    "    align-items: center;\n" +
    "    justify-content: space-between;\n" +
    "    gap: 0.75rem;\n" +
    "    flex-wrap: wrap;\n" +
    "    margin-top: 0.625rem;\n" +
    "  }\n" +
    "  .composer-buttons {\n" +
    "    display: flex;\n" +
    "    align-items: center;\n" +
    "    gap: 0.5rem;\n" +
    "  }\n" +
    "  .btn-secondary, .btn-primary {\n" +
    "    min-height: 2.75rem;\n" +
    "    min-width: 2.75rem;\n" +
    "    padding: 0.5rem 0.875rem;\n" +
    "    border-radius: 0.25rem;\n" +
    "    font-family: inherit;\n" +
    "    font-size: 0.8125rem;\n" +
    "    font-weight: 600;\n" +
    "    cursor: pointer;\n" +
    "  }\n" +
    "  .btn-secondary {\n" +
    "    border: 1px solid var(--vscode-button-border, var(--vscode-panel-border, #555));\n" +
    "    background-color: var(--vscode-button-secondaryBackground, rgba(128,128,128,0.18));\n" +
    "    color: var(--vscode-button-secondaryForeground, var(--vscode-editor-foreground));\n" +
    "  }\n" +
    "  .btn-secondary:hover {\n" +
    "    background-color: var(--vscode-button-secondaryHoverBackground, rgba(128,128,128,0.28));\n" +
    "  }\n" +
    "  .btn-primary {\n" +
    "    border: 1px solid transparent;\n" +
    "    background-color: var(--vscode-button-background, #0078d4);\n" +
    "    color: var(--vscode-button-foreground, #ffffff);\n" +
    "  }\n" +
    "  .btn-primary:hover {\n" +
    "    background-color: var(--vscode-button-hoverBackground, #106ebe);\n" +
    "  }\n" +
    "  .btn-secondary:focus-visible, .btn-primary:focus-visible {\n" +
    "    outline: var(--focus-ring);\n" +
    "    outline-offset: 2px;\n" +
    "  }\n" +
    "  .btn-primary:disabled, .status-select:disabled {\n" +
    "    opacity: 0.6;\n" +
    "    cursor: not-allowed;\n" +
    "  }\n" +
    "  .status-feedback {\n" +
    "    font-size: 0.75rem;\n" +
    "    font-weight: 600;\n" +
    "  }\n" +
    "  .comment-card {\n" +
    "    border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.22));\n" +
    "    background-color: var(--vscode-editorWidget-background, rgba(128,128,128,0.05));\n" +
    "    border-radius: 0.375rem;\n" +
    "    padding: 0.75rem 1rem;\n" +
    "    margin-bottom: 0.75rem;\n" +
    "  }\n" +
    "  .comment-header {\n" +
    "    display: flex;\n" +
    "    justify-content: space-between;\n" +
    "    align-items: baseline;\n" +
    "    gap: 0.75rem;\n" +
    "    margin-bottom: 0.375rem;\n" +
    "  }\n" +
    "  .comment-date {\n" +
    "    font-size: 0.6875rem;\n" +
    "    opacity: 0.75;\n" +
    "  }\n" +
    "  .comment-subj {\n" +
    "    font-size: 0.75rem;\n" +
    "    font-weight: 600;\n" +
    "    margin-bottom: 0.375rem;\n" +
    "    opacity: 0.85;\n" +
    "  }\n" +
    "  .comment-body {\n" +
    "    overflow-wrap: break-word;\n" +
    "  }\n" +
    "  .empty-msg {\n" +
    "    opacity: 0.7;\n" +
    "    font-style: italic;\n" +
    "  }\n" +
    "  a {\n" +
    "    color: var(--vscode-textLink-foreground, #3794ff);\n" +
    "  }\n" +
    "</style>\n" +
    "</head>\n" +
    "<body>\n" +
    "  <main>\n" +
    '    <div class="top-bar">\n' +
    '      <div class="badges">\n' +
    '        <div class="status-control">\n' +
    '          <span class="status-dot" aria-hidden="true"></span>\n' +
    '          <label for="status-select" class="status-label">Status</label>\n' +
    '          <select id="status-select" class="status-select">\n' +
    statusOptionsHtml +
    "\n          </select>\n" +
    '          <span id="status-feedback" class="status-feedback" aria-live="polite"></span>\n' +
    "        </div>\n" +
    '        <span class="importance-badge">Importance: ' +
    escapeHtml(task.importance || "Normal") +
    "</span>\n" +
    "      </div>\n" +
    '      <div class="composer-buttons">\n' +
    '        <button type="button" id="star-task-btn" class="btn-secondary" aria-pressed="' +
    (taskIsStarred ? "true" : "false") +
    '">' +
    (taskIsStarred ? "\u2605 Starred" : "\u2606 Star Task") +
    "</button>\n" +
    '        <button type="button" id="copy-md-btn" class="btn-secondary">Copy in Markdown</button>\n' +
    (permalink
      ? '        <a class="open-btn" href="' +
        escapeHtml(permalink) +
        '">Open in Wrike <span aria-hidden="true">&#8599;</span></a>\n'
      : "") +
    "      </div>\n" +
    "    </div>\n" +
    "    <h1>" +
    escapeHtml(task.title) +
    "</h1>\n" +
    '    <div class="meta-grid">\n' +
    '      <div><div class="meta-label">Client / Project</div><div class="meta-value">' +
    escapeHtml(clientTitle) +
    "</div></div>\n" +
    '      <div><div class="meta-label">Assigned To</div><div class="meta-value">' +
    escapeHtml(assignees || "You") +
    "</div></div>\n" +
    '      <div><div class="meta-label">Start Date</div><div class="meta-value">' +
    escapeHtml(startDate) +
    "</div></div>\n" +
    '      <div><div class="meta-label">Due Date</div><div class="meta-value">' +
    escapeHtml(dueDate) +
    "</div></div>\n" +
    '      <div><div class="meta-label">Updated</div><div class="meta-value">' +
    escapeHtml(updated) +
    "</div></div>\n" +
    '      <div><div class="meta-label">Created</div><div class="meta-value">' +
    escapeHtml(created) +
    "</div></div>\n" +
    "    </div>\n" +
    "    <h2>Description</h2>\n" +
    '    <div class="description-box">\n' +
    (descriptionHtml || '<p class="empty-msg">No description provided.</p>') +
    "\n    </div>\n" +
    "    <h2>Comments (" +
    comments.length +
    ")</h2>\n" +
    '    <div class="composer-box">\n' +
    '      <label for="comment-input" class="composer-label">Add a comment</label>\n' +
    '      <div class="composer-hint">Type <strong>@</strong> to tag a teammate, <strong>@assignees</strong>, or <strong>@followers</strong>. Press Ctrl+Enter to post.</div>\n' +
    '      <textarea id="comment-input" class="composer-textarea" rows="3" placeholder="Write a comment... Use @ to mention people"></textarea>\n' +
    '      <div id="mention-popup" class="mention-popup" role="listbox" aria-label="Mention suggestions" hidden="hidden"></div>\n' +
    '      <div class="composer-actions">\n' +
    '        <div class="composer-buttons">\n' +
    '          <button type="button" id="mention-btn" class="btn-secondary">@ Mention Someone</button>\n' +
    '          <button type="button" id="post-comment-btn" class="btn-primary">Post Comment</button>\n' +
    "        </div>\n" +
    '        <span id="comment-feedback" class="status-feedback" aria-live="polite"></span>\n' +
    "      </div>\n" +
    "    </div>\n" +
    '    <div class="comments-list">\n' +
    commentsHtml +
    "\n    </div>\n" +
    "  </main>\n" +
    '  <script nonce="' +
    escapeHtml(nonce) +
    '">\n' +
    "    (function () {\n" +
    "      const vscode = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : null;\n" +
    "      const contacts = " +
    contactsJsonSafe +
    ";\n" +
    "      const specialMentions = [\n" +
    "        { id: '@assignees', name: 'assignees', email: 'All task assignees', quasi: true },\n" +
    "        { id: '@followers', name: 'followers', email: 'All task followers', quasi: true }\n" +
    "      ];\n" +
    "      const allCandidates = specialMentions.concat(contacts);\n" +
    "      const insertedMentions = [];\n" +
    "      const statusSelect = document.getElementById('status-select');\n" +
    "      const statusFeedback = document.getElementById('status-feedback');\n" +
    "      const commentInput = document.getElementById('comment-input');\n" +
    "      const mentionPopup = document.getElementById('mention-popup');\n" +
    "      const mentionBtn = document.getElementById('mention-btn');\n" +
    "      const postBtn = document.getElementById('post-comment-btn');\n" +
    "      const starTaskBtn = document.getElementById('star-task-btn');\n" +
    "      const copyMdBtn = document.getElementById('copy-md-btn');\n" +
    "      const commentFeedback = document.getElementById('comment-feedback');\n" +
    "      let activeMatches = [];\n" +
    "      let activeIndex = 0;\n" +
    "      let mentionStartPos = -1;\n" +
    "\n" +
    "      if (starTaskBtn) {\n" +
    "        starTaskBtn.addEventListener('click', function () {\n" +
    "          if (!vscode) return;\n" +
    "          const nowStarred = starTaskBtn.getAttribute('aria-pressed') !== 'true';\n" +
    "          starTaskBtn.setAttribute('aria-pressed', nowStarred ? 'true' : 'false');\n" +
    "          starTaskBtn.textContent = nowStarred ? '\\u2605 Starred' : '\\u2606 Star Task';\n" +
    "          vscode.postMessage({ cmd: 'toggleStarTask', starred: nowStarred });\n" +
    "        });\n" +
    "      }\n" +
    "\n" +
    "      if (copyMdBtn) {\n" +
    "        copyMdBtn.addEventListener('click', function () {\n" +
    "          if (!vscode) return;\n" +
    "          copyMdBtn.textContent = 'Copied!';\n" +
    "          vscode.postMessage({ cmd: 'copyMarkdown' });\n" +
    "          setTimeout(function () {\n" +
    "            copyMdBtn.textContent = 'Copy in Markdown';\n" +
    "          }, 2000);\n" +
    "        });\n" +
    "      }\n" +
    "\n" +
    "      if (statusSelect) {\n" +
    "        statusSelect.addEventListener('change', function () {\n" +
    "          if (!vscode) return;\n" +
    "          statusFeedback.textContent = 'Saving...';\n" +
    "          statusSelect.disabled = true;\n" +
    "          vscode.postMessage({ cmd: 'changeStatus', customStatusId: statusSelect.value });\n" +
    "        });\n" +
    "      }\n" +
    "\n" +
    "      function closeMentionPopup() {\n" +
    "        mentionPopup.hidden = true;\n" +
    "        while (mentionPopup.firstChild) {\n" +
    "          mentionPopup.removeChild(mentionPopup.firstChild);\n" +
    "        }\n" +
    "        activeMatches = [];\n" +
    "        activeIndex = 0;\n" +
    "        mentionStartPos = -1;\n" +
    "      }\n" +
    "\n" +
    "      function selectMention(candidate) {\n" +
    "        if (!candidate || mentionStartPos < 0) return;\n" +
    "        const val = commentInput.value;\n" +
    "        const cursor = commentInput.selectionStart;\n" +
    "        const token = '@' + candidate.name;\n" +
    "        const before = val.slice(0, mentionStartPos);\n" +
    "        const after = val.slice(cursor);\n" +
    "        const spacer = after.startsWith(' ') ? '' : ' ';\n" +
    "        commentInput.value = before + token + spacer + after;\n" +
    "        const nextCursor = before.length + token.length + spacer.length;\n" +
    "        commentInput.focus();\n" +
    "        commentInput.setSelectionRange(nextCursor, nextCursor);\n" +
    "        insertedMentions.push({\n" +
    "          id: candidate.id,\n" +
    "          name: candidate.name,\n" +
    "          quasi: Boolean(candidate.quasi)\n" +
    "        });\n" +
    "        closeMentionPopup();\n" +
    "      }\n" +
    "\n" +
    "      function renderMentionPopup() {\n" +
    "        while (mentionPopup.firstChild) {\n" +
    "          mentionPopup.removeChild(mentionPopup.firstChild);\n" +
    "        }\n" +
    "        if (activeMatches.length === 0) {\n" +
    "          closeMentionPopup();\n" +
    "          return;\n" +
    "        }\n" +
    "        mentionPopup.hidden = false;\n" +
    "        activeMatches.forEach(function (item, idx) {\n" +
    "          const btn = document.createElement('button');\n" +
    "          btn.type = 'button';\n" +
    "          btn.className = 'mention-option' + (idx === activeIndex ? ' is-active' : '');\n" +
    "          btn.setAttribute('role', 'option');\n" +
    "          btn.setAttribute('aria-selected', idx === activeIndex ? 'true' : 'false');\n" +
    "          const nameSpan = document.createElement('strong');\n" +
    "          nameSpan.textContent = '@' + item.name;\n" +
    "          const metaSpan = document.createElement('span');\n" +
    "          metaSpan.className = 'mention-option-meta';\n" +
    "          metaSpan.textContent = item.email || '';\n" +
    "          btn.appendChild(nameSpan);\n" +
    "          btn.appendChild(metaSpan);\n" +
    "          btn.addEventListener('mousedown', function (e) {\n" +
    "            e.preventDefault();\n" +
    "            selectMention(item);\n" +
    "          });\n" +
    "          mentionPopup.appendChild(btn);\n" +
    "        });\n" +
    "      }\n" +
    "\n" +
    "      function checkMentionTrigger() {\n" +
    "        const val = commentInput.value;\n" +
    "        const cursor = commentInput.selectionStart;\n" +
    "        const before = val.slice(0, cursor);\n" +
    "        const match = before.match(/(?:^|\\s)@([^\\r\\n@]{0,45})$/);\n" +
    "        if (!match) {\n" +
    "          closeMentionPopup();\n" +
    "          return;\n" +
    "        }\n" +
    "        const query = match[1].toLowerCase().replace(/\\s+/g, ' ');\n" +
    "        const hasSpace = query.indexOf(' ') !== -1;\n" +
    "        mentionStartPos = before.lastIndexOf('@');\n" +
    "        activeMatches = allCandidates.filter(function (c) {\n" +
    "          const nameLower = c.name.toLowerCase();\n" +
    "          if (hasSpace) {\n" +
    "            return nameLower.indexOf(query) !== -1;\n" +
    "          }\n" +
    "          return (\n" +
    "            nameLower.indexOf(query) !== -1 ||\n" +
    "            (c.email && c.email.toLowerCase().indexOf(query) !== -1)\n" +
    "          );\n" +
    "        }).slice(0, 10);\n" +
    "        activeIndex = 0;\n" +
    "        renderMentionPopup();\n" +
    "      }\n" +
    "\n" +
    "      commentInput.addEventListener('input', checkMentionTrigger);\n" +
    "      commentInput.addEventListener('click', checkMentionTrigger);\n" +
    "      commentInput.addEventListener('keydown', function (e) {\n" +
    "        if (!mentionPopup.hidden && activeMatches.length > 0) {\n" +
    "          if (e.key === 'ArrowDown') {\n" +
    "            e.preventDefault();\n" +
    "            activeIndex = (activeIndex + 1) % activeMatches.length;\n" +
    "            renderMentionPopup();\n" +
    "            return;\n" +
    "          }\n" +
    "          if (e.key === 'ArrowUp') {\n" +
    "            e.preventDefault();\n" +
    "            activeIndex = (activeIndex - 1 + activeMatches.length) % activeMatches.length;\n" +
    "            renderMentionPopup();\n" +
    "            return;\n" +
    "          }\n" +
    "          if (e.key === 'Enter' || e.key === 'Tab') {\n" +
    "            e.preventDefault();\n" +
    "            selectMention(activeMatches[activeIndex]);\n" +
    "            return;\n" +
    "          }\n" +
    "          if (e.key === 'Escape') {\n" +
    "            e.preventDefault();\n" +
    "            closeMentionPopup();\n" +
    "            return;\n" +
    "          }\n" +
    "        }\n" +
    "        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {\n" +
    "          e.preventDefault();\n" +
    "          postBtn.click();\n" +
    "        }\n" +
    "      });\n" +
    "\n" +
    "      mentionBtn.addEventListener('click', function () {\n" +
    "        const val = commentInput.value;\n" +
    "        const cursor = commentInput.selectionStart;\n" +
    "        const prefix = cursor > 0 && !/\\s/.test(val[cursor - 1]) ? ' @' : '@';\n" +
    "        commentInput.value = val.slice(0, cursor) + prefix + val.slice(cursor);\n" +
    "        const nextPos = cursor + prefix.length;\n" +
    "        commentInput.focus();\n" +
    "        commentInput.setSelectionRange(nextPos, nextPos);\n" +
    "        checkMentionTrigger();\n" +
    "      });\n" +
    "\n" +
    "      postBtn.addEventListener('click', function () {\n" +
    "        if (!vscode) return;\n" +
    "        const text = commentInput.value.trim();\n" +
    "        if (!text) {\n" +
    "          commentFeedback.textContent = 'Enter a comment first.';\n" +
    "          return;\n" +
    "        }\n" +
    "        const lowerVal = commentInput.value.toLowerCase();\n" +
    "        for (let i = 0; i < allCandidates.length; i++) {\n" +
    "          const c = allCandidates[i];\n" +
    "          const tokenLower = ('@' + c.name).toLowerCase();\n" +
    "          if (lowerVal.indexOf(tokenLower) !== -1) {\n" +
    "            insertedMentions.push({ id: c.id, name: c.name, quasi: Boolean(c.quasi) });\n" +
    "          }\n" +
    "        }\n" +
    "        postBtn.disabled = true;\n" +
    "        commentFeedback.textContent = 'Posting comment...';\n" +
    "        vscode.postMessage({\n" +
    "          cmd: 'addComment',\n" +
    "          text: commentInput.value,\n" +
    "          mentions: insertedMentions\n" +
    "        });\n" +
    "      });\n" +
    "    })();\n" +
    "  </script>\n" +
    "</body>\n" +
    "</html>"
  );
}

async function applyTaskStatusUpdate(taskId, customStatusId, provider) {
  const auth = await getValidAuth();
  if (!auth || !auth.token) {
    throw new Error("Sign in to Wrike first.");
  }
  const updatedTasks = await wrikeWrite(
    "PUT",
    "/tasks/" + encodeURIComponent(taskId),
    { customStatus: customStatusId },
    auth
  );
  const updatedTask = updatedTasks[0];
  if (updatedTask) {
    for (let i = 0; i < cachedTasks.length; i++) {
      if (cachedTasks[i].id === taskId) {
        cachedTasks[i].customStatusId = updatedTask.customStatusId;
        cachedTasks[i].status = updatedTask.status;
        cachedTasks[i].updatedDate = updatedTask.updatedDate || cachedTasks[i].updatedDate;
        break;
      }
    }
    if (provider) {
      provider.rerenderLocal();
    }
  }
  return updatedTask;
}

async function postTaskComment(taskId, rawText, mentionsList) {
  const auth = await getValidAuth();
  if (!auth || !auth.token) {
    throw new Error("Sign in to Wrike first.");
  }
  await ensureMetadata(auth, false);
  const htmlText = buildCommentHtmlFromText(rawText, mentionsList);
  if (!htmlText) {
    throw new Error("Comment text cannot be empty.");
  }
  const created = await wrikeWrite(
    "POST",
    "/tasks/" + encodeURIComponent(taskId) + "/comments",
    { text: htmlText, plainText: "false" },
    auth
  );
  return created[0];
}

async function openTaskDetail(taskSummary, context, provider) {
  if (!taskSummary || !taskSummary.id) {
    return;
  }

  const auth = await getValidAuth().catch(() => null);
  if (!auth || !auth.token) {
    vscode.window.showWarningMessage("Sign in to Wrike first.");
    return;
  }

  activeDetailTaskId = taskSummary.id;
  activeDetailTitle = taskSummary.title || "Task";
  activeDetailMarkdown = "";
  const shortTitle =
    activeDetailTitle.length > 36
      ? activeDetailTitle.slice(0, 36) + "..."
      : activeDetailTitle;

  if (detailPanel) {
    detailPanel.title = "Wrike: " + shortTitle;
    detailPanel.reveal(detailPanel.viewColumn, false);
  } else {
    detailPanel = vscode.window.createWebviewPanel(
      "wrikeTasks.detail",
      "Wrike: " + shortTitle,
      vscode.ViewColumn.One,
      { enableScripts: true }
    );
    detailPanel.webview.onDidReceiveMessage(
      async function (msg) {
        if (!msg || !activeDetailTaskId) {
          return;
        }
        const targetTaskId = activeDetailTaskId;
        const targetTitle = activeDetailTitle || "Task";
        if (msg.cmd === "changeStatus" && msg.customStatusId) {
          try {
            await applyTaskStatusUpdate(targetTaskId, msg.customStatusId, provider);
            const st = statusesById.get(msg.customStatusId);
            vscode.window.showInformationMessage(
              "Wrike status updated to " + (st ? st.name : "new status") + "."
            );
            await openTaskDetail({ id: targetTaskId, title: targetTitle }, context, provider);
          } catch (err) {
            console.error("Failed to update Wrike status:", err);
            vscode.window.showErrorMessage("Failed to update status: " + err.message);
            await openTaskDetail({ id: targetTaskId, title: targetTitle }, context, provider);
          }
        } else if (msg.cmd === "addComment" && msg.text) {
          try {
            await postTaskComment(targetTaskId, msg.text, msg.mentions);
            vscode.window.showInformationMessage("Comment posted to Wrike.");
            await openTaskDetail({ id: targetTaskId, title: targetTitle }, context, provider);
          } catch (err) {
            console.error("Failed to post Wrike comment:", err);
            vscode.window.showErrorMessage("Failed to post comment: " + err.message);
            await openTaskDetail({ id: targetTaskId, title: targetTitle }, context, provider);
          }
        } else if (msg.cmd === "copyMarkdown") {
          try {
            if (activeDetailMarkdown && activeDetailTaskId === targetTaskId) {
              await vscode.env.clipboard.writeText(activeDetailMarkdown);
              vscode.window.showInformationMessage(
                'Copied Markdown for "' + targetTitle + '" to clipboard.'
              );
            } else {
              await copyTaskMarkdownById({ id: targetTaskId, title: targetTitle });
            }
          } catch (err) {
            console.error("Failed to copy task Markdown:", err);
            vscode.window.showErrorMessage("Failed to copy Markdown: " + err.message);
          }
        } else if (msg.cmd === "toggleStarTask") {
          const nextStarred =
            typeof msg.starred === "boolean" ? msg.starred : !isTaskStarred(targetTaskId);
          await setTaskStarred(targetTaskId, nextStarred, context, provider);
        }
      },
      null,
      context.subscriptions
    );
    detailPanel.onDidDispose(
      function () {
        detailPanel = null;
        activeDetailTaskId = null;
        activeDetailTitle = "";
        activeDetailMarkdown = "";
      },
      null,
      context.subscriptions
    );
  }

  detailPanel.webview.html =
    "<!DOCTYPE html><html><body style=\"font-family:var(--vscode-font-family);padding:24px;color:var(--vscode-editor-foreground);\">Loading task details and comments...</body></html>";

  try {
    await ensureMetadata(auth, false);
    const [fullTasks, comments] = await Promise.all([
      wrikeGet("/tasks/" + encodeURIComponent(taskSummary.id), auth),
      wrikeGet("/tasks/" + encodeURIComponent(taskSummary.id) + "/comments", auth)
    ]);

    if (activeDetailTaskId !== taskSummary.id || !detailPanel) {
      return;
    }

    const fullTask = fullTasks[0] || taskSummary;
    await ensureFoldersForTasks([fullTask], auth, false);
    if (activeDetailTaskId !== taskSummary.id || !detailPanel) {
      return;
    }
    const statusInfo = resolveStatusInfo(fullTask);
    const clientInfo = resolveClientInfo(fullTask);
    activeDetailTitle = fullTask.title || taskSummary.title || "Task";
    activeDetailMarkdown = buildTaskMarkdown(fullTask, statusInfo, comments, clientInfo);
    detailPanel.webview.html = buildTaskDetailHtml(fullTask, statusInfo, comments, clientInfo);
  } catch (err) {
    console.error("Failed to load task details:", err);
    if (detailPanel) {
      detailPanel.webview.html =
        "<!DOCTYPE html><html><body style=\"font-family:var(--vscode-font-family);padding:24px;color:var(--vscode-errorForeground);\">Failed to load task details: " +
        escapeHtml(err.message) +
        "</body></html>";
    }
  }
}

function resolveTaskArg(arg) {
  if (!arg) {
    return null;
  }
  if (arg.task) {
    return arg.task;
  }
  if (arg.id && arg.title) {
    return arg;
  }
  return null;
}

function resolveClientArg(arg) {
  if (!arg) {
    return null;
  }
  if (arg.clientInfo) {
    return arg.clientInfo;
  }
  if (arg.id && arg.title) {
    return arg;
  }
  return null;
}

async function pickTaskIfNeeded(arg, quickPickTitle) {
  const direct = resolveTaskArg(arg);
  if (direct) {
    return direct;
  }
  if (!hasLoadedOnce) {
    await loadMyTasks(false);
  }
  if (cachedTasks.length === 0) {
    vscode.window.showInformationMessage("No active tasks assigned to you.");
    return null;
  }
  const picked = await vscode.window.showQuickPick(
    cachedTasks.map(function (t) {
      return {
        label: t.title,
        description: resolveClientInfo(t).title + " \u2022 " + resolveStatusInfo(t).name,
        task: t
      };
    }),
    { title: quickPickTitle, placeHolder: "Choose a task...", matchOnDescription: true }
  );
  return picked ? picked.task : null;
}

async function setTaskStarred(taskId, shouldStar, context, provider) {
  if (!taskId) {
    return;
  }
  if (shouldStar) {
    starredTaskIds.add(taskId);
  } else {
    starredTaskIds.delete(taskId);
  }
  if (context && context.globalState) {
    await context.globalState.update(
      "wrikeTasks.starredTaskIds",
      Array.from(starredTaskIds)
    );
  }
  if (provider) {
    provider.rerenderLocal();
  } else {
    if (treeProviderInstance) {
      treeProviderInstance.rerenderLocal();
    } else if (recentProviderInstance) {
      recentProviderInstance.rerenderLocal();
    }
  }
}

async function setClientStarred(clientId, shouldStar, context, provider) {
  if (!clientId) {
    return;
  }
  if (shouldStar) {
    starredClientIds.add(clientId);
  } else {
    starredClientIds.delete(clientId);
  }
  if (context && context.globalState) {
    await context.globalState.update(
      "wrikeTasks.starredClientIds",
      Array.from(starredClientIds)
    );
  }
  if (provider) {
    provider.rerenderLocal();
  } else if (treeProviderInstance) {
    treeProviderInstance.rerenderLocal();
  }
}

function activate(context) {
  secretStorage = context.secrets;
  currentTaskSort = context.globalState.get("wrikeTasks.taskSort", "dueDate");
  currentClientSort = context.globalState.get("wrikeTasks.clientSort", "alpha");
  starredTaskIds = new Set(context.globalState.get("wrikeTasks.starredTaskIds", []));
  starredClientIds = new Set(context.globalState.get("wrikeTasks.starredClientIds", []));

  const recentProvider = new WrikeRecentTreeProvider();
  const provider = new WrikeTreeProvider();
  recentProviderInstance = recentProvider;
  treeProviderInstance = provider;

  context.subscriptions.push(
    recentProvider._emitter,
    provider._emitter,
    vscode.window.registerTreeDataProvider("wrikeTasks.recentView", recentProvider),
    vscode.window.registerTreeDataProvider("wrikeTasks.view", provider)
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("wrikeTasks.refresh", function () {
      provider.refresh(true);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("wrikeTasks.starTask", async function (arg) {
      const task = resolveTaskArg(arg);
      if (task && task.id) {
        await setTaskStarred(task.id, true, context, provider);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("wrikeTasks.unstarTask", async function (arg) {
      const task = resolveTaskArg(arg);
      if (task && task.id) {
        await setTaskStarred(task.id, false, context, provider);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("wrikeTasks.starClient", async function (arg) {
      const client = resolveClientArg(arg);
      if (client && client.id) {
        await setClientStarred(client.id, true, context, provider);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("wrikeTasks.unstarClient", async function (arg) {
      const client = resolveClientArg(arg);
      if (client && client.id) {
        await setClientStarred(client.id, false, context, provider);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("wrikeTasks.search", async function () {
      if (!hasLoadedOnce) {
        const state = await loadMyTasks(false);
        if (state.noToken) {
          vscode.window.showWarningMessage("Sign in to Wrike first.");
          return;
        }
        if (state.error) {
          vscode.window.showErrorMessage("Wrike error: " + state.error);
          return;
        }
      }

      if (cachedTasks.length === 0) {
        vscode.window.showInformationMessage("No active tasks assigned to you.");
        return;
      }

      const sorted = cachedTasks.slice().sort(compareTasks);
      const openBtn = {
        iconPath: new vscode.ThemeIcon("link-external"),
        tooltip: "Open Task in Wrike Browser"
      };
      const filterClientBtn = {
        iconPath: new vscode.ThemeIcon("filter"),
        tooltip: "Filter Sidebar to This Client"
      };

      const allItems = sorted.map(function (task) {
        const clientInfo = resolveClientInfo(task);
        const statusInfo = resolveStatusInfo(task);
        const due = task.dates && task.dates.due ? formatShortDate(task.dates.due) : "";
        const metaParts = [clientInfo.title, statusInfo.name];
        if (due) {
          metaParts.push("Due " + due);
        }
        const brief = stripBriefText(task.briefDescription);
        return {
          label: (task.importance === "High" ? "$(flame) " : "$(circle-large-outline) ") + task.title,
          description: metaParts.join(" · "),
          detail: brief || undefined,
          alwaysShow: true,
          task: task,
          clientTitle: clientInfo.title,
          buttons: [openBtn, filterClientBtn]
        };
      });

      const qp = vscode.window.createQuickPick();
      qp.title = "Search My Wrike Tasks (" + allItems.length + " assigned)";
      qp.placeholder = "Fuzzy search by task title, client/project name, status, or keyword...";
      qp.matchOnDescription = true;
      qp.matchOnDetail = true;
      qp.items = allItems;

      qp.onDidChangeValue(function (val) {
        const q = String(val || "").trim().toLowerCase();
        if (!q) {
          qp.items = allItems;
          return;
        }
        const queryTerms = tokenizeWords(q);
        if (queryTerms.length === 0) {
          qp.items = allItems;
          return;
        }
        const scored = [];
        for (const item of allItems) {
          const score = scoreTaskMatch(item.task, queryTerms);
          if (score > 0) {
            scored.push({ item: item, score: score });
          }
        }
        scored.sort(function (a, b) {
          if (b.score !== a.score) {
            return b.score - a.score;
          }
          return compareTasks(a.item.task, b.item.task);
        });
        qp.items = scored.map(function (entry) {
          return entry.item;
        });
      });

      qp.onDidTriggerItemButton(async function (event) {
        if (event.button === openBtn && event.item.task && isSafeHttpsUrl(event.item.task.permalink)) {
          await vscode.env.openExternal(vscode.Uri.parse(event.item.task.permalink));
        } else if (event.button === filterClientBtn && event.item.clientTitle) {
          activeFilterQuery = event.item.clientTitle;
          provider.rerenderLocal();
          qp.hide();
        }
      });

      qp.onDidAccept(async function () {
        const selected = qp.selectedItems[0];
        qp.hide();
        if (selected && selected.task) {
          await openTaskDetail(selected.task, context, provider);
        }
      });

      qp.onDidHide(function () {
        qp.dispose();
      });

      qp.show();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("wrikeTasks.filterTree", async function () {
      const input = await vscode.window.showInputBox({
        title: "Filter Wrike Sidebar Tasks",
        prompt: "Filter by task title, client name, status, or keyword (leave empty to clear filter)",
        value: activeFilterQuery,
        placeHolder: "e.g. Butte, QA, accessibility..."
      });
      if (input === undefined) {
        return;
      }
      activeFilterQuery = input.trim();
      provider.rerenderLocal();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("wrikeTasks.clearFilter", function () {
      activeFilterQuery = "";
      provider.rerenderLocal();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("wrikeTasks.sortTasks", async function () {
      const options = [
        {
          label: (currentTaskSort === "dueDate" ? "$(check) " : "") + "Sort Tasks: " + TASK_SORT_LABELS.dueDate,
          description: "Urgent and overdue tasks at the top of each status",
          kind: "task",
          value: "dueDate"
        },
        {
          label: (currentTaskSort === "updatedDate" ? "$(check) " : "") + "Sort Tasks: " + TASK_SORT_LABELS.updatedDate,
          description: "Most recently updated tasks first",
          kind: "task",
          value: "updatedDate"
        },
        {
          label: (currentTaskSort === "importance" ? "$(check) " : "") + "Sort Tasks: " + TASK_SORT_LABELS.importance,
          description: "High importance tasks pinned first, then by Due Date",
          kind: "task",
          value: "importance"
        },
        {
          label: (currentTaskSort === "title" ? "$(check) " : "") + "Sort Tasks: " + TASK_SORT_LABELS.title,
          description: "Alphabetical by task title",
          kind: "task",
          value: "title"
        },
        {
          label: (currentTaskSort === "createdDate" ? "$(check) " : "") + "Sort Tasks: " + TASK_SORT_LABELS.createdDate,
          description: "Newest created tasks first",
          kind: "task",
          value: "createdDate"
        },
        {
          label: (currentClientSort === "alpha" ? "$(check) " : "") + "Sort Clients: " + CLIENT_SORT_LABELS.alpha,
          description: "Alphabetical by client/project name",
          kind: "client",
          value: "alpha"
        },
        {
          label: (currentClientSort === "soonestDue" ? "$(check) " : "") + "Sort Clients: " + CLIENT_SORT_LABELS.soonestDue,
          description: "Clients with the most urgent due date at the top",
          kind: "client",
          value: "soonestDue"
        },
        {
          label: (currentClientSort === "mostTasks" ? "$(check) " : "") + "Sort Clients: " + CLIENT_SORT_LABELS.mostTasks,
          description: "Clients with the highest number of assigned tasks at the top",
          kind: "client",
          value: "mostTasks"
        }
      ];

      const picked = await vscode.window.showQuickPick(options, {
        title: "Sort Wrike Tasks & Clients",
        placeHolder:
          "Current: Tasks by " +
          (TASK_SORT_LABELS[currentTaskSort] || currentTaskSort) +
          " · Clients by " +
          (CLIENT_SORT_LABELS[currentClientSort] || currentClientSort)
      });

      if (!picked) {
        return;
      }

      if (picked.kind === "task") {
        currentTaskSort = picked.value;
        await context.globalState.update("wrikeTasks.taskSort", currentTaskSort);
      } else if (picked.kind === "client") {
        currentClientSort = picked.value;
        await context.globalState.update("wrikeTasks.clientSort", currentClientSort);
      }

      provider.rerenderLocal();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("wrikeTasks.signInOAuth", async function () {
      const existingOAuth = await getOAuthState();
      const clientId = await vscode.window.showInputBox({
        title: "Step 1/3: Wrike OAuth Client ID",
        prompt: "Enter the Client ID from your Wrike App page (make sure Redirect URI is set to https://localhost and saved)",
        value: (existingOAuth && existingOAuth.clientId) || vscode.workspace.getConfiguration("wrikeTasks").get("oauthClientId", "") || "",
        ignoreFocusOut: true
      });
      if (!clientId || !clientId.trim()) {
        return;
      }

      const clientSecret = await vscode.window.showInputBox({
        title: "Step 2/3: Wrike OAuth Secret Key",
        prompt: "Paste the Secret key from your Wrike App OAuth section",
        password: true,
        value: (existingOAuth && existingOAuth.clientSecret) || "",
        ignoreFocusOut: true
      });
      if (!clientSecret || !clientSecret.trim()) {
        return;
      }

      const cleanClientId = clientId.trim();
      const cleanSecret = clientSecret.trim();
      const authUrl =
        "https://login.wrike.com/oauth2/authorize/v4?client_id=" +
        encodeURIComponent(cleanClientId) +
        "&response_type=code&redirect_uri=" +
        encodeURIComponent(OAUTH_REDIRECT_URI);

      await vscode.env.openExternal(vscode.Uri.parse(authUrl));

      const pasted = await vscode.window.showInputBox({
        title: "Step 3/3: Paste Redirected URL or Authorization Code",
        prompt: "Click Accept in Wrike, then copy the redirected URL (https://localhost/?code=...) from your browser address bar and paste it here",
        placeHolder: "https://localhost/?code=...",
        ignoreFocusOut: true
      });
      if (!pasted || !pasted.trim()) {
        return;
      }

      let code = pasted.trim();
      const codeMatch = code.match(/[?&]code=([^&#\s]+)/i);
      if (codeMatch) {
        code = decodeURIComponent(codeMatch[1]);
      }

      try {
        const params = new URLSearchParams({
          client_id: cleanClientId,
          client_secret: cleanSecret,
          grant_type: "authorization_code",
          code: code,
          redirect_uri: OAUTH_REDIRECT_URI
        });

        const res = await fetch("https://login.wrike.com/oauth2/token", {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "application/json"
          },
          body: params.toString()
        });

        if (!res.ok) {
          const errText = await res.text().catch(() => "");
          throw new Error("HTTP " + res.status + ": " + errText.slice(0, 200));
        }

        const tokenData = await res.json();
        const resolvedHost = isValidWrikeHost(tokenData.host)
          ? tokenData.host.trim()
          : "www.wrike.com";
        const oauthPayload = {
          clientId: cleanClientId,
          clientSecret: cleanSecret,
          accessToken: tokenData.access_token,
          refreshToken: tokenData.refresh_token,
          host: resolvedHost,
          expiresAt: Date.now() + Number(tokenData.expires_in || 3600) * 1000 - 60000
        };

        await secretStorage.store(SECRET_OAUTH_KEY, JSON.stringify(oauthPayload));
        await secretStorage.store(SECRET_KEY, oauthPayload.accessToken);
        clearMemoryCaches();
        provider.refresh(true);
        vscode.window.showInformationMessage("Signed in to Wrike via OAuth.");
      } catch (err) {
        console.error("Wrike OAuth token exchange failed:", err);
        vscode.window.showErrorMessage("Wrike OAuth failed: " + err.message);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("wrikeTasks.setToken", async function () {
      const input = await vscode.window.showInputBox({
        title: "Wrike Permanent Access Token",
        prompt: "Paste your Wrike Permanent Access Token (stored in OS keychain)",
        password: true,
        ignoreFocusOut: true
      });
      if (!input || !input.trim()) {
        return;
      }
      await secretStorage.delete(SECRET_OAUTH_KEY);
      await secretStorage.store(SECRET_KEY, input.trim());
      clearMemoryCaches();
      provider.refresh(true);
      vscode.window.showInformationMessage("Wrike API token saved.");
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("wrikeTasks.clearToken", async function () {
      await secretStorage.delete(SECRET_KEY);
      await secretStorage.delete(SECRET_OAUTH_KEY);
      clearMemoryCaches();
      cachedTasks = [];
      hasLoadedOnce = false;
      activeFilterQuery = "";
      provider.refresh(false);
      vscode.window.showInformationMessage("Wrike API credentials removed.");
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("wrikeTasks.openTaskDetail", async function (arg) {
      const task = resolveTaskArg(arg);
      await openTaskDetail(task, context, provider);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("wrikeTasks.changeStatus", async function (arg) {
      const task = await pickTaskIfNeeded(arg, "Select Task to Change Status");
      if (!task) {
        return;
      }

      const auth = await getValidAuth().catch(() => null);
      if (!auth || !auth.token) {
        vscode.window.showWarningMessage("Sign in to Wrike first.");
        return;
      }
      await ensureMetadata(auth, false);

      const workflowStatuses = getWorkflowStatusesForTask(task);
      const statusItems = workflowStatuses.map(function (st) {
        const isCurrent = st.id === task.customStatusId;
        return {
          label: (isCurrent ? "$(check) " : "") + st.name,
          description: st.group + (isCurrent ? " (Current)" : ""),
          customStatusId: st.id
        };
      });

      const pickedStatus = await vscode.window.showQuickPick(statusItems, {
        title: "Change Status: " + task.title,
        placeHolder: "Current status: " + resolveStatusInfo(task).name
      });

      if (!pickedStatus || pickedStatus.customStatusId === task.customStatusId) {
        return;
      }

      try {
        await applyTaskStatusUpdate(task.id, pickedStatus.customStatusId, provider);
        const newInfo = statusesById.get(pickedStatus.customStatusId);
        vscode.window.showInformationMessage(
          "Updated \"" + task.title + "\" to " + (newInfo ? newInfo.name : pickedStatus.label) + "."
        );
      } catch (err) {
        console.error("Failed to update Wrike task status:", err);
        vscode.window.showErrorMessage("Failed to update status: " + err.message);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("wrikeTasks.addComment", async function (arg) {
      const task = await pickTaskIfNeeded(arg, "Select Task to Comment On");
      if (!task) {
        return;
      }

      const input = await vscode.window.showInputBox({
        title: "Add Comment: " + task.title,
        prompt: "Write a comment (supports @FirstName LastName, @assignees, @followers) or open the Task Detail pane for @mention autocomplete",
        placeHolder: "Type your comment..."
      });
      if (!input || !input.trim()) {
        return;
      }

      try {
        await postTaskComment(task.id, input, []);
        vscode.window.showInformationMessage("Comment posted to \"" + task.title + "\".");
      } catch (err) {
        console.error("Failed to post Wrike comment:", err);
        vscode.window.showErrorMessage("Failed to post comment: " + err.message);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("wrikeTasks.copyMarkdown", async function (arg) {
      const task = await pickTaskIfNeeded(arg, "Select Task to Copy in Markdown");
      if (!task) {
        return;
      }

      try {
        await copyTaskMarkdownById(task);
      } catch (err) {
        console.error("Failed to copy Wrike task as Markdown:", err);
        vscode.window.showErrorMessage("Failed to copy Markdown: " + err.message);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("wrikeTasks.openInBrowser", async function (arg) {
      const task = resolveTaskArg(arg);
      if (task && isSafeHttpsUrl(task.permalink)) {
        await vscode.env.openExternal(vscode.Uri.parse(task.permalink));
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("wrikeTasks.copyLink", async function (arg) {
      const task = resolveTaskArg(arg);
      if (task && isSafeHttpsUrl(task.permalink)) {
        await vscode.env.clipboard.writeText(task.permalink);
        vscode.window.showInformationMessage("Copied Wrike permalink to clipboard.");
      }
    })
  );
}

function deactivate() {
  if (detailPanel) {
    detailPanel.dispose();
    detailPanel = null;
  }
}

module.exports = {
  activate,
  deactivate,
  buildTaskDetailHtml,
  buildCommentHtmlFromText,
  getWorkflowStatusesForTask,
  sanitizeWrikeHtml,
  wrikeHtmlToMarkdown,
  buildTaskMarkdown,
  getRecentAndStarredTasks,
  isTaskStarred,
  isClientStarred
};
