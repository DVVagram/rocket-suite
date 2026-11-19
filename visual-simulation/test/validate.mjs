/**
 * Validation harness.
 *
 * Reads every design bundled with OpenRocket 24.12, builds the component tree,
 * mass properties, aerodynamic model and a full flight, then compares the
 * result against the flight data OpenRocket itself stored inside each file
 * (`<flightdata maxaltitude=...>`).  Those stored results are produced by
 * OpenRocket's own RK4 simulator, so the comparison is a direct accuracy check
 * of the ported models.
 *
 * Run: node test/validate.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

import { readZipEntries } from '../src/zip.js';
import { parseXML, child, children, childText } from '../src/xml.js';
import { parseDesign } from '../src/ork.js';
import { calculateMass, radiusAt } from '../src/mass.js';
import { createAeroModel } from '../src/aero.js';
import { resolveMotor } from '../src/motors.js';
import { simulate } from '../src/flight.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');
const examplesDir = path.join(repoRoot, 'core/src/main/resources/datafiles/examples');

let failures = 0;
let checks = 0;
const rows = [];

function fail(message) {
	failures++;
	console.error(`  ✗ ${message}`);
}

function check(condition, message) {
	checks++;
	if (!condition) fail(message);
	return condition;
}

async function readDesign(file) {
	const bytes = new Uint8Array(fs.readFileSync(file));
	const entries = await readZipEntries(bytes, (d) => new Uint8Array(zlib.inflateRawSync(d)));
	const design = entries.find((e) => /rocket\.ork$/i.test(e.name));
	if (!design) throw new Error('no rocket.ork inside archive');
	return new TextDecoder().decode(design.bytes);
}

/** Reads the simulations OpenRocket stored with the design. */
function readStoredSimulations(xml) {
	const doc = parseXML(xml);
	const out = [];
	(function walk(el) {
		if (el.name === 'simulation') {
			const conditions = child(el, 'conditions');
			const flightdata = child(el, 'flightdata');
			if (conditions && flightdata) {
				out.push({
					name: childText(el, 'name', 'Simulation'),
					configId: childText(conditions, 'configid', ''),
					rodLength: parseFloat(childText(conditions, 'launchrodlength', '1.2')),
					rodAngle: parseFloat(childText(conditions, 'launchrodangle', '0')),
					wind: parseFloat(childText(conditions, 'windaverage', '0')),
					windDirection: (parseFloat(childText(conditions, 'winddirection', '0')) * 180) / Math.PI,
					maxAltitude: parseFloat(flightdata.attrs.maxaltitude || 'NaN'),
					maxVelocity: parseFloat(flightdata.attrs.maxvelocity || 'NaN'),
					maxMach: parseFloat(flightdata.attrs.maxmach || 'NaN'),
					flightTime: parseFloat(flightdata.attrs.flighttime || 'NaN'),
				});
			}
		}
		for (const c of el.children) walk(c);
	})(doc);
	return out;
}

const files = fs.readdirSync(examplesDir).filter((f) => f.endsWith('.ork')).sort();

console.log('OpenRocket visual simulation — validation\n');
console.log(`Designs: ${files.length} (OpenRocket 24.12 bundled examples)\n`);

for (const file of files) {
	const full = path.join(examplesDir, file);
	const label = file.replace(/\.ork$/, '');
	console.log(`• ${label}`);

	let rocket;
	let xml;
	try {
		xml = await readDesign(full);
		rocket = parseDesign(xml);
	} catch (err) {
		fail(`parse failed: ${err.message}`);
		continue;
	}

	check(rocket.stages.length > 0, 'design has at least one stage');
	check(rocket.length > 0.01, `design length is sane (${rocket.length.toFixed(3)} m)`);
	check(rocket.maxDiameter > 0.001, `reference diameter is sane (${rocket.maxDiameter.toFixed(4)} m)`);
	check(rocket.components.length > 2, 'design has components');

	// Geometry sanity across every component.
	for (const c of rocket.components) {
		check(Number.isFinite(c.x0) && Number.isFinite(c.x1), `${c.name}: finite axial position`);
		if (c.type === 'nosecone' || c.type === 'transition' || c.type === 'bodytube') {
			for (const frac of [0, 0.25, 0.5, 0.75, 1]) {
				const r = radiusAt(c, c.length * frac);
				check(Number.isFinite(r) && r >= 0, `${c.name}: radius finite at ${frac}`);
			}
		}
	}

	const mass = calculateMass(rocket);
	check(mass.mass > 0, 'structural mass is positive');
	check(Number.isFinite(mass.cg) && mass.cg > 0, 'CG is finite and forward of the tail');

	const aero = createAeroModel(rocket, rocket.defaultConfig.id);
	check(Number.isFinite(aero.cp) && aero.cp > 0, 'CP is finite');
	check(aero.cp < rocket.length * 1.5, 'CP lies within the airframe');
	check(aero.refArea > 0, 'reference area positive');

	// Drag must be finite and positive across the Mach range.
	for (const mach of [0.1, 0.5, 0.9, 1.0, 1.2, 2.0, 3.0]) {
		const cd = aero.cd(mach, 0.02, mach * 340, 1.225);
		check(Number.isFinite(cd) && cd > 0 && cd < 5, `drag coefficient sane at Mach ${mach} (${cd.toFixed(3)})`);
	}

	// Compare against OpenRocket's own stored simulations.
	const sims = readStoredSimulations(xml);
	let compared = 0;
	for (const sim of sims.slice(0, 3)) {
		if (!Number.isFinite(sim.maxAltitude) || sim.maxAltitude <= 0) continue;
		const config = rocket.configs.find((c) => c.id === sim.configId);
		if (!config) continue;

		const motors = new Map();
		let motorOk = true;
		for (const comp of rocket.components) {
			if (!comp.motorMount) continue;
			const info = comp.motorMount.motors[sim.configId];
			if (!info || !info.designation) continue;
			try {
				const motor = await resolveMotor(info, { fetch: true });
				comp.motorLength = info.length;
				motors.set(comp.id, motor);
				if (motor.approximate) motorOk = false;
			} catch {
				motorOk = false;
			}
		}
		if (!motors.size || !motorOk) continue;

		const m = calculateMass(rocket, {
			motorMass: new Map([...motors].map(([id, mm]) => {
				const comp = rocket.components.find((c) => c.id === id);
				return [id, mm.totalMass * (comp?.clusterCount || 1)];
			})),
		});
		const flight = simulate(rocket, aero, {
			configId: sim.configId,
			motors,
			cg: m.cg,
			mass: m,
			wind: { speed: sim.wind, direction: sim.windDirection },
			rodLength: sim.rodLength,
			rodAngle: sim.rodAngle,
			launchAltitude: rocket.length,
		});

		check(flight.samples.length > 20, 'flight produced samples');
		check(Number.isFinite(flight.apogee) && flight.apogee > 0, 'apogee is finite and positive');
		for (const s of flight.samples) {
			check(Number.isFinite(s.pos[1]) && Number.isFinite(s.speed), 'samples are finite');
			if (failures > 40) break;
		}

		const err = (flight.apogee - sim.maxAltitude) / sim.maxAltitude;
		const velErr = (flight.maxSpeed - sim.maxVelocity) / sim.maxVelocity;
		rows.push({
			design: label,
			sim: sim.name,
			motor: [...motors.values()].map((mm) => mm.designation).join('+'),
			mass: m.mass,
			cg: m.cg,
			cp: aero.cp,
			stability: flight.stability,
			ours: flight.apogee,
			theirs: sim.maxAltitude,
			err,
			velErr,
		});
		compared++;
		if (compared >= 2) break;
	}

	rows.push({
		design: label,
		sim: '(structure only)',
		motor: '-',
		mass: mass.mass,
		cg: mass.cg,
		cp: aero.cp,
		stability: (aero.cp - mass.cg) / aero.refLength,
		ours: NaN,
		theirs: NaN,
		err: NaN,
		velEr: NaN,
	});
}

console.log('\n' + '='.repeat(96));
console.log('Apogee comparison against OpenRocket\'s own stored simulations');
console.log('='.repeat(96));
console.log(
	'design'.padEnd(34) +
	'motor'.padEnd(10) +
	'mass(g)'.padStart(8) +
	'CG(cm)'.padStart(8) +
	'CP(cm)'.padStart(8) +
	'margin'.padStart(8) +
	'ours(m)'.padStart(9) +
	'OR(m)'.padStart(9) +
	'err'.padStart(8)
);

const comparisons = rows.filter((r) => Number.isFinite(r.err));
for (const r of rows) {
	const fmt = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '-');
	console.log(
		r.design.slice(0, 33).padEnd(34) +
		String(r.motor).slice(0, 9).padEnd(10) +
		fmt(r.mass * 1000, 0).padStart(8) +
		fmt(r.cg * 100, 1).padStart(8) +
		fmt(r.cp * 100, 1).padStart(8) +
		fmt(r.stability, 2).padStart(8) +
		fmt(r.ours).padStart(9) +
		fmt(r.theirs).padStart(9) +
		(Number.isFinite(r.err) ? `${(r.err * 100).toFixed(1)}%`.padStart(8) : ''.padStart(8))
	);
}

if (comparisons.length) {
	const errors = comparisons.map((r) => Math.abs(r.err));
	const mean = errors.reduce((a, b) => a + b, 0) / errors.length;
	const max = Math.max(...errors);
	const within20 = errors.filter((e) => e <= 0.2).length;
	console.log('\n' + '-'.repeat(96));
	console.log(`Flights compared: ${comparisons.length}`);
	console.log(`Mean |apogee error|: ${(mean * 100).toFixed(1)}%   Max: ${(max * 100).toFixed(1)}%   Within 20%: ${within20}/${comparisons.length}`);
	check(mean < 0.2, `mean apogee error below 20% (${(mean * 100).toFixed(1)}%)`);
	check(max < 0.45, `no flight off by more than 45% (${(max * 100).toFixed(1)}%)`);
}

console.log(`\n${checks} checks, ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
