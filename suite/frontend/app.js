import { api } from "./api.js";
import { drawChart } from "./charts.js";
import { Viewer } from "./viewer.js";

const TITLES = {
  dashboard: ["Dashboard", "One workspace for design, flight and analysis"],
  designer: ["Rocket Designer", "OpenRocket designs, converted for flight"],
  simulator: ["Flight Simulator", "RocketPy six-degree-of-freedom flight"],
  viewer: ["3D Viewer", "Geometry from the design, motion from the simulation"],
  analysis: ["Flight Analysis", "Channels and events from the actual flight"],
  projects: ["Project Manager", "Designs, conversions and results kept together"],
  settings: ["Settings", "Engines and runtime"],
};

const state = {
  design: null,
  designPath: null,
  flight: null,
  project: null,
};

let viewer = null;

const $ = (id) => document.getElementById(id);
const fmt = (value, digits = 2) =>
  value === null || value === undefined || Number.isNaN(value)
    ? "—"
    : Number(value).toLocaleString(undefined, { maximumFractionDigits: digits });

function route(name) {
  const target = TITLES[name] ? name : "dashboard";
  document.querySelectorAll("nav button").forEach((b) =>
    b.classList.toggle("active", b.dataset.route === target)
  );
  document.querySelectorAll(".view").forEach((v) =>
    v.classList.toggle("hidden", v.id !== `view-${target}`)
  );
  const [title, sub] = TITLES[target];
  $("view-title").textContent = title;
  $("view-sub").textContent = sub;
  if (location.hash.slice(1) !== target) history.replaceState(null, "", `#${target}`);
  if (target === "viewer") {
    if (!viewer) viewer = new Viewer($("viewer-canvas"));
    viewer.resize();
  }
  if (target === "analysis") renderChart();
}

function renderKv(el, rows) {
  el.className = "kv";
  el.innerHTML = rows
    .map(([k, v]) => `<div class="k">${k}</div><div class="v">${v}</div>`)
    .join("");
}

function renderEvents(el, events) {
  if (!events?.length) {
    el.className = "muted";
    el.textContent = "No events reported.";
    return;
  }
  el.className = "";
  el.innerHTML = `<table class="events"><thead><tr><th>Event</th><th>Time</th><th>Altitude</th></tr></thead><tbody>${events
    .map(
      (e) =>
        `<tr><td>${e.name}</td><td class="num">${fmt(e.time, 3)} s</td><td class="num">${fmt(
          e.altitude,
          1
        )} m</td></tr>`
    )
    .join("")}</tbody></table>`;
}

function renderConversion(report) {
  const el = $("conversion-report");
  if (!report) return;
  const groups = [
    ["Approximations", report.approximations, "warn"],
    ["Unsupported", report.unsupported, "warn"],
    ["Warnings", report.warnings, "warn"],
  ].filter(([, items]) => items?.length);
  el.className = "";
  if (!groups.length) {
    el.innerHTML = '<span class="badge good">No conversion losses reported</span>';
    return;
  }
  el.innerHTML = groups
    .map(
      ([title, items, cls]) =>
        `<h3 style="font-size:12px;color:#8b9bb0;text-transform:uppercase;letter-spacing:.06em;margin:12px 0 6px">${title}</h3>` +
        items.map((i) => `<p><span class="badge ${cls}">note</span> ${i}</p>`).join("")
    )
    .join("");
}

function renderDesign() {
  const design = state.design;
  if (!design) return;
  renderKv($("design-summary"), [
    ["Name", design.name],
    ["Designer", design.designer || "—"],
    ["Loaded from", design.path.split(/[\\/]/).pop()],
    ["Structural mass", `${fmt(design.mass * 1000, 1)} g`],
    ["Body radius", `${fmt(design.radius * 1000, 1)} mm`],
    ["Centre of mass", design.centre_of_mass !== null ? `${fmt(design.centre_of_mass * 1000, 1)} mm` : "—"],
    ["Nose cone", design.surfaces.nosecones[0] ? `${design.surfaces.nosecones[0].kind}, ${fmt(design.surfaces.nosecones[0].length * 1000, 0)} mm` : "—"],
    ["Fin sets", String(design.surfaces.trapezoidal_fins.length + design.surfaces.elliptical_fins.length)],
    ["Parachutes", String(design.surfaces.parachutes.length)],
    ["OpenRocket apogee", design.openrocket_results?.max_altitude ? `${fmt(design.openrocket_results.max_altitude, 1)} m` : "no stored flight"],
  ]);
  renderConversion(state.designConversion);
}

function renderFlight() {
  const flight = state.flight;
  if (!flight) return;
  const s = flight.summary;
  renderKv($("sim-summary"), [
    ["Apogee", `${fmt(s.apogee, 1)} m`],
    ["Time to apogee", `${fmt(s.apogee_time, 2)} s`],
    ["Max velocity", `${fmt(s.max_speed, 1)} m/s`],
    ["Max Mach", fmt(s.max_mach, 3)],
    ["Max acceleration", `${fmt(s.max_acceleration, 1)} m/s²`],
    ["Rail exit velocity", `${fmt(s.rail_velocity, 1)} m/s`],
    ["Flight time", `${fmt(s.flight_time, 1)} s`],
    ["Simulation took", `${fmt(flight.elapsed_seconds, 1)} s`],
  ]);
  renderEvents($("sim-events"), flight.events);
  renderEvents($("analysis-events"), flight.events);

  const compare = flight.comparison || {};
  const keys = Object.keys(compare);
  $("sim-compare").className = keys.length ? "" : "muted";
  $("sim-compare").innerHTML = keys.length
    ? `<table class="events"><thead><tr><th>Quantity</th><th>RocketPy</th><th>OpenRocket</th><th>Δ</th></tr></thead><tbody>${keys
        .map(
          (k) =>
            `<tr><td>${k}</td><td class="num">${fmt(compare[k].rocketpy, 2)}</td><td class="num">${fmt(
              compare[k].openrocket,
              2
            )}</td><td class="num">${compare[k].delta_percent}%</td></tr>`
        )
        .join("")}</tbody></table>
      <p class="muted" style="margin:10px 0 0;font-size:12px">RocketSerializer reads OpenRocket's stored flight results as the reference. Designs with several motor configurations can pair a converted motor with another configuration's stored flight, so treat this column as a diagnostic, not an accuracy verdict.</p>`
    : "No OpenRocket reference stored in this design.";

  $("analysis-links").innerHTML = `<span class="muted">Engine: ${flight.engine.flight} · conversion: ${flight.engine.conversion} · design: ${flight.engine.design}</span>`;
  renderChart();
  if (viewer) viewer.setFlight(flight);
}

function renderChart() {
  if (!state.flight) return;
  const keyMap = {
    altitude: ["altitude", "Altitude (m)"],
    speed: ["speed", "Speed (m/s)"],
    acceleration: ["acceleration", "Acceleration (m/s²)"],
    thrust: ["thrust", "Thrust (N)"],
    mass: ["mass", "Mass (kg)"],
  };
  const [key, label] = keyMap[$("chart-select").value] || keyMap.altitude;
  const series = state.flight.series;
  if (!series[key]) {
    const el = $("chart-canvas");
    const ctx = el.getContext("2d");
    ctx.clearRect(0, 0, el.width, el.height);
    ctx.fillStyle = "#8b9bb0";
    ctx.font = "13px Segoe UI";
    ctx.fillText(`RocketPy did not expose a ${key} channel for this flight.`, 18, 32);
    return;
  }
  drawChart($("chart-canvas"), series, key, label, state.flight.events);
}

async function loadDesign(path) {
  $("design-error").classList.add("hidden");
  try {
    const result = await api.openDesign(path);
    state.design = result.design;
    state.designPath = path;
    state.flight = null;
    state.designConversion = result.conversion;
    renderDesign();
    $("btn-simulate").disabled = false;
    $("sim-status").textContent = "";
    $("viewer-hint").textContent = `${result.design.name} — geometry from the design`;
    if (viewer) viewer.setDesign(result.design);
    route("designer");
  } catch (error) {
    $("design-error").textContent = error.message;
    $("design-error").classList.remove("hidden");
  }
}

async function runFlight() {
  const button = $("btn-simulate");
  button.disabled = true;
  $("sim-status").textContent = "converting design and flying…";
  try {
    const payload = {
      path: state.designPath,
      settings: {
        environment: {
          elevation: Number($("env-elevation").value) || 0,
          wind_average: Number($("env-wind").value) || 0,
        },
      },
      save_project: false,
    };
    const flight = await api.simulate(payload);
    state.flight = flight;
    state.designConversion = flight.report;
    renderDesign();
    renderFlight();
    $("btn-save-project").disabled = false;
    $("btn-play").disabled = !viewer;
    $("sim-status").textContent = `flight complete in ${fmt(flight.elapsed_seconds, 1)} s`;
  } catch (error) {
    $("sim-status").textContent = "";
    $("design-error").textContent = error.message;
    $("design-error").classList.remove("hidden");
    route("simulator");
  } finally {
    button.disabled = false;
  }
}

async function saveProject() {
  if (!state.flight) return;
  try {
    const response = await fetch("/api/simulate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: state.designPath,
        settings: { environment: { elevation: Number($("env-elevation").value) || 0 } },
        save_project: true,
        project_name: state.design?.name || "Untitled rocket",
      }),
    });
    if (!response.ok) throw new Error((await response.json()).detail);
    const result = await response.json();
    state.project = result.project;
    $("sim-status").textContent = `saved project ${result.project.id}`;
    await refreshProjects();
  } catch (error) {
    $("sim-status").textContent = error.message;
  }
}

async function refreshProjects() {
  const { projects } = await api.projects();
  const render = (el, empty) => {
    el.className = projects.length ? "" : "list muted";
    el.innerHTML = projects.length
      ? projects
          .map(
            (p) => `<div class="item"><div><strong>${p.name}</strong><div class="meta">${
              p.runs
            } flight(s)${p.apogee ? ` · apogee ${fmt(p.apogee, 1)} m` : ""}</div></div><div class="meta">${p.updated.replace("T", " ")}</div></div>`
          )
          .join("")
      : empty;
  };
  render($("recent-projects"), "No projects yet — run a flight and save it.");
  render($("project-list"), "No projects yet.");
}

async function init() {
  document.querySelectorAll("nav button").forEach((button) =>
    button.addEventListener("click", () => route(button.dataset.route))
  );
  window.addEventListener("hashchange", () => route(location.hash.slice(1)));

  const health = await api.health();
  const status = $("runtime-status");
  status.className = `status ${health.ok ? "ok" : "bad"}`;
  status.textContent = health.ok
    ? `ready · ${health.jar_mb} MB jar · python ${health.python}`
    : "runtime incomplete — see Settings";

  renderKv($("settings-runtime"), [
    ["Python", health.python],
    ["OpenRocket jar", health.jar || "not found"],
    ["Java home", health.java_home || "not found"],
    ["Status", health.ok ? "design + conversion available" : "Java or jar missing"],
    ["Design engine", health.engines.design],
    ["Conversion engine", health.engines.conversion],
    ["Flight engine", health.engines.flight],
  ]);

  $("dashboard-cards").innerHTML = [
    ["Rocket Designer", "Open an .ork design", "designer"],
    ["Flight Simulator", "Convert and fly", "simulator"],
    ["3D Viewer", "Inspect geometry and flight", "viewer"],
    ["Flight Analysis", "Channels and events", "analysis"],
  ]
    .map(
      ([title, sub, target]) =>
        `<div class="card" data-target="${target}"><h3>${title}</h3><p>${sub}</p></div>`
    )
    .join("");
  document.querySelectorAll(".card[data-target]").forEach((card) =>
    card.addEventListener("click", () => route(card.dataset.target))
  );

  const { examples } = await api.examples();
  $("example-select").innerHTML = examples
    .map((e) => `<option value="${e.path}">${e.name}</option>`)
    .join("");

  $("btn-open-design").addEventListener("click", () => loadDesign($("example-select").value));
  $("btn-simulate").addEventListener("click", runFlight);
  $("btn-save-project").addEventListener("click", saveProject);
  $("chart-select").addEventListener("change", renderChart);
  $("btn-play").addEventListener("click", () => viewer?.play());
  $("follow").addEventListener("change", (event) => {
    if (viewer) viewer.follow = event.target.checked;
  });

  await refreshProjects();
  route(location.hash.slice(1) || "dashboard");

  // A design is required before the simulator can do anything.
  if (examples.length) {
    loadDesign(examples[0].path);
  }
}

init();
