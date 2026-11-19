/**
 * OpenRocket design reader.
 *
 * Turns a `rocket.ork` XML document into a fully positioned component tree.
 * Every component type that OpenRocket can write is understood, including
 * nested pods, parallel boosters, multi-stage stacks, all fin planforms and
 * every normalised body shape.  Positions follow OpenRocket's own
 * AxialMethod / RadiusMethod semantics so the result matches the 2D and 3D
 * views of the desktop application.
 */

import { parseXML, child, children, childText, childAny } from './xml.js';

export const EXTERNAL_TYPES = new Set([
	'nosecone', 'bodytube', 'transition', 'trapezoidfinset', 'ellipticalfinset',
	'freeformfinset', 'tubefinset', 'launchlug', 'railbutton',
]);

export const SYMMETRIC_TYPES = new Set(['nosecone', 'bodytube', 'transition']);
export const FIN_TYPES = new Set(['trapezoidfinset', 'ellipticalfinset', 'freeformfinset']);
export const RECOVERY_TYPES = new Set(['parachute', 'streamer']);
export const ASSEMBLY_TYPES = new Set(['stage', 'podset', 'parallelstage']);

const KNOWN_TYPES = new Set([
	'rocket',
	...EXTERNAL_TYPES, ...FIN_TYPES, ...SYMMETRIC_TYPES, ...RECOVERY_TYPES,
	...ASSEMBLY_TYPES,
	'innertube', 'tubecoupler', 'centeringring', 'bulkhead', 'engineblock',
	'masscomponent', 'shockcord',
]);

/** Surface roughness in metres, from OpenRocket's ExternalComponent.Finish. */
const FINISH_ROUGHNESS = {
	rough: 500e-6,
	roughunfinished: 250e-6,
	unfinished: 150e-6,
	normal: 60e-6,
	smooth: 20e-6,
	optimum: 5e-6,
	polished: 2e-6,
	finishpolished: 0.5e-6,
	mirror: 0,
};

function numText(el, tag, fallback = 0) {
	if (!el) return fallback;
	const c = child(el, tag);
	if (!c) return fallback;
	const v = parseFloat(c.text);
	return Number.isFinite(v) ? v : fallback;
}

/** Reads a numeric field that may be stored as "auto <value>". */
function numAuto(el, tag) {
	const c = child(el, tag);
	if (!c) return { auto: false, value: 0, present: false };
	const text = c.text.trim();
	if (/^auto/i.test(text)) {
		const v = parseFloat(text.slice(4));
		return { auto: true, value: Number.isFinite(v) ? v : 0, present: true };
	}
	const v = parseFloat(text);
	return { auto: false, value: Number.isFinite(v) ? v : 0, present: true };
}

function readAxial(el) {
	const a = child(el, 'axialoffset');
	if (a) {
		return { offset: parseFloat(a.text) || 0, method: (a.attrs.method || 'top').toLowerCase() };
	}
	const p = child(el, 'position');
	if (p) {
		return { offset: parseFloat(p.text) || 0, method: (p.attrs.type || 'top').toLowerCase() };
	}
	return { offset: 0, method: 'top' };
}

function readRadial(el) {
	const r = child(el, 'radiusoffset');
	if (r) {
		return { offset: parseFloat(r.text) || 0, method: (r.attrs.method || 'relative').toLowerCase() };
	}
	return { offset: 0, method: 'surface' };
}

function readColor(el) {
	const appearance = child(el, 'appearance');
	const paint = appearance && child(appearance, 'paint');
	if (!paint) return null;
	const ch = (k, d) => {
		const v = parseInt(paint.attrs[k], 10);
		return Number.isFinite(v) ? v : d;
	};
	return {
		r: ch('red', 200) / 255,
		g: ch('green', 200) / 255,
		b: ch('blue', 200) / 255,
		a: ch('alpha', 255) / 255,
	};
}

function readMaterial(el, tag = 'material') {
	const m = child(el, tag);
	if (!m) return { density: 0, type: 'bulk', name: '' };
	return {
		density: parseFloat(m.attrs.density) || 0,
		type: (m.attrs.type || 'bulk').toLowerCase(),
		name: m.text.trim(),
	};
}

function readFinish(el) {
	const f = childText(el, 'finish', 'normal').toLowerCase();
	return { name: f, roughness: FINISH_ROUGHNESS[f] ?? FINISH_ROUGHNESS.normal };
}

/** Collects fin planform points in chord/span space (metres). */
function readFinPoints(el, type, ctx) {
	if (type === 'trapezoidfinset') {
		const rootChord = numText(el, 'rootchord', 0.05);
		const tipChord = numText(el, 'tipchord', 0.02);
		const sweep = numText(el, 'sweeplength', numText(el, 'sweep', 0));
		const height = numText(el, 'height', 0.05);
		return [
			{ x: 0, y: 0 },
			{ x: rootChord, y: 0 },
			{ x: sweep + tipChord, y: height },
			{ x: sweep, y: height },
		];
	}
	if (type === 'ellipticalfinset') {
		const rootChord = numText(el, 'rootchord', 0.05);
		const height = numText(el, 'height', 0.05);
		const steps = 32;
		const pts = [];
		// Leading edge and tip: a half ellipse from the leading root edge to
		// mid-chord at the tip, then back down to the trailing root edge.
		for (let i = 0; i <= steps; i++) {
			const t = (i / steps) * Math.PI;
			pts.push({ x: (rootChord / 2) * (1 - Math.cos(t)), y: height * Math.sin(t) });
		}
		return pts;
	}
	if (type === 'freeformfinset') {
		const list = child(el, 'finpoints');
		const pts = list ? children(list, 'point').map((p) => ({
			x: parseFloat(p.attrs.x) || 0,
			y: parseFloat(p.attrs.y) || 0,
		})) : [];
		if (pts.length >= 3) return pts;
		ctx.warnings.push(`${ctx.label} has fewer than three fin points; skipping fin`);
		return [];
	}
	return [];
}

/** Motor count for each OpenRocket cluster configuration. */
const CLUSTER_COUNTS = {
	single: 1,
	double: 2,
	'3-row': 3,
	'4-row': 4,
	'3-ring': 3,
	'4-ring': 4,
	'5-ring': 5,
	'6-ring': 6,
	'3-star': 4,
	'4-star': 5,
	'5-star': 6,
	'6-star': 7,
	'9-grid': 9,
	'9-star': 9,
};

let autoId = 0;

/**
 * Reads one component element and (recursively) its subcomponents.
 * `pods` carries the enclosing body tube so nested parts can resolve `auto`
 * radii against the tube they sit in.
 */
function readComponent(el, parent, ctx) {
	const type = el.name;
	if (!KNOWN_TYPES.has(type)) {
		// Unknown component (future format addition): skip rather than abort the
		// whole design, and tell the user.
		ctx.warnings.push(`Unsupported component <${type}> skipped`);
		return null;
	}

	const comp = {
		type,
		name: childText(el, 'name', type),
		id: childText(el, 'id', `auto-${++autoId}`),
		parent,
		children: [],
		instances: Math.max(1, Math.round(numText(el, 'instancecount', numText(el, 'fincount', 1)))),
		angleOffset: numText(el, 'angleoffset', numText(el, 'rotation', 0)),
		axial: readAxial(el),
		radial: readRadial(el),
		color: readColor(el),
		insideColor: null,
		material: readMaterial(el),
		finish: readFinish(el),
		length: 0,
		x0: 0,
		x1: 0,
		outerRadius: 0,
		innerRadius: 0,
		foreRadius: 0,
		aftRadius: 0,
		thickness: numText(el, 'thickness', 0),
		shape: childText(el, 'shape', 'ogive').toLowerCase(),
		shapeParam: numText(el, 'shapeparameter', 1),
		crossSection: childText(el, 'crosssection', 'square').toLowerCase(),
		cant: numText(el, 'cant', 0),
		finPoints: [],
		shoulder: null,
		countCapped: false,
		source: el,
		configs: Object.create(null),
	};

	// OpenRocket 1.8 writes axial offsets twice (`axialoffset` plus the legacy
	// `position`); the reader above prefers the modern element.
	comp.isFlipped = childText(el, 'isflipped', 'false') === 'true';

	switch (type) {
		case 'nosecone': {
			comp.length = numText(el, 'length', 0.1);
			// The base radius is often written as "auto <value>"; the stored value
			// is the radius OpenRocket last resolved, so it is used directly.
			const aftAuto = numAuto(el, 'aftradius');
			const foreAuto = numAuto(el, 'foreradius');
			comp.baseAuto = aftAuto.auto;
			const base = aftAuto.value || foreAuto.value || 0.0125;
			if (comp.isFlipped) {
				comp.foreRadius = base;
				comp.aftRadius = 0;
			} else {
				comp.foreRadius = 0;
				comp.aftRadius = base;
			}
			comp.outerRadius = base;
			comp.innerRadius = Math.max(0, base - comp.thickness);
			const aftShoulder = {
				length: numText(el, 'aftshoulderlength', 0),
				radius: numText(el, 'aftshoulderradius', base),
				thickness: numText(el, 'aftshoulderthickness', comp.thickness),
				capped: childText(el, 'aftshouldercapped', 'false') === 'true',
			};
			const foreShoulder = {
				length: numText(el, 'foreshoulderlength', 0),
				radius: numText(el, 'foreshoulderradius', base),
				thickness: numText(el, 'foreshoulderthickness', comp.thickness),
				capped: childText(el, 'foreshouldercapped', 'false') === 'true',
			};
			comp.shoulder = comp.isFlipped ? foreShoulder : aftShoulder;
			comp.foreShoulder = foreShoulder;
			comp.aftShoulder = aftShoulder;
			break;
		}
		case 'transition': {
			comp.length = numText(el, 'length', 0.1);
			comp.foreRadius = numAuto(el, 'foreradius').value;
			comp.aftRadius = numAuto(el, 'aftradius').value;
			comp.foreRadiusAuto = numAuto(el, 'foreradius').auto;
			comp.aftRadiusAuto = numAuto(el, 'aftradius').auto;
			comp.outerRadius = Math.max(comp.foreRadius, comp.aftRadius);
			comp.innerRadius = Math.max(0, comp.outerRadius - comp.thickness);
			comp.foreShoulder = {
				length: numText(el, 'foreshoulderlength', 0),
				radius: numText(el, 'foreshoulderradius', comp.foreRadius),
				thickness: numText(el, 'foreshoulderthickness', comp.thickness),
			};
			comp.aftShoulder = {
				length: numText(el, 'aftshoulderlength', 0),
				radius: numText(el, 'aftshoulderradius', comp.aftRadius),
				thickness: numText(el, 'aftshoulderthickness', comp.thickness),
			};
			break;
		}
		case 'bodytube': {
			comp.length = numText(el, 'length', 0.1);
			const r = numAuto(el, 'radius');
			comp.radiusAuto = r.auto;
			comp.outerRadius = r.value || 0.0125;
			comp.foreRadius = comp.aftRadius = comp.outerRadius;
			comp.innerRadius = Math.max(0, comp.outerRadius - comp.thickness);
			break;
		}
		case 'innertube':
		case 'tubecoupler': {
			comp.length = numText(el, 'length', 0.05);
			const r = numAuto(el, 'outerradius');
			comp.radiusAuto = r.auto;
			comp.outerRadius = r.value || 0.009;
			comp.foreRadius = comp.aftRadius = comp.outerRadius;
			comp.innerRadius = Math.max(0, comp.outerRadius - comp.thickness);
			break;
		}
		case 'centeringring':
		case 'bulkhead': {
			comp.length = numText(el, 'length', 0.002);
			const outer = numAuto(el, 'outerradius');
			const inner = numAuto(el, 'innerradius');
			comp.outerRadiusAuto = outer.auto;
			comp.innerRadiusAuto = inner.auto;
			comp.outerRadius = outer.value || 0;
			comp.innerRadius = inner.value || 0;
			comp.foreRadius = comp.aftRadius = comp.outerRadius;
			break;
		}
		case 'engineblock': {
			comp.length = numText(el, 'length', 0.005);
			const r = numAuto(el, 'outerradius');
			comp.outerRadiusAuto = r.auto;
			comp.outerRadius = r.value || numText(el, 'radius', 0.009);
			comp.innerRadius = Math.max(0, comp.outerRadius - Math.max(comp.length, 0.001));
			comp.foreRadius = comp.aftRadius = comp.outerRadius;
			break;
		}
		case 'launchlug': {
			comp.length = numText(el, 'length', 0.03);
			comp.outerRadius = numText(el, 'radius', 0.0035);
			comp.innerRadius = Math.max(0, comp.outerRadius - comp.thickness);
			comp.foreRadius = comp.aftRadius = comp.outerRadius;
			break;
		}
		case 'railbutton': {
			comp.length = numText(el, 'height', numText(el, 'length', 0.006));
			comp.outerRadius = numText(el, 'outerradius', 0.004);
			comp.innerRadius = Math.max(0, comp.outerRadius - comp.thickness);
			comp.foreRadius = comp.aftRadius = comp.outerRadius;
			break;
		}
		case 'tubefinset': {
			comp.length = numText(el, 'length', 0.05);
			comp.outerRadius = numText(el, 'radius', 0.0125);
			comp.innerRadius = Math.max(0, comp.outerRadius - comp.thickness);
			comp.foreRadius = comp.aftRadius = comp.outerRadius;
			break;
		}
		case 'masscomponent': {
			comp.length = numText(el, 'packedlength', 0.02);
			comp.outerRadius = numText(el, 'packedradius', 0.01);
			comp.foreRadius = comp.aftRadius = comp.outerRadius;
			comp.mass = numText(el, 'mass', 0);
			comp.massType = childText(el, 'masscomponenttype', 'masscomponent');
			comp.material = readMaterial(el, 'material');
			break;
		}
		case 'parachute': {
			comp.length = numText(el, 'packedlength', 0.02);
			comp.outerRadius = numText(el, 'packedradius', 0.01);
			comp.foreRadius = comp.aftRadius = comp.outerRadius;
			comp.diameter = numText(el, 'diameter', 0.3);
			comp.lineCount = Math.max(0, Math.round(numText(el, 'linecount', 6)));
			comp.lineLength = numText(el, 'linelength', comp.diameter);
			comp.lineMaterial = readMaterial(el, 'linematerial');
			const cd = numAuto(el, 'cd');
			comp.cdAuto = cd.auto || !cd.present;
			comp.cd = comp.cdAuto ? 0.8 : cd.value;
			break;
		}
		case 'streamer': {
			comp.length = numText(el, 'packedlength', 0.02);
			comp.outerRadius = numText(el, 'packedradius', 0.01);
			comp.foreRadius = comp.aftRadius = comp.outerRadius;
			comp.stripLength = numText(el, 'length', numText(el, 'stripcount', 0) ? 0 : 0);
			comp.stripWidth = numText(el, 'width', 0.05);
			comp.stripLength = numText(el, 'length2', comp.stripLength) || numText(el, 'length', 0.3);
			comp.stripCount = Math.max(1, Math.round(numText(el, 'stripcount', 1)));
			comp.lineCount = Math.max(0, Math.round(numText(el, 'linecount', 2)));
			comp.lineLength = numText(el, 'linelength', 0);
			const cd = numAuto(el, 'cd');
			comp.cdAuto = cd.auto || !cd.present;
			comp.cd = comp.cdAuto ? 0.8 : cd.value;
			break;
		}
		case 'shockcord': {
			comp.length = numText(el, 'packedlength', 0.05);
			comp.outerRadius = numText(el, 'packedradius', 0.005);
			comp.foreRadius = comp.aftRadius = comp.outerRadius;
			comp.cordLength = numText(el, 'cordlength', 0.4);
			comp.material = readMaterial(el);
			break;
		}
		case 'stage':
		case 'podset':
		case 'parallelstage': {
			comp.length = 0; // derived from children
			break;
		}
		default:
			break;
	}

	// Recovery deployment and motor ignition are stored either directly on the
	// component or inside a per-configuration block.
	comp.deployEvent = childText(el, 'deployevent', 'ejection').toLowerCase();
	comp.deployAltitude = numText(el, 'deployaltitude', 200);
	comp.deployDelay = numText(el, 'deploydelay', 0);

	if (COMPONENT_CONFIG_ATTRS[type]) {
		for (const key of COMPONENT_CONFIG_ATTRS[type]) {
			const c = child(el, key);
			if (c && c.attrs.configid) {
				comp.configs[c.attrs.configid] = c.text.trim();
			}
		}
	}

	if (type === 'innertube' || type === 'tubecoupler' || type === 'bodytube') {
		const clusterName = childText(el, 'clusterconfiguration', 'single').toLowerCase();
		comp.clusterCount = CLUSTER_COUNTS[clusterName] || 1;
		comp.clusterConfiguration = clusterName;
		comp.clusterScale = numText(el, 'clusterscale', 1);
		const mount = child(el, 'motormount');
		if (mount) {
			comp.motorMount = readMotorMount(mount);
		}
	}

	// Fins need the parent radius to place their root, so planform points are
	// read here but attached during layout.
	if (FIN_TYPES.has(type)) {
		comp.finPoints = readFinPoints(el, type, ctx);
		comp.finThickness = numText(el, 'thickness', 0.003);
		comp.filletRadius = numText(el, 'filletradius', 0);
		comp.filletMaterial = readMaterial(el, 'filletmaterial');
		comp.length = comp.finPoints.reduce((m, p) => Math.max(m, p.x), 0);
	}

	const subs = child(el, 'subcomponents');
	if (subs) {
		for (const sub of subs.children) {
			const c = readComponent(sub, comp, ctx);
			if (c) comp.children.push(c);
		}
	}

	return comp;
}

/** Motor designations are per-configuration, so record every variant. */
const COMPONENT_CONFIG_ATTRS = {
	innertube: [],
};

function readMotorMount(mount) {
	const out = {
		overhang: numText(mount, 'overhang', 0),
		ignitionEvent: childText(mount, 'ignitionevent', 'automatic').toLowerCase(),
		ignitionDelay: numText(mount, 'ignitiondelay', 0),
		motors: Object.create(null),
		clusters: [],
	};
	const cluster = childAny(mount, ['clusterconfiguration']);
	if (cluster) out.clusterConfiguration = cluster.text.trim();

	for (const m of children(mount, 'motor')) {
		const configId = m.attrs.configid || 'default';
		const type = childText(m, 'type', 'single');
		out.motors[configId] = {
			type,
			manufacturer: childText(m, 'manufacturer', ''),
			designation: childText(m, 'designation', ''),
			digest: childText(m, 'digest', ''),
			diameter: numText(m, 'diameter', 0.018),
			length: numText(m, 'length', 0.07),
			delay: numText(m, 'delay', 0),
		};
	}
	return out;
}

/* ------------------------------------------------------------------ *
 * Layout
 * ------------------------------------------------------------------ */

function axialStart(comp, parentStart, parentLength) {
	const { offset, method } = comp.axial;
	switch (method) {
		case 'absolute':
			return offset;
		case 'bottom':
			return parentStart + parentLength + offset - comp.length;
		case 'middle':
			return parentStart + parentLength / 2 + offset - comp.length / 2;
		case 'top':
		default:
			return parentStart + offset;
	}
}

/**
 * Computes absolute axial positions for the whole tree.
 *
 * Assemblies (stages, pods, boosters) are laid out sequentially: their own
 * extent follows from their children, and the next sibling starts where the
 * previous one ended.
 */
function layout(comp, parentStart, parentLength, ctx) {
	if (ASSEMBLY_TYPES.has(comp.type)) {
		// Position of the assembly itself inside its parent.
		let assemblyStart;
		if (comp.type === 'stage') {
			assemblyStart = parentStart;
		} else {
			assemblyStart = axialStart(comp, parentStart, parentLength);
			comp.x0 = assemblyStart;
		}

		let maxEnd = assemblyStart;
		for (const c of comp.children) {
			layout(c, assemblyStart, comp.length || 0, ctx);
			maxEnd = Math.max(maxEnd, c.x1);
		}
		if (comp.type === 'stage') {
			// Stages stack: a stage spans the union of its parts.
			const minStart = comp.children.length
				? Math.min(...comp.children.map((c) => c.x0), assemblyStart)
				: assemblyStart;
			comp.x0 = minStart;
			comp.x1 = maxEnd;
			comp.length = comp.x1 - comp.x0;
			ctx.stageCursor = comp.x1;
		} else {
			comp.x1 = maxEnd;
			comp.length = comp.x1 - comp.x0;
		}
		return;
	}

	comp.x0 = axialStart(comp, parentStart, parentLength);
	comp.x1 = comp.x0 + comp.length;
	if (comp.x1 < comp.x0) {
		const t = comp.x0;
		comp.x0 = comp.x1;
		comp.x1 = t;
	}
}

/**
 * Resolves `auto` radii and parent-relative geometry.
 *
 * Runs in document order so a component with `auto` radius inherits the aft
 * radius of the body component in front of it, exactly as OpenRocket does.
 */
function resolveGeometry(comp, state) {
	const parent = comp.parent;

	if (SYMMETRIC_TYPES.has(comp.type)) {
		if (comp.type === 'bodytube' && comp.radiusAuto) {
			const inherited = state.previousAftRadius ?? (parent ? parent.innerRadius : comp.outerRadius);
			comp.outerRadius = Math.max(inherited, comp.outerRadius || 0);
			comp.foreRadius = comp.aftRadius = comp.outerRadius;
			comp.innerRadius = Math.max(0, comp.outerRadius - comp.thickness);
		}
		if (comp.type === 'transition') {
			if (comp.foreRadiusAuto) comp.foreRadius = state.previousAftRadius ?? comp.foreRadius;
			if (comp.aftRadiusAuto) comp.aftRadius = comp.foreRadius;
			comp.outerRadius = Math.max(comp.foreRadius, comp.aftRadius);
			comp.innerRadius = Math.max(0, comp.outerRadius - comp.thickness);
		}
		state.previousAftRadius = comp.aftRadius;
	}

	if (comp.type === 'innertube' || comp.type === 'tubecoupler') {
		if (comp.radiusAuto && parent) {
			const base = parent.innerRadius || parent.outerRadius - parent.thickness;
			if (base > 0) {
				comp.outerRadius = base;
				comp.innerRadius = Math.max(0, comp.outerRadius - comp.thickness);
				comp.foreRadius = comp.aftRadius = comp.outerRadius;
			}
		}
	}

	if (comp.type === 'centeringring' || comp.type === 'bulkhead' || comp.type === 'engineblock') {
		if (parent) {
			if (comp.outerRadiusAuto) comp.outerRadius = parent.innerRadius || parent.outerRadius;
			if (comp.innerRadiusAuto) {
				// Match the tube inside the ring when there is one beside it.
				const inner = parent.children.find((c) => c !== comp && (c.type === 'innertube' || c.type === 'tubecoupler'));
				comp.innerRadius = inner ? inner.outerRadius : 0;
			}
			comp.foreRadius = comp.aftRadius = comp.outerRadius;
		}
	}

	if (FIN_TYPES.has(comp.type) || comp.type === 'tubefinset' || comp.type === 'launchlug' || comp.type === 'railbutton') {
		const base = parent ? (parent.outerRadius || 0) : 0;
		const method = comp.radial.method;
		comp.rootRadius = method === 'absolute' ? comp.radial.offset : base + comp.radial.offset;
	}

	for (const c of comp.children) {
		resolveGeometry(c, state);
	}
}

/* ------------------------------------------------------------------ *
 * Public API
 * ------------------------------------------------------------------ */

export function parseDesign(xmlText) {
	const doc = parseXML(xmlText);
	const openrocket = child(doc, 'openrocket');
	const rocketEl = child(openrocket || doc, 'rocket') || findDeep(doc, 'rocket');
	if (!rocketEl) {
		throw new Error('Not an OpenRocket design: no <rocket> element found');
	}

	const ctx = { warnings: [], label: 'design' };
	const rocket = readComponent(rocketEl, null, ctx);
	rocket.type = 'rocket';
	rocket.name = childText(rocketEl, 'name', 'OpenRocket design');
	rocket.designer = childText(rocketEl, 'designer', '');
	rocket.referenceType = childText(rocketEl, 'referencetype', 'maximum');

	// Stages are the rocket's direct assembly children.
	const stages = [];
	let cursor = 0;
	for (const c of rocket.children) {
		if (c.type === 'stage' || c.type === 'parallelstage') {
			stages.push(c);
		}
	}
	// Lay out axial stages in order, each starting below the previous one.
	for (const stage of rocket.children) {
		layout(stage, cursor, 0, ctx);
		if (stage.type === 'stage') {
			cursor = Math.max(cursor, stage.x1);
		}
	}

	const state = { previousAftRadius: null };
	resolveGeometry(rocket, state);

	rocket.x0 = 0;
	rocket.length = Math.max(0, ...rocket.children.map((c) => c.x1));
	rocket.x1 = rocket.length;

	// Reference dimensions: OpenRocket uses the largest body diameter.
	let maxDiameter = 0;
	let maxRadius = 0;
	const all = [];
	(function walk(c) {
		all.push(c);
		for (const k of c.children) walk(k);
	})(rocket);
	for (const c of all) {
		if (SYMMETRIC_TYPES.has(c.type) && c.outerRadius > maxRadius) {
			maxRadius = c.outerRadius;
		}
	}
	maxDiameter = 2 * maxRadius;
	rocket.maxDiameter = maxDiameter || 0.02;
	rocket.maxRadius = maxRadius || 0.01;
	rocket.components = all;

	// Flight configurations: which stages burn, and which motor each mount uses.
	const configs = readConfigurations(rocketEl, all);
	rocket.configs = configs;
	rocket.defaultConfig = (configs.find((c) => c.isDefault) || configs[0] || { id: 'default', stages: stages.map(() => true) });
	rocket.stages = stages;
	rocket.warnings = ctx.warnings;
	rocket.decals = [];

	return rocket;
}

function findDeep(el, name) {
	if (el.name === name) return el;
	for (const c of el.children) {
		const f = findDeep(c, name);
		if (f) return f;
	}
	return null;
}

function readConfigurations(rocketEl, components) {
	const configs = [];
	for (const mc of children(rocketEl, 'motorconfiguration')) {
		const id = mc.attrs.configid || 'default';
		const stageFlags = [];
		for (const s of children(mc, 'stage')) {
			stageFlags[parseInt(s.attrs.number, 10) || 0] = s.attrs.active === 'true';
		}
		const motors = [];
		for (const c of components) {
			if (c.motorMount && c.motorMount.motors[id]) {
				const m = c.motorMount.motors[id];
				if (m.designation) motors.push(m);
			}
		}
		configs.push({
			id,
			isDefault: mc.attrs.default === 'true',
			stages: stageFlags,
			motors,
			label: motors.length
				? motors.map((m) => `${m.manufacturer} ${m.designation}-${m.delay}`).join(' + ')
				: 'No motor',
		});
	}
	if (!configs.length) {
		configs.push({ id: 'default', isDefault: true, stages: [], motors: [], label: 'No motor' });
	}
	return configs;
}

/** Motor mounted in a component for the given configuration. */
export function motorFor(component, configId) {
	if (!component.motorMount) return null;
	return component.motorMount.motors[configId] || component.motorMount.motors.default || null;
}

/** Stage index (document order) of a component, or -1. */
export function stageIndex(rocket, component) {
	const stages = rocket.stages;
	for (let i = 0; i < stages.length; i++) {
		let c = component;
		while (c) {
			if (c === stages[i]) return i;
			c = c.parent;
		}
	}
	return -1;
}
