/* ============================================================
   BOX:ON — interaction engine
   - state machine: idle → loading → armed → on
   - MediaPipe Hands via CDN (loaded after user gesture)
   - gesture: both wrists above forehead (relative to face midline) → charge
   - punch: forward velocity spike on either wrist → hit feedback
   - fallback: if camera unavailable, keyboard sim
       SPACE = toggle ON  |  click stage = punch  |  ESC = disengage
   ============================================================ */

(() => {
  "use strict";

  /* ---------- DOM refs ---------- */
  const app = document.getElementById("app");
  const enterBtn = document.getElementById("enter-btn");
  const disengageBtn = document.getElementById("disengage");
  const video = document.getElementById("cam");
  const overlay = document.getElementById("cam-overlay");
  const overlayCtx = overlay.getContext("2d");

  const statusDot = document.getElementById("status-dot");
  const statusText = document.getElementById("status-text");
  const statusMode = document.getElementById("status-mode");
  const statusClock = document.getElementById("status-clock");

  const donCurtain = document.getElementById("don-curtain");
  const donPct = document.getElementById("don-pct");
  const donBarFill = document.getElementById("don-bar-fill");

  const hudTimer = document.getElementById("hud-timer");
  const hudPunches = document.getElementById("hud-punches");
  const hudCombo = document.getElementById("hud-combo");
  const comboEl = document.getElementById("combo");

  const hitFlash = document.getElementById("hit-flash");
  const onFlash = document.getElementById("on-flash");
  const impactStamp = document.getElementById("impact-stamp");
  const moveCallout = document.getElementById("move-callout");

  const vfFps = document.getElementById("vf-fps");
  const vfHands = document.getElementById("vf-hands");
  const telLat = document.getElementById("tel-lat");
  const telHr = document.getElementById("tel-hr");
  const telSpd = document.getElementById("tel-spd");

  const errorBanner = document.getElementById("error-banner");

  /* ---------- state ---------- */
  const state = {
    mode: "idle",          // idle | loading | armed | donning | on
    hands: null,
    camStream: null,
    rafId: null,
    armedSince: 0,
    donProgress: 0,        // 0..1 — drives the gear-up curtain
    donLastHandAt: 0,
    onStartTime: 0,
    punches: 0,
    combo: 1,
    lastPunchAt: 0,
    roundDurationMs: 180000,
    timerInterval: null,
    fpsFrames: 0,
    fpsLast: performance.now(),
    prevWrists: { L: null, R: null },
    handCount: 0,
    cameraOk: false,
    lastMoveAt: 0,
    lastHandsHighAt: 0,
    lastDuckAt: 0,
  };

  /* ---------- helpers ---------- */
  function setMode(m) {
    state.mode = m;
    app.dataset.mode = m;
    const labels = {
      idle:    ["SYSTEM IDLE",     "MODE / STANDBY"],
      loading: ["BOOTING",         "MODE / CALIBRATE"],
      armed:   ["TRACKING",        "MODE / SCANNING"],
      donning: ["DONNING",         "MODE / GEARING UP"],
      on:      ["LIVE",            "MODE / COMBAT"],
    };
    const [s, mo] = labels[m] || ["—","—"];
    statusText.textContent = s;
    statusMode.textContent = mo;
    statusDot.classList.toggle("live", m === "on" || m === "donning" || m === "armed");
    if (m === "armed" || m === "idle") {
      state.donProgress = 0;
      state.armedSince = 0;
      paintDon(0);
    }
  }

  function paintDon(v) {
    app.style.setProperty("--don", v.toFixed(3));
    if (donPct) donPct.textContent = Math.round(v * 100) + "%";
    if (donBarFill) donBarFill.style.transform = "scaleX(" + v.toFixed(3) + ")";
  }

  function showError(msg) {
    errorBanner.textContent = msg;
    errorBanner.classList.add("show");
    clearTimeout(showError._t);
    showError._t = setTimeout(() => errorBanner.classList.remove("show"), 4200);
  }

  function startClock() {
    const t0 = performance.now();
    setInterval(() => {
      const ms = performance.now() - t0;
      const h = Math.floor(ms / 3600000);
      const m = Math.floor(ms / 60000) % 60;
      const s = Math.floor(ms / 1000) % 60;
      statusClock.textContent =
        String(h).padStart(2,"0") + ":" +
        String(m).padStart(2,"0") + ":" +
        String(s).padStart(2,"0");
    }, 500);
  }

  /* ============================================================
     CAMERA + MEDIAPIPE
     ============================================================ */

  async function loadMediaPipeHands() {
    if (window.Hands) return;
    // load CDN sequentially so the global is ready
    await loadScript("https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1675469240/hands.js");
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.crossOrigin = "anonymous";
      s.onload = () => resolve();
      s.onerror = () => reject(new Error("Failed to load " + src));
      document.head.appendChild(s);
    });
  }

  async function startCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error("getUserMedia unavailable in this context");
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user", width: 640, height: 480 },
      audio: false,
    });
    state.camStream = stream;
    video.srcObject = stream;
    await video.play();
    // resize overlay to match
    overlay.width = video.videoWidth || 640;
    overlay.height = video.videoHeight || 480;
    state.cameraOk = true;
  }

  function stopCamera() {
    if (state.camStream) {
      state.camStream.getTracks().forEach(t => t.stop());
      state.camStream = null;
    }
    state.cameraOk = false;
  }

  async function initHandsTracker() {
    await loadMediaPipeHands();

    const hands = new window.Hands({
      locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1675469240/${file}`,
    });
    hands.setOptions({
      maxNumHands: 2,
      modelComplexity: 0,
      minDetectionConfidence: 0.6,
      minTrackingConfidence: 0.5,
    });
    hands.onResults(onHandResults);
    state.hands = hands;

    // pump frames manually (avoids camera_utils dep)
    const loop = async () => {
      if (!state.cameraOk || !state.hands) return;
      if (video.readyState >= 2) {
        try {
          await state.hands.send({ image: video });
        } catch (e) {
          /* ignore transient send errors */
        }
      }
      state.rafId = requestAnimationFrame(loop);
    };
    loop();
  }

  /* ============================================================
     HAND RESULTS → ARMED CHARGE + PUNCH DETECTION
     ============================================================ */

  function onHandResults(results) {
    // fps
    state.fpsFrames++;
    const now = performance.now();
    if (now - state.fpsLast > 1000) {
      vfFps.textContent = state.fpsFrames + " FPS";
      state.fpsFrames = 0;
      state.fpsLast = now;
    }

    const hands = results.multiHandLandmarks || [];
    const handed = results.multiHandedness || [];
    state.handCount = hands.length;
    vfHands.textContent = hands.length + " HAND" + (hands.length === 1 ? "" : "S");

    // draw to overlay
    drawOverlay(hands, handed);

    // categorize wrists by handedness label (MP returns label in camera-mirrored sense;
    // since we display mirrored too, treat as-is)
    let L = null, R = null;
    hands.forEach((lms, i) => {
      const label = (handed[i] && handed[i].label) || (i === 0 ? "Left" : "Right");
      const wrist = lms[0]; // wrist landmark
      if (label === "Left") L = wrist;
      else R = wrist;
    });

    // GESTURE pipeline: armed → donning → on, driven by wrist Y
    handleDonning(L, R);

    // PUNCH: in ON mode, detect z-velocity (z gets more negative = closer to cam) OR
    // sudden expansion of wrist landmark size (not available reliably) — fall back to
    // 2D speed spike combined with y in upper half.
    if (state.mode === "on") {
      const tNow = performance.now();
      checkPunch("L", L, tNow);
      checkPunch("R", R, tNow);
      checkDucking(L, R, tNow);
    } else {
      state.prevWrists.L = null;
      state.prevWrists.R = null;
      state.lastHandsHighAt = 0;
    }
  }

  function checkPunch(side, w, tNow) {
    if (!w) { state.prevWrists[side] = null; return; }
    const prev = state.prevWrists[side];
    state.prevWrists[side] = { x: w.x, y: w.y, z: w.z, t: tNow };
    if (!prev) return;
    const dt = (tNow - prev.t) / 1000;
    if (dt <= 0) return;

    // velocity components — MediaPipe coords: y grows DOWN, z grows AWAY from cam
    const dx = (w.x - prev.x) / dt;
    const dy = (w.y - prev.y) / dt;
    const dz = (w.z - prev.z) / dt;
    const absX = Math.abs(dx);
    const absY = Math.abs(dy);
    const absZ = Math.abs(dz);
    const speed = Math.hypot(dx, dy);

    telSpd.textContent = speed.toFixed(2) + " m/s";

    // classify dominant axis — uppercut & hook first, fall back to straight
    let move = null;
    if (-dy > 1.6 && absY > absX * 1.2 && absY > absZ * 0.6) {
      move = "UPPERCUT";
    } else if (absX > 1.8 && absX > absY * 1.2) {
      move = "HOOK";
    } else if ((-dz) > 1.6 || (speed > 2.5 && w.y < 0.6)) {
      move = "STRAIGHT";
    }

    const cooled = (tNow - state.lastPunchAt) > 220;
    if (move && cooled) {
      showMove(move);
      registerPunch(side, speed);
    }
  }

  // Ducking: both wrists drop from guard (high) into lower frame within a window.
  function checkDucking(L, R, tNow) {
    if (!L || !R) return;
    const avgY = (L.y + R.y) / 2;
    if (avgY < 0.5) state.lastHandsHighAt = tNow;
    const fell = avgY > 0.72 && state.lastHandsHighAt > 0 && (tNow - state.lastHandsHighAt) < 700;
    const cooled = (tNow - state.lastDuckAt) > 900;
    if (fell && cooled) {
      state.lastDuckAt = tNow;
      // ducking doesn't count as a punch — just announce
      showMove("DUCKING");
    }
  }

  function showMove(name) {
    if (!moveCallout) return;
    const tNow = performance.now();
    // de-dupe: ignore same move firing within 180ms
    if (name === showMove._last && tNow - state.lastMoveAt < 180) return;
    state.lastMoveAt = tNow;
    showMove._last = name;
    moveCallout.textContent = name;
    moveCallout.classList.remove("fire");
    void moveCallout.offsetWidth;
    moveCallout.classList.add("fire");
  }

  /* ============================================================
     DONNING — hand at face → pull down → ON
     wrist y in [0.30 .. 0.70] maps to don progress [0 .. 1]
     ============================================================ */

  function handleDonning(L, R) {
    const tNow = performance.now();
    const anyHand = L || R;
    if (anyHand) state.donLastHandAt = tNow;

    if (state.mode === "armed") {
      // wait for a hand at face level
      const atFace = (L && L.y < 0.46 && L.x > 0.12 && L.x < 0.88) ||
                     (R && R.y < 0.46 && R.x > 0.12 && R.x < 0.88);
      if (atFace) {
        if (!state.armedSince) state.armedSince = tNow;
        // settle ~280ms before locking onto the hand (avoids flicker)
        if (tNow - state.armedSince > 280) {
          setMode("donning");
        }
      } else {
        state.armedSince = 0;
      }
      return;
    }

    if (state.mode !== "donning") return;

    if (anyHand) {
      // use the lower wrist (the one being pulled down)
      const ys = [];
      if (L) ys.push(L.y);
      if (R) ys.push(R.y);
      const y = Math.max(...ys);
      const raw = (y - 0.30) / 0.40;          // map 0.30..0.70 → 0..1
      const p = Math.max(0, Math.min(1, raw));
      // smooth toward target
      state.donProgress = state.donProgress + (p - state.donProgress) * 0.30;
      paintDon(state.donProgress);

      // lock to ON once we're nearly there
      if (state.donProgress >= 0.93) {
        triggerOnSequence();
      }
    } else {
      // hand temporarily lost — hold, then slowly decay
      if (tNow - state.donLastHandAt > 700) {
        state.donProgress = Math.max(0, state.donProgress - 0.012);
        paintDon(state.donProgress);
      }
      if (state.donProgress < 0.02 && tNow - state.donLastHandAt > 2200) {
        setMode("armed");
      }
    }
  }

  /* ============================================================
     OVERLAY DRAWING
     ============================================================ */

  function drawOverlay(hands, handed) {
    const w = overlay.width, h = overlay.height;
    overlayCtx.clearRect(0, 0, w, h);
    if (!hands.length) return;

    // draw skeletons w/ red theme
    const CONNS = [
      [0,1],[1,2],[2,3],[3,4],
      [0,5],[5,6],[6,7],[7,8],
      [5,9],[9,10],[10,11],[11,12],
      [9,13],[13,14],[14,15],[15,16],
      [13,17],[17,18],[18,19],[19,20],
      [0,17],
    ];

    hands.forEach((lms, i) => {
      overlayCtx.strokeStyle = "rgba(238,0,24,0.9)";
      overlayCtx.fillStyle = "#fff";
      overlayCtx.lineWidth = 2;

      // lines
      overlayCtx.beginPath();
      CONNS.forEach(([a,b]) => {
        const A = lms[a], B = lms[b];
        overlayCtx.moveTo(A.x * w, A.y * h);
        overlayCtx.lineTo(B.x * w, B.y * h);
      });
      overlayCtx.stroke();

      // dots
      lms.forEach((p, idx) => {
        overlayCtx.beginPath();
        overlayCtx.arc(p.x * w, p.y * h, idx === 0 ? 5 : 3, 0, Math.PI * 2);
        overlayCtx.fillStyle = idx === 0 ? "#fff" : "rgba(255,255,255,0.85)";
        overlayCtx.fill();
      });
    });
  }

  /* ============================================================
     ON SEQUENCE + COMBAT
     ============================================================ */

  function triggerOnSequence() {
    // ensure curtain locked to full
    state.donProgress = 1;
    paintDon(1);

    // white→red flash
    onFlash.classList.remove("fire");
    void onFlash.offsetWidth;
    onFlash.classList.add("fire");

    // shake once
    app.classList.remove("shake");
    void app.offsetWidth;
    app.classList.add("shake");
    setTimeout(() => app.classList.remove("shake"), 260);

    setMode("on");
    state.onStartTime = performance.now();
    state.punches = 0;
    state.combo = 1;
    hudPunches.textContent = "0";
    hudCombo.textContent = "1";

    if (state.timerInterval) clearInterval(state.timerInterval);
    state.timerInterval = setInterval(updateRoundTimer, 250);
    updateRoundTimer();

    // simulated heart rate
    telHr.textContent = (90 + Math.floor(Math.random() * 20)) + " bpm";
  }

  function updateRoundTimer() {
    const elapsed = performance.now() - state.onStartTime;
    let left = Math.max(0, state.roundDurationMs - elapsed);
    const m = Math.floor(left / 60000);
    const s = Math.floor(left / 1000) % 60;
    hudTimer.textContent = String(m).padStart(2,"0") + ":" + String(s).padStart(2,"0");
    if (left <= 0) {
      clearInterval(state.timerInterval);
      state.timerInterval = null;
    }
    // hr drift
    telHr.textContent = (110 + Math.floor(Math.random()*40) + Math.min(40, state.punches)) + " bpm";
    telLat.textContent = (10 + Math.floor(Math.random()*6)) + "ms";
  }

  function registerPunch(side, intensity = 1) {
    const now = performance.now();
    // combo logic
    if (now - state.lastPunchAt < 1100) {
      state.combo = Math.min(99, state.combo + 1);
    } else {
      state.combo = 1;
    }
    state.lastPunchAt = now;
    state.punches += 1;
    hudPunches.textContent = state.punches;
    hudCombo.textContent = state.combo;

    comboEl.classList.remove("pop");
    void comboEl.offsetWidth;
    comboEl.classList.add("pop");

    // hit flash + shake + impact stamp
    hitFlash.classList.remove("fire");
    void hitFlash.offsetWidth;
    hitFlash.classList.add("fire");

    if (impactStamp) {
      impactStamp.classList.remove("fire");
      // randomize rotation per hit for variety
      impactStamp.style.setProperty("--rot", (Math.random() * 30 - 15) + "deg");
      void impactStamp.offsetWidth;
      impactStamp.classList.add("fire");
    }

    app.classList.remove("shake");
    void app.offsetWidth;
    app.classList.add("shake");
    setTimeout(() => app.classList.remove("shake"), 240);
  }

  function disengage() {
    stopCamera();
    if (state.rafId) cancelAnimationFrame(state.rafId);
    state.rafId = null;
    if (state.timerInterval) clearInterval(state.timerInterval);
    state.timerInterval = null;
    if (state.hands && state.hands.close) { try { state.hands.close(); } catch(e){} }
    state.hands = null;
    setMode("idle");
  }

  /* ============================================================
     ENTRY FLOW
     ============================================================ */

  async function enter() {
    setMode("loading");
    let cameraStarted = false;
    try {
      await startCamera();
      cameraStarted = true;
    } catch (err) {
      console.warn("Camera unavailable:", err.message);
      showError("CAMERA BLOCKED · SIM MODE · PRESS SPACE TO ARM · CLICK TO PUNCH");
    }

    if (cameraStarted) {
      try {
        await initHandsTracker();
      } catch (err) {
        console.warn("Hands tracker failed:", err.message);
        showError("TRACKER OFFLINE · SIM MODE ENABLED");
      }
    }

    setMode("armed");
  }

  /* ============================================================
     EVENTS
     ============================================================ */

  enterBtn.addEventListener("click", () => enter().catch(e => {
    console.error(e);
    showError("BOOT FAILED · " + e.message);
    setMode("idle");
  }));

  disengageBtn.addEventListener("click", disengage);

  // keyboard sim (also helps demo when camera blocked)
  document.addEventListener("keydown", (e) => {
    if (e.code === "Space") {
      e.preventDefault();
      if (state.mode === "armed") {
        // simulate hand showing up at face → enter donning
        setMode("donning");
        simulateDonning();
      } else if (state.mode === "donning") {
        // instant-complete the gear-up
        triggerOnSequence();
      } else if (state.mode === "on") {
        registerPunch("sim", 1);
      }
    } else if (e.code === "ArrowDown" && state.mode === "donning") {
      e.preventDefault();
      state.donProgress = Math.min(1, state.donProgress + 0.08);
      paintDon(state.donProgress);
      if (state.donProgress >= 0.93) triggerOnSequence();
    } else if (e.code === "ArrowUp" && state.mode === "donning") {
      e.preventDefault();
      state.donProgress = Math.max(0, state.donProgress - 0.08);
      paintDon(state.donProgress);
    } else if (e.code === "Escape") {
      if (state.mode !== "idle") disengage();
    } else if (e.code === "KeyP" && state.mode === "on") {
      registerPunch("sim", 1);
    } else if (state.mode === "on" && (e.code === "KeyJ" || e.code === "KeyH" || e.code === "KeyU" || e.code === "KeyD")) {
      // sim-mode shortcuts for the four moves
      const map = { KeyJ: "STRAIGHT", KeyH: "HOOK", KeyU: "UPPERCUT", KeyD: "DUCKING" };
      const move = map[e.code];
      showMove(move);
      if (move !== "DUCKING") registerPunch("sim", 1);
    }
  });

  // smoothly fill donning progress over ~1.4s (sim only)
  function simulateDonning() {
    const start = performance.now();
    const dur = 1400;
    const step = () => {
      if (state.mode !== "donning") return;
      const t = Math.min(1, (performance.now() - start) / dur);
      // ease-in for a "pulling down" feel
      const eased = t * t * (3 - 2 * t);
      state.donProgress = eased;
      paintDon(eased);
      if (t >= 1) { triggerOnSequence(); return; }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  // click in combat mode = simulated punch (also great for touch)
  app.addEventListener("click", (e) => {
    if (state.mode !== "on") return;
    if (e.target.closest(".disengage")) return;
    registerPunch("sim", 1);
  });

  // boot
  startClock();
  setMode("idle");

})();
