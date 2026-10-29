/* 학습공간 환경 모니터 — 브라우저 쪽 코드
   원칙: 보드가 보고한 값만 표시하고, null·0·끊김·오래됨을 섞지 않습니다.
   명령은 '전송 중 → 보드 적용(ack) / 오류 / 응답 없음'으로 구분해 알리고, 자동 재전송하지 않습니다. */
(() => {
  "use strict";
  const STALE_S = 3;
  const WINDOW_S = 300;
  const $ = (id) => document.getElementById(id);

  // ---------- 상태 ----------
  let wsOpen = false;
  let snap = { link: "connecting", link_detail: "", mock: false, port: null, thresholds: { on: 350, off: 450, source: "firmware_default" } };
  let last = null;            // 마지막 state 메시지
  let lastAt = null;          // 브라우저가 그 state를 받은 시각(ms, performance.now)
  let lastWall = null;        // 같은 시각의 Date.now()
  const history = [];         // {t, light, temp, hum, led}
  let series = "light";
  let paused = false, frozen = null;
  let inFlight = false;
  let activeAlerts = new Map();
  let thDirty = false;

  // ---------- 연결 ----------
  function connect() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onopen = () => { wsOpen = true; render(); };
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      handle(msg);
    };
    ws.onclose = () => { wsOpen = false; render(); setTimeout(connect, 2000); };
    ws.onerror = () => ws.close();
  }

  function handle(msg) {
    if (msg.kind === "snapshot" || msg.kind === "health") {
      snap = { ...snap, ...msg };
      if (msg.state && (!last || msg.state.ms !== last.ms)) acceptState(msg.state, msg.age_s);
    } else if (msg.kind === "link") {
      snap.link = msg.link; snap.link_detail = msg.link_detail;
    } else if (msg.kind === "state") {
      snap.thresholds = msg.thresholds;
      acceptState(msg.state, 0);
    }
    render();
  }

  function acceptState(state, ageS) {
    const fresh = !last || state.ms !== last.ms;
    last = state;
    const ageMs = Math.max(0, (ageS || 0) * 1000);
    lastAt = performance.now() - ageMs;
    lastWall = Date.now() - ageMs;
    if (fresh) {
      history.push({ t: lastWall, light: state.light_raw, temp: state.temperature_c, hum: state.humidity_pct, led: state.led });
      const cutoff = Date.now() - WINDOW_S * 1000;
      while (history.length && history[0].t < cutoff) history.shift();
      drawChart();
      drawTable();
    }
  }

  // ---------- 연결 상태 판단 ----------
  function ageSeconds() { return lastAt == null ? null : (performance.now() - lastAt) / 1000; }
  function effectiveLink() {
    if (!wsOpen) return "bridge_down";
    if (snap.link === "ok") {
      const a = ageSeconds();
      if (a == null || a > STALE_S) return "stale";
    }
    return snap.link;
  }
  const LINK = {
    connecting: ["muted", "보드 확인 중"],
    ok: ["ok", "연결됨 · P01"],
    stale: ["warn", "값이 오래됨"],
    disconnected: ["bad", "보드 연결 끊김"],
    profile_mismatch: ["bad", "다른 회로 스케치 · 명령 차단"],
    bridge_down: ["bad", "브리지 프로그램 연결 끊김"],
  };
  // 카드 상태: ok / stale / disconnected / none
  function dataState(link) {
    if (!last) return "none";
    if (link === "ok") return "ok";
    if (link === "stale") return "stale";
    return "disconnected";
  }

  // ---------- 그리기 ----------
  const ICON = {
    dark: '<svg viewBox="0 0 24 24"><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z" fill="currentColor"/></svg>',
    mid: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="2.5"/><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor"/></svg>',
    bright: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="5" fill="currentColor"/><g stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M12 1.5v3M12 19.5v3M1.5 12h3M19.5 12h3M4.6 4.6l2.1 2.1M17.3 17.3l2.1 2.1M4.6 19.4l2.1-2.1M17.3 6.7l2.1-2.1"/></g></svg>',
  };
  function band(raw) {
    const { on, off } = snap.thresholds;
    if (raw < on) return ["dark", "어두움"];
    if (raw > off) return ["bright", "밝음"];
    return ["mid", "보통"];
  }
  function setTag(el, tone, text) { el.dataset.tone = tone; el.textContent = text; }
  function fmt(v, digits = 1) { return v == null ? "—" : Number(v).toFixed(digits); }

  function staleText(link) {
    const a = ageSeconds();
    if (link === "stale") return `${Math.round(a)}초 전 값 · 갱신 없음`;
    if (link === "bridge_down") return "브리지 끊김 · 마지막 값";
    if (link === "profile_mismatch") return "다른 회로 · 마지막 P01 값";
    return "연결 끊김 · 마지막 값";
  }

  function render() {
    const link = effectiveLink();
    const ds = dataState(link);
    const [tone, label] = LINK[link] || LINK.connecting;

    // 상단 연결 표시
    const pill = $("linkPill");
    if (pill.dataset.tone !== tone || $("linkText").textContent !== label) {
      pill.dataset.tone = tone;
      $("linkText").textContent = label + (link === "profile_mismatch" && snap.link_detail ? ` (${snap.link_detail})` : "");
    }
    const a = ageSeconds();
    $("ageText").textContent = a == null ? "아직 받은 값 없음" : `마지막 수신 ${a < 1 ? "방금" : Math.floor(a) + "초 전"}`;
    $("simBadge").hidden = !snap.mock;
    $("portInfo").textContent = snap.port ? (snap.mock ? "시뮬레이션(mock)" : snap.port) : "—";

    document.querySelectorAll(".card").forEach((c) => (c.dataset.state = ds));

    if (last) {
      // 밝기
      const [b, bText] = band(last.light_raw);
      $("bandIcon").innerHTML = ICON[b];
      $("bandText").textContent = bText;
      $("lightRaw").textContent = last.light_raw;
      drawMeter(last.light_raw);
      if (ds === "ok") setTag($("lightTag"), "ok", "정상 수신");
      else setTag($("lightTag"), ds === "stale" ? "warn" : "bad", staleText(link));

      // 온도·습도
      renderEnv("temp", last.temperature_c, "°C", ds, link);
      renderEnv("hum", last.humidity_pct, "%", ds, link);

      // LED
      const on = last.led === 1;
      $("ledIcon").dataset.on = String(on && ds === "ok");
      $("ledVal").textContent = on ? "켜짐" : "꺼짐";
      if (ds === "ok") setTag($("ledMode"), "muted", last.auto ? "자동 모드" : "수동 모드");
      else setTag($("ledMode"), ds === "stale" ? "warn" : "bad", "현재 상태 알 수 없음 · " + staleText(link));

      // 입력
      $("btnVal").textContent = last.button_pressed ? "눌림" : "안 눌림";
      $("potVal").textContent = last.pot_raw;
      $("lcdVal").textContent = last.lcd_ready ? "준비됨" : "초기화 실패";

      // 자동 스위치는 보드가 보고한 값만 반영
      $("autoSwitch").setAttribute("aria-checked", String(!!last.auto));
    }

    // 기준값 출처
    const th = snap.thresholds;
    if (!thDirty && document.activeElement !== $("onTh") && document.activeElement !== $("offTh")) {
      $("onTh").value = th.on; $("offTh").value = th.off;
    }
    $("thSource").textContent = th.source === "applied"
      ? `현재 기준 ${th.on} / ${th.off} · 이 화면에서 적용한 값`
      : `현재 기준 ${th.on} / ${th.off} · 펌웨어 시작값(보드는 기준값을 보내지 않음)`;

    // 컨트롤 활성화: 연결 정상 + 진행 중 명령 없음
    const canSend = link === "ok" && !inFlight;
    document.querySelectorAll("#control button, #threshForm input").forEach((el) => {
      if (el.tagName === "INPUT") el.disabled = link !== "ok"; else el.disabled = !canSend;
    });
    $("manualHint").textContent = link === "ok"
      ? "켜기·끄기를 누르면 자동 모드가 꺼집니다."
      : "보드 연결이 정상일 때만 조작할 수 있습니다. 출력이 꺼졌다고 가정하지 마세요.";

    evaluateAlerts(ds);
  }

  function renderEnv(key, value, unit, ds, link) {
    const valEl = $(key + "Val"), tagEl = $(key + "Tag");
    valEl.textContent = fmt(value);
    if (value == null) {
      setTag(tagEl, "muted", "값 없음 · DHT11 측정 전이거나 읽기 실패");
      return;
    }
    if (ds !== "ok") { setTag(tagEl, ds === "stale" ? "warn" : "bad", staleText(link)); return; }
    const al = activeAlerts.get(key);
    if (al) setTag(tagEl, "warn", "▲ " + al.short);
    else setTag(tagEl, "ok", "기준 범위 안");
  }

  function drawMeter(raw) {
    const { on, off } = snap.thresholds;
    const x = (v) => 10 + (v / 1023) * 280;
    $("lightMeter").innerHTML = `
      <title>조도 원시값 ${raw}, 켜는 기준 ${on}, 끄는 기준 ${off}</title>
      <rect x="10" y="14" width="280" height="10" rx="5" style="fill:var(--muted-bg);stroke:var(--line)"/>
      <rect x="${x(on)}" y="14" width="${Math.max(0, x(off) - x(on))}" height="10" style="fill:var(--line);opacity:.35"/>
      <line x1="${x(on)}" x2="${x(on)}" y1="8" y2="30" style="stroke:var(--chart-th);stroke-width:2"/>
      <line x1="${x(off)}" x2="${x(off)}" y1="8" y2="30" style="stroke:var(--chart-th);stroke-width:2;stroke-dasharray:3 2"/>
      <text x="${x(on)}" y="42" text-anchor="end" style="fill:var(--muted);font-size:10px">켜기 ${on}</text>
      <text x="${x(off)}" y="42" text-anchor="start" style="fill:var(--muted);font-size:10px">끄기 ${off}</text>
      <circle cx="${x(raw)}" cy="19" r="8" style="fill:var(--ink);stroke:var(--surface);stroke-width:2"/>`;
  }

  // ---------- 추이 그래프 ----------
  const SERIES = {
    light: { label: "밝기", unit: "", get: (d) => d.light, fixed: [0, 1023] },
    temp: { label: "온도", unit: "°C", get: (d) => d.temp, pad: 1 },
    hum: { label: "습도", unit: "%", get: (d) => d.hum, pad: 3 },
  };
  function drawChart() {
    if (paused) return;
    const svg = $("chart");
    const cfg = SERIES[series];
    const now = Date.now();
    const pts = history.map((d) => ({ t: d.t, v: cfg.get(d) }));
    const vals = pts.map((p) => p.v).filter((v) => v != null);
    let lo, hi;
    if (cfg.fixed) [lo, hi] = cfg.fixed;
    else if (vals.length) { lo = Math.floor(Math.min(...vals) - cfg.pad); hi = Math.ceil(Math.max(...vals) + cfg.pad); }
    else { lo = 0; hi = 1; }
    const L = 56, R = 624, T = 16, B = 200;
    const X = (t) => L + ((t - (now - WINDOW_S * 1000)) / (WINDOW_S * 1000)) * (R - L);
    const Y = (v) => B - ((v - lo) / (hi - lo || 1)) * (B - T);

    let out = `<title id="chartTitle">최근 5분 ${cfg.label}</title>`;
    // 가로 눈금
    for (let i = 0; i <= 4; i++) {
      const v = lo + ((hi - lo) * i) / 4, y = Y(v);
      out += `<line x1="${L}" x2="${R}" y1="${y}" y2="${y}" style="stroke:var(--hair)"/>`;
      out += `<text x="${L - 8}" y="${y + 4}" text-anchor="end">${cfg.fixed ? Math.round(v) : v.toFixed(1)}</text>`;
    }
    for (let m = 0; m <= 5; m++) {
      const x = X(now - (5 - m) * 60000);
      out += `<text x="${x}" y="${B + 20}" text-anchor="middle">${m === 5 ? "지금" : `-${5 - m}분`}</text>`;
    }
    if (cfg.unit) out += `<text x="${L - 8}" y="${T - 4}" text-anchor="end">${cfg.unit}</text>`;
    // 밝기: 기준선
    if (series === "light") {
      const { on, off } = snap.thresholds;
      out += `<line x1="${L}" x2="${R}" y1="${Y(on)}" y2="${Y(on)}" style="stroke:var(--chart-th);stroke-width:1.5"/>`;
      out += `<line x1="${L}" x2="${R}" y1="${Y(off)}" y2="${Y(off)}" style="stroke:var(--chart-th);stroke-width:1.5;stroke-dasharray:6 4"/>`;
      out += `<text x="${L + 6}" y="${Y(on) + 14}" text-anchor="start" style="fill:var(--chart-th)">켜기 ${on}</text>`;
      out += `<text x="${L + 6}" y="${Y(off) - 6}" text-anchor="start" style="fill:var(--chart-th)">끄기 ${off}</text>`;
    }
    // 선: null이나 2.5초 넘는 빈 구간에서 끊음
    let d = "", prevT = null;
    for (const p of pts) {
      if (p.v == null) { prevT = null; continue; }
      const cmd = prevT == null || p.t - prevT > 2500 ? "M" : "L";
      d += `${cmd}${X(p.t).toFixed(1)} ${Y(p.v).toFixed(1)}`;
      prevT = p.t;
    }
    out += `<path d="${d}" style="fill:none;stroke:var(--chart-line);stroke-width:2.5;stroke-linejoin:round"/>`;
    const lastPt = [...pts].reverse().find((p) => p.v != null);
    if (lastPt) out += `<circle cx="${X(lastPt.t)}" cy="${Y(lastPt.v)}" r="5" style="fill:var(--chart-line);stroke:var(--surface);stroke-width:2"/>`;

    const desc = vals.length
      ? `최근 5분 ${cfg.label}: 최소 ${fmtV(Math.min(...vals))}, 최대 ${fmtV(Math.max(...vals))}, 현재 ${lastPt ? fmtV(lastPt.v) : "값 없음"}${cfg.unit}.`
      : `${cfg.label} 값이 아직 없습니다.`;
    out += `<desc id="chartDesc">${desc}</desc>`;
    svg.innerHTML = out;
    function fmtV(v) { return cfg.fixed ? Math.round(v) : v.toFixed(1); }
  }

  function drawTable() {
    if (paused) return;
    const now = Date.now(), rows = [];
    for (let k = 0; k < 10; k++) {
      const target = now - k * 30000;
      let best = null;
      for (const d of history) if (Math.abs(d.t - target) < 1500 && (!best || Math.abs(d.t - target) < Math.abs(best.t - target))) best = d;
      if (!best) continue;
      const time = new Date(best.t).toLocaleTimeString("ko-KR", { hour12: false });
      rows.push(`<tr><td>${time}</td><td>${best.light}</td><td>${best.temp == null ? "값 없음" : best.temp.toFixed(1)}</td><td>${best.hum == null ? "값 없음" : best.hum.toFixed(1)}</td><td>${best.led ? "켜짐" : "꺼짐"}</td></tr>`);
    }
    $("trendRows").innerHTML = rows.join("") || `<tr><td colspan="5">아직 값이 없습니다.</td></tr>`;
  }

  // ---------- 명령 ----------
  const ERR = {
    unsupported_or_range: "보드가 거절했습니다. 지원하지 않는 명령이거나 범위를 벗어난 값입니다.",
    disconnected: "응답 전에 보드 연결이 끊겼습니다. 적용 여부를 알 수 없습니다.",
    write_failed: "COM 포트에 쓰지 못했습니다. USB 연결을 확인하세요.",
    busy: "이전 명령의 응답을 기다리는 중입니다. 잠시 뒤 다시 누르세요.",
    thresh_on_must_be_below_off: "켜는 기준은 끄는 기준보다 작아야 합니다.",
    thresh_out_of_range: "기준값은 0부터 1023 사이 정수여야 합니다.",
  };
  function rejectText(code) {
    if (code && code.startsWith("link_")) return "보드 연결이 정상이 아니어서 보내지 않았습니다.";
    return ERR[code] || `보내지 않았습니다 (${code}).`;
  }

  async function send(name, args, label) {
    if (inFlight) return;
    inFlight = true; render();
    const status = $("cmdStatus");
    status.dataset.tone = "muted";
    status.textContent = `‘${label}’ 전송 중…`;
    let res, body;
    try {
      res = await fetch("/api/command", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, args }) });
      body = await res.json();
    } catch {
      body = { result: "network" };
    }
    let tone, text;
    switch (body.result) {
      case "applied":
        tone = "ok";
        text = `‘${label}’ 보드 적용 확인 (요청 #${body.request}, ${body.latency_ms}ms).` + (name === "LED" || name === "STOP" ? " 실제 LED는 눈으로 확인하세요." : "");
        break;
      case "timeout":
        tone = "warn";
        text = `‘${label}’ 3초 안에 응답이 없습니다. 적용됐는지 알 수 없어 다시 보내지 않았습니다. 상태 카드의 값을 확인하세요.`;
        break;
      case "error":
        tone = "bad"; text = `‘${label}’ ${ERR[body.code] || "오류: " + body.code}`;
        break;
      case "rejected":
        tone = "bad"; text = `‘${label}’ ${rejectText(body.code)}`;
        break;
      default:
        tone = "bad"; text = `‘${label}’ 브리지 프로그램에 닿지 않아 보내지 못했습니다.`;
    }
    status.dataset.tone = tone;
    status.textContent = text;
    const li = document.createElement("li");
    li.textContent = `${new Date().toLocaleTimeString("ko-KR", { hour12: false })} ${label} → ${{ applied: "적용", timeout: "응답 없음", error: "오류", rejected: "보내지 않음" }[body.result] || "실패"}`;
    $("cmdLog").prepend(li);
    while ($("cmdLog").children.length > 8) $("cmdLog").lastChild.remove();
    inFlight = false; render();
    return body;
  }

  $("ledOn").addEventListener("click", () => send("LED", [1], "조명 켜기"));
  $("ledOff").addEventListener("click", () => send("LED", [0], "조명 끄기"));
  $("stopBtn").addEventListener("click", () => send("STOP", [], "모두 정지"));
  $("autoSwitch").addEventListener("click", () => {
    const next = !(last && last.auto);
    send("AUTO", [next ? 1 : 0], next ? "자동 모드 켜기" : "자동 모드 끄기");
  });

  // ---------- 기준값 폼 ----------
  function fieldError(input, errEl, msg) {
    errEl.textContent = msg || "";
    input.setAttribute("aria-invalid", msg ? "true" : "false");
  }
  function intIn(v, lo, hi) { return /^\d+$/.test(v) && +v >= lo && +v <= hi; }
  ["onTh", "offTh"].forEach((id) => $(id).addEventListener("input", () => { thDirty = true; }));
  $("threshForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const on = $("onTh"), off = $("offTh");
    let firstBad = null;
    const onOk = intIn(on.value.trim(), 0, 1023), offOk = intIn(off.value.trim(), 0, 1023);
    fieldError(on, $("onThErr"), onOk ? "" : "0부터 1023 사이의 정수를 입력하세요.");
    fieldError(off, $("offThErr"), offOk ? "" : "0부터 1023 사이의 정수를 입력하세요.");
    if (!onOk) firstBad = on; else if (!offOk) firstBad = off;
    if (onOk && offOk && +on.value >= +off.value) {
      fieldError(off, $("offThErr"), `끄는 기준은 켜는 기준(${on.value})보다 커야 합니다. 두 값 사이가 깜빡임을 막는 여유 구간입니다.`);
      firstBad = off;
    }
    if (firstBad) { firstBad.focus(); return; }
    const r = await send("THRESH", [+on.value, +off.value], `기준 ${on.value} / ${off.value} 적용`);
    if (r && r.result === "applied") thDirty = false;
  });

  // ---------- 그래프 조작 ----------
  document.querySelectorAll(".seg-btn").forEach((b) => b.addEventListener("click", () => {
    series = b.dataset.series;
    document.querySelectorAll(".seg-btn").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    const wasPaused = paused; paused = false; drawChart(); paused = wasPaused;
  }));
  $("pauseBtn").addEventListener("click", () => {
    paused = !paused;
    $("pauseBtn").setAttribute("aria-pressed", String(paused));
    $("pauseBtn").textContent = paused ? "그래프 다시 재생" : "그래프 일시정지";
    if (!paused) { drawChart(); drawTable(); }
  });

  // ---------- 환경 경고 ----------
  const DEFAULT_ALERT = { tempMax: 26, humMin: 30, humMax: 70 };
  let alertCfg = { ...DEFAULT_ALERT };
  try { const s = JSON.parse(localStorage.getItem("p01-alerts") || "null"); if (s) alertCfg = { ...alertCfg, ...s }; } catch { /* 저장소 사용 불가 */ }
  $("tempMax").value = alertCfg.tempMax; $("humMin").value = alertCfg.humMin; $("humMax").value = alertCfg.humMax;

  $("alertForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const t = $("tempMax"), lo = $("humMin"), hi = $("humMax");
    const tv = parseFloat(t.value), lv = parseFloat(lo.value), hv = parseFloat(hi.value);
    const errs = [
      [t, $("tempMaxErr"), Number.isFinite(tv) && tv >= 0 && tv <= 50 ? "" : "0부터 50 사이 값을 입력하세요."],
      [lo, $("humMinErr"), Number.isFinite(lv) && lv >= 20 && lv <= 90 ? "" : "20부터 90 사이 값을 입력하세요."],
      [hi, $("humMaxErr"), Number.isFinite(hv) && hv >= 20 && hv <= 90 ? "" : "20부터 90 사이 값을 입력하세요."],
    ];
    if (!errs[1][2] && !errs[2][2] && lv >= hv) errs[2][2] = `습도 상한은 하한(${lv}%)보다 커야 합니다.`;
    errs.forEach(([i, el, m]) => fieldError(i, el, m));
    const bad = errs.find((x) => x[2]);
    if (bad) { bad[0].focus(); $("alertSaved").textContent = ""; return; }
    alertCfg = { tempMax: tv, humMin: lv, humMax: hv };
    let stored = true;
    try { localStorage.setItem("p01-alerts", JSON.stringify(alertCfg)); } catch { stored = false; }
    $("alertSaved").textContent = stored ? "저장했습니다." : "적용했습니다. 이 브라우저는 저장을 막아 새로고침하면 기본값으로 돌아갑니다.";
    render();
  });

  function evaluateAlerts(ds) {
    const next = new Map();
    if (last && ds === "ok") {
      const t = last.temperature_c, h = last.humidity_pct;
      if (t != null && t > alertCfg.tempMax) next.set("temp", { short: `상한 ${alertCfg.tempMax}°C 초과`, long: `온도 ${t.toFixed(1)}°C · 상한 ${alertCfg.tempMax}°C 초과` });
      if (h != null && h < alertCfg.humMin) next.set("hum", { short: `하한 ${alertCfg.humMin}% 미만`, long: `습도 ${h.toFixed(1)}% · 하한 ${alertCfg.humMin}% 미만 (건조)` });
      if (h != null && h > alertCfg.humMax) next.set("hum", { short: `상한 ${alertCfg.humMax}% 초과`, long: `습도 ${h.toFixed(1)}% · 상한 ${alertCfg.humMax}% 초과 (습함)` });
    } else if (ds !== "ok") {
      // 연결이 정상이 아니면 경고를 새로 판단하지 않고 기존 경고를 유지
      return;
    }
    // 바뀐 것만 읽어 줌
    const msgs = [];
    for (const [k, v] of next) if (!activeAlerts.has(k) || activeAlerts.get(k).short !== v.short) msgs.push("경고: " + v.long);
    for (const k of activeAlerts.keys()) if (!next.has(k)) msgs.push((k === "temp" ? "온도" : "습도") + " 경고 해제");
    activeAlerts = next;
    if (msgs.length) $("announcer").textContent = msgs.join(". ");
    $("alertBox").hidden = next.size === 0;
    $("alertList").innerHTML = [...next.values()].map((v) => `<li>${v.long}</li>`).join("");
    if (last) { renderEnv("temp", last.temperature_c, "°C", ds, "ok"); renderEnv("hum", last.humidity_pct, "%", ds, "ok"); }
  }

  // 0.5초마다 '오래됨' 판단과 나이 표시 갱신
  setInterval(render, 500);
  drawChart();
  drawTable();
  connect();
})();
