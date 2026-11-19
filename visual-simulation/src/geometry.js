/**
 * Three.js geometry for OpenRocket components.
 *
 * Bodies of revolution are generated from the same radius profile that drives
 * the mass and aero models, so wall thickness, shoulder steps, shape
 * (conical/ogive/ellipsoid/power/parabolic/Haack) and fin planforms all match
 * the design file exactly.  Tube walls are modelled as real shells so hollow
 * bodies read correctly from the aft end.
 */

import * as THREE from '../vendor/three.module.js';
import { radiusAt } from './mass.js';
import { SYMMETRIC_TYPES, FIN_TYPES } from './ork.js';
import { stageOf } from './mass.js';

const SEGMENTS = 64;
const PROFILE_STEPS = 48;

function colorOf(comp, fallback = 0xd8d8d8) {
	if (!comp.color) return fallback;
	return new THREE.Color(comp.color.r, comp.color.g, comp.color.b).getHex();
}

function material(comp) {
	const c = colorOf(comp);
	return new THREE.MeshStandardMaterial({
		color: c,
		metalness: 0.08,
		roughness: comp.finish?.name === 'polished' ? 0.18 : 0.55,
		side: THREE.DoubleSide,
	});
}

/** Outer radius profile of a symmetric component, with shoulders appended. */
function bodyProfile(comp) {
	const steps = Math.max(8, PROFILE_STEPS);
	const pts = [];
	if (comp.type === 'bodytube') {
		pts.push({ x: 0, r: comp.outerRadius });
		pts.push({ x: comp.length, r: comp.outerRadius });
		return pts;
	}
	for (let i = 0; i <= steps; i++) {
		const x = (i / steps) * comp.length;
		pts.push({ x, r: Math.max(0, radiusAt(comp, x)) });
	}
	return pts;
}

/**
 * Revolve a radius profile around the X axis.
 * Adds an inner wall and end caps when the component has wall thickness.
 */
function revolveGeometry(profile, thickness, closedFore = false, closedAft = false) {
	const positions = [];
	const indices = [];

	const outerStart = 0;
	const n = profile.length;
	for (let i = 0; i < n; i++) {
		const p = profile[i];
		for (let s = 0; s <= SEGMENTS; s++) {
			const a = (s / SEGMENTS) * Math.PI * 2;
			positions.push(p.x, p.r * Math.cos(a), p.r * Math.sin(a));
		}
	}
	for (let i = 0; i < n - 1; i++) {
		for (let s = 0; s < SEGMENTS; s++) {
			const a = outerStart + i * (SEGMENTS + 1) + s;
			const b = a + 1;
			const c = a + (SEGMENTS + 1);
			const d = c + 1;
			indices.push(a, c, b, b, c, d);
		}
	}

	let innerStart = -1;
	const hasWall = thickness > 1e-5 && profile.some((p) => p.r - thickness > 1e-6);
	if (hasWall) {
		innerStart = positions.length / 3;
		for (let i = 0; i < n; i++) {
			const p = profile[i];
			const ri = Math.max(0, p.r - thickness);
			for (let s = 0; s <= SEGMENTS; s++) {
				const a = (s / SEGMENTS) * Math.PI * 2;
				positions.push(p.x, ri * Math.cos(a), ri * Math.sin(a));
			}
		}
		for (let i = 0; i < n - 1; i++) {
			for (let s = 0; s < SEGMENTS; s++) {
				const a = innerStart + i * (SEGMENTS + 1) + s;
				const b = a + 1;
				const c = a + (SEGMENTS + 1);
				const d = c + 1;
				// reversed winding for the inner surface
				indices.push(a, b, c, b, d, c);
			}
		}

		// Annular end caps.
		const cap = (index, reverse) => {
			const p = profile[index];
			const ri = Math.max(0, p.r - thickness);
			if (p.r <= 1e-6) return;
			const base = positions.length / 3;
			for (let s = 0; s <= SEGMENTS; s++) {
				const a = (s / SEGMENTS) * Math.PI * 2;
				positions.push(p.x, p.r * Math.cos(a), p.r * Math.sin(a));
				positions.push(p.x, ri * Math.cos(a), ri * Math.sin(a));
			}
			for (let s = 0; s < SEGMENTS; s++) {
				const o1 = base + s * 2;
				const i1 = o1 + 1;
				const o2 = o1 + 2;
				const i2 = o1 + 3;
				if (reverse) indices.push(o1, o2, i1, i1, o2, i2);
				else indices.push(o1, i1, o2, i1, i2, o2);
			}
		};
		cap(0, true);
		cap(n - 1, false);
	}

	// Solid caps for cones that close at a tip, or explicit closures.
	if (!hasWall) {
		if (closedFore) {
			const p = profile[0];
			if (p.r > 1e-6) {
				const base = positions.length / 3;
				positions.push(p.x, 0, 0);
				for (let s = 0; s <= SEGMENTS; s++) {
					const a = (s / SEGMENTS) * Math.PI * 2;
					positions.push(p.x, p.r * Math.cos(a), p.r * Math.sin(a));
				}
				for (let s = 0; s < SEGMENTS; s++) {
					indices.push(base, base + 1 + s, base + 2 + s);
				}
			}
		}
		if (closedAft) {
			const p = profile[n - 1];
			const base = positions.length / 3;
			positions.push(p.x, 0, 0);
			for (let s = 0; s <= SEGMENTS; s++) {
				const a = (s / SEGMENTS) * Math.PI * 2;
				positions.push(p.x, p.r * Math.cos(a), p.r * Math.sin(a));
			}
			for (let s = 0; s < SEGMENTS; s++) {
				indices.push(base, base + 2 + s, base + 1 + s);
			}
		}
	}

	const geom = new THREE.BufferGeometry();
	geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
	geom.setIndex(indices);
	geom.computeVertexNormals();
	return geom;
}

function shoulderGeometry(comp, shoulder, atAft) {
	const r = shoulder.radius;
	const t = shoulder.thickness || comp.thickness;
	const baseX = atAft ? comp.x1 : comp.x0 - shoulder.length;
	const profile = [
		{ x: baseX, r },
		{ x: baseX + shoulder.length, r },
	];
	const geom = revolveGeometry(profile, Math.min(t, r * 0.9), shoulder.capped, shoulder.capped);
	return geom;
}

function finGeometry(comp) {
	const pts = comp.finPoints;
	if (!pts || pts.length < 3) return null;

	const shape = new THREE.Shape();
	shape.moveTo(pts[0].x, pts[0].y);
	for (let i = 1; i < pts.length; i++) shape.lineTo(pts[i].x, pts[i].y);
	shape.closePath();

	const thickness = comp.finThickness || comp.thickness || 0.003;
	const cross = comp.crossSection;
	let depth = thickness;
	let bevel = 0;
	if (cross === 'rounded') {
		bevel = thickness * 0.45;
		depth = thickness - bevel * 2;
	} else if (cross === 'airfoil') {
		bevel = thickness * 0.48;
		depth = Math.max(thickness * 0.04, thickness - bevel * 2);
	}

	const geom = new THREE.ExtrudeGeometry(shape, {
		depth,
		bevelEnabled: bevel > 0,
		bevelThickness: bevel,
		bevelSize: bevel * 0.6,
		bevelSegments: cross === 'airfoil' ? 6 : 3,
		curveSegments: 8,
	});
	geom.translate(0, 0, -depth / 2 + (cross === 'square' ? 0 : 0));
	geom.computeVertexNormals();
	return geom;
}

/**
 * Builds the rocket as a set of stage groups, each holding its own component
 * meshes, so stages can separate during the flight.
 */
export function buildRocket(rocket) {
	const root = new THREE.Group();
	root.name = 'rocket';
	const stageGroups = new Map();
	const componentMeshes = new Map();
	const disposables = [];

	const getStageGroup = (index) => {
		if (!stageGroups.has(index)) {
			const g = new THREE.Group();
			g.name = `stage-${index}`;
			stageGroups.set(index, g);
			root.add(g);
		}
		return stageGroups.get(index);
	};

	for (const comp of rocket.components) {
		if (comp.type === 'rocket' || comp.type === 'stage' || comp.type === 'podset' || comp.type === 'parallelstage') {
			continue;
		}
		if (!(SYMMETRIC_TYPES.has(comp.type) || FIN_TYPES.has(comp.type) ||
			['tubefinset', 'launchlug', 'railbutton', 'masscomponent', 'parachute', 'streamer',
				'innertube', 'tubecoupler', 'centeringring', 'bulkhead', 'engineblock', 'shockcord'].includes(comp.type))) {
			continue;
		}

		const si = stageOf(rocket, comp);
		const group = getStageGroup(si >= 0 ? si : 0);
		const mat = material(comp);

		// Radial placement for pods/boosters: components whose ancestor chain
		// includes a podset or parallel stage sit off the centreline.
		let radialOffset = 0;
		let radialAngle = 0;
		for (let p = comp.parent; p; p = p.parent) {
			if (p.type === 'podset' || p.type === 'parallelstage') {
				const baseRadius = p.parent?.outerRadius ?? 0;
				radialOffset += p.radial.method === 'absolute' ? p.radial.offset : baseRadius + p.radial.offset;
				radialAngle += (p.angleOffset || 0) * (Math.PI / 180);
			}
		}

		if (SYMMETRIC_TYPES.has(comp.type)) {
			const profile = bodyProfile(comp);
			const geom = revolveGeometry(profile, comp.thickness, comp.type === 'nosecone', true);
			const mesh = new THREE.Mesh(geom, mat);
			placeAt(mesh, comp.x0, radialOffset, radialAngle);
			group.add(mesh);
			componentMeshes.set(comp.id, mesh);
			disposables.push(geom, mat);

			for (const [key, atAft] of [['foreShoulder', false], ['aftShoulder', true]]) {
				const s = comp[key];
				if (!s || !(s.length > 0) || !(s.radius > 0)) continue;
				const sgeom = shoulderGeometry(comp, s, atAft);
				const smesh = new THREE.Mesh(sgeom, mat);
				placeAt(smesh, 0, radialOffset, radialAngle);
				group.add(smesh);
				disposables.push(sgeom);
			}
		} else if (FIN_TYPES.has(comp.type)) {
			const geom = finGeometry(comp);
			if (!geom) continue;
			const rootR = comp.rootRadius ?? comp.parent?.outerRadius ?? 0;
			const count = comp.instances || 1;
			const angleOff = (comp.angleOffset || 0) * (Math.PI / 180);
			for (let i = 0; i < count; i++) {
				const mesh = new THREE.Mesh(geom, mat);
				const a = angleOff + (i * Math.PI * 2) / count;
				mesh.position.set(comp.x0, rootR * Math.cos(a) + radialOffset * Math.cos(radialAngle), rootR * Math.sin(a) + radialOffset * Math.sin(radialAngle));
				mesh.rotation.x = a;
				if (comp.cant) mesh.rotation.z = comp.cant * (Math.PI / 180);
				group.add(mesh);
				componentMeshes.set(`${comp.id}:${i}`, mesh);
			}
			disposables.push(geom, mat);
		} else if (comp.type === 'tubefinset') {
			const count = comp.instances || 6;
			const angleOff = (comp.angleOffset || 0) * (Math.PI / 180);
			const bodyR = comp.rootRadius ?? 0;
			for (let i = 0; i < count; i++) {
				const a = angleOff + (i * Math.PI * 2) / count;
				const geom = new THREE.CylinderGeometry(comp.outerRadius, comp.outerRadius, comp.length, 24, 1, true);
				const mesh = new THREE.Mesh(geom, mat);
				mesh.rotation.z = Math.PI / 2;
				mesh.position.set(
					comp.x0 + comp.length / 2,
					(bodyR + comp.outerRadius) * Math.cos(a),
					(bodyR + comp.outerRadius) * Math.sin(a)
				);
				group.add(mesh);
				componentMeshes.set(`${comp.id}:${i}`, mesh);
				disposables.push(geom);
			}
			disposables.push(mat);
		} else if (['innertube', 'tubecoupler', 'centeringring', 'bulkhead', 'engineblock', 'launchlug', 'railbutton'].includes(comp.type)) {
			const r = Math.max(comp.outerRadius, 0.0005);
			const ri = Math.max(0, comp.innerRadius);
			const profile = [
				{ x: comp.x0, r },
				{ x: comp.x1, r },
			];
			const geom = revolveGeometry(profile, Math.max(r - ri, 0.0005), true, true);
			const mesh = new THREE.Mesh(geom, mat);
			let off = radialOffset;
			let ang = radialAngle;
			if (comp.type === 'launchlug' || comp.type === 'railbutton') {
				const pr = comp.parent?.outerRadius ?? 0;
				ang = (comp.angleOffset || 0) * (Math.PI / 180);
				off = pr + r;
			}
			mesh.position.set(0, off * Math.cos(ang), off * Math.sin(ang));
			group.add(mesh);
			componentMeshes.set(comp.id, mesh);
			disposables.push(geom, mat);
		} else if (comp.type === 'parachute' || comp.type === 'streamer' || comp.type === 'masscomponent' || comp.type === 'shockcord') {
			// Packed recovery gear: a small slug inside the body.
			const r = Math.max(comp.outerRadius, 0.002);
			const geom = new THREE.CapsuleGeometry(r, Math.max(0.001, comp.length - 2 * r), 4, 12);
			const mesh = new THREE.Mesh(geom, new THREE.MeshStandardMaterial({ color: 0xf05a28, roughness: 0.9 }));
			mesh.rotation.z = Math.PI / 2;
			mesh.position.set(comp.x0 + comp.length / 2, radialOffset * Math.cos(radialAngle), radialOffset * Math.sin(radialAngle));
			mesh.visible = false; // shown only while packed, as a subtle hint
			group.add(mesh);
			componentMeshes.set(comp.id, mesh);
			disposables.push(geom);
		}
	}

	return { root, stageGroups, componentMeshes, disposables };
}

function placeAt(mesh, x, radialOffset, radialAngle) {
	mesh.position.set(
		x,
		radialOffset * Math.cos(radialAngle),
		radialOffset * Math.sin(radialAngle)
	);
}

/** Marker discs for CP and CG. */
export function makeMarkers(rocket, cg, cp) {
	const group = new THREE.Group();
	const radius = rocket.maxRadius * 1.05;

	const makeRing = (x, color) => {
		const g = new THREE.RingGeometry(radius * 0.98, radius * 1.12, 48);
		const m = new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, transparent: true, opacity: 0.95 });
		const mesh = new THREE.Mesh(g, m);
		mesh.position.set(x, 0, 0);
		mesh.rotation.y = Math.PI / 2;
		return mesh;
	};
	group.add(makeRing(cp, 0x22c55e));
	group.add(makeRing(cg, 0xfacc15));
	return group;
}

export { SEGMENTS };
