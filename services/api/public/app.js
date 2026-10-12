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
function activityLog({ jobId = null, showJob = true, tall = false } = {}) {
  const body = el("tbody");
  const node = el("div", { className: `panel table-wrap scroll-log` }, el("table", { className: "log" }, body));
  if (tall) node.style.maxHeight = "70vh";
  let filter = jobId;
  let lastId = null;

  return {
    node,
    setJob(id) { filter = id; lastId = null; body.replaceChildren(); },
    async refresh() {
      const params = new URLSearchParams();
      if (lastId !== null) params.set("after", lastId);
      if (filter) params.set("job", filter);
      const query = params.toString();
      const events = await api(query ? `/events?${query}` : "/events");
      for (const event of events) {
        body.prepend(el("tr", {},
          el("td", { className: "time num", textContent: new Date(event.created_at).toLocaleTimeString() }),
          showJob && el("td", { className: "job" },
            event.job_id ? el("a", { className: "mono", href: `#/jobs/${event.job_id}`, textContent: shortId(event.job_id) }) : ""),
          el("td", { className: "message", textContent: event.message })));
        lastId = event.id;
      }
      while (body.rows.length > 300) body.deleteRow(-1);
    },
  };
}

function sectionTitle(text, linkText, href) {
  return el("div", { className: "section-title" }, text, linkText && el("a", { href, textContent: linkText }));
}

// ---- pages -----------------------------------------------------------------------------------

function overviewPage() {
  const form = newJobForm();
  const stats = el("div", { className: "panel stats" });
  const jobs = jobsTable();
  const log = activityLog();

  const stat = (label, value) =>
    el("div", { className: "stat" }, el("div", { className: "label", textContent: label }), el("div", { className: "value", textContent: value }));

  return {
    mount(root) {
      root.append(
        pageHead("Overview", newJobButton(form)),
        form.node,
        stats,
        sectionTitle("Recent jobs", "View all", "#/jobs"), jobs.node,
        sectionTitle("Activity", "View all", "#/activity"), log.node);
    },
    async refresh() {
      const [s, recent] = await Promise.all([api("/stats"), api("/jobs")]);
      stats.replaceChildren(
        stat("Jobs running", s.jobs.running + s.jobs.waiting),
        stat("Tasks queued", s.tasks.queued),
        stat("Workers busy", `${s.workers.busy} / ${s.workers.desired}`),
        stat("Jobs completed", s.jobs.completed));
      jobs.render(recent.slice(0, 6));
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

function jobPage(jobId) {
  const header = el("div");
  const body = el("div");
  const log = activityLog({ jobId, showJob: false });
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
      root.append(header, body, previewPanel, sectionTitle("Activity"), log.node);
    },
    async refresh() {
      let job;
      try {
        job = await api(`/jobs/${jobId}`);
      } catch {
        header.replaceChildren(el("a", { className: "back", href: "#/jobs", textContent: "← Jobs" }), pageHead("Job not found"));
        body.replaceChildren();
        return;
      }
      drawHeader(job);
      drawBody(job);
      if (job.status === "COMPLETED" && !previewLoaded) await loadPreview();
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
