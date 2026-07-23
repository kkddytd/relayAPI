export const dashboardHtml = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="color-scheme" content="dark" />
    <meta name="theme-color" content="#080a09" />
    <title>客户端安装总数</title>
    <link rel="stylesheet" href="/installation-stats/dashboard.css" />
    <script src="/installation-stats/dashboard.js" defer></script>
  </head>
  <body>
    <canvas class="signal-field" id="signal-field" aria-hidden="true"></canvas>
    <div class="screen-frame" aria-hidden="true">
      <span class="corner corner-nw"></span>
      <span class="corner corner-ne"></span>
      <span class="corner corner-sw"></span>
      <span class="corner corner-se"></span>
    </div>

    <div class="page-shell">
      <header class="topbar">
        <div class="brand">
          <span class="brand-mark" aria-hidden="true"></span>
          <span>INSTALL TELEMETRY</span>
        </div>
        <div class="connection" data-state="connecting" id="connection-state">
          <span class="status-dot" aria-hidden="true"></span>
          <span id="connection-label">连接中</span>
        </div>
      </header>

      <main class="counter-stage">
        <section class="counter-block" aria-labelledby="counter-label">
          <p class="counter-kicker">CLIENT INSTALLATIONS</p>
          <div class="counter-line">
            <span class="counter-bracket" aria-hidden="true">[</span>
            <strong id="total-count" data-width="normal" aria-live="polite" aria-atomic="true">--</strong>
            <span class="counter-bracket" aria-hidden="true">]</span>
          </div>
          <h1 id="counter-label">累计安装次数</h1>
        </section>
      </main>

      <footer class="footer-line">
        <span>LIVE INSTALL SIGNAL</span>
        <span id="sync-label">等待实时数据</span>
      </footer>
    </div>
  </body>
</html>`;

export const dashboardCss = `:root {
  color: #f7faf8;
  background: #080a09;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-synthesis: none;
  letter-spacing: 0;
}

* { box-sizing: border-box; letter-spacing: 0; }
html, body { min-width: 320px; min-height: 100%; }
body { min-height: 100vh; min-height: 100svh; margin: 0; overflow: hidden; background: #080a09; }
.signal-field { position: fixed; inset: 0; display: block; width: 100%; height: 100%; }
.page-shell { position: relative; z-index: 2; display: grid; grid-template-rows: auto 1fr auto; min-height: 100vh; min-height: 100svh; padding: 0 48px; }
.screen-frame { position: fixed; z-index: 1; inset: 20px; pointer-events: none; border: 1px solid #222824; }
.corner { position: absolute; width: 22px; height: 22px; border-color: #4ade80; }
.corner-nw { top: -1px; left: -1px; border-top: 2px solid; border-left: 2px solid; }
.corner-ne { top: -1px; right: -1px; border-top: 2px solid; border-right: 2px solid; }
.corner-sw { bottom: -1px; left: -1px; border-bottom: 2px solid; border-left: 2px solid; }
.corner-se { right: -1px; bottom: -1px; border-right: 2px solid; border-bottom: 2px solid; }

.topbar, .footer-line { display: flex; align-items: center; justify-content: space-between; gap: 24px; min-height: 88px; color: #9ca8a0; font-size: 12px; font-weight: 700; }
.topbar { border-bottom: 1px solid #252b27; }
.footer-line { min-height: 72px; border-top: 1px solid #252b27; }
.brand, .connection { display: inline-flex; align-items: center; gap: 10px; }
.brand-mark { width: 9px; height: 9px; background: #fbbf24; box-shadow: 0 0 18px rgba(251, 191, 36, 0.55); }
.connection { min-width: 84px; justify-content: flex-end; color: #cbd3cd; }
.status-dot { width: 8px; height: 8px; border-radius: 50%; background: #94a3b8; box-shadow: 0 0 14px rgba(148, 163, 184, 0.45); }
.connection[data-state="online"] .status-dot { background: #4ade80; box-shadow: 0 0 18px rgba(74, 222, 128, 0.75); }
.connection[data-state="offline"] .status-dot { background: #fb7185; box-shadow: 0 0 18px rgba(251, 113, 133, 0.65); }

.counter-stage { display: grid; place-items: center; min-height: 0; padding: 44px 16px; }
.counter-block { width: min(100%, 1200px); text-align: center; }
.counter-kicker { margin: 0 0 22px; color: #4ade80; font-size: 13px; font-weight: 800; }
.counter-line { display: grid; grid-template-columns: 48px minmax(0, auto) 48px; align-items: center; justify-content: center; min-height: 184px; }
.counter-line strong { display: block; min-width: 3ch; max-width: 100%; color: #f7faf8; font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace; font-size: 152px; line-height: 1; font-weight: 800; font-variant-numeric: tabular-nums; text-shadow: 0 0 36px rgba(247, 250, 248, 0.18); }
.counter-line strong[data-width="wide"] { font-size: 116px; }
.counter-line strong[data-width="xwide"] { font-size: 82px; }
.counter-bracket { color: #59635c; font-family: "SFMono-Regular", Consolas, monospace; font-size: 72px; font-weight: 300; }
h1 { margin: 24px 0 0; color: #aeb9b1; font-size: 18px; line-height: 1.4; font-weight: 650; }
#sync-label { color: #fbbf24; }

@media (max-width: 720px) {
  .page-shell { padding: 0 24px; }
  .screen-frame { inset: 10px; }
  .topbar { min-height: 72px; }
  .footer-line { min-height: 60px; }
  .topbar, .footer-line { font-size: 10px; }
  .counter-stage { padding: 32px 0; }
  .counter-kicker { margin-bottom: 16px; font-size: 11px; }
  .counter-line { grid-template-columns: 24px minmax(0, auto) 24px; min-height: 112px; }
  .counter-line strong { font-size: 84px; }
  .counter-line strong[data-width="wide"] { font-size: 62px; }
  .counter-line strong[data-width="xwide"] { font-size: 42px; }
  .counter-bracket { font-size: 40px; }
  h1 { margin-top: 16px; font-size: 15px; }
}

@media (max-width: 390px) {
  .page-shell { padding: 0 18px; }
  .footer-line span:first-child { display: none; }
  .footer-line { justify-content: flex-end; }
  .counter-line strong { font-size: 72px; }
  .counter-line strong[data-width="wide"] { font-size: 52px; }
  .counter-line strong[data-width="xwide"] { font-size: 36px; }
}

@media (prefers-reduced-motion: reduce) {
  .signal-field { opacity: 0.7; }
}`;

export const dashboardJs = `(() => {
  const totalElement = document.getElementById("total-count");
  const connection = document.getElementById("connection-state");
  const connectionLabel = document.getElementById("connection-label");
  const syncLabel = document.getElementById("sync-label");
  const canvas = document.getElementById("signal-field");
  const context = canvas.getContext("2d", { alpha: false });
  const number = new Intl.NumberFormat("zh-CN");
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let displayedTotal = 0;
  let animationFrame = 0;
  let width = 0;
  let height = 0;
  let pixelRatio = 1;

  function setConnection(state, label) {
    connection.dataset.state = state;
    connectionLabel.textContent = label;
    syncLabel.textContent = state === "online" ? "实时同步中" : label;
  }

  function setCounterWidth(value) {
    const length = String(Math.max(0, Math.round(value))).length;
    totalElement.dataset.width = length > 9 ? "xwide" : length > 6 ? "wide" : "normal";
  }

  function showTotal(value) {
    const safeValue = Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
    setCounterWidth(safeValue);
    totalElement.textContent = number.format(safeValue);
  }

  function animateTotal(nextValue) {
    const target = Number.isFinite(Number(nextValue)) ? Math.max(0, Math.round(Number(nextValue))) : 0;
    cancelAnimationFrame(animationFrame);
    if (reducedMotion || totalElement.textContent === "--") {
      displayedTotal = target;
      showTotal(target);
      return;
    }
    const start = displayedTotal;
    const startedAt = performance.now();
    const duration = 620;
    const tick = (time) => {
      const progress = Math.min(1, (time - startedAt) / duration);
      const eased = 1 - Math.pow(1 - progress, 3);
      showTotal(start + (target - start) * eased);
      if (progress < 1) animationFrame = requestAnimationFrame(tick);
      else displayedTotal = target;
    };
    animationFrame = requestAnimationFrame(tick);
  }

  function render(stats) {
    animateTotal(stats.total);
  }

  function resizeCanvas() {
    width = window.innerWidth;
    height = window.innerHeight;
    pixelRatio = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(width * pixelRatio);
    canvas.height = Math.round(height * pixelRatio);
    canvas.style.width = width + "px";
    canvas.style.height = height + "px";
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  }

  function drawSignalField(time) {
    context.fillStyle = "#080a09";
    context.fillRect(0, 0, width, height);

    const grid = width <= 720 ? 36 : 54;
    context.lineWidth = 1;
    context.strokeStyle = "rgba(119, 137, 125, 0.12)";
    context.beginPath();
    for (let x = grid; x < width; x += grid) {
      context.moveTo(x + 0.5, 0);
      context.lineTo(x + 0.5, height);
    }
    for (let y = grid; y < height; y += grid) {
      context.moveTo(0, y + 0.5);
      context.lineTo(width, y + 0.5);
    }
    context.stroke();

    const phase = reducedMotion ? width * 0.68 : (time * 0.08) % (width + 160) - 80;
    context.strokeStyle = "rgba(74, 222, 128, 0.42)";
    context.beginPath();
    context.moveTo(phase + 0.5, 0);
    context.lineTo(phase + 0.5, height);
    context.stroke();

    const baseline = height * 0.76;
    const segment = width <= 720 ? 16 : 22;
    context.strokeStyle = "rgba(251, 191, 36, 0.22)";
    context.beginPath();
    for (let x = 0; x <= width; x += segment) {
      const pulse = Math.sin((x + time * 0.035) * 0.045) * 18 + Math.sin(x * 0.013) * 10;
      context.moveTo(x + 0.5, baseline - pulse);
      context.lineTo(x + 0.5, baseline + pulse);
    }
    context.stroke();

    context.strokeStyle = "rgba(247, 250, 248, 0.08)";
    context.strokeRect(width * 0.08 + 0.5, height * 0.18 + 0.5, width * 0.84, height * 0.64);

    if (!reducedMotion) requestAnimationFrame(drawSignalField);
  }

  async function refresh() {
    try {
      const response = await fetch("/api/v1/installations/stats", { cache: "no-store" });
      if (!response.ok) throw new Error("stats_unavailable");
      render(await response.json());
    } catch {
      setConnection("offline", "连接失败");
    }
  }

  resizeCanvas();
  drawSignalField(0);
  window.addEventListener("resize", () => {
    resizeCanvas();
    if (reducedMotion) drawSignalField(0);
  }, { passive: true });

  refresh();
  const stream = new EventSource("/api/v1/installations/stream");
  stream.addEventListener("open", () => setConnection("online", "实时"));
  stream.addEventListener("stats", (event) => {
    try {
      render(JSON.parse(event.data));
      setConnection("online", "实时");
    } catch {
      setConnection("offline", "数据异常");
    }
  });
  stream.addEventListener("error", () => setConnection("connecting", "重连中"));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refresh();
  });
})();`;
