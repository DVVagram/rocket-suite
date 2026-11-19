/**
 * Motor data: RASP (.eng) parsing plus ThrustCurve.org lookup.
 *
 * OpenRocket 24.12 design files store only the motor digest, designation and
 * physical dimensions; the thrust curve lives in the motor database.  This
 * module fetches the matching curve from the same public source OpenRocket
 * uses (ThrustCurve.org), caches it locally, and parses the RASP format whose
 * values are identical to the desktop application's motor database.
 */

const CLASS_IMPULSE = { A: 2.5, B: 5, C: 10, D: 20, E: 40, F: 80, G: 160, H: 320, I: 640, J: 1280, K: 2560, L: 5120, M: 10240, N: 20480, O: 40960 };

const cache = new Map();
const STORAGE_KEY = 'orvis.motors.v1';

function loadStorage() {
	try {
		const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
		if (raw) {
			const data = JSON.parse(raw);
			for (const [k, v] of Object.entries(data)) cache.set(k, v);
		}
	} catch {
		/* storage unavailable */
	}
}

function saveStorage() {
	try {
		const data = Object.fromEntries(cache);
		globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(data));
	} catch {
		/* quota or unavailable */
	}
}

loadStorage();

/**
 * Parse a RASP .eng file.
 * Format: `name diameter length delays propMass totalMass manufacturer;`
 * followed by `time thrust` lines.
 */
export function parseEng(text, fallbackName = '') {
	const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
	const header = lines.find((l) => l.includes(';'));
	if (!header) throw new Error('Not a RASP motor file (missing header)');
	const semi = header.indexOf(';');
	const head = header.slice(0, semi).split(/\s+/);
	const designation = head[0] || fallbackName;
	const diameter = parseFloat(head[1]) / 1000 || 0.018;
	const length = parseFloat(head[2]) / 1000 || 0.07;
	const delays = (head[3] || '').split(',').map((d) => parseFloat(d)).filter((d) => Number.isFinite(d));
	const propMass = parseFloat(head[4]) / 1000 || 0;
	const totalMass = parseFloat(head[5]) / 1000 || propMass || 0;
	const manufacturer = header.slice(semi + 1).trim();

	const curve = [];
	for (const line of lines) {
		if (line === header) continue;
		const parts = line.split(/\s+/);
		if (parts.length < 2) continue;
		const t = parseFloat(parts[0]);
		const n = parseFloat(parts[1]);
		if (Number.isFinite(t) && Number.isFinite(n)) curve.push([t, n]);
	}
	if (curve.length < 2) throw new Error('Motor file has no thrust samples');

	let impulse = 0;
	for (let i = 1; i < curve.length; i++) {
		impulse += ((curve[i][1] + curve[i - 1][1]) / 2) * (curve[i][0] - curve[i - 1][0]);
	}
	const burnTime = curve[curve.length - 1][0];

	return {
		designation,
		manufacturer,
		diameter,
		length,
		delays,
		propMass,
		totalMass,
		caseMass: Math.max(0, totalMass - propMass),
		curve,
		impulse,
		burnTime,
		source: 'RASP',
		approximate: false,
	};
}

/** Thrust in newtons at time t (seconds) after ignition. */
export function thrustAt(motor, t) {
	if (!motor || !motor.curve.length) return 0;
	if (t <= motor.curve[0][0]) return 0;
	const last = motor.curve[motor.curve.length - 1];
	if (t >= last[0]) return 0;
	let lo = 0;
	let hi = motor.curve.length - 1;
	while (hi - lo > 1) {
		const mid = (lo + hi) >> 1;
		if (motor.curve[mid][0] <= t) lo = mid;
		else hi = mid;
	}
	const [t0, n0] = motor.curve[lo];
	const [t1, n1] = motor.curve[hi];
	const f = (t - t0) / (t1 - t0 || 1);
	return n0 + f * (n1 - n0);
}

/** Propellant burned by time t (kg). */
export function propellantBurned(motor, t) {
	if (!motor || !motor.curve.length) return 0;
	if (t >= motor.burnTime) return motor.propMass;
	if (t <= 0) return 0;
	let impulse = 0;
	for (let i = 1; i < motor.curve.length; i++) {
		const [ta, na] = motor.curve[i - 1];
		const [tb, nb] = motor.curve[i];
		if (tb <= t) {
			impulse += ((na + nb) / 2) * (tb - ta);
		} else if (ta < t) {
			const f = (t - ta) / (tb - ta || 1);
			const n = na + f * (nb - na);
			impulse += ((na + n) / 2) * (t - ta);
		}
	}
	return motor.impulse > 0 ? motor.propMass * (impulse / motor.impulse) : 0;
}

/** A conservative synthetic curve, used only when no real data is reachable. */
function synthesize(designation, diameter, length) {
	const cls = (designation.match(/[A-O]/i) || ['C'])[0].toUpperCase();
	const impulse = CLASS_IMPULSE[cls] || 10;
	const burnTime = Math.max(0.4, (impulse / 12) ** 0.6);
	const totalMass = 0.024 + impulse * 0.0035;
	const propMass = Math.min(totalMass * 0.6, impulse * 0.0022);
	const n = 24;
	const curve = [[0, 0]];
	for (let i = 1; i < n; i++) {
		const t = (i / n) * burnTime;
		const u = i / n;
		curve.push([t, impulse / burnTime * (1.35 - 0.7 * u + 0.35 * Math.sin(Math.PI * u))]);
	}
	curve.push([burnTime, 0]);
	return {
		designation, manufacturer: '', diameter, length,
		delays: [], propMass, totalMass, caseMass: totalMass - propMass,
		curve, impulse, burnTime, source: 'estimated', approximate: true,
	};
}

function key(motor) {
	return `${motor.manufacturer}|${motor.designation}|${Math.round(motor.diameter * 1000)}`;
}

/**
 * Resolve a motor referenced by a design.
 * `info` is the <motor> element contents: { manufacturer, designation, diameter, length, delay }.
 */
export async function resolveMotor(info, options = {}) {
	const k = key(info);
	if (cache.has(k)) {
		return { ...cache.get(k), delay: info.delay };
	}

	if (options.fetch !== false) {
		try {
			const found = await fetchThrustCurve(info);
			cache.set(k, found);
			saveStorage();
			return { ...found, delay: info.delay };
		} catch (err) {
			options.onWarning?.(`Motor ${info.designation}: ${err.message}`);
		}
	}

	const synth = synthesize(info.designation, info.diameter, info.length);
	synth.estimated = true;
	return { ...synth, delay: info.delay };
}

async function fetchThrustCurve(info) {
	const api = 'https://www.thrustcurve.org/api/v1';
	const query = new URLSearchParams({ designation: info.designation });
	if (info.manufacturer) query.set('manufacturer', info.manufacturer);
	const res = await fetch(`${api}/search.json?${query}`, { headers: { accept: 'application/json' } });
	if (!res.ok) throw new Error(`ThrustCurve search failed (${res.status})`);
	const data = await res.json();
	const results = data.results || [];
	if (!results.length) throw new Error('no matching motor at ThrustCurve.org');

	// Prefer the variant whose case dimensions match the design.
	const wantD = Math.round(info.diameter * 1000);
	const wantL = Math.round(info.length * 1000);
	const match = results.find((r) => Math.abs(r.diameter - wantD) <= 1 && Math.abs(r.length - wantL) <= 2) ||
		results.find((r) => Math.abs(r.diameter - wantD) <= 1) || results[0];

	const dl = await fetch(`${api}/download.json?motorId=${encodeURIComponent(match.motorId)}&format=RASP`);
	if (!dl.ok) throw new Error(`ThrustCurve download failed (${dl.status})`);
	const payload = await dl.json();
	const body = payload.results?.[0]?.data;
	if (!body) throw new Error('ThrustCurve returned no thrust data');

	// The API encodes the motor file as base64 in the `data` field.
	const text = looksBase64(body) ? decodeBase64(body) : body;
	const parsed = parseEng(text, match.commonName || info.designation);
	parsed.manufacturer = match.manufacturerAbbrev || match.manufacturer || info.manufacturer;
	parsed.diameter = parsed.diameter || info.diameter;
	parsed.length = parsed.length || info.length;
	if (!parsed.totalMass) parsed.totalMass = (match.totalWeightG || 0) / 1000;
	if (!parsed.propMass) parsed.propMass = (match.propWeightG || 0) / 1000;
	parsed.caseMass = Math.max(0, parsed.totalMass - parsed.propMass);
	parsed.source = 'ThrustCurve.org';
	parsed.approximate = false;
	parsed.motorId = match.motorId;
	parsed.delays = (match.delays || '').split(',').map(Number).filter(Number.isFinite);
	return parsed;
}

function looksBase64(s) {
	const sample = s.slice(0, 200).replace(/\s+/g, '');
	return /^[A-Za-z0-9+/]+={0,2}$/.test(sample) && sample.length > 20;
}

function decodeBase64(s) {
	if (typeof atob === 'function') return atob(s);
	if (typeof Buffer !== 'undefined') return Buffer.from(s, 'base64').toString('latin1');
	throw new Error('No base64 decoder available');
}

/** Load a user-supplied .eng/.rse file. */
export function loadEngFile(text) {
	const motor = parseEng(text);
	cache.set(key(motor), motor);
	saveStorage();
	return motor;
}

/** All motors currently known (for the UI). */
export function knownMotors() {
	return [...cache.values()];
}
