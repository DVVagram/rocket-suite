const PALETTE = ["#4da3ff", "#35d0a5", "#f0c674", "#ff8f6b", "#b48bff"];

export function drawChart(canvas, series, key, label, events = []) {
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth || 800;
  const height = Number(canvas.getAttribute("height")) || 340;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const times = series.time || [];
  const values = series[key];
  if (!values || !times.length) {
    ctx.fillStyle = "#8b9bb0";
    ctx.font = "13px Segoe UI";
    ctx.fillText("No data for this channel", 18, 30);
    return;
  }

  const pad = { l: 62, r: 16, t: 16, b: 34 };
  const w = width - pad.l - pad.r;
  const h = height - pad.t - pad.b;
  const tMax = times[times.length - 1] || 1;
  let vMin = Math.min(...values);
  let vMax = Math.max(...values);
  if (vMax === vMin) { vMax += 1; vMin -= 1; }
  const span = vMax - vMin;
  vMin -= span * 0.06;
  vMax += span * 0.06;

  const x = (t) => pad.l + (t / tMax) * w;
  const y = (v) => pad.t + h - ((v - vMin) / (vMax - vMin)) * h;

  // grid + axes
  ctx.strokeStyle = "#1e2733";
  ctx.fillStyle = "#6f7f93";
  ctx.font = "11px Segoe UI";
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const gy = pad.t + (h * i) / 4;
    ctx.beginPath();
    ctx.moveTo(pad.l, gy);
    ctx.lineTo(pad.l + w, gy);
    ctx.stroke();
    const value = vMax - ((vMax - vMin) * i) / 4;
    ctx.fillText(value.toFixed(Math.abs(value) >= 100 ? 0 : 2), 8, gy + 4);
  }
  for (let i = 0; i <= 5; i++) {
    const t = (tMax * i) / 5;
    ctx.fillText(`${t.toFixed(1)}s`, x(t) - 10, height - 10);
  }

  // line
  ctx.strokeStyle = PALETTE[0];
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  values.forEach((v, i) => (i ? ctx.lineTo(x(times[i]), y(v)) : ctx.moveTo(x(times[i]), y(v))));
  ctx.stroke();

  const last = values[values.length - 1];
  ctx.lineTo(x(times[times.length - 1]), y(vMin));
  ctx.lineTo(x(times[0]), y(vMin));
  ctx.closePath();
  ctx.fillStyle = "rgba(77,163,255,0.10)";
  ctx.fill();

  // event markers
  ctx.setLineDash([3, 3]);
  events.forEach((event, index) => {
    if (!event.time || event.time > tMax) return;
    ctx.strokeStyle = PALETTE[2 + (index % 3)];
    ctx.beginPath();
    ctx.moveTo(x(event.time), pad.t);
    ctx.lineTo(x(event.time), pad.t + h);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = ctx.strokeStyle;
    ctx.fillText(event.name, x(event.time) + 4, pad.t + 12 + index * 12);
    ctx.setLineDash([3, 3]);
  });

  ctx.fillStyle = "#8b9bb0";
  ctx.font = "11.5px Segoe UI";
  ctx.fillText(label, pad.l, pad.t - 4);
}
