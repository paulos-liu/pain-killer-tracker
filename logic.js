/* Pain medicine log — dose math.
   A daily max is the highest sum inside any window (t - 24h, t].
   That sum peaks when the window ends on a dose, so those windows are enough.
   Intervals are elapsed time, not clock-face hours. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.PainLog = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const HOUR_MS = 60 * 60 * 1000;

  const PRESETS = [
    {
      id: "ibuprofen",
      medicineName: "Ibuprofen",
      ingredientName: "Ibuprofen",
      usualDoseMg: 200,
      doseWords: "1 tablet",
      intervalHours: 6,
      asNeeded: true,
      maxPer24hMg: 1200,
      blurb:
        "Common US adult over-the-counter label: 200 mg every 4–6 hours, and no more than 1,200 mg (6 tablets) in 24 hours unless a clinician directs otherwise. This preset uses a 6 hour interval. Change any number to match the bottle."
    },
    {
      id: "acetaminophen-es",
      medicineName: "Acetaminophen extra strength",
      ingredientName: "Acetaminophen",
      usualDoseMg: 1000,
      doseWords: "2 extra-strength caplets",
      intervalHours: 6,
      asNeeded: true,
      maxPer24hMg: 3000,
      blurb:
        "Common US Extra Strength label: 1,000 mg every 6 hours, and no more than 3,000 mg (6 caplets of 500 mg) in 24 hours. Some labels allow 4,000 mg. Every product that contains acetaminophen has to count toward the same max."
    },
    {
      id: "acetaminophen-regular",
      medicineName: "Acetaminophen regular strength",
      ingredientName: "Acetaminophen",
      usualDoseMg: 650,
      doseWords: "2 regular-strength tablets",
      intervalHours: 6,
      asNeeded: true,
      maxPer24hMg: 3250,
      blurb:
        "Common US regular-strength label: 650 mg every 4–6 hours, and no more than 3,250 mg (10 tablets of 325 mg) in 24 hours. This preset uses a 6 hour interval. Every product that contains acetaminophen has to count toward the same max."
    }
  ];

  function emptyState() {
    return { version: 1, ingredients: [], medicines: [], doses: [] };
  }

  function cleanText(value, max) {
    if (typeof value !== "string") return "";
    return value.replace(/[\u0000-\u001F\u007F]/g, "").trim().slice(0, max);
  }

  function cleanPain(value) {
    return value === "mild" || value === "moderate" || value === "severe" ? value : null;
  }

  function parseNum(value) {
    if (typeof value === "number") return Number.isFinite(value) ? value : NaN;
    if (typeof value !== "string") return NaN;
    const cleaned = value.trim().replace(/,/g, "");
    if (!cleaned) return NaN;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : NaN;
  }

  function normalize(data) {
    const recognized = !!(
      data &&
      typeof data === "object" &&
      !Array.isArray(data) &&
      (data.version === 1 ||
        Array.isArray(data.medicines) ||
        Array.isArray(data.doses) ||
        Array.isArray(data.ingredients))
    );
    if (!recognized) return { recognized: false, state: emptyState(), dropped: 0 };

    const ingredients = [];
    const seenIng = new Set();
    for (const raw of Array.isArray(data.ingredients) ? data.ingredients : []) {
      if (!raw || typeof raw.id !== "string" || !raw.id || raw.id.length > 80 || seenIng.has(raw.id)) continue;
      const name = cleanText(raw.name, 80);
      const max = Number(raw.maxPer24hMg);
      if (!name || !(max > 0) || max > 50000) continue;
      seenIng.add(raw.id);
      ingredients.push({ id: raw.id, name, maxPer24hMg: max });
    }

    const medicines = [];
    const seenMed = new Set();
    for (const raw of Array.isArray(data.medicines) ? data.medicines : []) {
      if (!raw || typeof raw.id !== "string" || !raw.id || raw.id.length > 80 || seenMed.has(raw.id)) continue;
      const name = cleanText(raw.name, 80);
      if (!name || !seenIng.has(raw.ingredientId)) continue;
      let usual = Number(raw.usualDoseMg);
      if (!Number.isFinite(usual) || usual < 0) usual = 0;
      if (usual > 20000) usual = 20000;
      let interval = Number(raw.intervalHours);
      if (!Number.isFinite(interval) || interval < 0) interval = 0;
      if (interval > 72) interval = 72;
      seenMed.add(raw.id);
      medicines.push({
        id: raw.id,
        name,
        ingredientId: raw.ingredientId,
        usualDoseMg: usual,
        doseWords: cleanText(raw.doseWords, 80),
        intervalHours: interval,
        asNeeded: raw.asNeeded !== false,
        active: raw.active !== false
      });
    }

    const doses = [];
    const seenDose = new Set();
    let dropped = 0;
    for (const raw of Array.isArray(data.doses) ? data.doses : []) {
      if (!raw || typeof raw.id !== "string" || !raw.id || raw.id.length > 80 || seenDose.has(raw.id)) {
        dropped += 1;
        continue;
      }
      if (!seenMed.has(raw.medicineId)) {
        dropped += 1;
        continue;
      }
      const amount = Number(raw.amountMg);
      const taken = new Date(raw.takenAt);
      if (!(amount > 0) || amount > 20000 || Number.isNaN(taken.getTime())) {
        dropped += 1;
        continue;
      }
      seenDose.add(raw.id);
      doses.push({
        id: raw.id,
        medicineId: raw.medicineId,
        takenAt: taken.toISOString(),
        amountMg: amount,
        doseWords: cleanText(raw.doseWords, 80),
        painBefore: cleanPain(raw.painBefore),
        painAfter: cleanPain(raw.painAfter),
        note: cleanText(raw.note, 200)
      });
    }

    doses.sort((a, b) => (a.takenAt < b.takenAt ? -1 : a.takenAt > b.takenAt ? 1 : a.id < b.id ? -1 : 1));
    let trimmed = 0;
    if (doses.length > 5000) {
      trimmed = doses.length - 5000;
      doses.splice(0, trimmed);
    }

    return {
      recognized: true,
      dropped: dropped + trimmed,
      state: { version: 1, ingredients, medicines, doses }
    };
  }

  function serialize(state) {
    return {
      version: 1,
      ingredients: state.ingredients.map((item) => ({
        id: item.id,
        name: item.name,
        maxPer24hMg: item.maxPer24hMg
      })),
      medicines: state.medicines.map((item) => ({
        id: item.id,
        name: item.name,
        ingredientId: item.ingredientId,
        usualDoseMg: item.usualDoseMg,
        doseWords: item.doseWords,
        intervalHours: item.intervalHours,
        asNeeded: item.asNeeded,
        active: item.active
      })),
      doses: state.doses.map((item) => ({
        id: item.id,
        medicineId: item.medicineId,
        takenAt: item.takenAt,
        amountMg: item.amountMg,
        doseWords: item.doseWords,
        painBefore: item.painBefore,
        painAfter: item.painAfter,
        note: item.note
      }))
    };
  }

  function formatMg(n) {
    if (!Number.isFinite(n)) return "—";
    const rounded = Math.round(n * 100) / 100;
    return rounded.toLocaleString(undefined, { maximumFractionDigits: 2 });
  }

  function formatHours(n) {
    if (!Number.isFinite(n)) return "";
    const rounded = Math.round(n * 10) / 10;
    const text = Number.isInteger(rounded) ? String(rounded) : String(rounded);
    return `${text} ${rounded === 1 ? "hour" : "hours"}`;
  }

  function localDateKey(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }

  function dateFromKey(key) {
    const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key || "");
    if (!parts) return null;
    const date = new Date(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]));
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function shiftDay(key, delta) {
    const date = dateFromKey(key);
    if (!date) return key;
    date.setDate(date.getDate() + delta);
    return localDateKey(date);
  }

  function toLocalInput(date) {
    const pad = (n) => String(n).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  function fromLocalInput(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value || "");
    if (!match) return null;
    const date = new Date(
      Number(match[1]),
      Number(match[2]) - 1,
      Number(match[3]),
      Number(match[4]),
      Number(match[5]),
      0,
      0
    );
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function normName(value) {
    return cleanText(value, 80).toLowerCase().replace(/\s+/g, " ");
  }

  function ingredientEvents(state, ingredientId, excludeDoseId) {
    const events = [];
    for (const dose of state.doses) {
      if (dose.id === excludeDoseId) continue;
      const medicine = state.medicines.find((item) => item.id === dose.medicineId);
      if (!medicine || medicine.ingredientId !== ingredientId) continue;
      const t = new Date(dose.takenAt).getTime();
      if (!Number.isFinite(t)) continue;
      events.push({ t, mg: dose.amountMg, medicineId: dose.medicineId, doseId: dose.id });
    }
    return events;
  }

  function peakMg(events) {
    let peak = 0;
    for (let i = 0; i < events.length; i++) {
      const end = events[i].t;
      const start = end - DAY_MS;
      let sum = 0;
      for (let j = 0; j < events.length; j++) {
        if (events[j].t > start && events[j].t <= end) sum += events[j].mg;
      }
      if (sum > peak) peak = sum;
    }
    return peak;
  }

  function windowSum(events, nowMs) {
    let sum = 0;
    for (const event of events) {
      if (event.t > nowMs - DAY_MS && event.t <= nowMs) sum += event.mg;
    }
    return sum;
  }

  function ingredientWindow(state, ingredientId, now) {
    const events = ingredientEvents(state, ingredientId, null);
    const ingredient = state.ingredients.find((item) => item.id === ingredientId);
    const max = ingredient ? ingredient.maxPer24hMg : 0;
    const used = windowSum(events, now.getTime());
    return { used, max, remaining: max - used };
  }

  function medicineTiming(state, medicine, now) {
    const nowMs = now.getTime();
    let lastAt = null;
    for (const dose of state.doses) {
      if (dose.medicineId !== medicine.id) continue;
      const t = new Date(dose.takenAt).getTime();
      if (t <= nowMs && (lastAt === null || t > lastAt)) lastAt = t;
    }
    if (!medicine.intervalHours || lastAt === null) return { lastAt, nextAt: null };
    return { lastAt, nextAt: lastAt + medicine.intervalHours * HOUR_MS };
  }

  function assessDose(state, input, now) {
    const amountMg = parseNum(input.amountMg);
    const takenAt = input.takenAt instanceof Date ? input.takenAt : null;
    const amountValid = Number.isFinite(amountMg) && amountMg > 0 && amountMg <= 20000;
    const takenAtValid = !!(takenAt && !Number.isNaN(takenAt.getTime()));
    const medicine = state.medicines.find((item) => item.id === input.medicineId);
    const errors = [];
    if (!medicine) errors.push("Choose a medicine.");
    if (!amountValid) {
      errors.push(
        Number.isFinite(amountMg) && amountMg > 20000
          ? "That amount is too large to log. Enter the milligrams in this dose."
          : "Enter the amount in milligrams."
      );
    }
    if (!takenAtValid) errors.push("Enter the time taken.");

    const base = {
      errors,
      warnings: [],
      amountValid,
      takenAtValid,
      peakMg: null,
      maxMg: null,
      ingredientName: null,
      nextDoseAt: null,
      medicineName: medicine ? medicine.name : null
    };
    if (!medicine || !amountValid || !takenAtValid) return base;

    const ingredient = state.ingredients.find((item) => item.id === medicine.ingredientId);
    if (!ingredient) {
      base.errors = ["This medicine is missing its daily max."];
      return base;
    }

    const events = ingredientEvents(state, ingredient.id, input.excludeDoseId || null);
    const takenMs = takenAt.getTime();
    const withDose = events.concat([{ t: takenMs, mg: amountMg, medicineId: medicine.id, doseId: "draft" }]);
    const peakWith = peakMg(withDose);
    const peakWithout = peakMg(events);
    const warnings = [];

    if (peakWith > ingredient.maxPer24hMg + 1e-6 && peakWith > peakWithout + 1e-6) {
      warnings.push({
        code: "over-max",
        peakMg: peakWith,
        maxMg: ingredient.maxPer24hMg,
        ingredientName: ingredient.name
      });
    }
    if (amountMg >= 5000) {
      warnings.push({ code: "large-amount", amountMg });
    }
    if (takenMs > now.getTime() + 5 * 60 * 1000) {
      warnings.push({ code: "future", at: takenMs });
    }

    const intervalMs = medicine.intervalHours * HOUR_MS;
    if (intervalMs > 0) {
      const same = events.filter((event) => event.medicineId === medicine.id);
      let prev = null;
      let next = null;
      for (const event of same) {
        // Equal timestamps still count. The form only stores minutes, so two
        // doses logged for the same minute are not six hours apart.
        if (event.t <= takenMs && (!prev || event.t > prev.t)) prev = event;
        if (event.t > takenMs && (!next || event.t < next.t)) next = event;
      }
      if (prev && takenMs - prev.t < intervalMs) {
        warnings.push({
          code: "early-before",
          at: prev.t,
          earliest: prev.t + intervalMs,
          intervalHours: medicine.intervalHours
        });
      }
      if (next && next.t - takenMs < intervalMs) {
        warnings.push({
          code: "early-after",
          at: next.t,
          intervalHours: medicine.intervalHours
        });
      }

      let closest = null;
      for (const event of events) {
        if (event.medicineId === medicine.id) continue;
        const dist = Math.abs(event.t - takenMs);
        if (dist < intervalMs && (!closest || dist < closest.dist)) closest = { event, dist };
      }
      if (closest) {
        warnings.push({
          code: "early-shared",
          at: closest.event.t,
          otherMedicineId: closest.event.medicineId,
          intervalHours: medicine.intervalHours,
          ingredientName: ingredient.name
        });
      }
    }

    return {
      errors: [],
      warnings,
      amountValid: true,
      takenAtValid: true,
      peakMg: peakWith,
      maxMg: ingredient.maxPer24hMg,
      ingredientName: ingredient.name,
      nextDoseAt: intervalMs > 0 ? takenMs + intervalMs : null,
      medicineName: medicine.name
    };
  }

  function dosesOnDay(state, key) {
    return state.doses
      .filter((dose) => localDateKey(new Date(dose.takenAt)) === key)
      .slice()
      .sort((a, b) => (a.takenAt < b.takenAt ? -1 : a.takenAt > b.takenAt ? 1 : a.id < b.id ? -1 : 1));
  }

  return {
    DAY_MS,
    PRESETS,
    emptyState,
    normalize,
    serialize,
    parseNum,
    formatMg,
    formatHours,
    localDateKey,
    dateFromKey,
    shiftDay,
    toLocalInput,
    fromLocalInput,
    normName,
    peakMg,
    ingredientWindow,
    medicineTiming,
    assessDose,
    dosesOnDay,
    cleanText
  };
});
