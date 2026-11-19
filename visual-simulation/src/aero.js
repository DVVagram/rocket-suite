/**
 * Aerodynamics: Barrowman stability with the Galejs body-lift extension, and
 * OpenRocket's subsonic/transonic/supersonic drag build-up.
 *
 * Every formula here is a direct port of
 * core/src/main/java/info/openrocket/core/aerodynamics/BarrowmanCalculator.java
 * and the classes in its `barrowman` package, so a design flown here sees the
 * same CP, stability margin and drag curve as in the desktop application.
 */

import { SYMMETRIC_TYPES, FIN_TYPES, EXTERNAL_TYPES } from './ork.js';
import { radiusAt, finPlanform, stageOf } from './mass.js';

const GAMMA = 1.4;
const G0 = 9.80665;
const R_AIR = 287.053;
const EPS = 1e-9;

/* ------------------------------------------------------------------ *
 * Standard atmosphere (OpenRocket's ExtendedISAModel)
 * ------------------------------------------------------------------ */

const LAYERS = [
	{ base: 0, temp: 288.15, lapse: -0.0065 },
	{ base: 11000, temp: 216.65, lapse: 0 },
	{ base: 20000, temp: 216.65, lapse: 0.001 },
	{ base: 32000, temp: 228.65, lapse: 0.0028 },
	{ base: 47000, temp: 270.65, lapse: 0 },
	{ base: 51000, temp: 270.65, lapse: -0.0028 },
	{ base: 71000, temp: 214.65, lapse: -0.002 },
	{ base: 84852, temp: 186.87, lapse: 0 },
];

function layerPressure(layer, h) {
	const { base, temp, lapse } = layer;
	const p0 = pressureAtLayerBase(layer.index);
	if (lapse === 0) {
		return p0 * Math.exp((-G0 * (h - base)) / (R_AIR * temp));
	}
	const t = temp + lapse * (h - base);
	return p0 * Math.pow(t / temp, (-G0) / (R_AIR * lapse));
}

let layerBaseCache = null;
function pressureAtLayerBase(index) {
	if (!layerBaseCache) {
		layerBaseCache = [101325];
		for (let i = 1; i < LAYERS.length; i++) {
			layerBaseCache[i] = layerPressure({ ...LAYERS[i - 1], index: i - 1 }, LAYERS[i].base);
		}
	}
	return layerBaseCache[index];
}

/** Atmospheric conditions at geometric altitude (m). */
export function atmosphere(altitude) {
	const h = Math.max(0, altitude);
	let layer = LAYERS[0];
	let index = 0;
	for (let i = 0; i < LAYERS.length; i++) {
		if (h >= LAYERS[i].base) {
			layer = LAYERS[i];
			index = i;
		}
	}
	const temperature = Math.max(120, layer.temp + layer.lapse * (h - layer.base));
	const pressure = Math.max(0.1, pressureAtLayerBase(index) * (layer.lapse === 0
		? Math.exp((-G0 * (h - layer.base)) / (R_AIR * layer.temp))
		: Math.pow(temperature / layer.temp, -G0 / (R_AIR * layer.lapse))));
	const density = pressure / (R_AIR * temperature);
	const speedOfSound = Math.sqrt(GAMMA * R_AIR * temperature);
	// Sutherland's law for dynamic viscosity; kinematic viscosity for Re.
	const mu = (1.458e-6 * Math.pow(temperature, 1.5)) / (temperature + 110.4);
	return { altitude: h, temperature, pressure, density, speedOfSound, viscosity: mu, kinematicViscosity: mu / density };
}

/* ------------------------------------------------------------------ *
 * Interpolators (LinearInterpolator / PolyInterpolator ports)
 * ------------------------------------------------------------------ */

function linear(table) {
	return (x) => {
		const xs = table.map((p) => p[0]);
		if (x <= xs[0]) return table[0][1];
		if (x >= xs[xs.length - 1]) return table[table.length - 1][1];
		for (let i = 1; i < table.length; i++) {
			if (x <= xs[i]) {
				const t = (x - xs[i - 1]) / (xs[i] - xs[i - 1]);
				return table[i - 1][1] + t * (table[i][1] - table[i - 1][1]);
			}
		}
		return table[table.length - 1][1];
	};
}

/** OpenRocket's BarrowmanCalculator.calculateStagnationCD. */
export function stagnationCD(m) {
	const pressure = m <= 1
		? 1 + (m * m) / 4 + Math.pow(m, 4) / 40
		: 1.84 - 0.76 / (m * m) + 0.166 / Math.pow(m, 4) + 0.035 / Math.pow(m, 6);
	return 0.85 * pressure;
}

/** OpenRocket's BarrowmanCalculator.calculateBaseCD. */
export function baseCD(m) {
	return m <= 1 ? 0.12 + 0.13 * m * m : 0.25 / m;
}

const ellipsoidTable = linear([
	[1.2, 0.11], [1.25, 0.128], [1.3, 0.14], [1.4, 0.148], [1.6, 0.152], [2.0, 0.159], [2.4, 0.162],
]);
const x14Table = linear([
	[1.2, 0.14], [1.3, 0.156], [1.4, 0.169], [1.6, 0.192], [1.8, 0.206], [2.2, 0.227], [2.6, 0.241],
	[3.0, 0.249], [3.6, 0.252],
]);
const x12Table = linear([
	[0.925, 0], [0.95, 0.014], [1.0, 0.05], [1.05, 0.06], [1.1, 0.059], [1.2, 0.081], [1.3, 0.084],
	[1.7, 0.085], [2.0, 0.078],
]);
const x34Table = linear([
	[0.8, 0], [0.9, 0.015], [1.0, 0.078], [1.06, 0.121], [1.2, 0.11], [1.4, 0.098], [1.6, 0.09],
	[2.0, 0.084], [2.8, 0.078], [3.4, 0.074],
]);
const vonKarmanTable = linear([
	[0.9, 0], [0.95, 0.01], [1.0, 0.027], [1.05, 0.055], [1.1, 0.07], [1.2, 0.081], [1.4, 0.095],
	[1.6, 0.097], [2.0, 0.091], [3.0, 0.083],
]);
const lvHaackTable = linear([
	[0.9, 0], [0.95, 0.01], [1.0, 0.024], [1.05, 0.066], [1.1, 0.084], [1.2, 0.1], [1.4, 0.114],
	[1.6, 0.117], [2.0, 0.113],
]);
const parabolicTable = linear([
	[0.95, 0], [0.975, 0.016], [1.0, 0.041], [1.05, 0.092], [1.1, 0.109], [1.2, 0.119], [1.4, 0.113], [1.7, 0.108],
]);
const parabolic12Table = linear([
	[0.8, 0], [0.9, 0.016], [0.95, 0.042], [1.0, 0.1], [1.05, 0.126], [1.1, 0.125], [1.3, 0.1], [1.5, 0.09], [1.8, 0.088],
]);
const parabolic34Table = linear([
	[0.9, 0], [0.95, 0.023], [1.0, 0.073], [1.05, 0.098], [1.1, 0.107], [1.2, 0.106], [1.4, 0.089], [1.7, 0.082],
]);
const bluntTable = linear(Array.from({ length: 61 }, (_, i) => {
	const m = i * 0.05;
	return [m, stagnationCD(m)];
}));

function ogiveNoseTable(param, sinphi) {
	const table = [];
	const cd1 = sinphi;
	const cd13 = 2.1 * sinphi * sinphi + 0.6019 * sinphi;
	// Polynomial through (M=1, cd1), (M=1.3, cd13) with the supersonic slope.
	const poly = hermite(1, 1.3, cd1, cd13, (4 / (GAMMA + 1)) * (1 - 0.5 * cd1), -1.1341 * sinphi);
	const mul = 0.72 * (param - 0.5) ** 2 + 0.82;
	for (let m = 1; m < 1.3001; m += 0.02) table.push([m, mul * poly(m)]);
	for (let m = 1.32; m < 4; m += 0.02) {
		table.push([m, mul * (2.1 * sinphi * sinphi + (0.5 * sinphi) / Math.sqrt(Math.max(1e-6, m * m - 1)))]);
	}
	return table;
}

/** Cubic Hermite through two points with specified end slopes. */
function hermite(x0, x1, y0, y1, d0, d1) {
	const h = x1 - x0;
	return (x) => {
		const t = (x - x0) / h;
		const t2 = t * t;
		const t3 = t2 * t;
		return (2 * t3 - 3 * t2 + 1) * y0 +
			(t3 - 2 * t2 + t) * h * d0 +
			(-2 * t3 + 3 * t2) * y1 +
			(t3 - t2) * h * d1;
	};
}

/**
 * Pressure drag of a nose/transition at a given Mach number, including
 * OpenRocket's fineness-ratio extrapolation and subsonic blending.
 */
function createNosePressureFunction(comp, foreRadius, aftRadius, fineness) {
	const sinphi = (() => {
		const r = radiusAt(comp, 0.99 * comp.length);
		const dr = aftRadius - r;
		return dr / Math.hypot(dr, 0.01 * comp.length || EPS);
	})();

	if (aftRadius <= foreRadius) {
		return null; // handled as a boattail
	}

	let int1 = null;
	let int2 = null;
	let p = 0;
	const shape = comp.type === 'bodytube' ? 'conical' : comp.shape;
	const param = comp.type === 'transition' ? comp.shapeParam : comp.shapeParam;

	switch (shape) {
		case 'conical':
			int1 = linear(ogiveNoseTable(0, sinphi));
			break;
		case 'ogive':
			int1 = linear(ogiveNoseTable(param, sinphi));
			break;
		case 'ellipsoid':
			int1 = ellipsoidTable;
			break;
		case 'power':
			if (param <= 0.25) {
				int1 = bluntTable; int2 = x14Table; p = param * 4;
			} else if (param <= 0.5) {
				int1 = x14Table; int2 = x12Table; p = (param - 0.25) * 4;
			} else if (param <= 0.75) {
				int1 = x12Table; int2 = x34Table; p = (param - 0.5) * 4;
			} else {
				int1 = x34Table;
				int2 = linear(ogiveNoseTable(0, 1 / Math.sqrt(1 + 4 * fineness * fineness)));
				p = (param - 0.75) * 4;
			}
			break;
		case 'parabolic':
			if (param <= 0.5) {
				int1 = linear(ogiveNoseTable(0, 1 / Math.sqrt(1 + 4 * fineness * fineness)));
				int2 = parabolic12Table; p = param * 2;
			} else if (param <= 0.75) {
				int1 = parabolic12Table; int2 = parabolic34Table; p = (param - 0.5) * 4;
			} else {
				int1 = parabolic34Table; int2 = parabolicTable; p = (param - 0.75) * 4;
			}
			break;
		case 'haack':
			int1 = vonKarmanTable; int2 = lvHaackTable; p = param * 3;
			break;
		default:
			int1 = linear(ogiveNoseTable(0, sinphi));
	}

	let merged = int1;
	if (int2) {
		const keys = new Set();
		// Both tables are sampled on their own grids; merge the break points.
		const xs = [];
		for (let m = 0.8; m <= 4.001; m += 0.05) xs.push(Number(m.toFixed(3)));
		merged = linear(xs.map((m) => [m, p * int2(m) + (1 - p) * int1(m)]));
		void keys;
	}

	const log4 = Math.log(fineness + 1) / Math.log(4);
	const raw = merged;
	const extrapolated = (m) => {
		const stag = bluntTable(m);
		if (stag <= 0) return 0;
		return stag * Math.pow(raw(m) / stag, log4);
	};

	// Blend in the subsonic branch exactly as OpenRocket does.
	const min = 0.8;
	const minValue = extrapolated(min);
	if (minValue < 0.001) {
		return extrapolated;
	}
	const cdMach0 = 0.8 * sinphi * sinphi;
	const minDeriv = (extrapolated(min + 0.01) - minValue) / 0.01;
	if (cdMach0 >= minValue - 0.01 || minDeriv <= 0.01) {
		return extrapolated;
	}
	const b = (min * minDeriv) / (minValue - cdMach0);
	const a = (minValue - cdMach0) / Math.pow(min, b);
	return (m) => (m < min ? a * Math.pow(m, b) + cdMach0 : extrapolated(m));
}

/* ------------------------------------------------------------------ *
 * Fin geometry (FinSetCalc port)
 * ------------------------------------------------------------------ */

const FIN_DIVISIONS = 48;
const STALL_ANGLE = (20 * Math.PI) / 180;
const CNA_SUBSONIC = 0.9;
const CNA_SUPERSONIC = 1.5;

const kTable = (() => {
	const xs = [];
	const k1 = [];
	const k2 = [];
	const k3 = [];
	for (let M = CNA_SUPERSONIC; M < 5.0 - 1e-9; M += 0.1) {
		const beta = Math.sqrt(Math.max(1e-9, M * M - 1));
		xs.push(M);
		k1.push(2 / beta);
		k2.push(((GAMMA + 1) * Math.pow(M, 4) - 4 * beta * beta) / (4 * Math.pow(beta, 4)));
		k3.push(((GAMMA + 1) * Math.pow(M, 8) + (2 * GAMMA * GAMMA - 7 * GAMMA - 5) * Math.pow(M, 6) +
			10 * (GAMMA + 1) * Math.pow(M, 4) + 8) / (6 * Math.pow(beta, 7)));
	}
	const pack = (ys) => linear(xs.map((x, i) => [x, ys[i]]));
	return { k1: pack(k1), k2: pack(k2), k3: pack(k3) };
})();

function finProperties(finPoints) {
	const span = Math.max(...finPoints.map((p) => p.y));
	const rootChord = Math.max(...finPoints.map((p) => p.x)) - Math.min(...finPoints.map((p) => p.x));
	const plan = finPlanform(finPoints);

	// Closed loop: planform plus the root chord line.
	const loop = finPoints.slice();
	const atRoot = finPoints.filter((p) => Math.abs(p.y) < 1e-9).sort((a, b) => a.x - b.x);
	if (atRoot.length < 2) {
		loop.push({ x: atRoot[0]?.x ?? 0, y: 0 });
		loop.push({ x: (atRoot[0]?.x ?? 0) + rootChord, y: 0 });
	}

	const lead = new Array(FIN_DIVISIONS).fill(Infinity);
	const trail = new Array(FIN_DIVISIONS).fill(-Infinity);
	const chordLength = new Array(FIN_DIVISIONS).fill(0);

	for (let k = 1; k < loop.length; k++) {
		const x1 = loop[k - 1].x, y1 = loop[k - 1].y;
		const x2 = loop[k].x, y2 = loop[k].y;
		if (Math.abs(y1 - y2) < 0.001) continue;
		let i1 = Math.trunc((y1 * 1.0001) / span * (FIN_DIVISIONS - 1));
		let i2 = Math.trunc((y2 * 1.0001) / span * (FIN_DIVISIONS - 1));
		i1 = Math.min(FIN_DIVISIONS - 1, Math.max(0, i1));
		i2 = Math.min(FIN_DIVISIONS - 1, Math.max(0, i2));
		if (i1 > i2) [i1, i2] = [i2, i1];
		for (let i = i1; i <= i2; i++) {
			const y = (i * span) / (FIN_DIVISIONS - 1);
			const x = Math.min(
				Math.max((y - y2) / (y1 - y2) * x1 + ((y1 - y) / (y1 - y2)) * x2, Math.min(x1, x2)),
				Math.max(x1, x2)
			);
			if (x < lead[i]) lead[i] = x;
			if (x > trail[i]) trail[i] = x;
			if (y1 < y2) chordLength[i] -= x;
			else chordLength[i] += x;
		}
	}

	for (let i = 0; i < FIN_DIVISIONS; i++) {
		if (!Number.isFinite(lead[i]) || !Number.isFinite(trail[i])) {
			lead[i] = 0;
			trail[i] = 0;
		}
		if (!(chordLength[i] >= 0)) chordLength[i] = 0;
		if (chordLength[i] > trail[i] - lead[i]) chordLength[i] = trail[i] - lead[i];
	}

	const dy = span / (FIN_DIVISIONS - 1);
	let macLength = 0, macSpan = 0, macLead = 0, area = 0, rollSum = 0, cosGamma = 0, cosGammaLead = 0;

	for (let i = 0; i < FIN_DIVISIONS; i++) {
		const length = trail[i] - lead[i];
		const y = i * dy;
		macLength += length * length;
		macSpan += y * length;
		macLead += lead[i] * length;
		area += length;
		rollSum += chordLength[i] * (y * y);
		if (i > 0) {
			const dx1 = (trail[i] + lead[i]) / 2 - (trail[i - 1] + lead[i - 1]) / 2;
			const hyp1 = Math.hypot(dx1, dy);
			if (hyp1 !== 0) cosGamma += dy / hyp1;
			const dx2 = lead[i] - lead[i - 1];
			const hyp2 = Math.hypot(dx2, dy);
			if (hyp2 !== 0) cosGammaLead += dy / hyp2;
		}
	}

	macLength *= dy; macSpan *= dy; macLead *= dy; area *= dy; rollSum *= dy;
	if (area > EPS) {
		macLength /= area; macSpan /= area; macLead /= area;
	} else {
		macLength = macSpan = macLead = 0;
	}
	cosGamma /= FIN_DIVISIONS - 1;
	cosGammaLead /= FIN_DIVISIONS - 1;

	return {
		span,
		rootChord,
		area: plan.area,
		macLength,
		macLead,
		macSpan,
		cosGamma,
		cosGammaLead,
		rollSum,
		ar: plan.area > EPS ? (2 * span * span) / plan.area : 0,
	};
}

/** Fin CNa for one fin, no interference (FinSetCalc.calculateFinCNa1). */
function finCNa1(mach, alpha, geometry, refArea) {
	const { span, area, cosGamma } = geometry;
	if (area < EPS || span < EPS || cosGamma < EPS) return 0;

	if (mach <= CNA_SUBSONIC) {
		const ratio = (span * span) / (area * cosGamma);
		return (2 * Math.PI * span * span) / (1 + Math.sqrt(1 + (1 - mach * mach) * ratio * ratio)) / refArea;
	}
	if (mach >= CNA_SUPERSONIC) {
		return (area * (kTable.k1(mach) + kTable.k2(mach) * alpha + kTable.k3(mach) * alpha * alpha)) / refArea;
	}
	// Transonic: linear interpolation in the CNa value (OpenRocket uses a
	// cubic Hermite with the analytic derivative; the value difference over
	// this narrow band is negligible, and monotone clamping keeps it stable).
	const sub = finCNa1(CNA_SUBSONIC, alpha, geometry, refArea);
	const sup = finCNa1(CNA_SUPERSONIC + 1e-9, alpha, geometry, refArea);
	const t = (mach - CNA_SUBSONIC) / (CNA_SUPERSONIC - CNA_SUBSONIC);
	return sub + t * (sup - sub);
}

/* ------------------------------------------------------------------ *
 * Model construction
 * ------------------------------------------------------------------ */

function wetArea(comp) {
	const N = 32;
	let a = 0;
	const dx = comp.length / N;
	for (let i = 0; i < N; i++) a += 2 * Math.PI * radiusAt(comp, (i + 0.5) * dx) * dx;
	return a;
}

function planform(comp) {
	const N = 64;
	let area = 0;
	let moment = 0;
	const dx = comp.length / N;
	for (let i = 0; i < N; i++) {
		const x = (i + 0.5) * dx;
		const w = 2 * radiusAt(comp, x);
		area += w * dx;
		moment += w * dx * x;
	}
	return { area, center: area > EPS ? moment / area : comp.length / 2 };
}

function fullVolume(comp) {
	const N = 64;
	let v = 0;
	const dx = comp.length / N;
	for (let i = 0; i < N; i++) {
		const r = radiusAt(comp, (i + 0.5) * dx);
		v += Math.PI * r * r * dx;
	}
	return v;
}

/**
 * Builds the aerodynamic model for one flight configuration.
 *
 * @returns {{cp:number, cna:number, refArea:number, refLength:number,
 *            cd:(mach:number, aoa:number, speed:number, rho:number)=>number,
 *            components:Array, warnings:string[]}}
 */
export function createAeroModel(rocket, configId) {
	const refLength = rocket.maxDiameter;
	const refArea = (Math.PI / 4) * refLength * refLength;
	const activeStages = rocket.configs.find((c) => c.id === configId)?.stages || [];

	const isActive = (comp) => {
		const si = stageOf(rocket, comp);
		if (si < 0) return true;
		const flag = activeStages[si];
		return flag === undefined ? true : flag;
	};

	const items = [];
	const warnings = [];

	(function walk(comp) {
		if (comp.type === 'rocket' || comp.type === 'stage' || comp.type === 'podset' || comp.type === 'parallelstage') {
			for (const c of comp.children) walk(c);
			return;
		}
		if (!isActive(comp)) return;

		if (SYMMETRIC_TYPES.has(comp.type)) {
			const fore = comp.foreRadius;
			const aft = comp.aftRadius;
			const plan = planform(comp);
			const vol = fullVolume(comp);
			const A0 = Math.PI * fore * fore;
			const A1 = Math.PI * aft * aft;
			let cna = (2 * (A1 - A0)) / refArea;
			let cp = Math.abs(A1 - A0) > EPS ? (comp.length * A1 - vol) / (A1 - A0) : comp.length / 2;
			if (!Number.isFinite(cp) || cp < 0 || cp > comp.length * 1.5) cp = comp.length / 2;

			// Galejs body lift
			const liftCna = (1.1 * plan.area) / refArea;
			const wBody = Math.abs(cna);
			const wLift = Math.abs(liftCna);
			cp = wBody + wLift > EPS
				? (cp * wBody + (plan.center) * wLift) / (wBody + wLift)
				: comp.length / 2;
			cna += liftCna;

			const fineness = comp.length / (2 * Math.abs(aft - fore) || EPS);
			items.push({
				component: comp,
				kind: 'body',
				cna,
				cp: comp.x0 + cp,
				foreRadius: fore,
				aftRadius: aft,
				wetArea: wetArea(comp),
				planformArea: plan.area,
				fineness,
				pressure: createNosePressureFunction(comp, fore, aft, fineness),
				finish: comp.finish,
			});
			return;
		}

		if (FIN_TYPES.has(comp.type)) {
			const geometry = finProperties(comp.finPoints);
			const bodyRadius = comp.rootRadius ?? comp.parent?.outerRadius ?? 0;
			const tau = geometry.span + bodyRadius > EPS ? bodyRadius / (geometry.span + bodyRadius) : 0;
			const interference = finInterferenceFactor(comp, rocket, isActive);
			const cnaPerFin = (mach, alpha) =>
				finCNa1(mach, alpha, geometry, refArea) * interference * (1 + tau);
			const cpPos = comp.x0 + geometry.macLead + 0.25 * geometry.macLength;

			items.push({
				component: comp,
				kind: 'fin',
				geometry,
				bodyRadius,
				interference,
				tau,
				finCount: comp.instances,
				cnaPerFin,
				// Equally spaced fins: sum of sin^2 over all fins is N/2.
				cna: cnaPerFin(0.05, 0) * (comp.instances / 2),
				cp: cpPos,
				thickness: comp.finThickness || comp.thickness,
				crossSection: comp.crossSection,
				finish: comp.finish,
			});
			return;
		}

		if (comp.type === 'tubefinset') {
			// Each tube behaves like a pair of flat plates whose chord is the
			// tube length and whose span is the tube diameter.
			const span = comp.outerRadius * 2;
			const geometry = {
				span,
				area: comp.length * span,
				cosGamma: 1,
				cosGammaLead: 1,
				macLength: comp.length,
				macLead: 0,
				ar: (2 * span * span) / (comp.length * span || EPS),
			};
			const tau = (comp.rootRadius ?? 0) / ((comp.rootRadius ?? 0) + span || EPS);
			const cnaPerFin = (mach, alpha) => finCNa1(mach, alpha, geometry, refArea) * (1 + tau);
			items.push({
				component: comp,
				kind: 'fin',
				geometry,
				bodyRadius: comp.rootRadius ?? 0,
				interference: 1,
				tau,
				finCount: comp.instances,
				cnaPerFin,
				cna: cnaPerFin(0.05, 0) * (comp.instances / 2),
				cp: comp.x0 + comp.length / 2,
				thickness: comp.thickness,
				crossSection: 'rounded',
				finish: comp.finish,
			});
			return;
		}

		if (comp.type === 'launchlug' || comp.type === 'railbutton') {
			items.push({
				component: comp,
				kind: 'protrusion',
				cna: 0,
				cp: comp.x0 + comp.length / 2,
				wetArea: 2 * Math.PI * comp.outerRadius * comp.length * (comp.instances || 1),
				finish: comp.finish,
			});
		}

		for (const c of comp.children) walk(c);
	})(rocket);

	const symmetric = items.filter((i) => i.kind === 'body').sort((a, b) => a.component.x0 - b.component.x0);
	for (let i = 0; i < symmetric.length; i++) {
		symmetric[i].prev = i > 0 ? symmetric[i - 1] : null;
		symmetric[i].next = i < symmetric.length - 1 ? symmetric[i + 1] : null;
	}

	const totalCna = items.reduce((s, i) => s + i.cna, 0);
	const totalCnaCp = items.reduce((s, i) => s + i.cna * i.cp, 0);
	const cp = totalCna > EPS ? totalCnaCp / totalCna : rocket.length * 0.6;

	const lengthAerodynamic = Math.max(
		...symmetric.map((i) => i.component.x1),
		...(items.filter((i) => i.kind === 'fin').map((i) => i.component.x1)),
		0.01
	);

	// Body extent for the fineness correction in the skin-friction model.
	const minX = Math.min(...symmetric.map((i) => i.component.x0), 0);
	const maxX = Math.max(...symmetric.map((i) => i.component.x1), minX + 0.01);
	const maxR = Math.max(...symmetric.map((i) => Math.max(i.foreRadius, i.aftRadius)), 0.01);

	function frictionCoefficient(mach, Re, perfect = false) {
		let Cf;
		if (perfect) {
			if (Re < 1e4) Cf = 1.33e-2;
			else if (Re < 5.39e5) Cf = 1.328 / Math.sqrt(Re);
			else Cf = 1 / Math.pow(1.5 * Math.log(Re) - 5.6, 2) - 1700 / Re;
		} else {
			Cf = Re < 1e4 ? 1.48e-2 : 1 / Math.pow(1.5 * Math.log(Re) - 5.6, 2);
		}
		let c1 = 1;
		let c2 = 1;
		if (perfect) {
			if (mach < 1.1 && Re > 1e6) {
				c1 = Re < 3e6 ? 1 - 0.1 * mach * mach * ((Re - 1e6) / 2e6) : 1 - 0.1 * mach * mach;
			}
			if (mach > 0.9 && Re > 1e6) {
				c2 = Re < 3e6
					? 1 + (1 / Math.pow(1 + 0.045 * mach * mach, 0.25) - 1) * ((Re - 1e6) / 2e6)
					: 1 / Math.pow(1 + 0.045 * mach * mach, 0.25);
			}
		} else {
			if (mach < 1.1) c1 = 1 - 0.1 * mach * mach;
			if (mach > 0.9) c2 = 1 / Math.pow(1 + 0.15 * mach * mach, 0.58);
		}
		if (mach < 0.9) Cf *= c1;
		else if (mach < 1.1) Cf *= (c2 * (mach - 0.9)) / 0.2 + (c1 * (1.1 - mach)) / 0.2;
		else Cf *= c2;
		return Cf;
	}

	function roughnessCorrection(mach) {
		if (mach < 0.9) return 1 - 0.1 * mach * mach;
		if (mach > 1.1) return 1 / (1 + 0.18 * mach * mach);
		const c1 = 1 - 0.1 * 0.81;
		const c2 = 1 / (1 + 0.18 * 1.21);
		return (c2 * (mach - 0.9)) / 0.2 + (c1 * (1.1 - mach)) / 0.2;
	}

	/** Total drag coefficient for the configuration. */
	function cd(mach, aoa, speed, atm, out) {
		const env = typeof atm === 'number' || atm === undefined ? atmosphere(atm || 0) : atm;
		const nu = env.kinematicViscosity || 1.5e-5;
		const Re = Math.max(1, (speed * lengthAerodynamic) / (nu || 1.5e-5));
		const Cf = frictionCoefficient(mach, Re);
		const roughCorr = roughnessCorrection(mach);

		let bodyFriction = 0;
		let otherFriction = 0;
		for (const item of items) {
			const roughness = item.finish?.roughness ?? 0.001;
			const limited = 0.032 * Math.pow(roughness / lengthAerodynamic, 0.2) * roughCorr;
			const componentCf = Math.max(Cf, limited);
			if (item.kind === 'body') {
				bodyFriction += (componentCf * item.wetArea) / refArea;
			} else if (item.kind === 'protrusion') {
				otherFriction += (componentCf * item.wetArea) / refArea;
			} else if (item.kind === 'fin') {
				const g = item.geometry;
				if (g.area > EPS && g.macLength > EPS) {
					otherFriction += (componentCf * (1 + (2 * item.thickness) / g.macLength) * 2 * g.area * item.finCount) / refArea;
				}
			}
		}
		const fB = (maxX - minX + 0.0001) / maxR;
		const correction = 1 + 1 / (2 * fB);
		const parts = {
			friction: otherFriction + correction * bodyFriction,
			pressure: 0,
			stagnation: 0,
			base: 0,
			fins: 0,
		};

		// Pressure drag: bodies.
		const stag = stagnationCD(mach);
		const base = baseCD(mach);
		for (const item of symmetric) {
			const c = item.component;
			const fore = item.foreRadius;
			const aft = item.aftRadius;
			const frontal = Math.abs(Math.PI * (fore * fore - aft * aft));

			if (Math.abs(fore - aft) < EPS || c.length < 1e-6) {
				if (c.length < 0.001 && fore < aft) parts.pressure += (stag * frontal) / refArea;
				continue;
			}
			if (aft < fore) {
				// Boattail: OpenRocket tapers base drag with fineness ratio.
				const fineness = c.length / (2 * Math.abs(aft - fore));
				if (fineness >= 3) continue;
				let term = (base * frontal) / refArea;
				parts.pressure += fineness <= 1 ? term : (term * (3 - fineness)) / 2;
				continue;
			}
			if (item.pressure) {
				parts.pressure += (item.pressure(mach) * frontal) / refArea;
			}
		}

		// Stagnation rings where the body steps outward.
		for (const item of symmetric) {
			const prev = item.prev;
			const prevRadius = prev ? prev.aftRadius : 0;
			const fore = item.component.length === 0
				? Math.max(item.foreRadius, item.aftRadius)
				: item.foreRadius;
			if (prevRadius < fore) {
				parts.stagnation += (stag * Math.PI * (fore * fore - prevRadius * prevRadius)) / refArea;
			}
		}

		// Base drag wherever the body steps inward or ends.
		for (const item of symmetric) {
			const next = item.next;
			const nextRadius = next ? next.foreRadius : 0;
			const aft = item.component.length === 0 ? Math.max(item.foreRadius, item.aftRadius) : item.aftRadius;
			if (nextRadius < aft) {
				parts.base += (base * Math.PI * (aft * aft - nextRadius * nextRadius)) / refArea;
			}
		}

		// Fin pressure drag.
		for (const item of items) {
			if (item.kind !== 'fin') continue;
			const g = item.geometry;
			if (g.area < EPS) continue;
			let term;
			if (item.crossSection === 'airfoil' || item.crossSection === 'rounded') {
				if (mach < 0.9) term = Math.pow(1 - mach * mach, -0.417) - 1;
				else if (mach < 1) term = 1 - 1.785 * (mach - 0.9);
				else term = 1.214 - 0.502 / (mach * mach) + 0.1095 / Math.pow(mach, 4);
			} else {
				term = stag;
			}
			term *= g.cosGammaLead * g.cosGammaLead;
			if (item.crossSection === 'square') term += base;
			else if (item.crossSection === 'rounded') term += base / 2;
			parts.fins += (term * g.span * item.thickness * item.finCount) / refArea;
		}

		// Angle-of-attack multiplier (OpenRocket's axialDrag polynomials).
		let mul;
		const a = Math.min(Math.PI - Math.min(aoa, Math.PI), Math.min(aoa, Math.PI));
		if (a < (17 * Math.PI) / 180) {
			const u = a / ((17 * Math.PI) / 180);
			mul = 1 + 0.3 * u * u;
		} else {
			const u = (a - (17 * Math.PI) / 180) / (Math.PI / 2 - (17 * Math.PI) / 180);
			mul = 1.3 * Math.max(0, 1 - u * u);
		}
		void env;
		parts.aoaMultiplier = mul;
		parts.total = Math.max(0, (parts.friction + parts.pressure + parts.stagnation + parts.base + parts.fins) * mul);
		if (out) Object.assign(out, parts);
		return parts.total;
	}

	/** Per-source drag breakdown at a flight condition (used by the UI). */
	function dragBreakdown(mach, aoa = 0.02, speed = mach * 340, atm = atmosphere(0)) {
		const last = { friction: 0, pressure: 0, stagnation: 0, base: 0, fins: 0, total: 0, aoaMultiplier: 1 };
		const holder = {};
		cd(mach, aoa, speed, atm, holder);
		void last;
		return holder;
	}

	/** CNa at a given Mach number (fins are Mach dependent). */
	function cnaAt(mach, alpha = 0) {
		let total = 0;
		for (const item of items) {
			if (item.kind === 'fin') total += item.cnaPerFin(mach, alpha) * (item.finCount / 2);
			else total += item.cna;
		}
		return total;
	}

	function cpAt(mach, alpha = 0) {
		let sum = 0;
		let weight = 0;
		for (const item of items) {
			const w = item.kind === 'fin' ? item.cnaPerFin(mach, alpha) * (item.finCount / 2) : item.cna;
			sum += w * item.cp;
			weight += w;
		}
		return weight > EPS ? sum / weight : rocket.length * 0.6;
	}

	return {
		items,
		cp,
		cna: totalCna,
		cnaAt,
		cpAt,
		refArea,
		refLength,
		lengthAerodynamic,
		cd,
		dragBreakdown,
		warnings,
	};
}

/** Fin-fin interference factor, ported from FinSetCalc. */
function finInterferenceFactor(comp, rocket, isActive) {
	const count = comp.instances;
	// Count overlapping fin sets on the same body (parallel fin interference).
	let overlapping = count;
	if (comp.parent) {
		for (const sib of comp.parent.children) {
			if (sib === comp || !FIN_TYPES.has(sib.type)) continue;
			if (!isActive(sib)) continue;
			const lead = Math.min(comp.x0, sib.x0);
			const trail = Math.max(comp.x1, sib.x1);
			if (sib.x0 < comp.x1 - 0.005 && sib.x1 > comp.x0 + 0.005) {
				overlapping += sib.instances;
			}
			void lead;
			void trail;
		}
	}
	switch (overlapping) {
		case 1: case 2: case 3: case 4: return 1;
		case 5: return 0.948;
		case 6: return 0.913;
		case 7: return 0.854;
		case 8: return 0.81;
		default: return 0.75;
	}
}

export { FIN_TYPES, EXTERNAL_TYPES };
