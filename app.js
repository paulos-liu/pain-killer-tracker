(function () {
  const STORAGE_KEY = "pain-medicine-log.v1";
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
  const ui = {
    day: PainLog.localDateKey(new Date()),
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

  function persist() {
    if (persistBlocked) return false;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(PainLog.serialize(state)));
      return true;
    } catch (err) {
      toast("Could not save on this device. Download a backup before you leave this page.");
      return false;
    }
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
      return {
        title: "Check this amount",
        detail: `${PainLog.formatMg(warning.amountMg)} mg is unusually large for a single dose.`
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

  function presetButtons() {
    const presets = PainLog.PRESETS.map(
      (preset) => `<button type="button" class="preset" data-action="pick-preset" data-preset="${esc(preset.id)}" data-focus-key="preset-${esc(preset.id)}">
        <span class="preset-name">${esc(preset.medicineName)}</span>
        <span class="preset-meta">${esc(PainLog.formatMg(preset.maxPer24hMg))} mg in 24 hours · every ${esc(PainLog.formatHours(preset.intervalHours))}</span>
      </button>`
    ).join("");
    return `${presets}<button type="button" class="preset" data-action="pick-preset" data-preset="custom" data-focus-key="preset-custom">
      <span class="preset-name">Other medicine</span>
      <span class="preset-meta">Set the name, the dose, and the daily max yourself.</span>
    </button>`;
  }

  function usualLine(med) {
    const bits = [];
    if (med.usualDoseMg > 0) bits.push(`${PainLog.formatMg(med.usualDoseMg)} mg`);
    if (med.doseWords) bits.push(med.doseWords);
    bits.push(med.intervalHours > 0 ? `every ${PainLog.formatHours(med.intervalHours)}` : "no interval set");
    if (med.asNeeded) bits.push("as needed");
    return bits.join(" · ");
  }

  function shareLine(med) {
    const ingredient = ingredientById(med.ingredientId);
    if (!ingredient) return "";
    const others = state.medicines.filter(
      (item) => item.active && item.id !== med.id && item.ingredientId === ingredient.id
    );
    const bits = [];
    if (PainLog.normName(med.name) !== PainLog.normName(ingredient.name)) bits.push(`Counts toward ${ingredient.name}`);
    if (others.length) bits.push(`Shared with ${others.map((item) => item.name).join(", ")}`);
    return bits.join(" · ");
  }

  function cardHtml(med, now) {
    const ingredient = ingredientById(med.ingredientId);
    const window = ingredient
      ? PainLog.ingredientWindow(state, ingredient.id, now)
      : { used: 0, max: 0, remaining: 0 };
    const tone = toneFor(window.used, window.max);
    const pct = window.max > 0 ? Math.max(0, Math.min(100, (window.used / window.max) * 100)) : 0;
    let remain = "Set a daily max to track this medicine.";
    if (window.max > 0 && window.used > window.max + 1e-6) {
      remain = `${PainLog.formatMg(window.used - window.max)} mg over this 24-hour window`;
    } else if (window.max > 0 && window.remaining <= 1e-6) {
      remain = "No room left in this 24-hour window";
    } else if (window.max > 0) {
      remain = `${PainLog.formatMg(window.remaining)} mg left in this 24-hour window`;
    }
    const timing = PainLog.medicineTiming(state, med, now);
    let next = "No interval set.";
    if (med.intervalHours > 0 && timing.lastAt === null) next = "No doses logged yet.";
    if (med.intervalHours > 0 && timing.nextAt !== null) {
      const label = med.asNeeded ? "Earliest next dose" : "Next dose";
      next = `${label} <time>${esc(formatTime(timing.nextAt))}</time> <span class="rel" data-rel="${timing.nextAt}">${esc(relPhrase(timing.nextAt, now.getTime()))}</span>`;
    }
    const shared = shareLine(med);
    const maxLabel = ingredient ? ingredient.name : med.name;
    return `<article class="card">
      <div class="card-head">
        <div>
          <h3>${esc(med.name)}</h3>
          <p class="meta">${esc(usualLine(med))}</p>
          ${shared ? `<p class="share">${esc(shared)}</p>` : ""}
        </div>
        <button type="button" class="btn btn-quiet" data-action="edit-medicine" data-id="${esc(med.id)}" data-focus-key="edit-med-${esc(med.id)}">Edit</button>
      </div>
      <div class="meter tone-${tone}" role="meter" aria-valuemin="0" aria-valuemax="${esc(window.max)}" aria-valuenow="${esc(window.used)}" aria-label="${esc(maxLabel)} in the last 24 hours">
        <span style="width:${pct}%"></span>
      </div>
      <p class="readout tone-${tone}"><span class="num">${esc(PainLog.formatMg(window.used))}</span> <span>of ${esc(PainLog.formatMg(window.max))} mg</span></p>
      <p class="readout-sub">in the last 24 hours</p>
      <p class="remain tone-${tone}">${esc(remain)}</p>
      <p class="next">${next}</p>
      <button type="button" class="btn btn-primary" data-action="log-dose" data-id="${esc(med.id)}" data-focus-key="log-${esc(med.id)}">Log a dose<span class="sr"> of ${esc(med.name)}</span></button>
    </article>`;
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

  function cardsSection(now) {
    const active = state.medicines
      .filter((item) => item.active)
      .sort((a, b) => a.name.localeCompare(b.name));
    const retired = state.medicines.filter((item) => !item.active);
    if (!active.length) {
      return `<section class="panel">
        <h2>Add a medicine to start</h2>
        <p class="section-copy">Set a daily max and the hours between doses. You can change both later. Preset numbers are common US adult label limits, not a dose chosen for you.</p>
        <div class="preset-list">${presetButtons()}</div>
        ${retiredBlock(retired)}
      </section>`;
    }
    return `<section>
      <div class="section-head">
        <h2>Right now</h2>
        <p class="section-copy">The last 24 hours, against the daily max you set. A dose is over the limit when any 24-hour stretch would pass that number.</p>
      </div>
      <div class="cards">${active.map((med) => cardHtml(med, now)).join("")}</div>
      <p class="add-row"><button type="button" class="btn btn-secondary" data-action="add-medicine" data-focus-key="add-medicine">Add a medicine</button></p>
      ${retiredBlock(retired)}
    </section>`;
  }

  function rowFlags(dose) {
    const taken = new Date(dose.takenAt);
    const result = PainLog.assessDose(
      state,
      {
        medicineId: dose.medicineId,
        amountMg: dose.amountMg,
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

  function dayBounds() {
    const today = PainLog.localDateKey(new Date());
    let latest = today;
    for (const dose of state.doses) {
      const key = PainLog.localDateKey(new Date(dose.takenAt));
      if (key > latest) latest = key;
    }
    return { today, latest };
  }

  function logSection(now) {
    const bounds = dayBounds();
    const todayKey = bounds.today;
    if (ui.day > bounds.latest) ui.day = bounds.latest;
    const doses = PainLog.dosesOnDay(state, ui.day);
    const totals = new Map();
    for (const dose of doses) {
      const med = medicineById(dose.medicineId);
      const ingredient = med ? ingredientById(med.ingredientId) : null;
      const key = ingredient ? ingredient.id : dose.medicineId;
      const name = ingredient ? ingredient.name : med ? med.name : "Medicine";
      const row = totals.get(key) || { name, mg: 0 };
      row.mg += dose.amountMg;
      totals.set(key, row);
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
          <td data-label="Time">${esc(formatTime(dose.takenAt))}</td>
          <td data-label="Medicine"><div>${esc(name)}${dose.note ? `<div class="note">${esc(dose.note)}</div>` : ""}${tags ? `<div class="tags">${tags}</div>` : ""}</div></td>
          <td data-label="Dose"><div><div class="num">${esc(PainLog.formatMg(dose.amountMg))} mg</div>${dose.doseWords ? `<div class="words">${esc(dose.doseWords)}</div>` : ""}</div></td>
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
    return `<section>
      <div class="section-head">
        <p class="eyebrow">This day</p>
        <div class="day-line">
          <button type="button" class="btn btn-secondary" data-action="prev-day" data-focus-key="prev-day">Prev</button>
          <h2>${esc(formatDay(ui.day))}</h2>
          <button type="button" class="btn btn-secondary" data-action="next-day" data-focus-key="next-day" ${ui.day >= bounds.latest ? "disabled" : ""}>Next</button>
        </div>
        <div class="jump">
          <label class="sr" for="jump-day">Jump to a day</label>
          <input id="jump-day" name="day" type="date" max="${bounds.latest}" value="${esc(ui.day)}">
          ${ui.day !== todayKey ? `<button type="button" class="btn btn-quiet" data-action="today" data-focus-key="today">Today</button>` : ""}
        </div>
        <p class="section-copy">Calendar day, for the record you can bring to an appointment. The max itself is any 24-hour stretch.</p>
        ${totalText ? `<p class="day-totals">This calendar day: ${esc(totalText)}.</p>` : ""}
      </div>
      ${
        doses.length
          ? `<div class="table-wrap"><table class="log">
              <caption class="sr">Doses on ${esc(formatDay(ui.day))}</caption>
              <thead><tr><th>Time taken</th><th>Medicine</th><th>Dose</th><th>Next dose</th><th>Pain before</th><th>Pain after</th><th></th></tr></thead>
              <tbody>${rows}</tbody>
            </table></div>`
          : `<p class="empty-day">Nothing logged this day.</p>`
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
    return PainLog.assessDose(
      state,
      {
        medicineId: ui.dialog.medicineId,
        amountMg: ui.dialog.amountMg,
        takenAt: PainLog.fromLocalInput(ui.dialog.takenAt),
        excludeDoseId: ui.dialog.doseId
      },
      new Date()
    );
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
    const lines = [
      `<p class="summary-total"><span class="num">${esc(PainLog.formatMg(result.peakMg))}</span> of <span class="num">${esc(PainLog.formatMg(result.maxMg))} mg</span></p>`,
      `<p>Highest total in any 24 hours for ${esc(result.ingredientName)}.</p>`
    ];
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
    return sheet(`<form class="sheet-form" data-form="dose" novalidate>
      <div class="sheet-top">
        <h2 id="dialog-title">${esc(title)}</h2>
        <button type="button" class="btn btn-quiet" data-action="close-dialog">Close</button>
      </div>
      <div class="sheet-body">
      ${errorBlock(ui.dialog.errors)}
      <div class="field">
        <label for="amountMg">Amount (mg)</label>
        <div class="amount-row">
          <button type="button" class="stepper" data-action="step-amount" data-dir="-1" aria-label="Decrease amount">−</button>
          <input id="amountMg" name="amountMg" type="text" inputmode="decimal" autocomplete="off" value="${esc(ui.dialog.amountMg)}" ${hasErrors ? "" : "data-autofocus"}>
          <button type="button" class="stepper" data-action="step-amount" data-dir="1" aria-label="Increase amount">+</button>
        </div>
        <p class="hint">Steps by the usual dose. You can also type a number.</p>
      </div>
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
        <p class="hint">Leave this blank if you do not know yet. You can set it from the day list later.</p>
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
      <p class="section-copy">${esc(med ? med.name : "This medicine")}, ${esc(PainLog.formatMg(PainLog.parseNum(ui.dialog.amountMg)))} mg${taken ? ` at ${esc(formatTime(taken))}` : ""}.</p>
      <ul class="warn-list">${items}</ul>
      </div>
      <div class="sheet-actions">
        <button type="button" class="btn btn-secondary" data-action="back-step">Go back</button>
        <button type="button" class="btn btn-danger" data-action="confirm-save-dose">${esc(saveLabel)}</button>
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
      <p class="section-copy">Preset numbers are common US adult label limits. Change them on the next screen if the bottle or the clinician says something else.</p>
      <div class="preset-list">${presetButtons()}</div>
      </div>
      </div>`);
  }

  function medicineDialog() {
    const editing = !!ui.dialog.medicineId;
    const hasIngredients = state.ingredients.length > 0;
    const mode = ui.dialog.ingredientMode === "existing" && hasIngredients ? "existing" : "new";
    ui.dialog.ingredientMode = mode;
    const others = state.medicines.filter(
      (item) => item.active && item.ingredientId === ui.dialog.ingredientId && item.id !== ui.dialog.medicineId
    );
    const shareNote =
      mode === "existing" && others.length
        ? `Changing this limit also changes it for ${others.map((item) => item.name).join(", ")}.`
        : "";
    const hasErrors = ui.dialog.errors && ui.dialog.errors.length;
    return sheet(`<form class="sheet-form" data-form="medicine" novalidate>
      <div class="sheet-top">
        <h2 id="dialog-title">${editing ? "Edit medicine" : "Add a medicine"}</h2>
        <button type="button" class="btn btn-quiet" data-action="close-dialog">Close</button>
      </div>
      <div class="sheet-body">
      ${ui.dialog.blurb ? `<p class="blurb">${esc(ui.dialog.blurb)}</p>` : ""}
      ${errorBlock(ui.dialog.errors)}
      <div class="field">
        <label for="med-name">Medicine</label>
        <input id="med-name" name="name" type="text" autocomplete="off" maxlength="80" value="${esc(ui.dialog.name)}" ${hasErrors ? "" : "data-autofocus"}>
      </div>
      ${
        hasIngredients
          ? `<fieldset class="mode">
              <legend>Which daily max</legend>
              <label class="check"><input type="radio" name="ingredientMode" value="existing" ${mode === "existing" ? "checked" : ""}> Use an existing limit</label>
              <label class="check"><input type="radio" name="ingredientMode" value="new" ${mode === "new" ? "checked" : ""}> New limit</label>
            </fieldset>
            ${
              mode === "existing"
                ? `<div class="field"><label for="ingredientId">Counts toward</label><select id="ingredientId" name="ingredientId">${state.ingredients
                    .map(
                      (item) => `<option value="${esc(item.id)}" ${item.id === ui.dialog.ingredientId ? "selected" : ""}>${esc(item.name)}</option>`
                    )
                    .join("")}</select></div>`
                : ""
            }`
          : ""
      }
      <div class="field">
        <label for="limitName">${mode === "existing" ? "Limit name" : "What this max is for"}</label>
        <input id="limitName" name="limitName" type="text" autocomplete="off" maxlength="80" value="${esc(ui.dialog.limitName)}" placeholder="Acetaminophen">
        <p class="hint" id="limit-hint"></p>
      </div>
      <div class="field">
        <label for="maxPer24hMg">Max in any 24 hours (mg)</label>
        <input id="maxPer24hMg" name="maxPer24hMg" type="text" inputmode="decimal" autocomplete="off" value="${esc(ui.dialog.maxPer24hMg)}">
        ${shareNote ? `<p class="hint">${esc(shareNote)}</p>` : ""}
      </div>
      <div class="field">
        <label for="usualDoseMg">Usual dose (mg)</label>
        <input id="usualDoseMg" name="usualDoseMg" type="text" inputmode="decimal" autocomplete="off" value="${esc(ui.dialog.usualDoseMg)}">
      </div>
      <div class="field">
        <label for="med-words">Usual description</label>
        <input id="med-words" name="doseWords" type="text" autocomplete="off" maxlength="80" value="${esc(ui.dialog.doseWords)}" placeholder="1 tablet">
      </div>
      <div class="field">
        <label for="intervalHours">Hours between doses</label>
        <input id="intervalHours" name="intervalHours" type="text" inputmode="decimal" autocomplete="off" value="${esc(ui.dialog.intervalHours)}">
        <p class="hint">Use 0 if you do not want an interval warning.</p>
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
        <p class="eyebrow">On this device</p>
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

  function view() {
    if (persistBlocked) return corruptView();
    const now = new Date();
    return `<div class="wrap">
      <header class="top">
        <p class="eyebrow">On this device</p>
        <h1>Pain medicine log</h1>
        <p class="lede">Doses, pain before and after, and how close each medicine is to the daily max you set. Saved in this browser.</p>
      </header>
      <aside class="safety">
        <p><strong>Call 911</strong> if breathing slows or stops, or if the person cannot be woken.</p>
        <p>Do not go past the limit you were given. This page only keeps the record.</p>
      </aside>
      ${cardsSection(now)}
      ${logSection(now)}
      <footer>
        <p>Not medical advice. Set each daily max from the bottle or the clinician. Medicines that share an ingredient, especially acetaminophen, should share one daily max.</p>
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
    ui.dialog = null;
    render();
  }

  function syncFromDom() {
    const form = document.querySelector("form[data-form]");
    if (!form || !ui.dialog) return;
    const data = new FormData(form);
    if (form.dataset.form === "dose") {
      ui.dialog.amountMg = String(data.get("amountMg") ?? "");
      ui.dialog.doseWords = String(data.get("doseWords") ?? "");
      ui.dialog.takenAt = String(data.get("takenAt") ?? "");
      ui.dialog.note = String(data.get("note") ?? "");
      return;
    }
    if (form.dataset.form === "medicine") {
      ui.dialog.name = String(data.get("name") ?? "");
      ui.dialog.limitName = String(data.get("limitName") ?? "");
      ui.dialog.maxPer24hMg = String(data.get("maxPer24hMg") ?? "");
      ui.dialog.usualDoseMg = String(data.get("usualDoseMg") ?? "");
      ui.dialog.doseWords = String(data.get("doseWords") ?? "");
      ui.dialog.intervalHours = String(data.get("intervalHours") ?? "");
      const mode = data.get("ingredientMode");
      if (mode === "new" || mode === "existing") ui.dialog.ingredientMode = mode;
      const ingredientId = data.get("ingredientId");
      if (ingredientId) ui.dialog.ingredientId = String(ingredientId);
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

  function refreshMedicineHints() {
    const hint = document.querySelector("#limit-hint");
    if (!hint || !ui.dialog || ui.dialog.type !== "medicine" || ui.dialog.ingredientMode !== "new") return;
    const match = state.ingredients.find(
      (item) => PainLog.normName(item.name) === PainLog.normName(ui.dialog.limitName)
    );
    hint.textContent = match
      ? `This uses the ${match.name} limit already on this device. Saving sets that limit to the number above.`
      : "Use the ingredient name when several products share a max, such as Acetaminophen.";
  }

  function openAdd() {
    ui.dialog = { type: "medicine", stage: "pick" };
    render();
  }

  function blankMedicine(partial) {
    ui.dialog = {
      type: "medicine",
      stage: "form",
      medicineId: null,
      name: "",
      ingredientMode: "new",
      ingredientId: state.ingredients[0] ? state.ingredients[0].id : "",
      limitName: "",
      maxPer24hMg: "",
      usualDoseMg: "",
      doseWords: "",
      intervalHours: 6,
      asNeeded: true,
      blurb: "",
      errors: [],
      ...partial
    };
    render();
  }

  function openPreset(presetId) {
    if (presetId === "custom") {
      blankMedicine({});
      return;
    }
    const preset = PainLog.PRESETS.find((item) => item.id === presetId);
    if (!preset) return;
    const existing = state.ingredients.find(
      (item) => PainLog.normName(item.name) === PainLog.normName(preset.ingredientName)
    );
    blankMedicine({
      name: preset.medicineName,
      ingredientMode: existing ? "existing" : "new",
      ingredientId: existing ? existing.id : "",
      limitName: existing ? existing.name : preset.ingredientName,
      maxPer24hMg: existing ? existing.maxPer24hMg : preset.maxPer24hMg,
      usualDoseMg: preset.usualDoseMg,
      doseWords: preset.doseWords,
      intervalHours: preset.intervalHours,
      asNeeded: preset.asNeeded,
      blurb: existing
        ? `${preset.blurb} ${existing.name} is already on this device with a ${PainLog.formatMg(existing.maxPer24hMg)} mg limit, so this medicine counts toward that limit. Change the max below if you want a different number.`
        : preset.blurb
    });
  }

  function openEditMedicine(id) {
    const med = medicineById(id);
    if (!med) return;
    const ingredient = ingredientById(med.ingredientId);
    ui.dialog = {
      type: "medicine",
      stage: "form",
      medicineId: med.id,
      name: med.name,
      ingredientMode: "existing",
      ingredientId: med.ingredientId,
      limitName: ingredient ? ingredient.name : med.name,
      maxPer24hMg: ingredient ? ingredient.maxPer24hMg : "",
      usualDoseMg: med.usualDoseMg,
      doseWords: med.doseWords,
      intervalHours: med.intervalHours,
      asNeeded: med.asNeeded,
      blurb: "",
      errors: []
    };
    render();
  }

  function openDose(medicineId, dose) {
    const med = medicineById(medicineId);
    if (!dose && (!med || !med.active)) return;
    const now = new Date();
    ui.dialog = dose
      ? {
          type: "dose",
          step: "edit",
          doseId: dose.id,
          medicineId: dose.medicineId,
          amountMg: String(dose.amountMg),
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
          doseWords: med.doseWords,
          takenAt: PainLog.toLocalInput(defaultTaken(ui.day, now)),
          painBefore: null,
          painAfter: null,
          note: "",
          errors: []
        };
    render();
  }

  function commitDose() {
    const taken = PainLog.fromLocalInput(ui.dialog.takenAt);
    const amount = PainLog.parseNum(ui.dialog.amountMg);
    const dose = {
      id: ui.dialog.doseId || uid(),
      medicineId: ui.dialog.medicineId,
      takenAt: taken.toISOString(),
      amountMg: amount,
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
    ui.day = PainLog.localDateKey(taken);
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

    const usual = PainLog.parseNum(String(dialog.usualDoseMg));
    if (!Number.isFinite(usual) || usual <= 0 || usual > 20000) {
      errors.push("Enter the usual dose in milligrams.");
    }
    const interval = PainLog.parseNum(String(dialog.intervalHours));
    if (!Number.isFinite(interval) || interval < 0 || interval > 72) {
      errors.push("Enter the hours between doses, from 0 to 72. Use 0 if there is no interval.");
    }
    const max = PainLog.parseNum(String(dialog.maxPer24hMg));
    if (!Number.isFinite(max) || max <= 0 || max > 50000) errors.push("Enter the daily max in milligrams.");
    if (Number.isFinite(usual) && Number.isFinite(max) && usual > max) {
      errors.push("The usual dose is higher than the daily max. Lower the dose or raise the max.");
    }
    const limitName = PainLog.cleanText(dialog.limitName, 80);
    if (!limitName) errors.push("Name the daily max, such as Ibuprofen or Acetaminophen.");

    let ingredient = null;
    if (dialog.ingredientMode === "existing") {
      ingredient = ingredientById(dialog.ingredientId);
      if (!ingredient) errors.push("Choose the daily max this medicine counts toward.");
      if (ingredient && limitName) {
        const collision = state.ingredients.find(
          (item) => item.id !== ingredient.id && PainLog.normName(item.name) === PainLog.normName(limitName)
        );
        if (collision) errors.push(`${collision.name} is already a daily max. Choose it from the list instead.`);
      }
    }

    if (errors.length) {
      dialog.errors = errors;
      render();
      return;
    }

    if (dialog.ingredientMode === "existing") {
      ingredient.name = limitName;
      ingredient.maxPer24hMg = max;
    } else {
      const match = state.ingredients.find((item) => PainLog.normName(item.name) === PainLog.normName(limitName));
      if (match) {
        match.name = limitName;
        match.maxPer24hMg = max;
        ingredient = match;
      } else {
        ingredient = { id: uid(), name: limitName, maxPer24hMg: max };
        state.ingredients.push(ingredient);
      }
    }

    const record = {
      name,
      ingredientId: ingredient.id,
      usualDoseMg: usual,
      doseWords: PainLog.cleanText(dialog.doseWords, 80),
      intervalHours: interval,
      asNeeded: !!dialog.asNeeded,
      active: true
    };
    if (dialog.medicineId) {
      const med = medicineById(dialog.medicineId);
      Object.assign(med, record);
    } else {
      state.medicines.push({ id: uid(), ...record });
    }
    ui.dialog = null;
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

  function onClick(event) {
    const button = event.target.closest("[data-action]");
    if (!button || button.disabled) return;
    const action = button.dataset.action;
    if (action === "prev-day") {
      ui.day = PainLog.shiftDay(ui.day, -1);
      render();
      return;
    }
    if (action === "next-day") {
      const bounds = dayBounds();
      if (ui.day >= bounds.latest) return;
      ui.day = PainLog.shiftDay(ui.day, 1);
      render();
      return;
    }
    if (action === "today") {
      ui.day = PainLog.localDateKey(new Date());
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
      openDose(button.dataset.id, null);
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
        body: `${med ? med.name : "This dose"}, ${PainLog.formatMg(dose.amountMg)} mg at ${formatTime(dose.takenAt)}, will be removed from this device.`,
        confirmLabel: "Delete dose"
      });
      return;
    }
    if (action === "retire-medicine") {
      const med = medicineById(button.dataset.id);
      if (!med) return;
      askConfirm({
        kind: "retire-medicine",
        medicineId: med.id,
        danger: true,
        title: `Remove ${med.name}?`,
        body: "It leaves the list. Past doses stay in the log, and you can put it back later.",
        confirmLabel: "Remove from list"
      });
      return;
    }
    if (action === "restore-medicine") {
      const med = medicineById(button.dataset.id);
      if (!med) return;
      med.active = true;
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
      ui.dialog = null;
      if (persist()) toast(med ? `${med.name} removed from the list.` : "Medicine removed.");
      render();
      return;
    }
    if (dialog.kind === "restore") {
      state = dialog.pendingState;
      ui.dialog = null;
      ui.day = PainLog.localDateKey(new Date());
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

  function onInput() {
    if (!ui.dialog) return;
    syncFromDom();
    if (ui.dialog.type === "dose" && ui.dialog.step === "edit") refreshDoseSummary();
    if (ui.dialog.type === "medicine") refreshMedicineHints();
  }

  function onChange(event) {
    const target = event.target;
    if (target.name === "day") {
      const bounds = dayBounds();
      ui.day = target.value && target.value <= bounds.latest ? target.value : bounds.latest;
      render();
      return;
    }
    if (!ui.dialog || ui.dialog.type !== "medicine") return;
    if (target.name === "ingredientMode") {
      const previous = ui.dialog.ingredientMode;
      syncFromDom();
      if (ui.dialog.ingredientMode === "new" && previous !== "new") {
        ui.dialog.limitName = "";
        ui.dialog.maxPer24hMg = "";
      }
      if (ui.dialog.ingredientMode === "existing") {
        const ingredient = ingredientById(ui.dialog.ingredientId) || state.ingredients[0];
        if (ingredient) {
          ui.dialog.ingredientId = ingredient.id;
          ui.dialog.limitName = ingredient.name;
          ui.dialog.maxPer24hMg = ingredient.maxPer24hMg;
        }
      }
      render();
      return;
    }
    if (target.name === "ingredientId") {
      syncFromDom();
      const ingredient = ingredientById(ui.dialog.ingredientId);
      if (ingredient) {
        ui.dialog.limitName = ingredient.name;
        ui.dialog.maxPer24hMg = ingredient.maxPer24hMg;
      }
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
    render();
    setInterval(() => {
      const now = Date.now();
      document.querySelectorAll("[data-rel]").forEach((el) => {
        const target = Number(el.dataset.rel);
        if (Number.isFinite(target)) el.textContent = relPhrase(target, now);
      });
    }, 30000);
    backupInput.addEventListener("change", onBackupFile);
    app.addEventListener("click", onClick);
    app.addEventListener("submit", onSubmit);
    app.addEventListener("input", onInput);
    app.addEventListener("change", onChange);
  }

  boot();
})();
