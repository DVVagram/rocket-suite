/**
 * Mass and centre-of-gravity computation.
 *
 * Mirrors OpenRocket's MassCalculation: shell volumes are integrated over the
 * actual body profile, tubes are treated as rings, fins use their planform
 * (including fillet material) and recovery devices use their surface and line
 * material densities.  Results are therefore directly comparable with the
 * "Mass & CG" figures shown by the desktop application.
 */

import { SYMMETRIC_TYPES, FIN_TYPES, RECOVERY_TYPES } from './ork.js';

const SLICES = 96;

/** Radius of a normalised body component at local position x (metres). */
export function radiusAt(comp, x) {
	const L = comp.length || 1e-9;
	const t = Math.min(1, Math.max(0, x / L));

	if (comp.type === 'bodytube') {
		return comp.outerRadius;
	}

	const r1 = comp.foreRadius;
	const r2 = comp.aftRadius;
	const delta = r2 - r1;

	if (comp.type === 'nosecone' || comp.type === 'transition') {
		return r1 + shapeDelta(comp.shape, comp.shapeParam, delta, L, t * L);
	}
	return comp.outerRadius;
}

/** OpenRocket's Transition.Shape profile functions (returned as a delta). */
function shapeDelta(shape, param, radius, length, x) {
	switch (shape) {
		case 'conical':
			return (radius * x) / length;
		case 'ogive': {
			const p = Math.min(1, Math.max(0, param));
			if (p < 1e-5) return (radius * x) / length;
			// Short ogives cannot be constructed; OpenRocket scales the profile.
			let xx = x;
			let ll = length;
			if (ll < Math.abs(radius)) {
				xx = x * Math.abs(radius) / ll;
				ll = Math.abs(radius);
			}
			const R = Math.sqrt(
				(ll * ll + radius * radius) *
				(((2 - p) * ll) ** 2 + (p * radius) ** 2) / (4 * (p * radius) ** 2)
			);
			const Lp = ll / p;
			const y0 = Math.sqrt(Math.max(0, R * R - Lp * Lp));
			return Math.sqrt(Math.max(0, R * R - (Lp - xx) * (Lp - xx))) - y0;
		}
		case 'ellipsoid': {
			const xx = (x * radius) / length;
			return Math.sqrt(Math.max(0, 2 * radius * xx - xx * xx));
		}
		case 'power': {
			if (param <= 1e-5) return x <= 1e-5 ? 0 : radius;
			return radius * Math.pow(x / length, param);
		}
		case 'parabolic': {
			const p = Math.min(1, Math.max(0, param));
			const u = x / length;
			return radius * ((2 * u - p * u * u) / (2 - p));
		}
		case 'haack': {
			// LD-Haack (param 0, "Von Kármán") through LV-Haack (param 1/3).
			const u = Math.min(1, Math.max(0, x / length));
			const theta = Math.acos(1 - 2 * u);
			const c = Math.min(1, Math.max(0, param));
			const inner = theta - Math.sin(2 * theta) / 2 + c * Math.pow(Math.sin(theta), 3);
			return (radius * Math.sqrt(Math.max(0, inner))) / Math.sqrt(Math.PI);
		}
		default:
			return (radius * x) / length;
	}
}

/** Volume and centroid of a thin-walled body of revolution. */
function shellProperties(comp) {
	const t = Math.min(comp.thickness, comp.outerRadius * 0.98);
	let volume = 0;
	let moment = 0;
	const dx = comp.length / SLICES;
	for (let i = 0; i < SLICES; i++) {
		const x = (i + 0.5) * dx;
		const ro = radiusAt(comp, x);
		const ri = Math.max(0, ro - t);
		const a = Math.PI * (ro * ro - ri * ri);
		volume += a * dx;
		moment += a * dx * x;
	}
	if (volume <= 0) {
		// Zero length or zero thickness: fall back to the projected face so that
		// massless components do not produce NaNs.
		return { volume: 0, centroid: comp.length / 2 };
	}
	return { volume, centroid: moment / volume };
}

function ringProperties(outerR, innerR, length) {
	const ro = Math.max(outerR, innerR);
	const ri = Math.min(outerR, innerR);
	return { volume: Math.PI * (ro * ro - ri * ri) * length, centroid: length / 2 };
}

function finPlanform(finPoints) {
	// Shoelace area and centroid in (chord, span) space.
	let area = 0;
	let cx = 0;
	let cy = 0;
	for (let i = 0; i < finPoints.length; i++) {
		const p = finPoints[i];
		const q = finPoints[(i + 1) % finPoints.length];
		const cross = p.x * q.y - q.x * p.y;
		area += cross;
		cx += (p.x + q.x) * cross;
		cy += (p.y + q.y) * cross;
	}
	area *= 0.5;
	if (Math.abs(area) < 1e-12) {
		return { area: 0, cx: 0, cy: 0 };
	}
	return { area: Math.abs(area), cx: cx / (6 * area), cy: cy / (6 * area) };
}

/**
 * Mass properties of a single component, in kg and metres from the nose tip.
 * `motorMass` is supplied by the flight simulator for motor mounts.
 */
export function componentMass(comp, opts = {}) {
	const density = comp.material?.density || 0;
	let mass = 0;
	let cg = comp.x0 + comp.length / 2;

	switch (comp.type) {
		case 'nosecone':
		case 'transition':
		case 'bodytube': {
			const shell = shellProperties(comp);
			mass = density * shell.volume;
			cg = comp.x0 + shell.centroid;

			// Shoulders are solid-ish tubes that overlap the neighbouring body.
			for (const key of ['foreShoulder', 'aftShoulder']) {
				const s = comp[key];
				if (!s || !(s.length > 0) || !(s.radius > 0)) continue;
				const wall = Math.min(s.thickness || comp.thickness, s.radius * 0.98);
				const ring = ringProperties(s.radius, s.radius - wall, s.length);
				const m = density * ring.volume;
				const sx = key === 'aftShoulder'
					? comp.x1 + s.length / 2
					: comp.x0 - s.length / 2;
				if (m > 0) {
					cg = (cg * mass + sx * m) / (mass + m);
					mass += m;
				}
				if (s.capped) {
					const capMass = density * Math.PI * s.radius * s.radius * wall;
					const capX = key === 'aftShoulder' ? comp.x1 + s.length : comp.x0 - s.length;
					if (capMass > 0) {
						cg = (cg * mass + capX * capMass) / (mass + capMass);
						mass += capMass;
					}
				}
			}
			break;
		}

		case 'innertube':
		case 'tubecoupler': {
			const ring = ringProperties(comp.outerRadius, comp.innerRadius, comp.length);
			mass = density * ring.volume;
			cg = comp.x0 + ring.centroid;
			break;
		}

		case 'centeringring':
		case 'bulkhead':
		case 'engineblock': {
			const ring = ringProperties(comp.outerRadius, comp.innerRadius, comp.length);
			mass = density * ring.volume;
			cg = comp.x0 + comp.length / 2;
			break;
		}

		case 'launchlug':
		case 'railbutton': {
			const ring = ringProperties(comp.outerRadius, comp.innerRadius, comp.length);
			mass = density * ring.volume;
			cg = comp.x0 + comp.length / 2;
			break;
		}

		case 'tubefinset': {
			const ring = ringProperties(comp.outerRadius, comp.innerRadius, comp.length);
			mass = density * ring.volume * comp.instances;
			cg = comp.x0 + comp.length / 2;
			break;
		}

		case 'trapezoidfinset':
		case 'ellipticalfinset':
		case 'freeformfinset': {
			const plan = finPlanform(comp.finPoints);
			const thickness = comp.finThickness || comp.thickness;
			let volume = plan.area * thickness;
			let finCgX = plan.cx;

			// Fin fillets: a quarter-round bead on both sides of the root chord.
			if (comp.filletRadius > 0 && plan.area > 0) {
				const rf = comp.filletRadius;
				const filletArea = 2 * (1 - Math.PI / 4) * rf * rf;
				const rootChord = Math.max(...comp.finPoints.map((p) => p.x)) - Math.min(...comp.finPoints.map((p) => p.x));
				const filletVolume = filletArea * rootChord;
				const filletDensity = comp.filletMaterial?.density || density;
				const filletMass = filletDensity * filletVolume;
				const finMass = density * volume;
				const total = finMass + filletMass;
				finCgX = total > 0 ? (finMass * plan.cx + filletMass * rootChord / 2) / total : plan.cx;
				volume = total / (density || 1);
			}

			mass = density * volume * comp.instances;
			cg = comp.x0 + finCgX;
			break;
		}

		case 'parachute': {
			const area = Math.PI * (comp.diameter / 2) ** 2;
			const canopy = (comp.material?.density || 0) * area;
			const lines = (comp.lineMaterial?.density || 0) * comp.lineLength * comp.lineCount;
			mass = canopy + lines;
			cg = comp.x0 + comp.length / 2;
			break;
		}

		case 'streamer': {
			const area = (comp.stripLength || 0.3) * (comp.stripWidth || 0.05) * (comp.stripCount || 1) * 2;
			mass = (comp.material?.density || 0) * area;
			cg = comp.x0 + comp.length / 2;
			break;
		}

		case 'shockcord': {
			mass = (comp.material?.density || 0) * (comp.cordLength || 0);
			cg = comp.x0 + comp.length / 2;
			break;
		}

		case 'masscomponent': {
			mass = comp.mass || 0;
			cg = comp.x0 + comp.length / 2;
			break;
		}

		default:
			mass = 0;
	}

	if (opts.motorMass && comp.motorMount) {
		const mx = comp.x0 + comp.length - (comp.motorMount.overhang || 0) - opts.motorLength / 2;
		cg = (cg * mass + mx * opts.motorMass) / (mass + opts.motorMass || 1);
		mass += opts.motorMass;
	}

	return { mass, cg, x0: comp.x0, x1: comp.x1 };
}

/**
 * Total mass properties for the active configuration.
 *
 * @param {object} rocket parsed design
 * @param {object} options { configId, motorMass: Map<componentId, kg>, includeComponents }
 */
export function calculateMass(rocket, options = {}) {
	const motorMasses = options.motorMass || new Map();
	const perComponent = [];
	const stages = rocket.stages.map(() => ({ mass: 0, moment: 0 }));

	let mass = 0;
	let moment = 0;

	(function walk(comp) {
		// Mass components always count; motors are added at their mount.
		const motorMass = comp.motorMount ? (motorMasses.get(comp.id) || 0) : 0;
		const props = componentMass(comp, {
			motorMass,
			motorLength: comp.motorMount ? comp.motorLength || 0.07 : 0,
		});

		if (props.mass > 0) {
			mass += props.mass;
			moment += props.mass * props.cg;
			perComponent.push({ component: comp, ...props });

			const si = stageOf(rocket, comp);
			if (si >= 0) {
				stages[si].mass += props.mass;
				stages[si].moment += props.mass * props.cg;
			}
		}

		for (const c of comp.children) walk(c);
	})(rocket);

	return {
		mass,
		cg: mass > 0 ? moment / mass : 0,
		perComponent,
		stages: stages.map((s) => ({ mass: s.mass, cg: s.mass > 0 ? s.moment / s.mass : 0 })),
	};
}

export function stageOf(rocket, comp) {
	for (let i = 0; i < rocket.stages.length; i++) {
		let c = comp;
		while (c) {
			if (c === rocket.stages[i]) return i;
			c = c.parent;
		}
	}
	return -1;
}

export { finPlanform };
