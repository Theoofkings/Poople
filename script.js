(() => {
  "use strict";

  const WORD_LEN = 4;
  const MAX_TRIES = 6;

  // Australian English Hunspell dictionary (wooorm/dictionaries), fetched live.
  const SOURCES = [
    "https://cdn.jsdelivr.net/npm/dictionary-en-au/index.dic",
    "https://unpkg.com/dictionary-en-au/index.dic",
    "https://raw.githubusercontent.com/wooorm/dictionaries/main/dictionaries/en-AU/index.dic",
  ];
  const CACHE_KEY = "poople-dict-v1";
  const CACHE_DAYS = 30;

  const $ = (id) => document.getElementById(id);
  const boardEl = $("board"), statusEl = $("status"), kbEl = $("keyboard");
  const actionsEl = $("actions"), shareBtn = $("share"), newBtn = $("newgame");

  let answers = [];       // possible answers (real 4-letter dictionary words)
  let validSet = new Set(); // accepted guesses
  let mode = localStorage.getItem("poople-mode") || "daily";
  let game = null;        // { answer, guesses, current, over, won, key }

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
      // lowercase only: skips proper nouns, acronyms and anything with punctuation
      if (!/^[a-z]+$/.test(stem)) continue;
      if (stem.length === WORD_LEN) {
        answerSet.add(stem);
        valid.add(stem);
      } else if (stem.length === WORD_LEN - 1 && flags.includes("S")) {
        valid.add(stem + "s"); // plurals are valid guesses but never answers
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
    // stale cache is better than nothing
    try {
      const stale = JSON.parse(localStorage.getItem(CACHE_KEY) || "null");
      if (stale) return stale;
    } catch (e) { /* ignore */ }
    throw lastErr || new Error("Could not load dictionary");
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
  function seededPick(seedStr) {
    const rng = mulberry32(xmur3(seedStr)());
    return answers[Math.floor(rng() * answers.length)];
  }

  /* ---------- date keys ---------- */

  const pad = (n) => String(n).padStart(2, "0");
  const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  function dailyKey() { return ymd(new Date()); }
  function weeklyKey() {
    const d = new Date();
    const diff = (d.getDay() + 6) % 7; // Monday start
    d.setDate(d.getDate() - diff);
    return ymd(d);
  }

  /* ---------- game state ---------- */

  const saveName = (m) => "poople-save-" + m;

  function newGame(m, forceNewRandom) {
    let key, answer;
    if (m === "daily") { key = dailyKey(); answer = seededPick("poople-daily-" + key); }
    else if (m === "weekly") { key = weeklyKey(); answer = seededPick("poople-weekly-" + key); }
    else { key = String(Date.now()); answer = answers[Math.floor(Math.random() * answers.length)]; }

    let saved = null;
    if (!forceNewRandom) {
      try { saved = JSON.parse(localStorage.getItem(saveName(m)) || "null"); } catch (e) { /* ignore */ }
    }
    if (saved && (m === "random" ? answers.includes(saved.answer) : saved.key === key)) {
      game = { answer: m === "random" ? saved.answer : answer, key: saved.key, guesses: saved.guesses || [], current: "" };
    } else {
      game = { answer, key, guesses: [], current: "" };
    }
    game.won = game.guesses.includes(game.answer);
    game.over = game.won || game.guesses.length >= MAX_TRIES;
    persist();
  }

  function persist() {
    try {
      localStorage.setItem(saveName(mode), JSON.stringify({ key: game.key, answer: game.answer, guesses: game.guesses }));
    } catch (e) { /* ignore */ }
  }

  /* ---------- scoring ---------- */

  function score(guess, answer) {
    const res = Array(WORD_LEN).fill("absent");
    const left = {};
    for (let i = 0; i < WORD_LEN; i++) {
      if (guess[i] === answer[i]) res[i] = "correct";
      else left[answer[i]] = (left[answer[i]] || 0) + 1;
    }
    for (let i = 0; i < WORD_LEN; i++) {
      if (res[i] === "correct") continue;
      if (left[guess[i]] > 0) { res[i] = "present"; left[guess[i]]--; }
    }
    return res;
  }

  /* ---------- rendering ---------- */

  function buildBoard() {
    boardEl.innerHTML = "";
    for (let r = 0; r < MAX_TRIES; r++) {
      const row = document.createElement("div");
      row.className = "row";
      for (let c = 0; c < WORD_LEN; c++) {
        const t = document.createElement("div");
        t.className = "tile";
        row.appendChild(t);
      }
      boardEl.appendChild(row);
    }
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

  function render(animateRow = -1) {
    const rows = boardEl.children;
    const keyState = {};
    for (let r = 0; r < MAX_TRIES; r++) {
      const tiles = rows[r].children;
      const guess = game.guesses[r];
      const isCurrent = r === game.guesses.length && !game.over;
      const result = guess ? score(guess, game.answer) : null;
      for (let c = 0; c < WORD_LEN; c++) {
        const t = tiles[c];
        t.className = "tile";
        t.style.animationDelay = "";
        if (guess) {
          t.textContent = guess[c];
          t.classList.add(result[c]);
          if (r === animateRow) t.style.animationDelay = c * 0.25 + "s";
          else t.style.animation = "none";
          const rank = { absent: 1, present: 2, correct: 3 };
          if (!keyState[guess[c]] || rank[result[c]] > rank[keyState[guess[c]]]) keyState[guess[c]] = result[c];
        } else if (isCurrent && game.current[c]) {
          t.textContent = game.current[c];
          t.classList.add("filled");
        } else {
          t.textContent = "";
        }
      }
    }
    kbEl.querySelectorAll(".key").forEach((k) => {
      const s = keyState[k.dataset.key];
      k.classList.remove("correct", "present", "absent");
      if (s) k.classList.add(s);
    });

    document.querySelectorAll(".modes button").forEach((b) =>
      b.classList.toggle("active", b.dataset.mode === mode));

    if (game.over) {
      statusEl.textContent = game.won
        ? `Nice! You got it in ${game.guesses.length}/${MAX_TRIES}.`
        : `The word was "${game.answer.toUpperCase()}".`;
    } else {
      const label = { daily: "Today's word", weekly: "This week's word", random: "Random word" }[mode];
      statusEl.textContent = `${label} – ${answers.length.toLocaleString()} words in the dictionary`;
    }
    actionsEl.hidden = !game.over && mode !== "random";
    shareBtn.hidden = !game.over;
    newBtn.hidden = mode !== "random";
  }

  function toast(msg) {
    const t = $("toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toast.id);
    toast.id = setTimeout(() => t.classList.remove("show"), 1400);
  }

  /* ---------- input ---------- */

  function press(key) {
    if (!game || game.over) return;
    if (key === "Enter") return submit();
    if (key === "Backspace") { game.current = game.current.slice(0, -1); return render(); }
    if (/^[a-z]$/.test(key) && game.current.length < WORD_LEN) {
      game.current += key;
      render();
    }
  }

  function submit() {
    if (game.current.length < WORD_LEN) {
      shake(); return toast("Not enough letters");
    }
    if (!validSet.has(game.current)) {
      shake(); return toast("Not in the dictionary");
    }
    game.guesses.push(game.current);
    game.current = "";
    game.won = game.guesses[game.guesses.length - 1] === game.answer;
    game.over = game.won || game.guesses.length >= MAX_TRIES;
    persist();
    render(game.guesses.length - 1);
  }

  function shake() {
    const row = boardEl.children[game.guesses.length];
    if (!row) return;
    row.classList.remove("shake");
    void row.offsetWidth;
    row.classList.add("shake");
  }

  function shareText() {
    const emoji = { correct: "🟩", present: "🟨", absent: "⬛" };
    const grid = game.guesses.map((g) => score(g, game.answer).map((s) => emoji[s]).join("")).join("\n");
    const title = mode === "random" ? "Poople (random)" : `Poople ${mode} ${game.key}`;
    return `${title} ${game.won ? game.guesses.length : "X"}/${MAX_TRIES}\n${grid}`;
  }

  /* ---------- events ---------- */

  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === "Enter" || e.key === "Backspace") { e.preventDefault(); press(e.key); }
    else if (/^[a-zA-Z]$/.test(e.key)) press(e.key.toLowerCase());
  });
  kbEl.addEventListener("click", (e) => {
    const k = e.target.closest(".key");
    if (k) { k.blur(); press(k.dataset.key); }
  });
  document.querySelector(".modes").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-mode]");
    if (!b || b.dataset.mode === mode || !answers.length) return;
    mode = b.dataset.mode;
    localStorage.setItem("poople-mode", mode);
    newGame(mode);
    render();
  });
  newBtn.addEventListener("click", () => { newGame("random", true); render(); });
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
    buildBoard();
    buildKeyboard();
    statusEl.textContent = "Loading dictionary…";
    try {
      const dict = await fetchDictionary();
      answers = dict.answers;
      validSet = new Set(dict.valid);
      if (!["daily", "weekly", "random"].includes(mode)) mode = "daily";
      newGame(mode);
      render();
    } catch (err) {
      statusEl.innerHTML = "Couldn't load the dictionary. <a href=\"\" onclick=\"location.reload();return false\">Retry</a>";
      console.error(err);
    }
  }
  start();
})();
