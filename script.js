(() => {
  "use strict";

  const WORD_LEN = 4;
  const TARGET = "poop";

  // Australian English Hunspell dictionary (wooorm/dictionaries), fetched live.
  const SOURCES = [
    "https://cdn.jsdelivr.net/npm/dictionary-en-au/index.dic",
    "https://unpkg.com/dictionary-en-au/index.dic",
    "https://raw.githubusercontent.com/wooorm/dictionaries/main/dictionaries/en-AU/index.dic",
  ];
  const CACHE_KEY = "poople-dict-v1";
  const CACHE_DAYS = 30;

  // Start-word difficulty (shortest number of steps to POOP)
  const RANGES = {
    daily: [3, 6],
    weekly: [6, 99],
    random: [3, 99],
  };

  const $ = (id) => document.getElementById(id);
  const ladderEl = $("ladder"), statusEl = $("status"), kbEl = $("keyboard");
  const solutionEl = $("solution");
  const undoBtn = $("undo"), hintBtn = $("hint"), giveBtn = $("giveup");
  const shareBtn = $("share"), newBtn = $("newgame");

  let answers = [];          // 4-letter dictionary words usable as start words
  let validSet = new Set();  // every accepted word
  let dist = new Map();      // word -> shortest steps to POOP
  let next = new Map();      // word -> next word on a shortest path to POOP
  let candidates = {};       // mode -> start words
  let mode = localStorage.getItem("poople-mode") || "daily";
  let game = null;           // { key, path, current, won, gaveUp, hints }

  /* ---------- dictionary ---------- */

  function parseDic(text) {
    const answerSet = new Set();
    const valid = new Set();
    const lines = text.split(/\r?\n/);
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      const slash = line.indexOf("/");
      const stem = slash === -1 ? line : line.slice(0, slash);
      const flags = slash === -1 ? "" : line.slice(slash + 1);
      if (!/^[a-z]+$/.test(stem)) continue; // skips proper nouns, acronyms, punctuation
      if (stem.length === WORD_LEN) {
        answerSet.add(stem);
        valid.add(stem);
      } else if (stem.length === WORD_LEN - 1 && flags.includes("S")) {
        valid.add(stem + "s"); // plurals are valid steps
      }
    }
    return { answers: [...answerSet].sort(), valid: [...valid] };
  }

  async function fetchDictionary() {
    try {
      const cached = JSON.parse(localStorage.getItem(CACHE_KEY) || "null");
      if (cached && Date.now() - cached.t < CACHE_DAYS * 864e5 && cached.answers.length > 100) {
        return cached;
      }
    } catch (e) { /* ignore */ }

    let lastErr;
    for (const url of SOURCES) {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(res.status + " " + url);
        const parsed = parseDic(await res.text());
        if (parsed.answers.length < 100) throw new Error("Dictionary looked empty");
        const data = { t: Date.now(), ...parsed };
        try { localStorage.setItem(CACHE_KEY, JSON.stringify(data)); } catch (e) { /* quota */ }
        return data;
      } catch (e) { lastErr = e; }
    }
    try {
      const stale = JSON.parse(localStorage.getItem(CACHE_KEY) || "null");
      if (stale) return stale;
    } catch (e) { /* ignore */ }
    throw lastErr || new Error("Could not load dictionary");
  }

  /* ---------- word graph (BFS out from POOP) ---------- */

  function buildGraph() {
    // Bucket words by wildcard pattern, e.g. "p_op" links poop, prop, ...
    const buckets = new Map();
    for (const w of validSet) {
      for (let i = 0; i < WORD_LEN; i++) {
        const k = w.slice(0, i) + "_" + w.slice(i + 1);
        let b = buckets.get(k);
        if (!b) buckets.set(k, (b = []));
        b.push(w);
      }
    }
    dist = new Map([[TARGET, 0]]);
    next = new Map();
    const queue = [TARGET];
    for (let h = 0; h < queue.length; h++) {
      const w = queue[h];
      for (let i = 0; i < WORD_LEN; i++) {
        for (const n of buckets.get(w.slice(0, i) + "_" + w.slice(i + 1))) {
          if (!dist.has(n)) {
            dist.set(n, dist.get(w) + 1);
            next.set(n, w);
            queue.push(n);
          }
        }
      }
    }
    // Candidate start words per mode, from real dictionary stems only
    const reachable = answers.filter((w) => w !== TARGET && dist.has(w));
    candidates = {};
    for (const m of Object.keys(RANGES)) {
      const [lo, hi] = RANGES[m];
      let list = reachable.filter((w) => dist.get(w) >= lo && dist.get(w) <= hi);
      if (list.length < 10) list = reachable.filter((w) => dist.get(w) >= 2);
      if (list.length === 0) list = reachable;
      candidates[m] = list;
    }
  }

  /* ---------- seeded random ---------- */

  function xmur3(str) {
    let h = 1779033703 ^ str.length;
    for (let i = 0; i < str.length; i++) {
      h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
      h = (h << 13) | (h >>> 19);
    }
    return () => {
      h = Math.imul(h ^ (h >>> 16), 2246822507);
      h = Math.imul(h ^ (h >>> 13), 3266489909);
      return (h ^= h >>> 16) >>> 0;
    };
  }
  function mulberry32(a) {
    return () => {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function seededPick(list, seedStr) {
    const rng = mulberry32(xmur3(seedStr)());
    return list[Math.floor(rng() * list.length)];
  }

  /* ---------- date keys ---------- */

  const pad = (n) => String(n).padStart(2, "0");
  const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const dailyKey = () => ymd(new Date());
  function weeklyKey() {
    const d = new Date();
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // Monday start
    return ymd(d);
  }

  /* ---------- game state ---------- */

  const saveName = (m) => "poople-ladder-" + m;

  function newGame(m, forceNewRandom) {
    let key, start;
    if (m === "daily") { key = dailyKey(); start = seededPick(candidates.daily, "poople-daily-" + key); }
    else if (m === "weekly") { key = weeklyKey(); start = seededPick(candidates.weekly, "poople-weekly-" + key); }
    else { key = String(Date.now()); start = candidates.random[Math.floor(Math.random() * candidates.random.length)]; }

    let saved = null;
    if (!forceNewRandom) {
      try { saved = JSON.parse(localStorage.getItem(saveName(m)) || "null"); } catch (e) { /* ignore */ }
    }
    const usable = saved && Array.isArray(saved.path) && saved.path.length &&
      (m === "random" ? dist.has(saved.path[0]) : saved.key === key);
    game = usable
      ? { key: saved.key, path: saved.path, hints: saved.hints || 0, gaveUp: !!saved.gaveUp }
      : { key, path: [start], hints: 0, gaveUp: false };
    game.edit = null; // { pos, letter }: the one letter being changed
    game.sel = 0;     // which tile is selected
    game.won = game.path[game.path.length - 1] === TARGET;
    persist();
  }

  function candidate() {
    const w = last();
    if (!game.edit) return w;
    return w.slice(0, game.edit.pos) + game.edit.letter + w.slice(game.edit.pos + 1);
  }

  function checkWord(g) {
    if (g === last()) return "Change one letter first";
    if (!validSet.has(g)) return "Not in the dictionary";
    if (game.path.includes(g)) return "Already used that word";
    if (!dist.has(g)) return "Dead end: you can't reach POOP from there";
    return "";
  }

  function persist() {
    try {
      localStorage.setItem(saveName(mode), JSON.stringify({
        key: game.key, path: game.path, hints: game.hints, gaveUp: game.gaveUp,
      }));
    } catch (e) { /* ignore */ }
  }

  const isOver = () => game.won || game.gaveUp;
  const par = () => dist.get(game.path[0]);
  const stepsTaken = () => game.path.length - 1;
  const last = () => game.path[game.path.length - 1];

  function diffCount(a, b) {
    let n = 0;
    for (let i = 0; i < WORD_LEN; i++) if (a[i] !== b[i]) n++;
    return n;
  }

  /* ---------- rendering ---------- */

  function tileRow(word, prev, cls) {
    const row = document.createElement("div");
    row.className = "row";
    for (let i = 0; i < WORD_LEN; i++) {
      const t = document.createElement("div");
      t.className = "tile " + cls;
      if (prev && word[i] !== prev[i]) t.classList.add("changed");
      t.textContent = word[i] || "";
      row.appendChild(t);
    }
    return row;
  }

  function buildKeyboard() {
    const rows = ["qwertyuiop", "asdfghjkl", "!zxcvbnm<"];
    kbEl.innerHTML = "";
    for (const r of rows) {
      const row = document.createElement("div");
      row.className = "krow";
      for (const ch of r) {
        const b = document.createElement("button");
        b.className = "key";
        if (ch === "!") { b.textContent = "Enter"; b.dataset.key = "Enter"; b.classList.add("wide"); }
        else if (ch === "<") { b.textContent = "⌫"; b.dataset.key = "Backspace"; b.classList.add("wide"); }
        else { b.textContent = ch; b.dataset.key = ch; }
        row.appendChild(b);
      }
      kbEl.appendChild(row);
    }
  }

  function render() {
    ladderEl.innerHTML = "";
    game.path.forEach((w, i) => {
      const cls = i === 0 ? "start" : game.won && i === game.path.length - 1 ? "won" : "step";
      ladderEl.appendChild(tileRow(w, i > 0 ? game.path[i - 1] : null, cls));
    });

    if (!isOver()) {
      const input = document.createElement("div");
      input.className = "row";
      input.id = "inputRow";
      const cand = candidate();
      for (let i = 0; i < WORD_LEN; i++) {
        const t = document.createElement("div");
        t.className = "tile input" +
          (i === game.sel ? " sel" : "") +
          (game.edit && game.edit.pos === i ? " edited" : "");
        t.dataset.pos = i;
        t.textContent = cand[i];
        input.appendChild(t);
      }
      if (game.edit && !checkWord(cand)) input.classList.add("valid");
      ladderEl.appendChild(input);

      const arrow = document.createElement("div");
      arrow.className = "arrow";
      arrow.textContent = "⋮";
      ladderEl.appendChild(arrow);
      ladderEl.appendChild(tileRow(TARGET, null, "goal"));
    }
    ladderEl.scrollTop = ladderEl.scrollHeight;

    // solution when given up
    solutionEl.hidden = !game.gaveUp;
    solutionEl.innerHTML = "";
    if (game.gaveUp) {
      const h = document.createElement("div");
      h.textContent = `Shortest route (${par()} steps):`;
      solutionEl.appendChild(h);
      let w = game.path[0], prev = null;
      solutionEl.appendChild(tileRow(w, null, "sol"));
      while (w !== TARGET) {
        prev = w; w = next.get(w);
        solutionEl.appendChild(tileRow(w, prev, "sol"));
      }
    }

    document.querySelectorAll(".modes button").forEach((b) =>
      b.classList.toggle("active", b.dataset.mode === mode));

    const label = { daily: "Today's word", weekly: "This week's word", random: "Random word" }[mode];
    if (game.won) {
      const s = stepsTaken();
      statusEl.textContent = s <= par()
        ? `POOP in ${s}! That's the shortest route. 💩`
        : `POOP in ${s} steps (shortest is ${par()}).`;
    } else if (game.gaveUp) {
      statusEl.textContent = `Gave up on ${game.path[0].toUpperCase()}.`;
    } else {
      statusEl.textContent = `${label}: ${game.path[0].toUpperCase()} → POOP · Steps ${stepsTaken()} · Shortest ${par()}`;
    }

    const over = isOver();
    undoBtn.hidden = over; hintBtn.hidden = over; giveBtn.hidden = over;
    undoBtn.disabled = game.path.length < 2;
    shareBtn.hidden = !game.won;
    newBtn.hidden = mode !== "random";
    kbEl.hidden = over;
  }

  function toast(msg, ms = 1600) {
    const t = $("toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toast.id);
    toast.id = setTimeout(() => t.classList.remove("show"), ms);
  }

  function shake() {
    const row = $("inputRow");
    if (!row) return;
    row.classList.remove("shake");
    void row.offsetWidth;
    row.classList.add("shake");
  }

  /* ---------- input ---------- */

  function press(key) {
    if (!game || isOver()) return;
    if (key === "Enter") return submit();
    if (key === "Backspace" || key === "Escape") { game.edit = null; return render(); }
    if (key === "ArrowLeft") { game.sel = (game.sel + WORD_LEN - 1) % WORD_LEN; return render(); }
    if (key === "ArrowRight") { game.sel = (game.sel + 1) % WORD_LEN; return render(); }
    if (/^[a-z]$/.test(key)) {
      // only one letter can differ from the current word, so a new edit replaces the old one
      game.edit = key === last()[game.sel] ? null : { pos: game.sel, letter: key };
      render();
    }
  }

  function submit() {
    const g = candidate();
    const err = checkWord(g);
    if (err) { shake(); return toast(err); }
    game.path.push(g);
    game.edit = null;
    game.won = g === TARGET;
    persist();
    render();
  }

  function undo() {
    if (isOver() || game.path.length < 2) return;
    game.path.pop();
    game.edit = null;
    persist();
    render();
  }

  function hint() {
    if (isOver()) return;
    const n = next.get(last());
    if (!n) return toast("No hint available");
    game.hints++;
    persist();
    toast(`Try: ${n.toUpperCase()}`, 2500);
  }

  function giveUp() {
    if (isOver()) return;
    if (!confirm("Give up and see the shortest route?")) return;
    game.gaveUp = true;
    persist();
    render();
  }

  function shareText() {
    const title = mode === "random" ? "Poople (random)" : `Poople ${mode} ${game.key}`;
    const s = stepsTaken();
    const blocks = "🟫".repeat(Math.max(0, s - 1)) + "💩";
    const hints = game.hints ? ` · ${game.hints} hint${game.hints > 1 ? "s" : ""}` : "";
    return `${title}\n${game.path[0].toUpperCase()} → POOP in ${s} (shortest ${par()})${hints}\n${blocks}`;
  }

  /* ---------- events ---------- */

  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (["Enter", "Backspace", "Escape", "ArrowLeft", "ArrowRight"].includes(e.key)) {
      e.preventDefault(); press(e.key);
    } else if (/^[a-zA-Z]$/.test(e.key)) press(e.key.toLowerCase());
    else if (/^[1-4]$/.test(e.key) && game && !isOver()) { game.sel = +e.key - 1; render(); }
  });
  ladderEl.addEventListener("click", (e) => {
    const t = e.target.closest(".tile.input");
    if (!t || !game || isOver()) return;
    game.sel = +t.dataset.pos;
    render();
  });
  kbEl.addEventListener("click", (e) => {
    const k = e.target.closest(".key");
    if (k) { k.blur(); press(k.dataset.key); }
  });
  document.querySelector(".modes").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-mode]");
    if (!b || b.dataset.mode === mode || !answers.length) return;
    b.blur();
    mode = b.dataset.mode;
    localStorage.setItem("poople-mode", mode);
    newGame(mode);
    render();
  });
  undoBtn.addEventListener("click", () => { undoBtn.blur(); undo(); });
  hintBtn.addEventListener("click", () => { hintBtn.blur(); hint(); });
  giveBtn.addEventListener("click", () => { giveBtn.blur(); giveUp(); });
  newBtn.addEventListener("click", () => { newBtn.blur(); newGame("random", true); render(); });
  shareBtn.addEventListener("click", async () => {
    const text = shareText();
    try {
      if (navigator.share) await navigator.share({ text });
      else { await navigator.clipboard.writeText(text); toast("Copied to clipboard"); }
    } catch (e) {
      try { await navigator.clipboard.writeText(text); toast("Copied to clipboard"); } catch (e2) { /* ignore */ }
    }
  });

  /* ---------- start ---------- */

  async function start() {
    buildKeyboard();
    statusEl.textContent = "Loading dictionary…";
    try {
      const dict = await fetchDictionary();
      answers = dict.answers;
      validSet = new Set(dict.valid);
      validSet.add(TARGET);
      buildGraph();
      if (!candidates.daily || candidates.daily.length === 0) throw new Error("No playable words found");
      if (!RANGES[mode]) mode = "daily";
      newGame(mode);
      render();
    } catch (err) {
      statusEl.innerHTML = "Couldn't load the dictionary. <a href=\"\" onclick=\"location.reload();return false\">Retry</a>";
      console.error(err);
    }
  }
  start();
})();
