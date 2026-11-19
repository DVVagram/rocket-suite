/**
 * Flight simulation.
 *
 * Six-degree-of-freedom-lite integration: the translational state is
 * integrated with RK4 in three dimensions while attitude follows the airflow
 * with a rate set by the static margin, which reproduces the weathercocking
 * OpenRocket predicts for a stable rocket.  Thrust, propellant mass flow,
 * gravity variation with altitude, atmospheric density, wind and parachute
 * drag are all modelled.
 */

import { atmosphere } from './aero.js';
import { thrustAt, propellantBurned } from './motors.js';
import { calculateMass, stageOf } from './mass.js';

const G = 9.80665;
const DEG = Math.PI / 180;

function add(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function scale(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }
function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function len(a) { return Math.sqrt(dot(a, a)); }
function norm(a) {
	const l = len(a);
	return l > 1e-9 ? scale(a, 1 / l) : [0, 1, 0];
}
function cross(a, b) {
	return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function lerp(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }

/**
 * Runs a flight.
 *
 * @param {object} rocket parsed design
 * @param {object} aero aerodynamic model (from createAeroModel)
 * @param {object} options
 *   configId, motors: Map<componentId, motor>, cg, mass,
 *   wind: {speed (m/s), direction (deg, where the wind blows towards); or 'from'},
 *   rodLength, rodAngle (deg from vertical), launchAltitude, maxTime
 */
export function simulate(rocket, aero, options = {}) {
	const motors = options.motors || new Map();
	const configId = options.configId;
	const config = rocket.configs.find((c) => c.id === configId) || rocket.defaultConfig;

	const countOf = (comp) => comp?.clusterCount || 1;
	const mountOf = (id) => rocket.components.find((c) => c.id === id);

	const initialMass = calculateMass(rocket, {
		motorMass: new Map([...motors].map(([id, m]) => [id, m.totalMass * countOf(mountOf(id))])),
	});

	const cg0 = options.cg ?? initialMass.cg;
	const stability = (aero.cp - cg0) / aero.refLength;

	// Motors, grouped by stage.  Every motor mount keeps its own curve, so a
	// cluster of motors in one stage produces its combined thrust.
	const stages = rocket.stages.map((stage, index) => ({
		index,
		name: stage.name,
		mass: initialMass.stages[index]?.mass || 0,
		cg: initialMass.stages[index]?.cg || 0,
		lit: false,
		burnedOut: false,
	}));

	const mounts = [];
	for (const comp of rocket.components) {
		if (!comp.motorMount) continue;
		const m = motors.get(comp.id);
		const si = stageOf(rocket, comp);
		if (m && si >= 0) {
			mounts.push({ comp, motor: m, stage: si, ignition: 0, burnout: 0 });
		}
	}

	// Staging order: the lowest stage lights first, and each higher stage then
	// follows its configured ignition event (automatic/burnout = when the stage
	// below finishes burning).
	const stageOrder = [...new Set(mounts.map((m) => m.stage))].sort((a, b) => b - a);
	let chainEnd = 0;
	stageOrder.forEach((si, i) => {
		const group = mounts.filter((m) => m.stage === si);
		const mount = group[0].comp.motorMount;
		const event = mount?.ignitionEvent || 'automatic';
		const delay = mount?.ignitionDelay || 0;
		let ignition;
		if (event === 'never') ignition = Infinity;
		else if (i === 0 || event === 'launch') ignition = 0;
		else ignition = chainEnd + delay;
		for (const m of group) {
			m.ignition = ignition;
			m.burnout = ignition + m.motor.burnTime;
		}
		chainEnd = ignition + Math.max(...group.map((m) => m.motor.burnTime));
	});

	const activeStages = new Set(stages.map((s) => s.index));
	const activeStageFlags = config.stages || [];
	for (const s of [...activeStages]) {
		if (activeStageFlags[s] === false) activeStages.delete(s);
	}

	// Wind blows along `wind.direction` (meteorological: direction it comes from).
	const windSpeed = options.wind?.speed ?? 3;
	const windFrom = (options.wind?.direction ?? 270) * DEG;
	const windDirFrom = [Math.cos(windFrom), 0, Math.sin(windFrom)];
	const wind = scale(windDirFrom, -windSpeed);

	const rodLength = options.rodLength ?? rocket.launchRodLength ?? 1.2;
	const rodAngle = (options.rodAngle ?? rocket.launchRodAngle ?? 0) * DEG;
	const rodDir = [Math.sin(rodAngle), Math.cos(rodAngle), 0];
	const launchAltitude = options.launchAltitude ?? 0;
	const maxTime = options.maxTime ?? 600;
	const dt = options.dt ?? 0.002;
	const sampleRate = options.sampleRate ?? 60;

	const state = {
		t: 0,
		pos: [0, launchAltitude, 0],
		vel: [0, 0, 0],
		axis: rodDir.slice(),
		mass: initialMass.mass,
		onRail: true,
		thrust: 0,
		recovered: false,
		deployed: new Set(),
		dragArea: 0,
	};

	const samples = [];
	const events = [];
	const separations = [];

	let cg = cg0;
	let separated = new Set();
	let lastSample = -1e9;
	let apogee = 0;
	let maxSpeed = 0;
	let maxMach = 0;
	let maxAccel = 0;
	let landed = false;
	let burnoutTime = 0;

	// Ejection charges fire from the motor in the stage that carries the
	// recovery device, after that motor's delay.
	const ejectionByStage = new Map();
	let ejectionTime = Infinity;
	for (const m of mounts) {
		if (!activeStages.has(m.stage) || !Number.isFinite(m.ignition)) continue;
		const eject = m.burnout + (m.motor.delay || 0);
		ejectionByStage.set(m.stage, Math.max(ejectionByStage.get(m.stage) ?? -Infinity, eject));
		ejectionTime = Math.min(ejectionTime, eject);
	}

	const say = (type, text) => events.push({ t: state.t, type, text });

	function motorThrust(t) {
		let total = 0;
		for (const m of mounts) {
			if (!activeStages.has(m.stage)) continue;
			if (t >= m.ignition && t < m.burnout) total += countOf(m.comp) * thrustAt(m.motor, t - m.ignition);
		}
		return total;
	}

	function currentMass(t) {
		let m = 0;
		for (const s of stages) {
			if (activeStages.has(s.index)) m += s.mass;
		}
		for (const mo of mounts) {
			if (!activeStages.has(mo.stage) || t < mo.ignition) continue;
			m -= countOf(mo.comp) * propellantBurned(mo.motor, Math.min(t - mo.ignition, mo.motor.burnTime));
		}
		return Math.max(0.001, m);
	}

	function chuteArea() {
		let area = 0;
		for (const comp of rocket.components) {
			if (!state.deployed.has(comp.id)) continue;
			if (comp.type === 'parachute') {
				area += comp.cd * Math.PI * (comp.diameter / 2) ** 2;
			} else if (comp.type === 'streamer') {
				area += comp.cd * (comp.stripLength || 0.3) * (comp.stripWidth || 0.05) * 0.5;
			}
		}
		return area;
	}

	/** Acceleration for a state vector; used by RK4. */
	function accel(pos, vel, t) {
		const alt = Math.max(0, pos[1]);
		const atm = atmosphere(alt);
		const speed = len(vel);
		const mach = speed / atm.speedOfSound;
		const vrel = sub(vel, wind);
		const vrelSpeed = len(vrel);
		const relDir = norm(vrel);
		const aoa = Math.acos(Math.min(1, Math.max(-1, dot(state.axis, relDir))));

		const q = 0.5 * atm.density * vrelSpeed * vrelSpeed;
		let cd = aero.cd(mach, Number.isFinite(aoa) ? aoa : 0, vrelSpeed, atm);

		const chute = chuteArea();
		let dragForceVec;
		if (chute > 0) {
			// Body plus canopy; the canopy dominates and is not axial.
			const bodyArea = aero.refArea * cd;
			dragForceVec = scale(relDir, -q * (bodyArea * 0.35 + chute));
		} else {
			dragForceVec = scale(relDir, -q * aero.refArea * cd);
		}

		const thrust = motorThrust(t);
		const force = add(dragForceVec, scale(state.axis, thrust));
		const g = G * Math.pow(6371000 / (6371000 + alt), 2);
		const acc = scale(force, 1 / currentMass(t));
		acc[1] -= g;
		return acc;
	}

	// Rail phase keeps the rocket on the rod until it has travelled the rod
	// length, exactly as OpenRocket does.
	let railDistance = 0;
	let lastVel = [0, 0, 0];

	function derivative(pos, vel, t) {
		if (state.onRail) {
			const a = accel(pos, vel, t);
			const along = dot(a, rodDir);
			return scale(rodDir, along);
		}
		return accel(pos, vel, t);
	}

	function step(t, pos, vel, h) {
		const k1v = derivative(pos, vel, t);
		const k1p = vel;
		const k2v = derivative(add(pos, scale(k1p, h / 2)), add(vel, scale(k1v, h / 2)), t + h / 2);
		const k2p = add(vel, scale(k1v, h / 2));
		const k3v = derivative(add(pos, scale(k2p, h / 2)), add(vel, scale(k2v, h / 2)), t + h / 2);
		const k3p = add(vel, scale(k2v, h / 2));
		const k4v = derivative(add(pos, scale(k3p, h)), add(vel, scale(k3v, h)), t + h);
		const k4p = add(vel, scale(k3v, h));

		const newPos = add(pos, scale(add(add(k1p, scale(k2p, 2)), add(scale(k3p, 2), k4p)), h / 6));
		const newVel = add(vel, scale(add(add(k1v, scale(k2v, 2)), add(scale(k3v, 2), k4v)), h / 6));
		return { pos: newPos, vel: newVel };
	}

	function deployEligible(t) {
		for (const comp of rocket.components) {
			if (!(comp.type === 'parachute' || comp.type === 'streamer')) continue;
			if (state.deployed.has(comp.id)) continue;
			const ev = comp.deployEvent || 'ejection';
			if (ev === 'apogee' && state.vel[1] < 0 && state.t > 0.5) return comp;
			if (ev === 'altitude' && state.pos[1] - launchAltitude <= comp.deployAltitude) return comp;
			if (ev === 'ejection') {
				const stageEjection = ejectionByStage.has(stageOf(rocket, comp))
					? ejectionByStage.get(stageOf(rocket, comp))
					: ejectionTime;
				if (Number.isFinite(stageEjection) && t >= stageEjection + (comp.deployDelay || 0)) return comp;
			}
			if (ev === 'never') continue;
		}
		return null;
	}

	let burnoutTimeRef = () => burnoutTime;

	say('ignition', 'Ignition');
	const t0 = 0;
	state.t = 0;

	while (state.t < maxTime) {
		const h = dt;
		const next = step(state.t, state.pos, state.vel, h);
		const prevAlt = state.pos[1];

		state.pos = next.pos;
		state.vel = next.vel;
		state.t += h;

		// Rail constraint
		if (state.onRail) {
			railDistance = dot(sub(state.pos, [0, launchAltitude, 0]), rodDir);
			if (railDistance >= rodLength) {
				state.onRail = false;
				say('rail', 'Leaves launch rod');
			}
		}

		// Attitude: align with the airflow at a rate driven by the static margin.
		if (!state.onRail) {
			const vrel = sub(state.vel, wind);
			const vrelSpeed = len(vrel);
			if (vrelSpeed > 0.5) {
				const atm = atmosphere(state.pos[1]);
				const q = 0.5 * atm.density * vrelSpeed * vrelSpeed;
				const target = norm(vrel);
				const rate = Math.min(25, 0.02 + (Math.abs(stability) + 0.2) * Math.min(40, q * 0.12));
				const f = 1 - Math.exp(-rate * h);
				state.axis = norm(lerp(state.axis, target, f));
			}
		}

		// Motors
		const thrust = motorThrust(state.t);
		state.thrust = thrust;
		if (thrust > 0) {
			maxAccel = Math.max(maxAccel, thrust / state.mass);
		}
		if (thrust > 0 && !events.some((e) => e.type === 'liftoff')) {
			say('liftoff', 'Liftoff');
		}

		// Ignition and burnout, per stage, from the motor schedule.
		for (const s of stages) {
			if (!activeStages.has(s.index)) continue;
			const group = mounts.filter((m) => m.stage === s.index && Number.isFinite(m.ignition));
			if (!group.length) continue;

			if (!s.lit && state.t >= Math.min(...group.map((m) => m.ignition))) {
				s.lit = true;
				say('ignition', `${s.name} ignition`);
			}
			const lastBurnout = Math.max(...group.map((m) => m.burnout));
			if (s.lit && !s.burnedOut && state.t >= lastBurnout) {
				s.burnedOut = true;
				burnoutTime = Math.max(burnoutTime, state.t);
				say('burnout', `${s.name} burnout`);
			}
		}

		// Stage separation: a lower stage drops away once its own motors finish.
		// Stage 0 is the sustainer and always stays.
		for (const s of stages) {
			if (s.index === 0 || !activeStages.has(s.index) || separated.has(s.index)) continue;
			const group = mounts.filter((m) => m.stage === s.index && Number.isFinite(m.ignition));
			if (!group.length) continue;
			if (state.t >= Math.max(...group.map((m) => m.burnout)) + 0.05) {
				separated.add(s.index);
				activeStages.delete(s.index);
				separations.push({
					t: state.t,
					stage: s.index,
					position: state.pos.slice(),
					velocity: state.vel.slice(),
					axis: state.axis.slice(),
				});
				say('separation', `${s.name} separation`);
			}
		}

		// Apogee / deployment
		const altitude = state.pos[1] - launchAltitude;
		const speed = len(state.vel);
		const atm = atmosphere(state.pos[1]);
		maxSpeed = Math.max(maxSpeed, speed);
		maxMach = Math.max(maxMach, speed / atm.speedOfSound);
		state.mach = speed / atm.speedOfSound;

		if (altitude > apogee) apogee = altitude;

		if (!landed && state.t > 0.2) {
			const candidate = deployEligible(state.t);
			if (candidate) {
				state.deployed.add(candidate.id);
				say('deploy', `${candidate.name} deployed`);
			}
		}

		if (state.vel[1] < 0 && state.pos[1] <= launchAltitude && state.t > 1) {
			landed = true;
			state.pos[1] = launchAltitude;
			say('landing', 'Landing');
			break;
		}

		// Sampling
		if (state.t - lastSample >= 1 / sampleRate) {
			lastSample = state.t;
			samples.push({
				t: state.t,
				pos: state.pos.slice(),
				vel: state.vel.slice(),
				axis: state.axis.slice(),
				altitude,
				speed,
				mach: state.mach,
				accel: (speed - len(lastVel)) / (1 / sampleRate),
				thrust,
				mass: currentMass(state.t),
				chute: state.deployed.size > 0,
				onRail: state.onRail,
				stages: stages.map((s) => ({ active: activeStages.has(s.index), ignition: s.ignition })),
			});
			lastVel = state.vel.slice();
		}
	}

	const descentSpeed = samples.length ? samples[samples.length - 1].speed : 0;

	return {
		samples,
		events,
		separations,
		stability,
		cg: cg0,
		cp: aero.cp,
		liftoffMass: initialMass.mass,
		apogee,
		maxSpeed,
		maxMach,
		maxAcceleration: maxAccel,
		flightTime: state.t,
		descentSpeed,
		landed,
		landingPosition: state.pos.slice(),
		landingDistance: Math.hypot(state.pos[0], state.pos[2]),
		massBreakdown: initialMass,
		motors: mounts.map((m) => ({
			component: m.comp.name,
			designation: m.motor.designation,
			manufacturer: m.motor.manufacturer,
			source: m.motor.source,
			approximate: m.motor.approximate,
			impulse: m.motor.impulse,
		})),
	};
}

export { DEG };
