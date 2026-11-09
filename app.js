(function () {
  const STORAGE_KEY = "pain-medicine-log.v1";
  const OWNED_SESSION_KEY = "pain-medicine-log.owned-session";
  const LAST_SESSION_KEY = "pain-medicine-log.last-session";
  const SESSION_CODE = /^[0-9abcdefghjkmnpqrstvwxyz]{16}$/;
  const PAIN = [
    { id: "mild", label: "Mild" },
    { id: "moderate", label: "Moderate" },
    { id: "severe", label: "Severe" }
  ];

  const app = document.querySelector("#app");
  const toastEl = document.querySelector("#toast");
  const backupInput = document.querySelector("#backup-file");

  let state = PainLog.emptyState();
  let persistBlocked = false;
  let rawBackup = null;
  let toastTimer = 0;
  const RANGES = [
    { id: "today", label: "Today" },
    { id: "yesterday", label: "Yesterday" },
    { id: "7", label: "7 days" },
    { id: "30", label: "30 days" },
    { id: "all", label: "All" },
    { id: "custom", label: "Custom" }
  ];

  const TABS = [
    { id: "medicines", label: "Medicines" },
    { id: "log", label: "Log" }
  ];

  const ui = {
    range: "today",
    rangeFrom: "",
    rangeTo: "",
    tab: "medicines",
    dialog: null
  };

  function uid() {
    if (globalThis.crypto && crypto.randomUUID) return crypto.randomUUID();
    return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  function esc(value) {
    return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    }[ch]));
  }

  function formatTime(value) {
    const date = value instanceof Date ? value : new Date(value);
    return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(date);
  }

  function formatWhen(targetMs, fromMs) {
    const date = new Date(targetMs);
    const time = formatTime(date);
    if (PainLog.localDateKey(date) === PainLog.localDateKey(new Date(fromMs))) return time;
    const day = new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(date);
    return `${day} ${time}`;
  }

  function formatDay(key) {
    const date = PainLog.dateFromKey(key);
    return new Intl.DateTimeFormat(undefined, {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric"
    }).format(date);
  }

  function relPhrase(targetMs, nowMs) {
    const mins = Math.round((targetMs - nowMs) / 60000);
    if (mins <= 0) return "ready now";
    const hours = Math.floor(mins / 60);
    const minutes = mins % 60;
    if (hours <= 0) return `in ${minutes} min`;
    if (minutes === 0) return `in ${hours} h`;
    return `in ${hours} h ${minutes} min`;
  }

  function faceSvg(level) {
    const mouth = {
      mild: "M15 29c2.4 4.2 15.6 4.2 18 0",
      moderate: "M16 30h16",
      severe: "M15 33c2.4-4.2 15.6-4.2 18 0"
    }[level];
    return `<svg viewBox="0 0 48 48" aria-hidden="true"><circle cx="24" cy="24" r="18" fill="none" stroke="currentColor" stroke-width="2.2"/><circle cx="17.5" cy="20" r="2" fill="currentColor"/><circle cx="30.5" cy="20" r="2" fill="currentColor"/><path d="${mouth}" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>`;
  }

  function toast(message) {
    toastEl.textContent = message;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastEl.textContent = "";
    }, 3500);
  }

  function sessionFromLocation() {
    const params = new URLSearchParams(location.search);
    const id = String(params.get("session") || "").toLowerCase().replace(/[^0-9a-z]/g, "");
    return SESSION_CODE.test(id) ? id : "";
  }

  const sessionId = sessionFromLocation();
  let sessionPushTimer = 0;
  let sessionPushing = 0;
  let localRevision = 0;
  let polling = false;
  let pollMissingNoted = false;

  function readSessionKey(key) {
    try {
      const id = String(localStorage.getItem(key) || "").toLowerCase();
      return SESSION_CODE.test(id) ? id : "";
    } catch (err) {
      return "";
    }
  }

  function writeSessionKey(key, id) {
    try {
      localStorage.setItem(key, id);
    } catch (err) {
      /* the link still works for this visit */
    }
  }

  function forgetSession(id) {
    try {
      if (localStorage.getItem(OWNED_SESSION_KEY) === id) localStorage.removeItem(OWNED_SESSION_KEY);
      if (localStorage.getItem(LAST_SESSION_KEY) === id) localStorage.removeItem(LAST_SESSION_KEY);
    } catch (err) {
      /* the unwanted code simply stays unused */
    }
  }

  function preferredSession() {
    return readSessionKey(OWNED_SESSION_KEY) || readSessionKey(LAST_SESSION_KEY);
  }

  function saveLocal() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(PainLog.serialize(state)));
  }

  function queueSessionPush() {
    if (!sessionId) return;
    localRevision += 1;
    clearTimeout(sessionPushTimer);
    sessionPushTimer = setTimeout(() => {
      sessionPushTimer = 0;
      const payload = JSON.stringify(PainLog.serialize(state));
      sessionPushing += 1;
      fetch(`/api/sessions/${sessionId}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: payload
      }).then((response) => {
        if (!response.ok) toast("Saved on this device. The shared log did not update.");
      }).catch(() => {
        toast("Saved on this device. The shared log did not update.");
      }).finally(() => {
        sessionPushing -= 1;
      });
    }, 250);
  }

  function persist() {
    if (persistBlocked) return false;
    try {
      saveLocal();
    } catch (err) {
      toast("Could not save on this device. Download a backup before you leave this page.");
      return false;
    }
    queueSessionPush();
    return true;
  }

  function rememberRemote(next) {
    state = next;
    persistBlocked = false;
    writeSessionKey(LAST_SESSION_KEY, sessionId);
    try { saveLocal(); } catch (err) { /* the shared copy is still on screen */ }
  }

  async function loadSharedSession() {
    const response = await fetch(`/api/sessions/${sessionId}`, {
      headers: { accept: "application/json" },
      cache: "no-store"
    });
    if (response.status === 404) {
      forgetSession(sessionId);
      toast("No log exists for that code.");
      return;
    }
    if (!response.ok) throw new Error("load failed");
    const body = await response.json();
    const result = PainLog.normalize(body);
    if (!result.recognized) throw new Error("unrecognized");
    rememberRemote(result.state);
  }

  function pollWouldClobber() {
    if (ui.dialog) return true;
    const el = document.activeElement;
    if (!el || el === document.body) return false;
    return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT";
  }

  async function pollSharedSession() {
    if (!sessionId || polling || sessionPushTimer || sessionPushing || document.hidden) return;
    if (pollWouldClobber()) return;
    const revision = localRevision;
    polling = true;
    try {
      const response = await fetch(`/api/sessions/${sessionId}`, {
        headers: { accept: "application/json" },
        cache: "no-store"
      });
      if (revision !== localRevision || sessionPushTimer || sessionPushing || pollWouldClobber()) return;
      if (response.status === 404) {
        if (!pollMissingNoted) {
          pollMissingNoted = true;
          forgetSession(sessionId);
          toast("No log exists for that code.");
        }
        return;
      }
      if (!response.ok) return;
      const result = PainLog.normalize(await response.json());
      if (!result.recognized) return;
      const current = JSON.stringify(PainLog.serialize(state));
      const incoming = JSON.stringify(PainLog.serialize(result.state));
      if (current === incoming) return;
      rememberRemote(result.state);
      render();
    } catch (err) {
      /* the next poll tries again */
    } finally {
      polling = false;
    }
  }

  let sessionPromise = null;

  function ensureSession() {
    if (sessionId) return Promise.resolve(sessionId);
    if (!sessionPromise) {
      sessionPromise = (async () => {
        let id = "";
        let sent = "";
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const payload = JSON.stringify(PainLog.serialize(state));
          if (id && payload === sent) break;
          if (!id) {
            const response = await fetch("/api/sessions", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: payload
            });
            if (!response.ok) throw new Error("create failed");
            const body = await response.json();
            if (!SESSION_CODE.test(body.id)) throw new Error("bad id");
            id = body.id;
          } else {
            const response = await fetch(`/api/sessions/${id}`, {
              method: "PUT",
              headers: { "content-type": "application/json" },
              body: payload
            });
            if (!response.ok) throw new Error("save failed");
          }
          sent = payload;
        }
        writeSessionKey(OWNED_SESSION_KEY, id);
        writeSessionKey(LAST_SESSION_KEY, id);
        return id;
      })().catch((err) => {
        sessionPromise = null;
        throw err;
      });
    }
    return sessionPromise;
  }

  function goToSession(id) {
    const url = new URL(location.href);
    url.searchParams.set("session", id);
    location.replace(url.toString());
  }

  async function shareSession() {
    let id = "";
    try {
      id = await ensureSession();
    } catch (err) {
      toast("Could not share this log. A shared code needs the Cloudflare site.");
      return;
    }
    const url = new URL(location.href);
    url.searchParams.set("session", id);
    const link = url.toString();
    try {
      if (!navigator.clipboard || !navigator.clipboard.writeText) throw new Error("no clipboard");
      await navigator.clipboard.writeText(link);
      toast("Link copied.");
    } catch (err) {
      toast(link);
    }
    if (!sessionId) goToSession(id);
  }

  function download(filename, text) {
    const blob = new Blob([text], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  function medicineById(id) {
    return state.medicines.find((item) => item.id === id) || null;
  }

  function ingredientById(id) {
    return state.ingredients.find((item) => item.id === id) || null;
  }

  function toneFor(used, max) {
    if (!(max > 0)) return "ok";
    if (used > max + 1e-6) return "over";
    if (used >= max * 0.8) return "near";
    return "ok";
  }

  function defaultTaken(dayKey, now) {
    if (dayKey === PainLog.localDateKey(now)) return now;
    const date = PainLog.dateFromKey(dayKey);
    if (!date) return now;
    date.setHours(now.getHours(), now.getMinutes(), 0, 0);
    return date;
  }

  function warningText(warning) {
    if (warning.code === "over-max") {
      return {
        title: "Over the daily max",
        detail: `The highest 24-hour total for ${warning.ingredientName} would be ${PainLog.formatMg(warning.peakMg)} mg. The limit you set is ${PainLog.formatMg(warning.maxMg)} mg.`
      };
    }
    if (warning.code === "large-amount") {
      const which = warning.ingredientName ? ` of ${warning.ingredientName}` : "";
      return {
        title: "Check this amount",
        detail: `${PainLog.formatMg(warning.amountMg)} mg${which} is unusually large for a single dose.`
      };
    }
    if (warning.code === "future") {
      return {
        title: "This time is in the future",
        detail: "Log it only if that is really when the dose will be taken."
      };
    }
    if (warning.code === "early-before") {
      return {
        title: "Inside the interval",
        detail: `The last dose of this medicine was at ${formatTime(warning.at)}. The interval you set is ${PainLog.formatHours(warning.intervalHours)}, so the earliest next dose is ${formatTime(warning.earliest)}.`
      };
    }
    if (warning.code === "early-after") {
      return {
        title: "Inside the interval",
        detail: `Another dose of this medicine is logged at ${formatTime(warning.at)}, inside the ${PainLog.formatHours(warning.intervalHours)} interval.`
      };
    }
    if (warning.code === "early-shared") {
      const other = medicineById(warning.otherMedicineId);
      const name = other ? other.name : "Another medicine";
      return {
        title: "Inside the interval",
        detail: `${name} was logged at ${formatTime(warning.at)}. It also counts as ${warning.ingredientName}, and it falls inside the ${PainLog.formatHours(warning.intervalHours)} interval.`
      };
    }
    return { title: "Check this dose", detail: "" };
  }

  function errorBlock(errors) {
    if (!errors || !errors.length) return "";
    return `<div class="errors" role="alert" tabindex="-1" data-autofocus>${errors
      .map((item) => `<p>${esc(item)}</p>`)
      .join("")}</div>`;
  }

  function joinNames(names) {
    if (names.length <= 1) return names[0] || "";
    if (names.length === 2) return `${names[0]} and ${names[1]}`;
    return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
  }

  function presetParts(preset) {
    if (Array.isArray(preset.parts) && preset.parts.length) return preset.parts;
    return [
      {
        ingredientName: preset.ingredientName,
        mgPerUnit: preset.usualDoseMg,
        maxPer24hMg: preset.maxPer24hMg
      }
    ];
  }

  function presetMeta(preset) {
    const parts = presetParts(preset);
    const every = `every ${PainLog.formatHours(preset.intervalHours)}`;
    if (parts.length > 1) {
      const bits = parts
        .map((part) => `${PainLog.formatMg(part.mgPerUnit)} mg ${part.ingredientName}`)
        .join(" + ");
      return `${bits} · ${every}`;
    }
    return `${PainLog.formatMg(preset.maxPer24hMg)} mg in 24 hours · ${every}`;
  }

  function presetButtons() {
    const presets = PainLog.PRESETS.map(
      (preset) => `<button type="button" class="preset" data-action="pick-preset" data-preset="${esc(preset.id)}" data-focus-key="preset-${esc(preset.id)}">
        <span class="preset-name">${esc(preset.medicineName)}</span>
        <span class="preset-meta">${esc(presetMeta(preset))}</span>
      </button>`
    ).join("");
    return `${presets}<button type="button" class="preset" data-action="pick-preset" data-preset="custom" data-focus-key="preset-custom">
      <span class="preset-name">Other medicine</span>
      <span class="preset-meta">Name, dose, and daily max.</span>
    </button>`;
  }

  function usualLine(med) {
    const parts = PainLog.medicineParts(med);
    const bits = [];
    if (parts.length > 1) {
      if (med.doseWords) bits.push(med.doseWords);
      bits.push(
        parts
          .map((part) => {
            const ingredient = ingredientById(part.ingredientId);
            const name = ingredient ? ingredient.name : "";
            return `${PainLog.formatMg(part.mgPerUnit)} mg ${name}`.trim();
          })
          .join(" + ")
      );
    } else {
      if (med.usualDoseMg > 0) bits.push(`${PainLog.formatMg(med.usualDoseMg)} mg`);
      if (med.doseWords) bits.push(med.doseWords);
    }
    bits.push(med.intervalHours > 0 ? `every ${PainLog.formatHours(med.intervalHours)}` : "no interval set");
    if (med.asNeeded) bits.push("as needed");
    return bits.join(" · ");
  }

  function shareLine(med) {
    const parts = PainLog.medicineParts(med);
    const ingredients = parts.map((part) => ingredientById(part.ingredientId)).filter(Boolean);
    const bits = [];
    if (parts.length > 1) bits.push(`Counts toward ${joinNames(ingredients.map((item) => item.name))}`);
    else if (ingredients[0] && PainLog.normName(med.name) !== PainLog.normName(ingredients[0].name)) {
      bits.push(`Counts toward ${ingredients[0].name}`);
    }
    const shared = [];
    for (const other of state.medicines) {
      if (!other.active || other.id === med.id) continue;
      const overlaps = PainLog.medicineParts(other).some((part) =>
        parts.some((own) => own.ingredientId === part.ingredientId)
      );
      if (overlaps) shared.push(other.name);
    }
    if (shared.length) bits.push(`Shared with ${shared.join(", ")}`);
    return bits.join(" · ");
  }

  function formatPct(used, max) {
    if (!(max > 0)) return "—";
    const pct = (used / max) * 100;
    if (used > 0 && pct < 0.5) return "<1%";
    return `${Math.round(pct)}%`;
  }

  function mgLine(window) {
    if (!(window.max > 0)) return "No daily max";
    const used = `${PainLog.formatMg(window.used)} of ${PainLog.formatMg(window.max)} mg`;
    if (window.used > window.max + 1e-6) return `${used} · ${PainLog.formatMg(window.used - window.max)} mg over`;
    return used;
  }

  function barWidths(used, added, max) {
    if (!(max > 0)) return { used: 0, next: 0, edge: 0 };
    const usedPct = Math.max(0, Math.min(100, (used / max) * 100));
    const totalPct = Math.max(0, Math.min(100, ((used + added) / max) * 100));
    return { used: usedPct, next: Math.max(0, totalPct - usedPct), edge: totalPct };
  }

  function forecastLine(reading, added) {
    if (!(added > 0) || !(reading.max > 0)) return "";
    const total = reading.used + added;
    const text = `${PainLog.formatMg(total)} of ${PainLog.formatMg(reading.max)} mg`;
    if (total > reading.max + 1e-6) return `Would be ${text} · ${PainLog.formatMg(total - reading.max)} mg over`;
    return `Would be ${text}`;
  }

  function pctBlock(ingredient, reading, showLabel, periodLabel, added) {
    const extra = added > 0 ? added : 0;
    const tone = toneFor(reading.used, reading.max);
    const widths = barWidths(reading.used, extra, reading.max);
    const pct = formatPct(reading.used, reading.max);
    const preview = extra > 0 && reading.max > 0;
    const total = reading.used + extra;
    const over = preview && total > reading.max + 1e-6;
    const pin = preview && widths.edge > 78;
    const forecast = preview ? `${PainLog.formatMg(total)} mg` : "";
    const forecastPct = preview ? formatPct(total, reading.max) : "";
    const label = preview
      ? `${ingredient.name}, ${pct} of the daily max ${periodLabel}. Would be ${forecastPct} after the usual dose`
      : `${ingredient.name}, ${pct} of the daily max ${periodLabel}`;
    const forecastHtml = preview
      ? `<span class="meter-next${over ? " is-over" : ""}" style="width:${widths.next}%"></span>
        <span class="meter-forecast${over ? " is-over" : ""}${pin ? " pin-end" : ""}" style="${pin ? "" : `left:${widths.edge}%`}">${esc(forecast)}</span>`
      : "";
    const note = preview ? `<p class="pct-forecast${over ? " is-over" : ""}">${esc(forecastLine(reading, extra))}</p>` : "";
    return `<div class="pct-line">
      <div class="pct-head">
        ${showLabel ? `<p class="meter-label">${esc(ingredient.name)}</p>` : `<span class="sr">${esc(ingredient.name)}</span>`}
        <span class="pct tone-${tone}">${esc(pct)}</span>
      </div>
      <div class="meter${preview ? " has-preview" : ""} tone-${tone}" role="meter" aria-valuemin="0" aria-valuemax="${esc(reading.max)}" aria-valuenow="${esc(reading.used)}" aria-label="${esc(label)}">
        <span class="meter-used" style="width:${widths.used}%"></span>
        ${forecastHtml}
      </div>
      <p class="pct-sub">${esc(mgLine(reading))}</p>
      ${note}
    </div>`;
  }

  function usageBars(med, read, periodLabel, preview) {
    const parts = PainLog.medicineParts(med);
    return parts
      .map((part) => {
        const ingredient = ingredientById(part.ingredientId);
        if (!ingredient) return "";
        const showLabel = parts.length > 1 || PainLog.normName(med.name) !== PainLog.normName(ingredient.name);
        const added = preview ? part.mgPerUnit : 0;
        return pctBlock(ingredient, read(ingredient.id), showLabel, periodLabel, added);
      })
      .join("");
  }

  function homeIngredients(now) {
    const ids = new Set();
    for (const med of state.medicines) {
      if (!med.active) continue;
      for (const part of PainLog.medicineParts(med)) {
        if (part.ingredientId) ids.add(part.ingredientId);
      }
    }
    for (const ingredient of state.ingredients) {
      if (ids.has(ingredient.id)) continue;
      const day = PainLog.ingredientDay(state, ingredient.id, now);
      const rolling = PainLog.ingredientWindow(state, ingredient.id, now);
      if (day.used > 0 || rolling.used > 0) ids.add(ingredient.id);
    }
    return [...ids]
      .map((id) => ingredientById(id))
      .filter(Boolean)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  function ingredientRow(ingredient, now) {
    const today = pctBlock(ingredient, PainLog.ingredientDay(state, ingredient.id, now), false, "since midnight", 0);
    const rolling = pctBlock(ingredient, PainLog.ingredientWindow(state, ingredient.id, now), false, "in the last 24 hours", 0);
    return `<tr>
      <td data-label="Chemical"><div class="med-name">${esc(ingredient.name)}</div></td>
      <td data-label="Today"><div class="pct-stack"><p class="pct-caption">Today</p>${today}</div></td>
      <td data-label="Last 24 hours"><div class="pct-stack"><p class="pct-caption">Last 24 hours</p>${rolling}</div></td>
    </tr>`;
  }

  function nextLine(med, now) {
    const timing = PainLog.medicineTiming(state, med, now);
    if (!(med.intervalHours > 0)) return "No interval set.";
    if (timing.lastAt === null) return "No doses logged yet.";
    if (timing.nextAt === null) return "No interval set.";
    const label = med.asNeeded ? "Earliest next dose" : "Next dose";
    return `${label} <time>${esc(formatTime(timing.nextAt))}</time> <span class="rel" data-rel="${timing.nextAt}">${esc(relPhrase(timing.nextAt, now.getTime()))}</span>`;
  }

  function medicineChoice(med, now, open) {
    const shared = shareLine(med);
    const todayBars = usageBars(med, (id) => PainLog.ingredientDay(state, id, now), "since midnight", true);
    const rollingBars = usageBars(med, (id) => PainLog.ingredientWindow(state, id, now), "in the last 24 hours", true);
    return `<details class="med-choice" ${open ? "open" : ""}>
      <summary>${esc(med.name)}</summary>
      <div class="med-choice-body">
        <p class="meta">${esc(usualLine(med))}</p>
        ${shared ? `<p class="share">${esc(shared)}</p>` : ""}
        <p class="next">${nextLine(med, now)}</p>
        <div class="choice-meters">
          <div><p class="pct-caption is-on">Today</p>${todayBars}</div>
          <div><p class="pct-caption is-on">Last 24 hours</p>${rollingBars}</div>
        </div>
        <div class="row-actions">
          <button type="button" class="btn btn-primary" data-action="log-dose" data-id="${esc(med.id)}" data-focus-key="log-${esc(med.id)}">Log<span class="sr"> a dose of ${esc(med.name)}</span></button>
          <button type="button" class="btn btn-quiet" data-action="edit-medicine" data-id="${esc(med.id)}" data-focus-key="edit-med-${esc(med.id)}">Edit<span class="sr"> ${esc(med.name)}</span></button>
        </div>
      </div>
    </details>`;
  }

  function retiredBlock(retired) {
    if (!retired.length) return "";
    return `<details class="retired">
      <summary>Removed medicines (${retired.length})</summary>
      <ul>
        ${retired
          .map(
            (med) => `<li><span>${esc(med.name)}</span><button type="button" class="btn btn-quiet" data-action="restore-medicine" data-id="${esc(med.id)}" data-focus-key="restore-${esc(med.id)}">Put back</button></li>`
          )
          .join("")}
      </ul>
    </details>`;
  }

  function logUsageButton() {
    return `<button type="button" class="btn btn-primary" data-action="log-usage" data-focus-key="log-usage">Log medicine usage</button>`;
  }

  function cardsSection(now) {
    const ingredients = homeIngredients(now);
    if (!ingredients.length) {
      return `<section class="panel">
        <h2>No medicines yet</h2>
        <p class="add-row">${logUsageButton()}</p>
      </section>`;
    }
    return `<section>
      <div class="section-head usage-head">
        <h2>Usage</h2>
        ${logUsageButton()}
      </div>
      <div class="table-wrap">
        <table class="meds">
          <caption class="sr">Percent of each chemical's daily max used since midnight, and in the last 24 hours</caption>
          <thead><tr><th scope="col">Chemical</th><th scope="col">Today</th><th scope="col">Last 24 hours</th></tr></thead>
          <tbody>${ingredients.map((ingredient) => ingredientRow(ingredient, now)).join("")}</tbody>
        </table>
      </div>
    </section>`;
  }

  function rowFlags(dose) {
    const taken = new Date(dose.takenAt);
    const result = PainLog.assessDose(
      state,
      {
        medicineId: dose.medicineId,
        amountMg: dose.amountMg,
        parts: dose.parts,
        takenAt: taken,
        excludeDoseId: dose.id
      },
      taken
    );
    return result.warnings.filter((item) => item.code === "over-max" || item.code.startsWith("early"));
  }

  function painWord(value) {
    const level = PAIN.find((item) => item.id === value);
    return level ? level.label : "Not set";
  }

  function doseAmountHtml(dose) {
    if (Array.isArray(dose.parts) && dose.parts.length > 1) {
      const lines = dose.parts
        .map((part) => {
          const ingredient = ingredientById(part.ingredientId);
          const name = ingredient ? ingredient.name : "Drug";
          return `<div class="num">${esc(PainLog.formatMg(part.amountMg))} mg ${esc(name)}</div>`;
        })
        .join("");
      return `<div>${lines}${dose.doseWords ? `<div class="words">${esc(dose.doseWords)}</div>` : ""}</div>`;
    }
    return `<div><div class="num">${esc(PainLog.formatMg(dose.amountMg))} mg</div>${dose.doseWords ? `<div class="words">${esc(dose.doseWords)}</div>` : ""}</div>`;
  }

  function doseAmountPhrase(dose) {
    if (Array.isArray(dose.parts) && dose.parts.length > 1) {
      return dose.parts
        .map((part) => {
          const ingredient = ingredientById(part.ingredientId);
          return `${ingredient ? ingredient.name : "Drug"} ${PainLog.formatMg(part.amountMg)} mg`;
        })
        .join(", ");
    }
    return `${PainLog.formatMg(dose.amountMg)} mg`;
  }

  function rangeWindow(now) {
    const today = PainLog.localDateKey(now);
    if (ui.range === "yesterday") {
      const day = PainLog.shiftDay(today, -1);
      return { from: day, to: day };
    }
    if (ui.range === "7") return { from: PainLog.shiftDay(today, -6), to: today };
    if (ui.range === "30") return { from: PainLog.shiftDay(today, -29), to: today };
    if (ui.range === "all") return { from: null, to: null };
    if (ui.range === "custom") {
      let from = ui.rangeFrom || today;
      let to = ui.rangeTo || from;
      if (from > to) {
        const swap = from;
        from = to;
        to = swap;
      }
      return { from, to };
    }
    return { from: today, to: today };
  }

  function rangeLabel(window) {
    if (!window.from && !window.to) return "All doses";
    if (window.from === window.to) return formatDay(window.from);
    if (ui.range === "7") return "Last 7 days";
    if (ui.range === "30") return "Last 30 days";
    const short = (key) =>
      new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(
        PainLog.dateFromKey(key)
      );
    return `${short(window.from)} – ${short(window.to)}`;
  }

  function dosesInRange(window) {
    return state.doses
      .filter((dose) => {
        const key = PainLog.localDateKey(new Date(dose.takenAt));
        if (window.from && key < window.from) return false;
        if (window.to && key > window.to) return false;
        return true;
      })
      .sort((a, b) => (a.takenAt < b.takenAt ? -1 : a.takenAt > b.takenAt ? 1 : a.id < b.id ? -1 : 1));
  }

  function selectedDay(now) {
    const window = rangeWindow(now);
    const today = PainLog.localDateKey(now);
    if (window.from && window.from === window.to) return window.from;
    if (!window.from || (today >= window.from && today <= window.to)) return today;
    return window.to;
  }

  function formatLoggedAt(iso, multiDay) {
    const date = new Date(iso);
    if (!multiDay) return formatTime(date);
    const day = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
    return `${day}, ${formatTime(date)}`;
  }

  function logSection(now) {
    const window = rangeWindow(now);
    const label = rangeLabel(window);
    const multiDay = !window.from || window.from !== window.to;
    const doses = dosesInRange(window);
    const totals = new Map();
    const addTotal = (key, name, mg) => {
      const row = totals.get(key) || { name, mg: 0 };
      row.mg += mg;
      totals.set(key, row);
    };
    for (const dose of doses) {
      if (Array.isArray(dose.parts) && dose.parts.length) {
        for (const part of dose.parts) {
          const ingredient = ingredientById(part.ingredientId);
          addTotal(ingredient ? ingredient.id : part.ingredientId, ingredient ? ingredient.name : "Drug", part.amountMg);
        }
      } else {
        const med = medicineById(dose.medicineId);
        const ingredient = med ? ingredientById(med.ingredientId) : null;
        addTotal(
          ingredient ? ingredient.id : dose.medicineId,
          ingredient ? ingredient.name : med ? med.name : "Medicine",
          dose.amountMg
        );
      }
    }
    const totalText = [...totals.values()]
      .map((item) => `${item.name} ${PainLog.formatMg(item.mg)} mg`)
      .join(", ");
    const rows = doses
      .map((dose) => {
        const med = medicineById(dose.medicineId);
        const flags = rowFlags(dose);
        const over = flags.some((item) => item.code === "over-max");
        const early = flags.some((item) => item.code.startsWith("early"));
        const rowClass = [over ? "is-over" : "", early ? "is-early" : ""].filter(Boolean).join(" ");
        const tags = [
          over ? `<span class="tag">Over daily max</span>` : "",
          early ? `<span class="tag tag-early">Inside interval</span>` : ""
        ].join("");
        const next = med && med.intervalHours > 0 ? formatWhen(new Date(dose.takenAt).getTime() + med.intervalHours * 3600 * 1000, new Date(dose.takenAt).getTime()) : "—";
        const name = med ? med.name : "Removed medicine";
        return `<tr class="${rowClass}">
          <td data-label="When">${esc(formatLoggedAt(dose.takenAt, multiDay))}</td>
          <td data-label="Medicine"><div>${esc(name)}${dose.note ? `<div class="note">${esc(dose.note)}</div>` : ""}${tags ? `<div class="tags">${tags}</div>` : ""}</div></td>
          <td data-label="Dose">${doseAmountHtml(dose)}</td>
          <td data-label="Next dose">${esc(next)}</td>
          <td data-label="Pain before">${esc(painWord(dose.painBefore))}</td>
          <td data-label="Pain after">
            <div class="pain-word">${esc(painWord(dose.painAfter))}</div>
            <div class="pain-picks no-print">
              ${PAIN.map(
                (level) => `<button type="button" class="face compact" aria-pressed="${dose.painAfter === level.id}" aria-label="Set pain after to ${level.label} for ${esc(name)} at ${esc(formatTime(dose.takenAt))}" data-action="set-pain-after" data-id="${esc(dose.id)}" data-level="${level.id}" data-focus-key="after-${esc(dose.id)}-${level.id}">${faceSvg(level.id)}</button>`
              ).join("")}
            </div>
          </td>
          <td class="actions" data-label="">
            <div class="row-actions">
              <button type="button" class="btn btn-quiet" data-action="edit-dose" data-id="${esc(dose.id)}" data-focus-key="edit-dose-${esc(dose.id)}">Edit<span class="sr"> ${esc(name)} at ${esc(formatTime(dose.takenAt))}</span></button>
              <button type="button" class="btn btn-quiet" data-action="delete-dose" data-id="${esc(dose.id)}" data-focus-key="delete-dose-${esc(dose.id)}">Delete<span class="sr"> ${esc(name)} at ${esc(formatTime(dose.takenAt))}</span></button>
            </div>
          </td>
        </tr>`;
      })
      .join("");
    const filters = RANGES.map(
      (item) =>
        `<button type="button" class="btn btn-secondary" data-action="set-range" data-range="${item.id}" aria-pressed="${ui.range === item.id}" data-focus-key="range-${item.id}">${item.label}</button>`
    ).join("");
    const custom =
      ui.range === "custom"
        ? `<div class="custom-range">
            <label for="range-from">From</label>
            <input id="range-from" name="range-from" type="date" value="${esc(ui.rangeFrom)}">
            <label for="range-to">To</label>
            <input id="range-to" name="range-to" type="date" value="${esc(ui.rangeTo)}">
          </div>`
        : "";
    return `<section>
      <div class="section-head">
        <h2>Log</h2>
        <div class="filters" role="group" aria-label="Time period">${filters}</div>
        ${custom}
        <p class="range-label">${esc(label)}</p>
        ${totalText ? `<p class="day-totals">${esc(totalText)}</p>` : ""}
      </div>
      ${
        doses.length
          ? `<div class="table-wrap"><table class="log">
              <caption class="sr">Doses for ${esc(label)}</caption>
              <thead><tr><th scope="col">When</th><th scope="col">Medicine</th><th scope="col">Dose</th><th scope="col">Next dose</th><th scope="col">Pain before</th><th scope="col">Pain after</th><th scope="col"><span class="sr">Actions</span></th></tr></thead>
              <tbody>${rows}</tbody>
            </table></div>`
          : `<p class="empty-day">Nothing logged for this period.</p>`
      }
    </section>`;
  }

  function sheet(inner) {
    return `<dialog class="modal"><div class="sheet">${inner}</div></dialog>`;
  }

  function facePicker(which, selected) {
    return `<div class="faces">${PAIN.map((level) => {
      const pressed = selected === level.id;
      return `<button type="button" class="face" aria-pressed="${pressed}" data-action="set-pain" data-which="${which}" data-level="${level.id}">${faceSvg(level.id)}<span>${level.label}</span></button>`;
    }).join("")}</div>`;
  }

  function doseAssessment() {
    const med = medicineById(ui.dialog.medicineId);
    const parts = med ? PainLog.medicineParts(med) : [];
    const input = {
      medicineId: ui.dialog.medicineId,
      takenAt: PainLog.fromLocalInput(ui.dialog.takenAt),
      excludeDoseId: ui.dialog.doseId
    };
    if (parts.length > 1 && ui.dialog.partAmounts) {
      input.parts = parts.map((part) => ({
        ingredientId: part.ingredientId,
        amountMg: ui.dialog.partAmounts[part.ingredientId]
      }));
    } else {
      input.amountMg = ui.dialog.amountMg;
    }
    return PainLog.assessDose(state, input, new Date());
  }

  function summaryHtml(result) {
    if (!result.amountValid || !result.takenAtValid) {
      return { className: "summary", html: "<p>Enter the amount and the time to see the 24-hour total.</p>" };
    }
    const tone = result.warnings.some((item) => item.code === "over-max")
      ? "over"
      : result.warnings.length
        ? "near"
        : "ok";
    const taken = PainLog.fromLocalInput(ui.dialog.takenAt);
    const lines = [];
    if (result.ingredients && result.ingredients.length > 1) {
      for (const item of result.ingredients) {
        const over = result.warnings.some(
          (warning) => warning.code === "over-max" && warning.ingredientName === item.ingredientName
        );
        lines.push(
          `<p class="summary-total${over ? " is-over" : ""}"><span class="num">${esc(PainLog.formatMg(item.peakMg))}</span> of <span class="num">${esc(PainLog.formatMg(item.maxMg))} mg</span> ${esc(item.ingredientName)}</p>`
        );
      }
    } else {
      lines.push(
        `<p class="summary-total"><span class="num">${esc(PainLog.formatMg(result.peakMg))}</span> of <span class="num">${esc(PainLog.formatMg(result.maxMg))} mg</span></p>`,
        `<p>Highest total in any 24 hours for ${esc(result.ingredientName)}.</p>`
      );
    }
    if (result.nextDoseAt && taken) {
      lines.push(
        `<p>Next dose of ${esc(result.medicineName)} could be at ${esc(formatWhen(result.nextDoseAt, taken.getTime()))}.</p>`
      );
    }
    for (const warning of result.warnings) {
      const text = warningText(warning);
      lines.push(`<p class="warn-line"><strong>${esc(text.title)}.</strong> ${esc(text.detail)}</p>`);
    }
    return { className: `summary tone-${tone}`, html: lines.join("") };
  }

  function doseDialog() {
    const med = medicineById(ui.dialog.medicineId);
    const editing = !!ui.dialog.doseId;
    const result = doseAssessment();
    const summary = summaryHtml(result);
    const title = editing ? `Edit ${med ? med.name : "dose"}` : `Log ${med ? med.name : "a dose"}`;
    const button = result.warnings.length ? "Review warning" : editing ? "Save changes" : "Log dose";
    const hasErrors = ui.dialog.errors && ui.dialog.errors.length;
    const parts = med ? PainLog.medicineParts(med) : [];
    const combo = parts.length > 1;
    const amountFields = combo
      ? `<div class="field">
          <label for="units">How many</label>
          <div class="amount-row">
            <button type="button" class="stepper" data-action="step-units" data-dir="-1" aria-label="Decrease amount">−</button>
            <input id="units" name="units" type="text" inputmode="decimal" autocomplete="off" value="${esc(ui.dialog.units)}" ${hasErrors ? "" : "data-autofocus"}>
            <button type="button" class="stepper" data-action="step-units" data-dir="1" aria-label="Increase amount">+</button>
          </div>
        </div>
        ${parts
          .map((part) => {
            const ingredient = ingredientById(part.ingredientId);
            const name = ingredient ? ingredient.name : "Drug";
            return `<div class="field">
              <label for="part-amt-${esc(part.ingredientId)}">${esc(name)} (mg)</label>
              <input id="part-amt-${esc(part.ingredientId)}" name="part-amt-${esc(part.ingredientId)}" type="text" inputmode="decimal" autocomplete="off" value="${esc(ui.dialog.partAmounts[part.ingredientId] || "")}">
            </div>`;
          })
          .join("")}`
      : `<div class="field">
          <label for="amountMg">Amount (mg)</label>
          <div class="amount-row">
            <button type="button" class="stepper" data-action="step-amount" data-dir="-1" aria-label="Decrease amount">−</button>
            <input id="amountMg" name="amountMg" type="text" inputmode="decimal" autocomplete="off" value="${esc(ui.dialog.amountMg)}" ${hasErrors ? "" : "data-autofocus"}>
            <button type="button" class="stepper" data-action="step-amount" data-dir="1" aria-label="Increase amount">+</button>
          </div>
        </div>`;
    return sheet(`<form class="sheet-form" data-form="dose" novalidate>
      <div class="sheet-top">
        <h2 id="dialog-title">${esc(title)}</h2>
        <button type="button" class="btn btn-quiet" data-action="close-dialog">Close</button>
      </div>
      <div class="sheet-body">
      ${errorBlock(ui.dialog.errors)}
      ${amountFields}
      <div class="field">
        <label for="doseWords">How you took it</label>
        <input id="doseWords" name="doseWords" type="text" autocomplete="off" maxlength="80" value="${esc(ui.dialog.doseWords)}" placeholder="1 tablet">
      </div>
      <div class="field">
        <label for="takenAt">Time taken</label>
        <input id="takenAt" name="takenAt" type="datetime-local" required value="${esc(ui.dialog.takenAt)}">
      </div>
      <fieldset class="pain">
        <legend>Pain before</legend>
        ${facePicker("before", ui.dialog.painBefore)}
      </fieldset>
      <fieldset class="pain">
        <legend>Pain after</legend>
        ${facePicker("after", ui.dialog.painAfter)}
      </fieldset>
      <div class="field">
        <label for="note">Note</label>
        <textarea id="note" name="note" maxlength="200">${esc(ui.dialog.note)}</textarea>
      </div>
      <div id="dose-summary" class="${summary.className}">${summary.html}</div>
      </div>
      <div class="sheet-actions">
        <button type="submit" class="btn btn-primary" id="dose-submit">${esc(button)}</button>
      </div>
    </form>`);
  }

  function confirmDoseDialog() {
    const med = medicineById(ui.dialog.medicineId);
    const result = doseAssessment();
    const taken = PainLog.fromLocalInput(ui.dialog.takenAt);
    const items = result.warnings
      .map((warning) => {
        const text = warningText(warning);
        return `<li><strong>${esc(text.title)}.</strong> ${esc(text.detail)}</li>`;
      })
      .join("");
    const saveLabel = ui.dialog.doseId ? "Save this dose" : "Log this dose";
    const heading = ui.dialog.doseId ? "Save this dose anyway?" : "Log this dose anyway?";
    return sheet(`<div class="sheet-form">
      <div class="sheet-top">
        <h2 id="dialog-title" tabindex="-1" data-autofocus>${esc(heading)}</h2>
      </div>
      <div class="sheet-body">
      <p class="section-copy">${esc(pendingDosePhrase(med, taken))}</p>
      <ul class="warn-list">${items}</ul>
      </div>
      <div class="sheet-actions">
        <button type="button" class="btn btn-secondary" data-action="back-step">Go back</button>
        <button type="button" class="btn btn-danger" data-action="confirm-save-dose">${esc(saveLabel)}</button>
      </div>
      </div>`);
  }

  function usageReturn(openId) {
    return { type: "log-usage", openId: openId || "" };
  }

  function logUsageDialog() {
    const now = new Date();
    const active = state.medicines
      .filter((item) => item.active)
      .sort((a, b) => a.name.localeCompare(b.name));
    const retired = state.medicines.filter((item) => !item.active);
    const openId = ui.dialog.openId || "";
    const choices = active.length
      ? `<div class="med-choices">${active.map((med) => medicineChoice(med, now, med.id === openId)).join("")}</div>`
      : `<p class="section-copy">No medicines yet.</p>`;
    return sheet(`<div class="sheet-form">
      <div class="sheet-top">
        <h2 id="dialog-title" tabindex="-1" data-autofocus>Log medicine usage</h2>
        <button type="button" class="btn btn-quiet" data-action="close-dialog">Close</button>
      </div>
      <div class="sheet-body">
        ${choices}
        ${retiredBlock(retired)}
      </div>
      <div class="sheet-actions">
        <button type="button" class="btn btn-secondary" data-action="add-medicine" data-focus-key="add-medicine">Add a medicine</button>
      </div>
    </div>`);
  }

  function pickerDialog() {
    return sheet(`<div class="sheet-form">
      <div class="sheet-top">
        <h2 id="dialog-title" tabindex="-1" data-autofocus>Add a medicine</h2>
        <button type="button" class="btn btn-quiet" data-action="close-dialog">Close</button>
      </div>
      <div class="sheet-body">
      <div class="preset-list">${presetButtons()}</div>
      </div>
      </div>`);
  }

  function pendingDosePhrase(med, taken) {
    const name = med ? med.name : "This medicine";
    const when = taken ? ` at ${formatTime(taken)}` : "";
    const parts = med ? PainLog.medicineParts(med) : [];
    if (parts.length > 1 && ui.dialog.partAmounts) {
      const bits = parts
        .map((part) => {
          const ingredient = ingredientById(part.ingredientId);
          const mg = PainLog.formatMg(PainLog.parseNum(ui.dialog.partAmounts[part.ingredientId]));
          return `${ingredient ? ingredient.name : "Drug"} ${mg} mg`;
        })
        .join(", ");
      return `${name}, ${bits}${when}.`;
    }
    return `${name}, ${PainLog.formatMg(PainLog.parseNum(ui.dialog.amountMg))} mg${when}.`;
  }

  function medicineDialog() {
    const editing = !!ui.dialog.medicineId;
    const hasErrors = ui.dialog.errors && ui.dialog.errors.length;
    const focusPart = ui.dialog.focusPartKey || "";
    ui.dialog.focusPartKey = "";
    const parts = ui.dialog.parts || [];
    const partFields = parts
      .map((part) => {
        const focus = !hasErrors && focusPart === part.key ? "data-autofocus" : "";
        return `<div class="part">
          <div class="field">
            <label for="part-name-${esc(part.key)}">Drug</label>
            <input id="part-name-${esc(part.key)}" name="part-name-${esc(part.key)}" type="text" autocomplete="off" maxlength="80" value="${esc(part.name)}" placeholder="Acetaminophen" ${focus}>
            <p class="hint" id="part-hint-${esc(part.key)}"></p>
          </div>
          <div class="part-grid">
            <div class="field">
              <label for="part-mg-${esc(part.key)}">mg per dose</label>
              <input id="part-mg-${esc(part.key)}" name="part-mg-${esc(part.key)}" type="text" inputmode="decimal" autocomplete="off" value="${esc(part.mgPerUnit)}">
            </div>
            <div class="field">
              <label for="part-max-${esc(part.key)}">Max in 24 hours (mg)</label>
              <input id="part-max-${esc(part.key)}" name="part-max-${esc(part.key)}" type="text" inputmode="decimal" autocomplete="off" value="${esc(part.maxPer24hMg)}">
            </div>
          </div>
          ${parts.length > 1 ? `<button type="button" class="btn btn-quiet" data-action="remove-part" data-key="${esc(part.key)}">Remove drug</button>` : ""}
        </div>`;
      })
      .join("");
    return sheet(`<form class="sheet-form" data-form="medicine" novalidate>
      <div class="sheet-top">
        <h2 id="dialog-title">${editing ? "Edit medicine" : "Add a medicine"}</h2>
        <button type="button" class="btn btn-quiet" data-action="close-dialog">Close</button>
      </div>
      <div class="sheet-body">
      ${errorBlock(ui.dialog.errors)}
      <div class="field">
        <label for="med-name">Medicine</label>
        <input id="med-name" name="name" type="text" autocomplete="off" maxlength="80" value="${esc(ui.dialog.name)}" ${hasErrors || focusPart ? "" : "data-autofocus"}>
      </div>
      <div class="parts">
        <p class="parts-label">In one dose</p>
        ${partFields}
        ${parts.length < 8 ? `<button type="button" class="btn btn-secondary" data-action="add-part">Add another drug</button>` : ""}
      </div>
      <div class="field">
        <label for="med-words">Usual description</label>
        <input id="med-words" name="doseWords" type="text" autocomplete="off" maxlength="80" value="${esc(ui.dialog.doseWords)}" placeholder="1 tablet">
      </div>
      <div class="field">
        <label for="intervalHours">Hours between doses</label>
        <input id="intervalHours" name="intervalHours" type="text" inputmode="decimal" autocomplete="off" value="${esc(ui.dialog.intervalHours)}">
      </div>
      <label class="check"><input name="asNeeded" type="checkbox" ${ui.dialog.asNeeded ? "checked" : ""}> Only as needed</label>
      </div>
      <div class="sheet-actions">
        <button type="submit" class="btn btn-primary">${editing ? "Save changes" : "Save medicine"}</button>
        ${editing ? `<button type="button" class="btn btn-quiet" data-action="retire-medicine" data-id="${esc(ui.dialog.medicineId)}">Remove from list</button>` : ""}
      </div>
    </form>`);
  }

  function genericConfirm() {
    const dialog = ui.dialog;
    return sheet(`<div class="sheet-form">
      <div class="sheet-top">
        <h2 id="dialog-title" tabindex="-1" data-autofocus>${esc(dialog.title)}</h2>
        <button type="button" class="btn btn-quiet" data-action="close-dialog">Close</button>
      </div>
      <div class="sheet-body">
      <p class="section-copy">${esc(dialog.body)}</p>
      </div>
      <div class="sheet-actions">
        <button type="button" class="btn btn-secondary" data-action="close-dialog">Go back</button>
        <button type="button" class="btn ${dialog.danger ? "btn-danger" : "btn-primary"}" data-action="confirm-generic">${esc(dialog.confirmLabel)}</button>
      </div>
      </div>`);
  }

  function dialogHtml() {
    if (!ui.dialog) return "";
    if (ui.dialog.type === "log-usage") return logUsageDialog();
    if (ui.dialog.type === "medicine" && ui.dialog.stage === "pick") return pickerDialog();
    if (ui.dialog.type === "medicine") return medicineDialog();
    if (ui.dialog.type === "dose" && ui.dialog.step === "confirm") return confirmDoseDialog();
    if (ui.dialog.type === "dose") return doseDialog();
    if (ui.dialog.type === "confirm") return genericConfirm();
    return "";
  }

  function corruptView() {
    return `<div class="wrap">
      <header class="top">
        <h1>Pain medicine log</h1>
      </header>
      <div class="errors" role="alert">
        <p>The saved log could not be read. It is still in this browser until you start a new log.</p>
      </div>
      <p class="add-row">
        <button type="button" class="btn btn-secondary" data-action="download-raw">Download the unreadable save</button>
        <button type="button" class="btn btn-danger" data-action="start-fresh">Start a new log</button>
      </p>
    </div>`;
  }

  function tabBar() {
    const buttons = TABS.map((item) => {
      const selected = ui.tab === item.id;
      return `<button type="button" class="tab" role="tab" id="tab-${item.id}" aria-controls="panel-${item.id}" aria-selected="${selected}" tabindex="${selected ? "0" : "-1"}" data-action="set-tab" data-tab="${item.id}" data-focus-key="tab-${item.id}">${item.label}</button>`;
    }).join("");
    return `<div class="tabs" role="tablist" aria-label="Sections">${buttons}</div>`;
  }

  function view() {
    if (persistBlocked) return corruptView();
    const now = new Date();
    const tab = ui.tab === "log" ? "log" : "medicines";
    return `<div class="wrap">
      <header class="top">
        <h1>Pain medicine log</h1>
        <button type="button" class="btn btn-secondary share-session no-print" data-action="share-session" data-focus-key="share-session">Share session</button>
      </header>
      ${tabBar()}
      <div role="tabpanel" id="panel-${tab}" aria-labelledby="tab-${tab}">
        ${tab === "log" ? logSection(now) : cardsSection(now)}
      </div>
      <footer>
        ${sessionId ? `<p>Anyone with this code can open and change this log. Not medical advice.</p>` : ""}
        <div class="footer-actions no-print">
          <button type="button" class="btn btn-quiet" data-action="download-backup">Download backup</button>
          <button type="button" class="btn btn-quiet" data-action="restore-backup">Restore backup</button>
        </div>
      </footer>
    </div>
    ${dialogHtml()}`;
  }

  function render() {
    const focusKey = document.activeElement && document.activeElement.dataset
      ? document.activeElement.dataset.focusKey || ""
      : "";
    app.innerHTML = view();
    const dlg = app.querySelector("dialog");
    if (dlg) {
      dlg.showModal();
      dlg.addEventListener("cancel", (event) => {
        event.preventDefault();
        closeOrBack();
      });
      dlg.addEventListener("click", (event) => {
        if (event.target === dlg) closeOrBack();
      });
      const auto = dlg.querySelector("[data-autofocus]");
      if (auto) auto.focus();
      if (ui.dialog && ui.dialog.type === "medicine") refreshMedicineHints();
      return;
    }
    if (focusKey && window.CSS && CSS.escape) {
      const next = app.querySelector(`[data-focus-key="${CSS.escape(focusKey)}"]`);
      if (next) next.focus();
    }
  }

  function closeOrBack() {
    if (!ui.dialog) return;
    if (ui.dialog.type === "dose" && ui.dialog.step === "confirm") {
      ui.dialog.step = "edit";
      render();
      return;
    }
    if (ui.dialog.type === "confirm" && ui.dialog.kind === "retire-medicine") {
      openEditMedicine(ui.dialog.medicineId);
      return;
    }
    if (ui.dialog.returnTo && ui.dialog.returnTo.type === "log-usage") {
      ui.dialog = usageReturn(ui.dialog.returnTo.openId);
      render();
      return;
    }
    ui.dialog = null;
    render();
    pollSharedSession();
  }

  function syncFromDom() {
    const form = document.querySelector("dialog form[data-form]");
    if (!form || !ui.dialog) return;
    const data = new FormData(form);
    if (form.dataset.form === "dose") {
      const amount = data.get("amountMg");
      if (amount !== null) ui.dialog.amountMg = String(amount);
      const units = data.get("units");
      if (units !== null) ui.dialog.units = String(units);
      if (ui.dialog.partAmounts) {
        for (const id of Object.keys(ui.dialog.partAmounts)) {
          const value = data.get(`part-amt-${id}`);
          if (value !== null) ui.dialog.partAmounts[id] = String(value);
        }
      }
      ui.dialog.doseWords = String(data.get("doseWords") ?? "");
      ui.dialog.takenAt = String(data.get("takenAt") ?? "");
      ui.dialog.note = String(data.get("note") ?? "");
      return;
    }
    if (form.dataset.form === "medicine") {
      ui.dialog.name = String(data.get("name") ?? "");
      ui.dialog.doseWords = String(data.get("doseWords") ?? "");
      ui.dialog.intervalHours = String(data.get("intervalHours") ?? "");
      if (ui.dialog.parts) {
        ui.dialog.parts = ui.dialog.parts.map((part) => ({
          ...part,
          name: String(data.get(`part-name-${part.key}`) ?? part.name),
          mgPerUnit: String(data.get(`part-mg-${part.key}`) ?? part.mgPerUnit),
          maxPer24hMg: String(data.get(`part-max-${part.key}`) ?? part.maxPer24hMg)
        }));
      }
      const box = form.querySelector("[name=asNeeded]");
      if (box) ui.dialog.asNeeded = box.checked;
    }
  }

  function refreshDoseSummary() {
    const slot = document.querySelector("#dose-summary");
    const button = document.querySelector("#dose-submit");
    if (!slot || !ui.dialog || ui.dialog.type !== "dose") return;
    const result = doseAssessment();
    const summary = summaryHtml(result);
    slot.className = summary.className;
    slot.innerHTML = summary.html;
    if (button) {
      button.textContent = result.warnings.length
        ? "Review warning"
        : ui.dialog.doseId
          ? "Save changes"
          : "Log dose";
    }
  }

  function applyUnits() {
    const raw = String(ui.dialog.units ?? "").trim();
    if (!raw || raw.endsWith(".")) return;
    const units = PainLog.parseNum(raw);
    if (!Number.isFinite(units) || units < 0) return;
    const med = medicineById(ui.dialog.medicineId);
    if (!med || !ui.dialog.partAmounts) return;
    for (const part of PainLog.medicineParts(med)) {
      const mg = Math.round(part.mgPerUnit * units * 100) / 100;
      ui.dialog.partAmounts[part.ingredientId] = String(mg);
      const input = document.getElementById(`part-amt-${part.ingredientId}`);
      if (input) input.value = String(mg);
    }
    refreshDoseSummary();
  }

  function refreshMedicineHints() {
    if (!ui.dialog || ui.dialog.type !== "medicine" || !ui.dialog.parts) return;
    for (const part of ui.dialog.parts) {
      const hint = document.getElementById(`part-hint-${part.key}`);
      if (!hint) continue;
      const match = state.ingredients.find(
        (item) => PainLog.normName(item.name) === PainLog.normName(part.name)
      );
      if (!match) {
        hint.textContent = "";
        continue;
      }
      const others = state.medicines.filter(
        (med) =>
          med.active &&
          med.id !== ui.dialog.medicineId &&
          PainLog.medicineParts(med).some((item) => item.ingredientId === match.id)
      );
      hint.textContent = others.length
        ? `Same limit as ${others.map((med) => med.name).join(", ")}.`
        : `Uses the ${match.name} limit already saved.`;
    }
  }

  function emptyPart() {
    return { key: uid(), ingredientId: "", name: "", mgPerUnit: "", maxPer24hMg: "" };
  }

  function partFromPreset(part) {
    const existing = state.ingredients.find(
      (item) => PainLog.normName(item.name) === PainLog.normName(part.ingredientName)
    );
    return {
      key: uid(),
      ingredientId: existing ? existing.id : "",
      name: existing ? existing.name : part.ingredientName,
      mgPerUnit: part.mgPerUnit,
      maxPer24hMg: existing ? existing.maxPer24hMg : part.maxPer24hMg == null ? "" : part.maxPer24hMg
    };
  }

  function partsFromMedicine(med) {
    const parts = PainLog.medicineParts(med).map((part) => {
      const ingredient = ingredientById(part.ingredientId);
      return {
        key: uid(),
        ingredientId: part.ingredientId,
        name: ingredient ? ingredient.name : "",
        mgPerUnit: part.mgPerUnit,
        maxPer24hMg: ingredient ? ingredient.maxPer24hMg : ""
      };
    });
    return parts.length ? parts : [emptyPart()];
  }

  function openAdd() {
    const returnTo = ui.dialog && ui.dialog.type === "log-usage" ? usageReturn(ui.dialog.openId) : (ui.dialog && ui.dialog.returnTo) || null;
    ui.dialog = { type: "medicine", stage: "pick", returnTo };
    render();
  }

  function blankMedicine(partial) {
    ui.dialog = {
      type: "medicine",
      stage: "form",
      medicineId: null,
      name: "",
      parts: [emptyPart()],
      doseWords: "",
      intervalHours: 6,
      asNeeded: true,
      focusPartKey: "",
      errors: [],
      returnTo: null,
      ...partial
    };
    render();
  }

  function openPreset(presetId) {
    const returnTo = (ui.dialog && ui.dialog.returnTo) || null;
    if (presetId === "custom") {
      blankMedicine({ returnTo });
      return;
    }
    const preset = PainLog.PRESETS.find((item) => item.id === presetId);
    if (!preset) return;
    blankMedicine({
      name: preset.medicineName,
      parts: presetParts(preset).map(partFromPreset),
      doseWords: preset.doseWords,
      intervalHours: preset.intervalHours,
      asNeeded: preset.asNeeded,
      returnTo
    });
  }

  function openEditMedicine(id) {
    const med = medicineById(id);
    if (!med) return;
    const returnTo = ui.dialog && ui.dialog.type === "log-usage" ? usageReturn(id) : (ui.dialog && ui.dialog.returnTo) || null;
    ui.dialog = {
      type: "medicine",
      stage: "form",
      medicineId: med.id,
      name: med.name,
      parts: partsFromMedicine(med),
      doseWords: med.doseWords,
      intervalHours: med.intervalHours,
      asNeeded: med.asNeeded,
      focusPartKey: "",
      errors: [],
      returnTo
    };
    render();
  }

  function comboAmounts(med, dose) {
    const parts = PainLog.medicineParts(med);
    if (parts.length < 2) return null;
    const partAmounts = {};
    let units = "1";
    if (dose && Array.isArray(dose.parts)) {
      const ratios = parts.map((part) => {
        const found = dose.parts.find((item) => item.ingredientId === part.ingredientId);
        partAmounts[part.ingredientId] = found ? String(found.amountMg) : "";
        return found && part.mgPerUnit > 0 ? found.amountMg / part.mgPerUnit : null;
      });
      if (ratios.every((ratio) => ratio !== null && Math.abs(ratio - ratios[0]) < 1e-6)) {
        units = String(Math.round(ratios[0] * 1000) / 1000);
      }
    } else {
      for (const part of parts) partAmounts[part.ingredientId] = String(part.mgPerUnit);
    }
    return { units, partAmounts };
  }

  function openDose(medicineId, dose, returnTo) {
    const med = medicineById(medicineId);
    if (!dose && (!med || !med.active)) return;
    const now = new Date();
    const combo = comboAmounts(med, dose || null);
    ui.dialog = dose
      ? {
          type: "dose",
          step: "edit",
          doseId: dose.id,
          medicineId: dose.medicineId,
          amountMg: String(dose.amountMg),
          units: combo ? combo.units : "",
          partAmounts: combo ? combo.partAmounts : null,
          doseWords: dose.doseWords,
          takenAt: PainLog.toLocalInput(new Date(dose.takenAt)),
          painBefore: dose.painBefore,
          painAfter: dose.painAfter,
          note: dose.note,
          errors: []
        }
      : {
          type: "dose",
          step: "edit",
          doseId: null,
          medicineId,
          amountMg: med.usualDoseMg > 0 ? String(med.usualDoseMg) : "",
          units: combo ? combo.units : "",
          partAmounts: combo ? combo.partAmounts : null,
          doseWords: med.doseWords,
          takenAt: PainLog.toLocalInput(defaultTaken(selectedDay(now), now)),
          painBefore: null,
          painAfter: null,
          note: "",
          errors: []
        };
    ui.dialog.returnTo = returnTo || null;
    render();
  }

  function commitDose() {
    const taken = PainLog.fromLocalInput(ui.dialog.takenAt);
    const med = medicineById(ui.dialog.medicineId);
    const medParts = med ? PainLog.medicineParts(med) : [];
    let parts;
    let amount;
    if (medParts.length > 1) {
      parts = medParts.map((part) => ({
        ingredientId: part.ingredientId,
        amountMg: PainLog.parseNum(ui.dialog.partAmounts[part.ingredientId])
      }));
      amount = Math.round(parts.reduce((sum, part) => sum + part.amountMg, 0) * 100) / 100;
    } else {
      amount = PainLog.parseNum(ui.dialog.amountMg);
      parts = [{ ingredientId: medParts[0] ? medParts[0].ingredientId : med.ingredientId, amountMg: amount }];
    }
    const dose = {
      id: ui.dialog.doseId || uid(),
      medicineId: ui.dialog.medicineId,
      takenAt: taken.toISOString(),
      amountMg: amount,
      parts,
      doseWords: PainLog.cleanText(ui.dialog.doseWords, 80),
      painBefore: PAIN.some((item) => item.id === ui.dialog.painBefore) ? ui.dialog.painBefore : null,
      painAfter: PAIN.some((item) => item.id === ui.dialog.painAfter) ? ui.dialog.painAfter : null,
      note: PainLog.cleanText(ui.dialog.note, 200)
    };
    const editing = !!ui.dialog.doseId;
    if (editing) {
      const index = state.doses.findIndex((item) => item.id === dose.id);
      if (index >= 0) state.doses[index] = dose;
    } else {
      state.doses.push(dose);
    }
    const loggedDay = PainLog.localDateKey(taken);
    const visible = rangeWindow(new Date());
    const outside = (visible.from && loggedDay < visible.from) || (visible.to && loggedDay > visible.to);
    if (outside) {
      ui.range = "custom";
      ui.rangeFrom = loggedDay;
      ui.rangeTo = loggedDay;
    }
    ui.dialog = null;
    if (persist()) toast(editing ? "Dose updated." : "Dose logged.");
    render();
  }

  function saveMedicine() {
    syncFromDom();
    const dialog = ui.dialog;
    const errors = [];
    const name = PainLog.cleanText(dialog.name, 80);
    if (!name) errors.push("Enter the medicine’s name.");
    const activeDup = state.medicines.find(
      (item) => item.active && item.id !== dialog.medicineId && PainLog.normName(item.name) === PainLog.normName(name)
    );
    const retiredDup = state.medicines.find(
      (item) => !item.active && item.id !== dialog.medicineId && PainLog.normName(item.name) === PainLog.normName(name)
    );
    if (activeDup) errors.push("That medicine is already on the list. Edit it instead of adding it again.");
    if (retiredDup) errors.push("That medicine was removed. Put it back from Removed medicines instead of adding it again.");

    const interval = PainLog.parseNum(String(dialog.intervalHours));
    if (!Number.isFinite(interval) || interval < 0 || interval > 72) {
      errors.push("Enter the hours between doses, from 0 to 72.");
    }

    const cleaned = (dialog.parts || []).map((part) => ({
      ingredientId: part.ingredientId,
      name: PainLog.cleanText(part.name, 80),
      mg: PainLog.parseNum(String(part.mgPerUnit)),
      max: PainLog.parseNum(String(part.maxPer24hMg))
    }));
    if (!cleaned.length) errors.push("Add at least one drug.");
    if (cleaned.some((part) => !part.name)) errors.push("Enter a name for each drug.");
    if (cleaned.some((part) => !Number.isFinite(part.mg) || part.mg <= 0 || part.mg > 20000)) {
      errors.push("Enter the milligrams in one dose of each drug.");
    }
    if (cleaned.some((part) => !Number.isFinite(part.max) || part.max <= 0 || part.max > 50000)) {
      errors.push("Enter the daily max for each drug.");
    }
    const seenNames = new Set();
    for (const part of cleaned) {
      if (!part.name) continue;
      const key = PainLog.normName(part.name);
      if (seenNames.has(key)) errors.push("Each drug in one medicine needs its own name.");
      seenNames.add(key);
      if (Number.isFinite(part.mg) && Number.isFinite(part.max) && part.mg > part.max) {
        errors.push(`${part.name}: the dose is higher than the daily max.`);
      }
    }

    const usedByOthers = (ingredientId) =>
      state.medicines.some(
        (med) => med.id !== dialog.medicineId && PainLog.medicineParts(med).some((part) => part.ingredientId === ingredientId)
      );
    const planned = [];
    if (!errors.length) {
      for (const part of cleaned) {
        const norm = PainLog.normName(part.name);
        const bound = part.ingredientId ? ingredientById(part.ingredientId) : null;
        const named = state.ingredients.find((item) => PainLog.normName(item.name) === norm);
        let ingredient;
        if (bound && PainLog.normName(bound.name) === norm) ingredient = bound;
        else if (named) ingredient = named;
        else if (bound && !usedByOthers(bound.id)) ingredient = bound;
        else ingredient = { id: uid(), name: part.name, maxPer24hMg: part.max, isNew: true };
        planned.push({ ingredient, name: part.name, max: part.max, mg: part.mg });
      }
      const ids = planned.map((item) => item.ingredient.id);
      if (new Set(ids).size !== ids.length) errors.push("Each drug in one medicine needs its own name.");
    }

    if (errors.length) {
      dialog.errors = errors;
      render();
      return;
    }

    for (const row of planned) {
      row.ingredient.name = row.name;
      row.ingredient.maxPer24hMg = row.max;
      if (row.ingredient.isNew) {
        delete row.ingredient.isNew;
        state.ingredients.push(row.ingredient);
      }
    }

    const record = {
      name,
      parts: planned.map((row) => ({ ingredientId: row.ingredient.id, mgPerUnit: row.mg })),
      ingredientId: planned[0].ingredient.id,
      usualDoseMg: planned[0].mg,
      doseWords: PainLog.cleanText(dialog.doseWords, 80),
      intervalHours: interval,
      asNeeded: !!dialog.asNeeded,
      active: true
    };
    const savedId = dialog.medicineId || uid();
    if (dialog.medicineId) {
      const med = medicineById(dialog.medicineId);
      Object.assign(med, record);
    } else {
      state.medicines.push({ id: savedId, ...record });
    }
    ui.dialog = dialog.returnTo && dialog.returnTo.type === "log-usage" ? usageReturn(savedId) : null;
    if (persist()) toast("Medicine saved.");
    render();
  }

  function askConfirm(partial) {
    ui.dialog = {
      type: "confirm",
      danger: true,
      title: "",
      body: "",
      confirmLabel: "Confirm",
      kind: "",
      ...partial
    };
    render();
  }

  function onTabKey(event) {
    const current = event.target.closest && event.target.closest("[role=tab]");
    if (!current || !app.contains(current)) return;
    const index = TABS.findIndex((item) => item.id === current.dataset.tab);
    if (index < 0) return;
    let nextIndex = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") nextIndex = (index + 1) % TABS.length;
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") nextIndex = (index - 1 + TABS.length) % TABS.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = TABS.length - 1;
    else return;
    event.preventDefault();
    ui.tab = TABS[nextIndex].id;
    current.blur();
    render();
    const selected = app.querySelector(`[data-tab="${ui.tab}"]`);
    if (selected) selected.focus();
  }

  function onClick(event) {
    const button = event.target.closest("[data-action]");
    if (!button || button.disabled) return;
    const action = button.dataset.action;
    if (action === "set-tab") {
      const next = button.dataset.tab;
      if (TABS.some((item) => item.id === next)) ui.tab = next;
      render();
      return;
    }
    if (action === "set-range") {
      ui.range = button.dataset.range || "today";
      if (ui.range === "custom") {
        const today = PainLog.localDateKey(new Date());
        if (!ui.rangeFrom) ui.rangeFrom = today;
        if (!ui.rangeTo) ui.rangeTo = today;
      }
      render();
      return;
    }
    if (action === "log-usage") {
      ui.dialog = usageReturn("");
      render();
      return;
    }
    if (action === "add-medicine") {
      openAdd();
      return;
    }
    if (action === "pick-preset") {
      openPreset(button.dataset.preset);
      return;
    }
    if (action === "edit-medicine") {
      openEditMedicine(button.dataset.id);
      return;
    }
    if (action === "log-dose") {
      const returnTo = ui.dialog && ui.dialog.type === "log-usage" ? usageReturn(button.dataset.id) : null;
      openDose(button.dataset.id, null, returnTo);
      return;
    }
    if (action === "edit-dose") {
      const dose = state.doses.find((item) => item.id === button.dataset.id);
      if (dose) openDose(dose.medicineId, dose);
      return;
    }
    if (action === "delete-dose") {
      const dose = state.doses.find((item) => item.id === button.dataset.id);
      if (!dose) return;
      const med = medicineById(dose.medicineId);
      askConfirm({
        kind: "delete-dose",
        doseId: dose.id,
        danger: true,
        title: "Delete this dose?",
        body: `${med ? med.name : "This dose"}, ${doseAmountPhrase(dose)} at ${formatTime(dose.takenAt)}, will be removed from this device.`,
        confirmLabel: "Delete dose"
      });
      return;
    }
    if (action === "retire-medicine") {
      const med = medicineById(button.dataset.id);
      if (!med) return;
      const returnTo = (ui.dialog && ui.dialog.returnTo) || null;
      askConfirm({
        kind: "retire-medicine",
        medicineId: med.id,
        danger: true,
        title: `Remove ${med.name}?`,
        body: "It leaves the list. Past doses stay in the log, and you can put it back later.",
        confirmLabel: "Remove from list",
        returnTo
      });
      return;
    }
    if (action === "restore-medicine") {
      const med = medicineById(button.dataset.id);
      if (!med) return;
      med.active = true;
      if (ui.dialog && ui.dialog.type === "log-usage") ui.dialog.openId = med.id;
      if (persist()) toast(`${med.name} is back on the list.`);
      render();
      return;
    }
    if (action === "set-pain-after") {
      const dose = state.doses.find((item) => item.id === button.dataset.id);
      if (!dose) return;
      dose.painAfter = dose.painAfter === button.dataset.level ? null : button.dataset.level;
      if (persist()) toast("Pain after saved.");
      render();
      return;
    }
    if (action === "set-pain") {
      if (!ui.dialog || ui.dialog.type !== "dose") return;
      const key = button.dataset.which === "before" ? "painBefore" : "painAfter";
      const level = button.dataset.level;
      ui.dialog[key] = ui.dialog[key] === level ? null : level;
      document.querySelectorAll(`[data-which="${button.dataset.which}"]`).forEach((el) => {
        el.setAttribute("aria-pressed", el.dataset.level === ui.dialog[key] ? "true" : "false");
      });
      return;
    }
    if (action === "add-part") {
      if (!ui.dialog || ui.dialog.type !== "medicine") return;
      syncFromDom();
      const part = emptyPart();
      ui.dialog.parts.push(part);
      ui.dialog.focusPartKey = part.key;
      ui.dialog.errors = [];
      render();
      return;
    }
    if (action === "remove-part") {
      if (!ui.dialog || ui.dialog.type !== "medicine") return;
      syncFromDom();
      ui.dialog.parts = (ui.dialog.parts || []).filter((part) => part.key !== button.dataset.key);
      if (!ui.dialog.parts.length) ui.dialog.parts.push(emptyPart());
      ui.dialog.errors = [];
      render();
      return;
    }
    if (action === "step-units") {
      if (!ui.dialog || ui.dialog.type !== "dose") return;
      syncFromDom();
      const current = PainLog.parseNum(ui.dialog.units);
      const base = Number.isFinite(current) ? current : 0;
      let next = Math.round((base + Number(button.dataset.dir) * 0.5) * 100) / 100;
      if (next < 0) next = 0;
      ui.dialog.units = String(next);
      const input = document.querySelector("[name=units]");
      if (input) input.value = ui.dialog.units;
      applyUnits();
      return;
    }
    if (action === "step-amount") {
      if (!ui.dialog || ui.dialog.type !== "dose") return;
      syncFromDom();
      const med = medicineById(ui.dialog.medicineId);
      const step = med && med.usualDoseMg > 0 ? med.usualDoseMg : 100;
      const current = PainLog.parseNum(ui.dialog.amountMg);
      const base = Number.isFinite(current) ? current : 0;
      let next = Math.round((base + Number(button.dataset.dir) * step) * 100) / 100;
      if (next < 0) next = 0;
      ui.dialog.amountMg = String(next);
      const input = document.querySelector("[name=amountMg]");
      if (input) input.value = ui.dialog.amountMg;
      refreshDoseSummary();
      return;
    }
    if (action === "close-dialog") {
      closeOrBack();
      return;
    }
    if (action === "back-step") {
      if (ui.dialog && ui.dialog.type === "dose") ui.dialog.step = "edit";
      render();
      return;
    }
    if (action === "confirm-save-dose") {
      commitDose();
      return;
    }
    if (action === "confirm-generic") {
      runConfirm();
      return;
    }
    if (action === "share-session") {
      shareSession();
      return;
    }
    if (action === "download-backup") {
      download(
        `pain-medicine-log-${PainLog.localDateKey(new Date())}.json`,
        JSON.stringify(PainLog.serialize(state), null, 2)
      );
      return;
    }
    if (action === "restore-backup") {
      backupInput.click();
      return;
    }
    if (action === "download-raw") {
      if (!rawBackup) {
        toast("There is no saved text to download.");
        return;
      }
      download(`pain-medicine-log-unreadable-${PainLog.localDateKey(new Date())}.json`, rawBackup);
      return;
    }
    if (action === "start-fresh") {
      try {
        localStorage.removeItem(STORAGE_KEY);
      } catch (err) {
        toast("Could not clear the saved log.");
        return;
      }
      persistBlocked = false;
      rawBackup = null;
      state = PainLog.emptyState();
      ui.dialog = null;
      ui.tab = "medicines";
      ui.range = "today";
      render();
      toast("Started a new log on this device.");
    }
  }

  function runConfirm() {
    const dialog = ui.dialog;
    if (!dialog || dialog.type !== "confirm") return;
    if (dialog.kind === "delete-dose") {
      state.doses = state.doses.filter((item) => item.id !== dialog.doseId);
      ui.dialog = null;
      if (persist()) toast("Dose deleted.");
      render();
      return;
    }
    if (dialog.kind === "retire-medicine") {
      const med = medicineById(dialog.medicineId);
      if (med) med.active = false;
      ui.dialog = dialog.returnTo && dialog.returnTo.type === "log-usage" ? usageReturn("") : null;
      if (persist()) toast(med ? `${med.name} removed from the list.` : "Medicine removed.");
      render();
      return;
    }
    if (dialog.kind === "restore") {
      state = dialog.pendingState;
      ui.dialog = null;
      ui.range = "today";
      if (persist()) toast("Backup restored on this device.");
      render();
    }
  }

  function onSubmit(event) {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    event.preventDefault();
    if (form.dataset.form === "dose") {
      syncFromDom();
      const result = doseAssessment();
      if (result.errors.length) {
        ui.dialog.errors = result.errors;
        ui.dialog.step = "edit";
        render();
        return;
      }
      if (result.warnings.length) {
        ui.dialog.errors = [];
        ui.dialog.step = "confirm";
        render();
        return;
      }
      commitDose();
      return;
    }
    if (form.dataset.form === "medicine") saveMedicine();
  }

  function onInput(event) {
    if (!ui.dialog) return;
    syncFromDom();
    if (ui.dialog.type === "dose" && ui.dialog.step === "edit") {
      if (event.target && event.target.name === "units") applyUnits();
      else refreshDoseSummary();
    }
    if (ui.dialog.type === "medicine" && ui.dialog.stage !== "pick") refreshMedicineHints();
  }

  function onChange(event) {
    const target = event.target;
    if (target.name === "range-from" || target.name === "range-to") {
      const today = PainLog.localDateKey(new Date());
      if (target.name === "range-from") ui.rangeFrom = target.value || today;
      else ui.rangeTo = target.value || today;
      ui.range = "custom";
      render();
    }
  }

  function onBackupFile() {
    const file = backupInput.files && backupInput.files[0];
    backupInput.value = "";
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      let parsed;
      try {
        parsed = JSON.parse(String(reader.result || ""));
      } catch (err) {
        toast("That file is not a log this page can read.");
        return;
      }
      const result = PainLog.normalize(parsed);
      if (!result.recognized || (!result.state.medicines.length && !result.state.doses.length)) {
        toast("That file has no medicines or doses this page can read.");
        return;
      }
      const dropped = result.dropped
        ? ` ${result.dropped} ${result.dropped === 1 ? "entry was" : "entries were"} left out because they could not be read.`
        : "";
      askConfirm({
        kind: "restore",
        danger: true,
        pendingState: result.state,
        title: "Replace the log on this device?",
        body: `This file has ${result.state.medicines.length} ${result.state.medicines.length === 1 ? "medicine" : "medicines"} and ${result.state.doses.length} ${result.state.doses.length === 1 ? "dose" : "doses"}.${dropped}`,
        confirmLabel: "Replace log"
      });
    };
    reader.onerror = () => toast("Could not read that file.");
    reader.readAsText(file);
  }

  function boot() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const result = PainLog.normalize(JSON.parse(raw));
        if (!result.recognized) {
          persistBlocked = true;
          rawBackup = raw;
        } else {
          state = result.state;
        }
      }
    } catch (err) {
      persistBlocked = true;
      try {
        rawBackup = localStorage.getItem(STORAGE_KEY);
      } catch (readErr) {
        rawBackup = null;
      }
    }
    if (persistBlocked) {
      render();
      wire();
      if (sessionId) {
        loadSharedSession().then(() => render()).catch(() => {
          toast("Could not open that shared log. Showing the copy on this device.");
        });
      }
      return;
    }
    if (!sessionId) {
      const preferred = preferredSession();
      if (preferred) {
        goToSession(preferred);
        return;
      }
    }
    render();
    wire();
    if (sessionId) {
      loadSharedSession().then(() => render()).catch(() => {
        toast("Could not open that shared log. Showing the copy on this device.");
      });
      return;
    }
    ensureSession().then((id) => goToSession(id)).catch(() => {
      /* Share session reports this when it is used. */
    });
  }

  function wire() {
    setInterval(() => {
      const now = Date.now();
      document.querySelectorAll("[data-rel]").forEach((el) => {
        const target = Number(el.dataset.rel);
        if (Number.isFinite(target)) el.textContent = relPhrase(target, now);
      });
      pollSharedSession();
    }, 30000);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) pollSharedSession();
    });
    backupInput.addEventListener("change", onBackupFile);
    app.addEventListener("click", onClick);
    app.addEventListener("keydown", onTabKey);
    app.addEventListener("submit", onSubmit);
    app.addEventListener("input", onInput);
    app.addEventListener("change", onChange);
  }

  boot();
})();
