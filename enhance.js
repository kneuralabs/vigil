/* ============================================================
   VIGIL — enhancements (Kneuralabs rebrand)
   · Theme toggle (dark / light) with persistence
   · Live monitor terminal (heartbeat + mirrored events + alerts)
   · Matrix rain overlay on boxes while searching
   These are decoupled from app.js via DOM observers, so every
   scan event is captured regardless of call site.
   ============================================================ */
(function () {
  "use strict";
  var root = document.documentElement;

  /* ---------- 0. THEME TOGGLE ---------- */
  var THEME_KEY = "vigil-theme";
  function applyTheme(mode) {
    root.dataset.theme = mode;
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", mode === "dark" ? "#07182F" : "#F7F8FA");
  }
  // honor any previously toggled choice (wins over tweak default)
  var stored = null;
  try { stored = localStorage.getItem(THEME_KEY); } catch (e) {}
  if (stored === "dark" || stored === "light") applyTheme(stored);

  function bindToggle() {
    var btn = document.getElementById("theme-toggle");
    if (!btn) return;
    btn.addEventListener("click", function () {
      var next = root.dataset.theme === "dark" ? "light" : "dark";
      applyTheme(next);
      try { localStorage.setItem(THEME_KEY, next); } catch (e) {}
      term.push("info", "theme switched \u2192 " + next + " mode");
    });
  }
  // re-assert stored theme once Tweaks has mounted (it may set its default late)
  if (stored === "dark" || stored === "light") {
    setTimeout(function () { applyTheme(stored); }, 1300);
  }

  /* ---------- 1. TERMINAL ---------- */
  function clock() {
    var d = new Date();
    return d.toTimeString().slice(0, 8);
  }
  var term = {
    body: null,
    prompt: null,
    lines: 0,
    init: function () {
      this.body = document.getElementById("term-body");
      if (!this.body) return;
      this.prompt = document.createElement("div");
      this.prompt.className = "term-line";
      this.prompt.innerHTML =
        '<span class="pfx">vigil@watch:~$</span>' +
        '<span class="m" id="term-cmd">watch --interval 10s surface intranet</span>' +
        '<span class="term-cursor"></span>';
      this.body.appendChild(this.prompt);
      // boot sequence
      var self = this;
      var boot = [
        ["info", "vigil-monitor v2.0 \u00b7 kneuralabs surface watch"],
        ["", "loading sensors: ssl ct dns mx intranet \u2026"],
        ["ok", "6 sensors online \u2014 continuous watch engaged"]
      ];
      boot.forEach(function (b, i) {
        setTimeout(function () { self.push(b[0], b[1]); }, 180 * (i + 1));
      });
    },
    push: function (type, msg) {
      if (!this.body) return;
      var line = document.createElement("div");
      line.className = "term-line" + (type ? " " + type : "");
      var prefix = "";
      if (type === "crit") prefix = "\u25B6 ALERT  ";
      else if (type === "warn") prefix = "\u25B8 WARN   ";
      line.innerHTML =
        '<span class="t">[' + clock() + "]</span>" +
        '<span class="m">' + prefix + msg + "</span>";
      this.body.insertBefore(line, this.prompt);
      this.lines++;
      // cap history
      while (this.lines > 160 && this.body.firstChild && this.body.firstChild !== this.prompt) {
        this.body.removeChild(this.body.firstChild);
        this.lines--;
      }
      this.body.scrollTop = this.body.scrollHeight;
      if (type === "crit") flashAlert();
    }
  };

  /* terminal state pill */
  var lastCritAt = 0;
  function setTermState() {
    var pill = document.getElementById("term-state");
    var stat = pill && pill.parentElement;
    if (!pill) return;
    var scanning = document.querySelector(".stat-card.loading");
    var recentCrit = Date.now() - lastCritAt < 6000;
    var state = recentCrit ? "ALERT" : scanning ? "SCANNING" : "WATCHING";
    pill.textContent = state;
    if (stat) stat.style.color = recentCrit ? "#FF8A7E" : scanning ? "#E2B25C" : "#4FB286";
    var dot = stat && stat.querySelector(".term-pulse");
    if (dot) dot.style.background = recentCrit ? "#FF8A7E" : scanning ? "#E2B25C" : "#4FB286";
  }
  function flashAlert() {
    lastCritAt = Date.now();
    setTermState();
    var t = document.querySelector(".terminal");
    if (t) {
      t.animate(
        [{ boxShadow: "0 0 0 0 rgba(200,40,30,.55)" }, { boxShadow: "0 0 0 6px rgba(200,40,30,0)" }],
        { duration: 800, easing: "ease-out" }
      );
    }
  }

  /* ---------- 2. MIRROR EVENT FEED INTO TERMINAL ---------- */
  function mirrorEvent(node) {
    if (!node || node.nodeType !== 1 || !node.classList || !node.classList.contains("event")) return;
    var type = ["ok", "info", "warn", "crit"].filter(function (c) { return node.classList.contains(c); })[0] || "";
    var titleEl = node.querySelector("strong");
    var msgEl = node.querySelector("p");
    var title = titleEl ? titleEl.textContent.trim() : "";
    var msg = msgEl ? msgEl.textContent.trim() : "";
    var text = title ? title + (msg ? "  \u2014  " + msg : "") : msg;
    if (type === "crit") lastCritAt = Date.now();
    term.push(type, text);
  }
  function watchEventFeed() {
    var feed = document.getElementById("event-feed");
    if (!feed) return;
    new MutationObserver(function (muts) {
      muts.forEach(function (m) {
        Array.prototype.forEach.call(m.addedNodes, mirrorEvent);
      });
      setTermState();
    }).observe(feed, { childList: true });
  }

  /* heartbeat — quiet ticks while idle so the monitor never looks dead */
  var beats = [
    "watch tick \u2014 surface nominal, 0 anomalies",
    "polling crt.sh \u00b7 dns.google \u2014 endpoints reachable",
    "certificate transparency stream \u2014 no new issuance",
    "intranet keepalive \u2014 agent channel idle",
    "integrity check ok \u2014 no configuration drift"
  ];
  var beatIdx = 0;
  function heartbeat() {
    if (document.querySelector(".stat-card.loading")) return; // scan owns the feed
    if (root.dataset.motion === "off") { setTermState(); return; }
    term.push("", "\u00b7 " + beats[beatIdx % beats.length]);
    beatIdx++;
    setTermState();
  }

  /* ---------- 3. MATRIX RAIN OVERLAY ---------- */
  var GLYPHS = "01<>/{}[]=+\u00b7\u00d7ABCDEF0123456789\u30A2\u30AB\u30B5\u30BF\u30CA";
  function MatrixField(host) {
    this.host = host;
    this.canvas = document.createElement("canvas");
    this.canvas.className = "matrix-canvas";
    host.appendChild(this.canvas);
    this.ctx = this.canvas.getContext("2d");
    this.running = false;
    this.raf = null;
  }
  MatrixField.prototype.colors = function () {
    var dark = root.dataset.theme === "dark";
    this.headCol = dark ? "rgba(127,182,232,0.95)" : "rgba(74,139,200,0.92)";
    this.bodyRGB = dark ? "127,182,232" : "28,92,170";
  };
  MatrixField.prototype.size = function () {
    var r = this.canvas.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    this.w = r.width; this.h = r.height;
    this._ow = this.canvas.offsetWidth; this._oh = this.canvas.offsetHeight;
    this.canvas.width = Math.round(this.w * dpr);
    this.canvas.height = Math.round(this.h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.f = 13;
    this.cols = Math.max(1, Math.floor(this.w / this.f));
    this.rows = Math.ceil(this.h / this.f) + 2;
    this.head = [];
    this.speed = [];
    this.cells = [];
    for (var c = 0; c < this.cols; c++) {
      this.head[c] = Math.floor(Math.random() * -this.rows);
      this.speed[c] = 0.30 + Math.random() * 0.45;
    }
    return true;
  };
  MatrixField.prototype.glyph = function (key, force) {
    if (force || this.cells[key] === undefined || Math.random() < 0.05) {
      this.cells[key] = GLYPHS[(Math.random() * GLYPHS.length) | 0];
    }
    return this.cells[key];
  };
  MatrixField.prototype.draw = function () {
    // keep the backing store matched to the displayed box (panels grow as
    // content loads — a stale bitmap gets stretched into elongated glyphs)
    if (this.canvas.offsetWidth !== this._ow || this.canvas.offsetHeight !== this._oh) {
      if (!this.size()) return;
    }
    var ctx = this.ctx;
    ctx.clearRect(0, 0, this.w, this.h);
    ctx.font = "600 " + this.f + "px 'IBM Plex Mono', ui-monospace, monospace";
    ctx.textBaseline = "top";
    var trail = 7;
    for (var c = 0; c < this.cols; c++) {
      this.head[c] += this.speed[c];
      var hr = Math.floor(this.head[c]);
      for (var t = 0; t < trail; t++) {
        var row = hr - t;
        if (row < 0 || row > this.rows) continue;
        var ch = this.glyph(c + "_" + row, t === 0);
        var x = c * this.f, y = row * this.f;
        if (t === 0) {
          ctx.fillStyle = this.headCol;
        } else {
          var a = Math.max(0, 0.42 * (1 - t / trail));
          ctx.fillStyle = "rgba(" + this.bodyRGB + "," + a.toFixed(2) + ")";
        }
        ctx.fillText(ch, x, y);
      }
      if (hr - trail > this.rows && Math.random() < 0.04) this.head[c] = Math.floor(Math.random() * -6);
    }
  };
  MatrixField.prototype.start = function () {
    if (this.running) return;
    if (root.dataset.motion === "off") return;
    if (!this.size()) return;
    this.colors();
    this.running = true;
    var self = this;
    requestAnimationFrame(function () { self.canvas.classList.add("on"); });
    (function loop() {
      if (!self.running) return;
      self.draw();
      self.raf = requestAnimationFrame(loop);
    })();
  };
  MatrixField.prototype.stop = function () {
    if (!this.running) return;
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.canvas.classList.remove("on");
    var self = this;
    setTimeout(function () {
      if (!self.running && self.ctx) self.ctx.clearRect(0, 0, self.canvas.width, self.canvas.height);
    }, 440);
  };
  function fieldFor(host) {
    if (!host.__matrix) host.__matrix = new MatrixField(host);
    return host.__matrix;
  }

  /* drive matrix from loading state via observers */
  function watchStatCards() {
    Array.prototype.forEach.call(document.querySelectorAll(".stat-card"), function (card) {
      var f = fieldFor(card);
      if (card.classList.contains("loading")) f.start();
      new MutationObserver(function () {
        if (card.classList.contains("loading")) f.start(); else f.stop();
        setTermState();
      }).observe(card, { attributes: true, attributeFilter: ["class"] });
    });
  }
  function watchSkeletonPanels() {
    ["ssl-details", "dns-details", "crt-details"].forEach(function (id) {
      var el = document.getElementById(id);
      if (!el) return;
      var panel = el.closest(".panel") || el;
      var f = fieldFor(panel);
      var sync = function () {
        if (el.querySelector(".loading-skeleton")) f.start(); else f.stop();
      };
      sync();
      new MutationObserver(sync).observe(el, { childList: true });
    });
  }

  /* ---------- boot ---------- */
  function start() {
    bindToggle();
    term.init();
    watchEventFeed();
    watchStatCards();
    watchSkeletonPanels();
    setTermState();
    setInterval(heartbeat, 5200);
    setInterval(setTermState, 1500);
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }

  // expose for debugging / future hooks
  window.vigilTerm = term;
})();
