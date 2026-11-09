const test = require("node:test");
const assert = require("node:assert/strict");
const PainLog = require("../logic.js");

const HOUR = 60 * 60 * 1000;

function stateWith(extra) {
  return {
    version: 1,
    ingredients: [
      { id: "ing-ibu", name: "Ibuprofen", maxPer24hMg: 1200 },
      { id: "ing-ace", name: "Acetaminophen", maxPer24hMg: 3000 }
    ],
    medicines: [
      {
        id: "med-ibu",
        name: "Ibuprofen",
        ingredientId: "ing-ibu",
        usualDoseMg: 200,
        doseWords: "1 tablet",
        intervalHours: 6,
        asNeeded: true,
        active: true
      },
      {
        id: "med-ace",
        name: "Acetaminophen extra strength",
        ingredientId: "ing-ace",
        usualDoseMg: 1000,
        doseWords: "2 extra-strength caplets",
        intervalHours: 6,
        asNeeded: true,
        active: true
      },
      {
        id: "med-cold",
        name: "Cold medicine",
        ingredientId: "ing-ace",
        usualDoseMg: 500,
        doseWords: "1 dose",
        intervalHours: 6,
        asNeeded: true,
        active: true
      }
    ],
    doses: [],
    ...extra
  };
}

function dose(id, medicineId, hoursFromZero, mg) {
  return {
    id,
    medicineId,
    takenAt: new Date(hoursFromZero * HOUR).toISOString(),
    amountMg: mg,
    doseWords: "",
    painBefore: null,
    painAfter: null,
    note: ""
  };
}

function assess(state, hours, mg, medicineId, excludeDoseId) {
  return PainLog.assessDose(
    state,
    {
      medicineId,
      amountMg: mg,
      takenAt: new Date(hours * HOUR),
      excludeDoseId: excludeDoseId || null
    },
    new Date(hours * HOUR)
  );
}

test("a dose exactly 24 hours older is outside the window", () => {
  const events = [
    { t: 0, mg: 800 },
    { t: PainLog.DAY_MS, mg: 800 }
  ];
  assert.equal(PainLog.peakMg(events), 800);
});

test("a dose one millisecond inside the window counts", () => {
  const events = [
    { t: 0, mg: 800 },
    { t: PainLog.DAY_MS - 1, mg: 800 }
  ];
  assert.equal(PainLog.peakMg(events), 1600);
});

test("the peak is the worst 24-hour stretch, not the all-time total", () => {
  const events = [
    { t: 0, mg: 400 },
    { t: 10 * HOUR, mg: 400 },
    { t: 30 * HOUR, mg: 400 }
  ];
  assert.equal(PainLog.peakMg(events), 800);
});

test("shared ingredient doses add toward one max", () => {
  const state = stateWith();
  state.doses = [dose("a", "med-ace", 0, 1000), dose("b", "med-cold", 2, 1000)];
  const result = assess(state, 4, 1000, "med-ace");
  assert.equal(result.peakMg, 3000);
  assert.equal(result.warnings.some((item) => item.code === "over-max"), false);

  const over = assess(state, 4, 1500, "med-ace");
  assert.equal(over.peakMg, 3500);
  assert.equal(over.warnings.some((item) => item.code === "over-max"), true);
});

test("a different ingredient does not add to the max", () => {
  const state = stateWith();
  state.doses = [dose("a", "med-ace", 0, 2500)];
  const result = assess(state, 1, 400, "med-ibu");
  assert.equal(result.peakMg, 400);
  assert.equal(result.warnings.some((item) => item.code === "over-max"), false);
});

test("editing a dose does not count it twice", () => {
  const state = stateWith();
  state.doses = [dose("a", "med-ibu", 0, 800)];
  const result = assess(state, 1, 300, "med-ibu", "a");
  assert.equal(result.peakMg, 300);
  assert.equal(result.warnings.some((item) => item.code === "over-max"), false);
});

test("over-max is warned only when this dose raises a total past the limit", () => {
  const state = stateWith();
  state.doses = [dose("a", "med-ibu", 0, 800), dose("b", "med-ibu", 1, 800)];
  const later = assess(state, 40, 200, "med-ibu");
  assert.equal(later.warnings.some((item) => item.code === "over-max"), false);
  assert.ok(later.peakMg <= 1200 || later.peakMg === 1600);
  const codes = later.warnings.map((item) => item.code);
  assert.equal(codes.includes("over-max"), false);
});

test("two doses in the same minute count as inside the interval", () => {
  const state = stateWith();
  state.doses = [dose("a", "med-ibu", 3, 200)];
  const result = assess(state, 3, 200, "med-ibu");
  assert.equal(result.warnings.some((item) => item.code === "early-before"), true);
  assert.equal(result.warnings.some((item) => item.code === "early-after"), false);
});

test("an exact interval is allowed and one millisecond early is not", () => {
  const state = stateWith();
  state.doses = [dose("a", "med-ibu", 0, 200)];
  const exact = assess(state, 6, 200, "med-ibu");
  assert.equal(exact.warnings.some((item) => item.code === "early-before"), false);

  const early = PainLog.assessDose(
    state,
    {
      medicineId: "med-ibu",
      amountMg: 200,
      takenAt: new Date(6 * HOUR - 1),
      excludeDoseId: null
    },
    new Date(6 * HOUR - 1)
  );
  assert.equal(early.warnings.some((item) => item.code === "early-before"), true);
});

test("a dose sandwiched inside the interval warns about the later dose", () => {
  const state = stateWith();
  state.doses = [dose("a", "med-ibu", 0, 200), dose("b", "med-ibu", 10, 200)];
  const result = assess(state, 5, 200, "med-ibu");
  assert.equal(result.warnings.some((item) => item.code === "early-before"), true);
  assert.equal(result.warnings.some((item) => item.code === "early-after"), true);
});

test("another product with the same ingredient can trip the interval", () => {
  const state = stateWith();
  state.doses = [dose("a", "med-cold", 0, 500)];
  const result = assess(state, 2, 1000, "med-ace");
  const shared = result.warnings.find((item) => item.code === "early-shared");
  assert.ok(shared);
  assert.equal(shared.otherMedicineId, "med-cold");
});

test("today's total starts at local midnight and skips yesterday and the future", () => {
  const state = stateWith();
  const now = new Date(2026, 10, 8, 15, 0, 0, 0);
  const stamp = (date) => date.toISOString();
  const add = (id, when, mg) => ({
    id,
    medicineId: "med-ibu",
    takenAt: stamp(when),
    amountMg: mg,
    parts: [{ ingredientId: "ing-ibu", amountMg: mg }]
  });
  state.doses = [
    add("yesterday", new Date(2026, 10, 7, 23, 30, 0, 0), 200),
    add("midnight", new Date(2026, 10, 8, 0, 0, 0, 0), 200),
    add("morning", new Date(2026, 10, 8, 8, 0, 0, 0), 400),
    add("future", new Date(2026, 10, 8, 18, 0, 0, 0), 200)
  ];
  assert.equal(PainLog.ingredientDay(state, "ing-ibu", now).used, 600);
  assert.equal(PainLog.ingredientWindow(state, "ing-ibu", now).used, 800);
});

test("the current 24-hour window ignores an older dose and a future dose", () => {
  const state = stateWith();
  const now = new Date(48 * HOUR);
  state.doses = [
    dose("old", "med-ibu", 48 - 24, 200),
    dose("in", "med-ibu", 30, 400),
    dose("future", "med-ibu", 49, 200)
  ];
  // dose at exactly now-24h is excluded; dose at 30h is inside; future is not yet.
  const window = PainLog.ingredientWindow(state, "ing-ibu", now);
  assert.equal(window.used, 400);
  assert.equal(window.max, 1200);
});

test("zero amount is blocked and a very large amount is a warning", () => {
  const state = stateWith();
  const now = new Date(0);
  const empty = PainLog.assessDose(
    state,
    { medicineId: "med-ibu", amountMg: "", takenAt: now, excludeDoseId: null },
    now
  );
  assert.equal(empty.amountValid, false);
  assert.ok(empty.errors.length > 0);

  const huge = assess(state, 0, 5000, "med-ibu");
  assert.equal(huge.warnings.some((item) => item.code === "large-amount"), true);
  assert.equal(huge.errors.length, 0);
});

test("calendar day follows the local clock", () => {
  const evening = new Date(2026, 10, 7, 23, 30, 0, 0);
  assert.equal(PainLog.localDateKey(evening), "2026-11-07");
  const state = stateWith();
  state.doses = [
    {
      id: "late",
      medicineId: "med-ibu",
      takenAt: evening.toISOString(),
      amountMg: 200,
      doseWords: "",
      painBefore: "moderate",
      painAfter: "mild",
      note: ""
    }
  ];
  assert.equal(PainLog.dosesOnDay(state, "2026-11-07").length, 1);
  assert.equal(PainLog.toLocalInput(evening), "2026-11-07T23:30");
  assert.equal(PainLog.fromLocalInput("2026-11-07T23:30").getTime(), evening.getTime());
});

test("normalize keeps valid records and drops junk", () => {
  const result = PainLog.normalize({
    version: 1,
    ingredients: [
      { id: "ing", name: "Ibuprofen", maxPer24hMg: 1200 },
      { id: "bad", name: "", maxPer24hMg: 10 }
    ],
    medicines: [
      {
        id: "med",
        name: "Ibuprofen",
        ingredientId: "ing",
        usualDoseMg: 200,
        doseWords: "1 tablet",
        intervalHours: 6,
        asNeeded: true,
        active: true
      }
    ],
    doses: [
      {
        id: "ok",
        medicineId: "med",
        takenAt: "2026-11-07T18:00:00.000Z",
        amountMg: 200,
        doseWords: "1 tablet",
        painBefore: "severe",
        painAfter: "nope",
        note: "with food"
      },
      { id: "nope", medicineId: "missing", takenAt: "2026-11-07T18:00:00.000Z", amountMg: 200 }
    ]
  });
  assert.equal(result.recognized, true);
  assert.equal(result.state.ingredients.length, 1);
  assert.equal(result.state.medicines.length, 1);
  assert.equal(result.state.doses.length, 1);
  assert.equal(result.state.doses[0].painAfter, null);
  assert.equal(result.state.doses[0].painBefore, "severe");
  assert.equal(result.dropped, 1);

  const round = PainLog.normalize(PainLog.serialize(result.state));
  assert.deepEqual(round.state, result.state);
});

test("an unrelated file is not treated as a log", () => {
  const result = PainLog.normalize({ hello: "world" });
  assert.equal(result.recognized, false);
  assert.equal(result.state.doses.length, 0);
});

test("commas in a typed amount are thousands separators", () => {
  assert.equal(PainLog.parseNum("1,200"), 1200);
  assert.equal(PainLog.parseNum("1,200.5"), 1200.5);
  assert.equal(PainLog.parseNum(""), NaN);
});

test("presets cover ibuprofen, acetaminophen, and a two-drug tablet", () => {
  const ids = PainLog.PRESETS.map((item) => item.id);
  assert.deepEqual(ids, ["ibuprofen", "acetaminophen-es", "acetaminophen-regular", "percocet"]);
  const ibu = PainLog.PRESETS[0];
  assert.equal(ibu.maxPer24hMg, 1200);
  assert.equal(ibu.intervalHours, 6);
  assert.equal(PainLog.PRESETS[1].maxPer24hMg, 3000);
  assert.equal(PainLog.PRESETS[1].ingredientName, PainLog.PRESETS[2].ingredientName);
  const percocet = PainLog.PRESETS.find((item) => item.id === "percocet");
  assert.equal(percocet.doseWords, "1 tablet");
  assert.equal(percocet.parts[0].ingredientName, "Oxycodone");
  assert.equal(percocet.parts[0].mgPerUnit, 5);
  assert.equal(percocet.parts[0].maxPer24hMg, null);
  assert.equal(percocet.parts[1].ingredientName, "Acetaminophen");
  assert.equal(percocet.parts[1].mgPerUnit, 325);
  assert.equal(percocet.parts[1].maxPer24hMg, 3000);
});

test("an older save becomes one part on the medicine and the dose", () => {
  const result = PainLog.normalize({
    version: 1,
    ingredients: [{ id: "ing", name: "Ibuprofen", maxPer24hMg: 1200 }],
    medicines: [
      {
        id: "med",
        name: "Ibuprofen",
        ingredientId: "ing",
        usualDoseMg: 200,
        doseWords: "1 tablet",
        intervalHours: 6,
        asNeeded: true,
        active: true
      }
    ],
    doses: [
      {
        id: "ok",
        medicineId: "med",
        takenAt: "2026-11-07T18:00:00.000Z",
        amountMg: 400,
        doseWords: "",
        painBefore: null,
        painAfter: null,
        note: ""
      }
    ]
  });
  assert.equal(result.state.version, 2);
  assert.deepEqual(result.state.medicines[0].parts, [{ ingredientId: "ing", mgPerUnit: 200 }]);
  assert.deepEqual(result.state.doses[0].parts, [{ ingredientId: "ing", amountMg: 400 }]);
  const window = PainLog.ingredientWindow(result.state, "ing", new Date("2026-11-07T18:30:00.000Z"));
  assert.equal(window.used, 400);
});

test("a combination tablet counts each drug toward its own max", () => {
  const state = stateWith();
  state.ingredients.push({ id: "ing-oxy", name: "Oxycodone", maxPer24hMg: 30 });
  state.medicines.push({
    id: "med-percocet",
    name: "Percocet",
    ingredientId: "ing-oxy",
    usualDoseMg: 5,
    parts: [
      { ingredientId: "ing-oxy", mgPerUnit: 5 },
      { ingredientId: "ing-ace", mgPerUnit: 325 }
    ],
    doseWords: "1 tablet",
    intervalHours: 6,
    asNeeded: true,
    active: true
  });
  state.doses = [
    dose("ace", "med-ace", 0, 2800),
    {
      id: "tab",
      medicineId: "med-percocet",
      takenAt: new Date(HOUR).toISOString(),
      amountMg: 330,
      parts: [
        { ingredientId: "ing-oxy", amountMg: 5 },
        { ingredientId: "ing-ace", amountMg: 325 }
      ],
      doseWords: "1 tablet",
      painBefore: null,
      painAfter: null,
      note: ""
    }
  ];
  const now = new Date(2 * HOUR);
  assert.equal(PainLog.ingredientWindow(state, "ing-ace", now).used, 3125);
  assert.equal(PainLog.ingredientWindow(state, "ing-oxy", now).used, 5);
  assert.equal(PainLog.ingredientWindow(state, "ing-ibu", now).used, 0);

  const second = PainLog.assessDose(
    state,
    {
      medicineId: "med-percocet",
      parts: [
        { ingredientId: "ing-oxy", amountMg: 5 },
        { ingredientId: "ing-ace", amountMg: 325 }
      ],
      takenAt: now,
      excludeDoseId: null
    },
    now
  );
  const over = second.warnings.filter((item) => item.code === "over-max");
  assert.equal(over.length, 1);
  assert.equal(over[0].ingredientName, "Acetaminophen");
  assert.equal(over[0].peakMg, 3450);
  const oxy = second.ingredients.find((item) => item.ingredientName === "Oxycodone");
  assert.equal(oxy.peakMg, 10);
  assert.equal(oxy.maxMg, 30);
  const shared = second.warnings.find((item) => item.code === "early-shared");
  assert.equal(shared.otherMedicineId, "med-ace");
  assert.equal(shared.ingredientName, "Acetaminophen");
});
