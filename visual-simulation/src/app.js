/**
 * Visual simulation front end.
 *
 * Loads an OpenRocket design, resolves its motors, computes mass/CP/drag with
 * OpenRocket's models, flies it and plays the flight back in 3D.
 */

import { readOrkFile } from './zip.js';
import { parseDesign } from './ork.js';
import { calculateMass } from './mass.js';
import { createAeroModel } from './aero.js';
import { resolveMotor, loadEngFile } from './motors.js';
import { simulate } from './flight.js';
import { SimulationView } from './scene.js';
import { makeMarkers } from './geometry.js';

const EXAMPLES = [
	'A simple model rocket.ork',
	'Three stage low power rocket.ork',
	'Two stage high power rocket.ork',
	'ARC payload rocket.ork',
	'Clustered motors.ork',
	'Dual parachute deployment.ork',
	'Pods--airframes and winglets.ork',
	'Pods--powered with recovery deployment.ork',
	'Tube fin rocket.ork',
	'3D printable nose cone and fins.ork',
	'Parallel booster staging.ork',
	'Base drag hack (short-wide).ork',
	'Chute release.ork',
	'Deployable payload.ork',
	'Airstart timing.ork',
	'Simulation extensions.ork',
	'Simulation scripting.ork',
];

const EXAMPLE_BASE = '../core/src/main/resources/datafiles/examples/';

const el = (id) => document.getElementById(id);

const state = {
	rocket: null,
	aero: null,
	flight: null,
	view: null,
	configId: null,
	time: 0,
	playing: false,
	speed: 1,
	motors: new Map(),
	fileName: '',
	showMarkers: true,
	busy: false,
};

const dom = {};

function init() {
	for (const id of [
		'view', 'designSelect', 'fileInput', 'engInput', 'configSelect', 'status', 'warnings',
		'summary', 'hud', 'timeline', 'playBtn', 'restartBtn', 'speedSelect', 'cameraSelect',
		'windSpeed', 'windDir', 'rodLength', 'rodAngle', 'markersToggle', 'designInfo', 'dropzone',
	]) dom[id] = el(id);

	const select = dom.designSelect;
	select.innerHTML = '<option value="">Bundled OpenRocket examples…</option>' +
		EXAMPLES.map((f) => `<option value="${f}">${f.replace(/\.ork$/, '')}</option>`).join('');
	select.addEventListener('change', () => {
		if (select.value) loadExample(select.value);
	});

	dom.fileInput.addEventListener('change', (e) => {
		const file = e.target.files?.[0];
		if (file) loadFile(file);
	});

	dom.engInput.addEventListener('change', async (e) => {
		const file = e.target.files?.[0];
		if (!file) return;
		try {
			const text = await file.text();
			const motor = loadEngFile(text);
			toast(`Loaded motor ${motor.designation} (${motor.impulse.toFixed(1)} N·s)`);
			rebuild();
		} catch (err) {
			toast(`Could not read motor file: ${err.message}`, true);
		}
	});

	dom.configSelect.addEventListener('change', () => {
		state.configId = dom.configSelect.value;
		rebuild();
	});

	dom.playBtn.addEventListener('click', togglePlay);
	dom.restartBtn.addEventListener('click', () => {
		state.time = 0;
		state.playing = true;
		dom.playBtn.textContent = 'Pause';
	});
	dom.speedSelect.addEventListener('change', () => { state.speed = Number(dom.speedSelect.value); });
	dom.cameraSelect.addEventListener('change', () => {
		if (state.view) state.view.cameraMode = dom.cameraSelect.value;
	});
	dom.timeline.addEventListener('input', () => {
		state.time = Number(dom.timeline.value);
		state.playing = false;
		dom.playBtn.textContent = 'Play';
	});
	dom.markersToggle.addEventListener('change', () => {
		state.showMarkers = dom.markersToggle.checked;
		if (state.markers) state.markers.visible = state.showMarkers;
	});

	for (const id of ['windSpeed', 'windDir', 'rodLength', 'rodAngle']) {
		dom[id].addEventListener('change', rebuild);
	}

	// Drag and drop a .ork anywhere on the page.
	window.addEventListener('dragover', (e) => {
		e.preventDefault();
		document.body.classList.add('dragging');
	});
	window.addEventListener('dragleave', () => document.body.classList.remove('dragging'));
	window.addEventListener('drop', (e) => {
		e.preventDefault();
		document.body.classList.remove('dragging');
		const file = e.dataTransfer?.files?.[0];
		if (file) loadFile(file);
	});

	window.addEventListener('resize', () => state.view?.resize());
	if (typeof ResizeObserver !== 'undefined') {
		const observer = new ResizeObserver(() => state.view?.resize());
		observer.observe(dom.view.parentElement);
	}

	// Expose the live state for debugging from the browser console.
	window.__orvis = state;

	loadExample('A simple model rocket.ork');
	requestAnimationFrame(tick);
}

function toast(message, isError = false) {
	const node = document.createElement('div');
	node.className = 'toast' + (isError ? ' error' : '');
	node.textContent = message;
	document.body.appendChild(node);
	setTimeout(() => node.classList.add('fade'), 2600);
	setTimeout(() => node.remove(), 3400);
}

async function loadExample(name) {
	try {
		setStatus(`Loading ${name}…`);
		const res = await fetch(EXAMPLE_BASE + encodeURIComponent(name));
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const buffer = await res.arrayBuffer();
		const { xml } = await readOrkFile(buffer);
		await loadDesign(xml, name.replace(/\.ork$/, ''));
	} catch (err) {
		setStatus('');
		toast(`Could not load example: ${err.message}`, true);
	}
}

async function loadFile(file) {
	try {
		setStatus(`Reading ${file.name}…`);
		const buffer = await file.arrayBuffer();
		const { xml } = await readOrkFile(buffer);
		await loadDesign(xml, file.name.replace(/\.ork$/i, ''));
	} catch (err) {
		setStatus('');
		toast(`Could not read ${file.name}: ${err.message}`, true);
	}
}

async function loadDesign(xml, label) {
	state.fileName = label;
	const rocket = parseDesign(xml);

	if (!rocket.stages.length) {
		throw new Error('Design has no stages');
	}

	state.rocket = rocket;
	state.configId = rocket.defaultConfig.id;

	dom.configSelect.innerHTML = rocket.configs
		.map((c) => `<option value="${c.id}">${escapeHtml(c.label)}</option>`)
		.join('');
	dom.configSelect.value = state.configId;

	await rebuild();
}

function escapeHtml(s) {
	return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function setStatus(text) {
	dom.status.textContent = text;
	dom.status.style.display = text ? 'block' : 'none';
}

/** Resolve motors, recompute mass/aero, fly and rebuild the view. */
async function rebuild() {
	if (!state.rocket || state.busy) return;
	state.busy = true;
	try {
		const rocket = state.rocket;
		const configId = state.configId;
		const warnings = [...rocket.warnings];

		const motors = new Map();
		const motorInfos = [];
		for (const comp of rocket.components) {
			if (!comp.motorMount) continue;
			const info = comp.motorMount.motors[configId] || comp.motorMount.motors.default;
			if (!info || !info.designation) continue;
			motorInfos.push({ comp, info });
		}

		setStatus(motorInfos.length ? 'Fetching motor data…' : 'Preparing…');
		for (const { comp, info } of motorInfos) {
			const motor = await resolveMotor(info, {
				onWarning: (w) => warnings.push(w),
			});
			motors.set(comp.id, motor);
			comp.motorLength = info.length;
			if (motor.approximate) {
				warnings.push(`Motor ${info.designation} has no published thrust curve available offline — using an estimated curve. Load a RASP .eng file or connect to ThrustCurve.org for exact data.`);
			}
		}

		const mass = calculateMass(rocket, {
			motorMass: new Map([...motors].map(([id, m]) => {
				const comp = rocket.components.find((c) => c.id === id);
				return [id, m.totalMass * (comp?.clusterCount || 1)];
			})),
		});
		const aero = createAeroModel(rocket, configId);

		rocket.launchRodLength = Number(dom.rodLength.value) || 1.2;
		rocket.launchRodAngle = Number(dom.rodAngle.value) || 0;

		const flight = simulate(rocket, aero, {
			configId,
			motors,
			cg: mass.cg,
			mass,
			wind: {
				speed: Number(dom.windSpeed.value) || 0,
				direction: Number(dom.windDir.value) || 0,
			},
			rodLength: rocket.launchRodLength,
			rodAngle: rocket.launchRodAngle,
			launchAltitude: rocket.length,
		});

		state.motors = motors;
		state.aero = aero;
		state.flight = flight;
		state.time = 0;
		state.playing = true;

		buildView(rocket, aero, flight, mass);
		renderSummary(rocket, aero, flight, mass, warnings);
		dom.playBtn.textContent = 'Pause';
		dom.timeline.max = flight.flightTime.toFixed(2);
		dom.timeline.value = 0;
		setStatus('');
	} catch (err) {
		console.error(err);
		setStatus('');
		toast(`Simulation failed: ${err.message}`, true);
	} finally {
		state.busy = false;
	}
}

function buildView(rocket, aero, flight, mass) {
	if (state.view) {
		state.view.dispose();
		const old = document.getElementById('view');
		const fresh = old.cloneNode(false);
		old.replaceWith(fresh);
		dom.view = fresh;
	}

	const view = new SimulationView(dom.view, rocket, aero, flight, { camera: dom.cameraSelect.value });
	state.view = view;

	state.markers = makeMarkers(rocket, mass.cg, aero.cp);
	state.markers.visible = state.showMarkers;
	view.rocketRoot.add(state.markers);

	view.setTime(0);
	view.render(0.016);
}

function renderSummary(rocket, aero, flight, mass, warnings) {
	const f = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '—');
	const stability = flight.stability;
	const stabilityText = stability >= 1 && stability <= 2 ? 'stable' : stability > 2 ? 'over-stable' : 'unstable';

	dom.summary.innerHTML = `
		<div class="stat-grid">
			<div><span>Apogee</span><b>${f(flight.apogee, 1)} m</b></div>
			<div><span>Max speed</span><b>${f(flight.maxSpeed, 1)} m/s</b></div>
			<div><span>Max Mach</span><b>${f(flight.maxMach, 2)}</b></div>
			<div><span>Flight time</span><b>${f(flight.flightTime, 1)} s</b></div>
			<div><span>Descent</span><b>${f(flight.descentSpeed, 1)} m/s</b></div>
			<div><span>Drift</span><b>${f(flight.landingDistance, 0)} m</b></div>
			<div><span>Liftoff mass</span><b>${f(mass.mass * 1000, 0)} g</b></div>
			<div><span>CG</span><b>${f(mass.cg * 100, 1)} cm</b></div>
			<div><span>CP</span><b>${f(aero.cp * 100, 1)} cm</b></div>
			<div><span>Stability</span><b class="${stability < 1 ? 'bad' : stability > 2 ? 'warn' : 'good'}">${f(stability, 2)} cal (${stabilityText})</b></div>
		</div>
		<div class="motors">
			${flight.motors.length
				? flight.motors.map((m) => `<div class="motor"><span>${escapeHtml(m.designation)}</span> ${f(m.impulse, 1)} N·s · ${escapeHtml(m.source)}${m.approximate ? ' · estimated' : ''}</div>`).join('')
				: '<div class="motor muted">No motor in this configuration</div>'}
		</div>
		<div class="design-line">${escapeHtml(rocket.name)} · ${f(rocket.length * 100, 1)} cm long · ${f(rocket.maxDiameter * 1000, 1)} mm diameter · ${rocket.stages.length} stage${rocket.stages.length > 1 ? 's' : ''}</div>
	`;

	dom.warnings.innerHTML = warnings.length
		? `<ul>${[...new Set(warnings)].map((w) => `<li>${escapeHtml(w)}</li>`).join('')}</ul>`
		: '<p class="ok">Design read with no warnings.</p>';

	dom.designInfo.textContent = state.fileName;
}

function togglePlay() {
	state.playing = !state.playing;
	if (state.playing && state.time >= state.flight.flightTime - 0.01) state.time = 0;
	dom.playBtn.textContent = state.playing ? 'Pause' : 'Play';
}

let lastFrame = performance.now();

function tick(now) {
	const dt = Math.min(0.1, (now - lastFrame) / 1000);
	lastFrame = now;

	const view = state.view;
	const flight = state.flight;
	if (view && flight) {
		if (state.playing) {
			state.time += dt * state.speed;
			if (state.time >= flight.flightTime) {
				state.time = flight.flightTime;
				state.playing = false;
				dom.playBtn.textContent = 'Replay';
			}
			dom.timeline.value = state.time;
		}
		view.setTime(state.time);
		view.render(dt);
		updateHud();
	}
	requestAnimationFrame(tick);
}

function updateHud() {
	const s = state.view?.current;
	if (!s) return;
	const f = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '—');
	dom.hud.innerHTML = `
		<div class="hud-row"><span class="hud-label">T+</span><b>${f(s.t, 2)} s</b></div>
		<div class="hud-row"><span class="hud-label">ALT</span><b>${f(s.altitude, 1)} m</b></div>
		<div class="hud-row"><span class="hud-label">VEL</span><b>${f(s.speed, 1)} m/s</b></div>
		<div class="hud-row"><span class="hud-label">MACH</span><b>${f(s.mach, 2)}</b></div>
		<div class="hud-row"><span class="hud-label">MASS</span><b>${f(s.mass * 1000, 0)} g</b></div>
		<div class="hud-row"><span class="hud-label">THR</span><b>${f(s.thrust, 0)} N</b></div>
	`;
	if (state.markers) state.markers.visible = state.showMarkers && !s.chute;
}

init();
