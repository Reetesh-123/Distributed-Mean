// Web UI for the Distributed Mean API. No build step, no libraries.
// Pages are chosen by the URL hash. Each page has mount(root) to build its HTML once,
// and refresh() to load fresh data every second.

// ---- helpers ---------------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);

/** Create an element. Text always goes through textContent, so server data cannot inject HTML. */
function el(tag, props = {}, ...children) {
  const element = Object.assign(document.createElement(tag), props);
  element.append(...children.filter((child) => child != null && child !== false));
  return element;
}

async function api(path, options) {
  const response = await fetch(path, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `${response.status} ${JSON.stringify(body)}`);
  return body;
}

const sendJson = (method, path, data) =>
  api(path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });

function toast(message, ok = true) {
  const node = el("div", { className: `toast${ok ? "" : " err"}`, textContent: message });
  $("toasts").append(node);
  setTimeout(() => node.remove(), 3500);
}

// ---- formatting ------------------------------------------------------------------------------

const shortId = (id) => id.slice(0, 8);
const formatNumber = (n) => Number(n).toLocaleString();
const sentenceCase = (text) => text.charAt(0) + text.slice(1).toLowerCase();

function formatDuration(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

function timeAgo(iso) {
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}

function jobDuration(job) {
  const start = new Date(job.started_at || job.created_at).getTime();
  const end = job.finished_at ? new Date(job.finished_at).getTime() : Date.now();
  return formatDuration(end - start);
}

const isActive = (job) => job.status === "PENDING" || job.status === "RUNNING";

// ---- small components ------------------------------------------------------------------------

const status = (name) => el("span", { className: `status ${name}`, textContent: sentenceCase(name) });

function progressBar(percent, wide = false) {
  const done = percent >= 100 ? " done" : "";
  return el("span", { className: `bar${wide ? " wide" : ""}${done}` }, el("span", { style: `width:${percent}%` }));
}

function pageHead(title, ...rightSide) {
  return el("div", { className: "page-head" }, el("h1", { textContent: title }), el("div", { className: "right" }, ...rightSide));
}

function emptyRow(columns, text) {
  return el("tr", {}, el("td", { colSpan: columns, className: "empty", textContent: text }));
}

function table(headings, tbody) {
  const head = el("tr", {}, ...headings.map((text) => el("th", { textContent: text })));
  return el("div", { className: "panel table-wrap" }, el("table", {}, el("thead", {}, head), tbody));
}

async function cancelJob(jobId) {
  if (!confirm(`Cancel job ${shortId(jobId)}?`)) return false;
  try {
    await api(`/jobs/${jobId}`, { method: "DELETE" });
    toast("Job cancelled");
    return true;
  } catch (error) {
    toast(error.message, false);
    return false;
  }
}

/** The "New job" form. It stays hidden until toggle() is called. */
function newJobForm() {
  const files = el("input", { id: "files", type: "number", value: 50, min: 2, max: 99999 });
  const numbers = el("input", { id: "numbers", type: "number", value: 10000, min: 2, max: 999999 });
  const create = el("button", { type: "submit", className: "primary", textContent: "Create job" });
  const form = el("form", { className: "form-row" },
    el("div", {}, el("label", { htmlFor: "files", textContent: "Files" }), files),
    el("div", {}, el("label", { htmlFor: "numbers", textContent: "Numbers per file" }), numbers),
    create);
  const node = el("div", { className: "panel pad", hidden: true, style: "margin-bottom:20px" }, form);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    create.disabled = true;
    try {
      const { jobId } = await sendJson("POST", "/jobs", { F: Number(files.value), C: Number(numbers.value) });
      toast("Job created");
      location.hash = `#/jobs/${jobId}`;
    } catch (error) {
      toast(error.message, false);
    } finally {
      create.disabled = false;
    }
  });

  return { node, toggle: () => { node.hidden = !node.hidden; } };
}

function newJobButton(form) {
  return el("button", { className: "primary", textContent: "New job", onclick: form.toggle });
}

/** Table of jobs. Call render(jobs) with fresh data. */
function jobsTable() {
  const body = el("tbody");
  return {
    node: table(["Job", "Size", "Status", "Progress", "Duration", "Created"], body),
    render(jobs, emptyText = "No jobs yet") {
      if (!jobs.length) return body.replaceChildren(emptyRow(6, emptyText));
      body.replaceChildren(...jobs.map((job) => {
        const percent = Math.round(Number(job.progress));
        return el("tr", {},
          el("td", {}, el("a", { className: "mono", href: `#/jobs/${job.id}`, textContent: shortId(job.id) })),
          el("td", { className: "num", textContent: `${formatNumber(job.f)} × ${formatNumber(job.c)}` }),
          el("td", {}, status(job.status)),
          el("td", { className: "num" }, progressBar(percent), `${percent}%`),
          el("td", { className: "num", textContent: jobDuration(job) }),
          el("td", { className: "muted", title: new Date(job.created_at).toLocaleString(), textContent: timeAgo(job.created_at) }));
      }));
    },
  };
}

/** Activity log. Each refresh() fetches only the lines it has not seen yet. */
function activityLog({ jobId = null, showJob = true, tall = false, accept = () => true } = {}) {
  const body = el("tbody");
  const emptyNote = el("div", { className: "empty", textContent: "No activity yet" });
  const node = el("div", { className: `panel table-wrap scroll-log` }, el("table", { className: "log" }, body), emptyNote);
  if (tall) node.style.maxHeight = "70vh";
  let filter = jobId;
  let lastId = null;

  return {
    node,
    setJob(id) { filter = id; lastId = null; body.replaceChildren(); emptyNote.hidden = false; },
    /** Skip every line up to and including this event id (used to start the overview empty). */
    startAfter(id) { if (lastId === null) lastId = id; },
    async refresh() {
      const params = new URLSearchParams();
      if (lastId !== null) params.set("after", lastId);
      if (filter) params.set("job", filter);
      const query = params.toString();
      const events = await api(query ? `/events?${query}` : "/events");
      for (const event of events) {
        lastId = event.id;
        if (!accept(event)) continue;
        body.prepend(el("tr", {},
          el("td", { className: "time num", textContent: new Date(event.created_at).toLocaleTimeString() }),
          showJob && el("td", { className: "job" },
            event.job_id ? el("a", { className: "mono", href: `#/jobs/${event.job_id}`, textContent: shortId(event.job_id) }) : ""),
          el("td", { className: "message", textContent: event.message })));
      }
      while (body.rows.length > 300) body.deleteRow(-1);
      emptyNote.hidden = body.rows.length > 0;
    },
  };
}

function sectionTitle(text, linkText, href) {
  return el("div", { className: "section-title" }, text, linkText && el("a", { href, textContent: linkText }));
}

/** Natural order: workers-2 before workers-10. */
const workerNumber = (worker) => Number(worker.id.match(/(\d+)$/)?.[1] ?? 0);
const plural = (n, word) => `${formatNumber(n)} ${word}${Number(n) === 1 ? "" : "s"}`;

/** What a busy worker is doing, as two short lines: [what, details]. */
function describeTask(worker) {
  const files = worker.task_files;
  if (worker.task_type === "GENERATE") {
    const range = worker.task_first_file === worker.task_last_file
      ? `File ${worker.task_first_file}`
      : `Files ${worker.task_first_file}–${worker.task_last_file}`;
    return [`Generating ${plural(worker.task_size, "file")}`, range];
  }
  if (worker.task_is_final) return [`Final step: ${plural(worker.task_size, "item")}`, `Covers ${plural(files, "file")}, then divides`];
  return [`Combining ${plural(worker.task_size, "item")}`, `Covers ${plural(files, "file")}`];
}

/** One tile per worker: its state and, when busy, which job and which files it is working on. */
function workerTiles() {
  const node = el("div", { className: "tiles" });
  return {
    node,
    render(workers) {
      // The grid adapts to the fleet: a few workers get big tiles that fill the row, many get compact ones.
      node.dataset.size = workers.length <= 8 ? "roomy" : workers.length <= 16 ? "compact" : "dense";
      if (!workers.length) return node.replaceChildren(el("div", { className: "panel empty", textContent: "No workers running" }));
      node.replaceChildren(...[...workers].sort((a, b) => workerNumber(a) - workerNumber(b)).map((worker) => {
        const busy = worker.status === "BUSY" && worker.current_task_id && worker.task_type;
        const lines = busy ? describeTask(worker) : [{
          IDLE: "Waiting for a task", DRAINING: "Finishing, then stopping", DEAD: "No heartbeat", BUSY: "Working",
        }[worker.status] || sentenceCase(worker.status)];
        return el("div", { className: `panel tile ${worker.status}` },
          el("div", { className: "tile-head" }, el("span", { className: "mono name", textContent: worker.id }), status(worker.status)),
          el("div", { className: "what", textContent: lines[0] }),
          lines[1] && el("div", { className: "sub", textContent: lines[1] }),
          busy && el("div", { className: "sub" },
            "Job ", el("a", { className: "mono", href: `#/jobs/${worker.task_job_id}`, textContent: shortId(worker.task_job_id) }),
            ` · ${formatDuration(Date.now() - new Date(worker.current_task_started_at))}`),
          el("div", { className: "foot" }, `${plural(worker.tasks_done, "task")} done · speed ${worker.slowdown}×`));
      }));
    },
  };
}

// ---- pages -----------------------------------------------------------------------------------

/**
 * The overview always starts empty. When the page loads, remember the newest job and log line that
 * already exist; the overview then shows only what happens after that. The memory lasts until the page
 * is reloaded or closed, so moving between pages keeps your running job, and a reload starts empty again.
 * The Jobs and Activity pages still show the full history.
 */
let overviewBaseline = null;
async function loadOverviewBaseline() {
  if (overviewBaseline) return overviewBaseline;
  const [jobs, events] = await Promise.all([api("/jobs"), api("/events")]);
  overviewBaseline = {
    jobCreatedAt: jobs.length ? jobs[0].created_at : null, // /jobs is newest first
    eventId: events.length ? events[events.length - 1].id : 0,
  };
  return overviewBaseline;
}

function overviewPage() {
  const form = newJobForm();
  const stats = el("div", { className: "panel stats" });
  const workers = workerTiles();
  const jobs = jobsTable();
  let visibleJobIds = new Set();
  // Lines of jobs the overview hides (created before this tab opened) stay hidden too.
  const log = activityLog({ accept: (event) => !event.job_id || visibleJobIds.has(event.job_id) });

  const stat = (label, value) =>
    el("div", { className: "stat" }, el("div", { className: "label", textContent: label }), el("div", { className: "value", textContent: value }));

  return {
    mount(root) {
      root.append(
        pageHead("Overview", newJobButton(form)),
        form.node,
        stats,
        sectionTitle("Workers", "Details", "#/workers"), workers.node,
        sectionTitle("Recent jobs", "View all", "#/jobs"), jobs.node,
        sectionTitle("Activity", "View all", "#/activity"), log.node);
    },
    async refresh() {
      const baseline = await loadOverviewBaseline();
      log.startAfter(baseline.eventId);
      const [s, allJobs, workerList] = await Promise.all([api("/stats"), api("/jobs"), api("/workers")]);
      const since = baseline.jobCreatedAt ? new Date(baseline.jobCreatedAt).getTime() : -Infinity;
      const shown = allJobs.filter((job) => new Date(job.created_at).getTime() > since);
      visibleJobIds = new Set(shown.map((job) => job.id));
      stats.replaceChildren(
        stat("Jobs running", shown.filter(isActive).length),
        stat("Tasks queued", s.tasks.queued),
        stat("Workers busy", `${s.workers.busy} / ${s.workers.desired}`),
        stat("Jobs completed", shown.filter((job) => job.status === "COMPLETED").length));
      workers.render(workerList);
      jobs.render(shown.slice(0, 6), "No jobs yet. Click New job to start one.");
      await log.refresh();
    },
  };
}

function jobsPage() {
  const form = newJobForm();
  const jobs = jobsTable();
  const search = el("input", { type: "search", placeholder: "Search by id", oninput: () => draw() });
  const statusFilter = el("select", { onchange: () => draw() },
    ...["ALL", "PENDING", "RUNNING", "COMPLETED", "FAILED", "CANCELLED"].map((value) =>
      el("option", { value, textContent: value === "ALL" ? "All statuses" : sentenceCase(value) })));
  let allJobs = [];

  function draw() {
    const text = search.value.trim().toLowerCase();
    const shown = allJobs.filter((job) =>
      (statusFilter.value === "ALL" || job.status === statusFilter.value) && job.id.startsWith(text));
    jobs.render(shown, allJobs.length ? "No jobs match" : "No jobs yet");
  }

  return {
    mount(root) {
      root.append(pageHead("Jobs", newJobButton(form)), form.node,
        el("div", { className: "toolbar" }, search, statusFilter), jobs.node);
    },
    async refresh() {
      allJobs = await api("/jobs");
      draw();
    },
  };
}

/**
 * Raw data of one job. The workers store numbers as .npy (binary), which a text editor cannot open,
 * so this shows the first values of a few raw files next to the mean recomputed from all raw files
 * and the mean the system produced, and lets you download any raw file as CSV.
 */
function rawDataPanel(jobId) {
  const body = el("div", { className: "pad" });
  const node = el("details", { className: "panel", hidden: true, open: true, style: "margin-top:20px" },
    el("summary", { textContent: "Raw data and check" }), body);
  let loaded = null; // "partial" once files exist, "done" after the job completed

  const fmt = (value) => (value === null ? "–" : value.toFixed(6));
  const sameAsResult = (rows) => rows.every((row) => row.recomputed === null || row.result === null || Math.abs(row.recomputed - row.result) < 1e-9);

  function downloadRow(fileCount) {
    const input = el("input", { type: "number", min: 0, max: fileCount - 1, value: 0, "aria-label": "Raw file number" });
    const link = el("a", { className: "button", textContent: "Download CSV", download: "" });
    const update = () => { link.href = `/jobs/${jobId}/raw/${Number(input.value) || 0}`; };
    input.addEventListener("input", update);
    update();
    return el("div", { className: "form-row", style: "margin-top:14px" },
      el("div", {}, el("label", { textContent: `Raw file number (0 to ${fileCount - 1})` }), input), link);
  }

  function draw(job, preview) {
    const head = el("tr", {}, ...["Position", ...preview.files.map((index) => `File ${index}`), "Mean of all files", "System result"]
      .map((text) => el("th", { textContent: text })));
    const rows = preview.rows.map((row) => el("tr", {},
      el("td", { className: "num", textContent: row.position }),
      ...row.values.map((value) => el("td", { className: "num", textContent: fmt(value) })),
      el("td", { className: "num", textContent: fmt(row.recomputed) }),
      el("td", { className: "num", textContent: fmt(row.result) })));
    const checkable = preview.rows.some((row) => row.recomputed !== null && row.result !== null);
    body.replaceChildren(
      el("p", { className: "muted", style: "margin:0 0 10px", textContent:
        `First ${preview.rows.length} positions of the first ${preview.files.length} raw files. ` +
        "Each position is a row; the mean is taken across all files in that row." }),
      el("div", { className: "table-wrap" }, el("table", {}, el("thead", {}, head), el("tbody", {}, ...rows))),
      checkable && el("p", { className: sameAsResult(preview.rows) ? "ok-note" : "banner", style: "margin:10px 0 0", textContent:
        sameAsResult(preview.rows) ? "The mean recomputed from all raw files matches the system result." : "The recomputed mean differs from the system result." }),
      downloadRow(job.f));
  }

  return {
    node,
    async load(job) {
      const state = job.status === "COMPLETED" ? "done" : "partial";
      if (job.files_generated === 0 || loaded === state) return;
      loaded = state;
      node.hidden = false;
      try {
        draw(job, await api(`/jobs/${jobId}/raw-preview`));
      } catch (error) {
        loaded = null;
        body.replaceChildren(el("p", { className: "muted", textContent: error.message }));
      }
    },
  };
}

function jobPage(jobId) {
  const header = el("div");
  const body = el("div");
  const log = activityLog({ jobId, showJob: false });
  const workers = workerTiles();
  const raw = rawDataPanel(jobId);
  const preview = el("pre");
  const previewPanel = el("details", { className: "panel", hidden: true, style: "margin-top:20px" },
    el("summary", { textContent: "Result preview" }), preview);
  let previewLoaded = false;

  async function loadPreview() {
    previewLoaded = true;
    previewPanel.hidden = false;
    try {
      const response = await fetch(`/jobs/${jobId}/result`, { headers: { Range: "bytes=0-1999" } });
      const lines = (await response.text()).split("\n");
      lines.pop(); // the last line may be cut off by the byte range
      preview.textContent = lines.join("\n");
    } catch (error) {
      preview.textContent = error.message;
    }
  }

  function drawHeader(job) {
    const actions = [];
    if (isActive(job)) {
      actions.push(el("button", { className: "danger", textContent: "Cancel", onclick: async () => { if (await cancelJob(job.id)) poll(); } }));
    }
    if (job.status === "COMPLETED") {
      actions.push(el("a", { className: "button primary", href: `/jobs/${job.id}/result`, textContent: "Download CSV" }));
    }
    actions.push(el("button", { textContent: "Copy id", onclick: () => navigator.clipboard?.writeText(job.id).then(() => toast("Copied")) }));
    header.replaceChildren(
      el("a", { className: "back", href: "#/jobs", textContent: "← Jobs" }),
      pageHead(`Job ${shortId(job.id)}`, ...actions));
    header.querySelector("h1").after(status(job.status));
  }

  function tasksPanel(tasks) {
    const counts = ["DONE", "QUEUED", "PENDING", "FAILED"].map((name) => [name, tasks[name] || 0]);
    const total = counts.reduce((sum, [, n]) => sum + n, 0) || 1;
    return el("div", { className: "panel pad" },
      el("div", { className: "segments" },
        ...counts.map(([name, n]) => el("span", { className: `seg-${name}`, style: `width:${(100 * n) / total}%` }))),
      el("div", { className: "legend" },
        ...counts.map(([name, n]) => el("span", {}, el("b", { textContent: formatNumber(n) }), ` ${name.toLowerCase()}`))));
  }

  function drawBody(job) {
    const percent = Math.round(Number(job.progress));
    const meta = (label, value) => el("div", {}, el("dt", { textContent: label }), el("dd", { className: "num", textContent: value }));
    body.replaceChildren(
      ...(job.error ? [el("div", { className: "banner", textContent: job.error })] : []),
      el("dl", { className: "panel meta", style: "margin:0" },
        meta("Files", formatNumber(job.f)),
        meta("Numbers per file", formatNumber(job.c)),
        meta("Created", timeAgo(job.created_at)),
        meta("Duration", jobDuration(job)),
        meta("Generated", `${formatNumber(job.files_generated)} / ${formatNumber(job.f)}`)),
      sectionTitle("Progress"),
      el("div", { className: "panel pad progress-row" }, progressBar(percent, true), el("span", { className: "pct num", textContent: `${percent}%` })),
      sectionTitle("Tasks"),
      tasksPanel(job.tasks || {}));
  }

  return {
    mount(root) {
      root.append(header, body, sectionTitle("Workers", "Details", "#/workers"), workers.node, previewPanel, raw.node, sectionTitle("Activity"), log.node);
    },
    async refresh() {
      let job;
      try {
        job = await api(`/jobs/${jobId}`);
        workers.render(await api("/workers"));
      } catch {
        header.replaceChildren(el("a", { className: "back", href: "#/jobs", textContent: "← Jobs" }), pageHead("Job not found"));
        body.replaceChildren();
        return;
      }
      drawHeader(job);
      drawBody(job);
      if (job.status === "COMPLETED" && !previewLoaded) await loadPreview();
      await raw.load(job);
      await log.refresh();
    },
  };
}

function workersPage() {
  const body = el("tbody");
  const count = el("input", { type: "number", min: 0, max: 32, style: "width:80px", "aria-label": "Number of workers" });
  const apply = el("button", { textContent: "Apply" });
  let edited = false;
  count.addEventListener("input", () => { edited = true; });

  apply.addEventListener("click", async () => {
    try {
      const { desired } = await sendJson("PUT", "/workers", { count: Number(count.value) });
      edited = false;
      toast(`Workers set to ${desired}`);
      poll();
    } catch (error) {
      toast(error.message, false);
    }
  });

  function drawWorkers(workers) {
    if (!workers.length) return body.replaceChildren(emptyRow(6, "No workers running"));
    body.replaceChildren(...workers.map((worker) => el("tr", {},
      el("td", { className: "mono", textContent: worker.id }),
      el("td", {}, status(worker.status)),
      el("td", { className: "num", textContent: `${worker.slowdown}×` }),
      el("td", { className: "num", textContent: formatNumber(worker.tasks_done) }),
      el("td", { className: "mono", textContent: worker.current_task_id
        ? `${shortId(worker.current_task_id)} · ${formatDuration(Date.now() - new Date(worker.current_task_started_at))}` : "–" }),
      el("td", { className: "muted", textContent: timeAgo(worker.last_seen) }))));
  }

  return {
    mount(root) {
      root.append(
        pageHead("Workers", el("span", { className: "muted", textContent: "Count" }), count, apply),
        table(["Worker", "Status", "Speed", "Tasks done", "Current task", "Last seen"], body));
    },
    async refresh() {
      const [stats, workers] = await Promise.all([api("/stats"), api("/workers")]);
      if (!edited && document.activeElement !== count) count.value = stats.workers.desired;
      drawWorkers(workers);
    },
  };
}

function activityPage() {
  const log = activityLog({ tall: true });
  const jobSelect = el("select", { onchange: () => log.setJob(jobSelect.value || null) }, el("option", { value: "", textContent: "All jobs" }));

  return {
    mount(root) {
      root.append(pageHead("Activity", jobSelect), log.node);
    },
    async refresh() {
      const known = new Set([...jobSelect.options].map((option) => option.value));
      for (const job of await api("/jobs")) {
        if (!known.has(job.id)) jobSelect.append(el("option", { value: job.id, textContent: `${shortId(job.id)} · ${formatNumber(job.f)} × ${formatNumber(job.c)}` }));
      }
      await log.refresh();
    },
  };
}

// ---- router and refresh loop -----------------------------------------------------------------

function resolveRoute() {
  const path = location.hash.replace(/^#/, "") || "/";
  const jobMatch = path.match(/^\/jobs\/([0-9a-fA-F-]{36})$/);
  if (jobMatch) return { name: "jobs", page: jobPage(jobMatch[1]) };
  if (path === "/jobs") return { name: "jobs", page: jobsPage() };
  if (path === "/workers") return { name: "workers", page: workersPage() };
  if (path === "/activity") return { name: "activity", page: activityPage() };
  return { name: "overview", page: overviewPage() };
}

let current = null;
let refreshing = false;

async function poll() {
  if (!current || refreshing) return;
  refreshing = true;
  const route = current;
  try {
    await route.page.refresh();
    $("live").classList.remove("offline");
    $("live").lastChild.textContent = "Live";
  } catch (error) {
    $("live").classList.add("offline");
    $("live").lastChild.textContent = "Offline";
  } finally {
    refreshing = false;
  }
}

function navigate() {
  current = resolveRoute();
  document.querySelectorAll("#nav a").forEach((link) => link.classList.toggle("active", link.dataset.route === current.name));
  $("page").replaceChildren();
  current.page.mount($("page"));
  window.scrollTo(0, 0);
  poll();
}

window.addEventListener("hashchange", navigate);
navigate();
setInterval(poll, 1000);
