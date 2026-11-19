/**
 * 3D flight view.
 *
 * Local rocket space uses +X from nose to tail, so the rocket's attitude is
 * applied by mapping +X onto the negative flight axis.  Everything visible is
 * generated from the design: body profiles, fin planforms, paint colours,
 * stage groups, canopy and shroud lines.
 */

import * as THREE from '../vendor/three.module.js';
import { buildRocket } from './geometry.js';

const UP = new THREE.Vector3(0, 1, 0);

function makeGridTexture() {
	const size = 512;
	const canvas = document.createElement('canvas');
	canvas.width = canvas.height = size;
	const ctx = canvas.getContext('2d');
	ctx.fillStyle = '#3d5a3a';
	ctx.fillRect(0, 0, size, size);
	for (let i = 0; i < 2500; i++) {
		const x = Math.random() * size;
		const y = Math.random() * size;
		ctx.fillStyle = `rgba(${60 + Math.random() * 40},${95 + Math.random() * 45},${55 + Math.random() * 30},0.5)`;
		ctx.fillRect(x, y, 2 + Math.random() * 3, 2 + Math.random() * 3);
	}
	ctx.strokeStyle = 'rgba(255,255,255,0.09)';
	ctx.lineWidth = 2;
	for (let i = 0; i <= 8; i++) {
		const p = (i / 8) * size;
		ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, size); ctx.stroke();
		ctx.beginPath(); ctx.moveTo(0, p); ctx.lineTo(size, p); ctx.stroke();
	}
	const tex = new THREE.CanvasTexture(canvas);
	tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
	tex.repeat.set(24, 24);
	return tex;
}

function makeSmokeTexture() {
	const size = 128;
	const canvas = document.createElement('canvas');
	canvas.width = canvas.height = size;
	const ctx = canvas.getContext('2d');
	const g = ctx.createRadialGradient(size / 2, size / 2, 2, size / 2, size / 2, size / 2);
	g.addColorStop(0, 'rgba(255,255,255,0.9)');
	g.addColorStop(0.45, 'rgba(235,235,235,0.45)');
	g.addColorStop(1, 'rgba(220,220,220,0)');
	ctx.fillStyle = g;
	ctx.fillRect(0, 0, size, size);
	return new THREE.CanvasTexture(canvas);
}

export class SimulationView {
	constructor(canvas, rocket, aero, flight, options = {}) {
		this.rocket = rocket;
		this.aero = aero;
		this.flight = flight;
		this.canvas = canvas;

		this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
		this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
		this.renderer.shadowMap.enabled = true;
		this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
		this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
		this.renderer.toneMappingExposure = 1.05;

		this.scene = new THREE.Scene();
		this.scene.fog = new THREE.Fog(0xbcd2e8, 120, 900);

		this.camera = new THREE.PerspectiveCamera(50, 1, 0.02, 4000);
		this.camera.position.set(2.2, 1.6, 2.2);

		this.buildSky();
		this.buildLights();
		this.buildGround();
		this.buildPad();

		const built = buildRocket(rocket);
		this.rocketRoot = built.root;
		this.stageGroups = built.stageGroups;
		this.scene.add(this.rocketRoot);

		this.buildFlame();
		this.buildChute();
		this.buildSmoke();

		this.detached = new Map();
		this.cameraMode = options.camera || 'chase';
		this.time = 0;
		this.lastTime = 0;
		this.orbit = 0;

		this.resize();
	}

	buildSky() {
		const geom = new THREE.SphereGeometry(2000, 32, 16);
		const mat = new THREE.ShaderMaterial({
			side: THREE.BackSide,
			depthWrite: false,
			uniforms: {
				top: { value: new THREE.Color(0x3f7fc4) },
				bottom: { value: new THREE.Color(0xd8e6f2) },
			},
			vertexShader: `
				varying float vY;
				void main() {
					vY = normalize(position).y;
					gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
				}`,
			fragmentShader: `
				uniform vec3 top;
				uniform vec3 bottom;
				varying float vY;
				void main() {
					float t = clamp(vY * 0.5 + 0.5, 0.0, 1.0);
					gl_FragColor = vec4(mix(bottom, top, pow(t, 0.85)), 1.0);
				}`,
		});
		this.sky = new THREE.Mesh(geom, mat);
		this.scene.add(this.sky);
	}

	buildLights() {
		const hemi = new THREE.HemisphereLight(0xdfefff, 0x3f4a36, 1.1);
		this.scene.add(hemi);

		const sun = new THREE.DirectionalLight(0xfff2df, 2.4);
		sun.position.set(18, 30, 12);
		sun.castShadow = true;
		sun.shadow.mapSize.set(2048, 2048);
		sun.shadow.camera.near = 1;
		sun.shadow.camera.far = 120;
		sun.shadow.camera.left = -12;
		sun.shadow.camera.right = 12;
		sun.shadow.camera.top = 12;
		sun.shadow.camera.bottom = -12;
		this.sun = sun;
		this.scene.add(sun);
	}

	buildGround() {
		const tex = makeGridTexture();
		const geom = new THREE.PlaneGeometry(4000, 4000);
		const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.95, metalness: 0 });
		const ground = new THREE.Mesh(geom, mat);
		ground.rotation.x = -Math.PI / 2;
		ground.receiveShadow = true;
		this.scene.add(ground);
		this.ground = ground;
	}

	buildPad() {
		const pad = new THREE.Group();
		const base = new THREE.Mesh(
			new THREE.BoxGeometry(1.2, 0.12, 1.2),
			new THREE.MeshStandardMaterial({ color: 0x6b7280, roughness: 0.85 })
		);
		base.position.y = 0.06;
		base.receiveShadow = true;
		base.castShadow = true;
		pad.add(base);

		const angle = (this.rocket.launchRodAngle || 0) * (Math.PI / 180);
		const rodLen = this.rocket.launchRodLength || Math.max(1.2, this.rocket.length * 3);
		const rod = new THREE.Mesh(
			new THREE.CylinderGeometry(0.006, 0.006, rodLen, 12),
			new THREE.MeshStandardMaterial({ color: 0xc0c6cc, metalness: 0.85, roughness: 0.25 })
		);
		rod.position.set(Math.sin(angle) * rodLen / 2, Math.cos(angle) * rodLen / 2, 0);
		rod.rotation.z = -angle;
		rod.castShadow = true;
		pad.add(rod);

		this.pad = pad;
		this.scene.add(pad);
	}

	buildFlame() {
		const geom = new THREE.ConeGeometry(0.035, 0.28, 20, 1, true);
		geom.translate(0, -0.14, 0);
		const mat = new THREE.MeshBasicMaterial({
			color: 0xffb347, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false,
		});
		this.flame = new THREE.Mesh(geom, mat);
		this.flame.rotation.z = Math.PI / 2;
		this.flame.visible = false;

		this.flameLight = new THREE.PointLight(0xffa53a, 0, 6, 2);
		this.flameGroup = new THREE.Group();
		this.flameGroup.add(this.flame);
		this.flameGroup.add(this.flameLight);
		this.scene.add(this.flameGroup);
	}

	buildChute() {
		const group = new THREE.Group();
		const canopyGeom = new THREE.SphereGeometry(1, 24, 12, 0, Math.PI * 2, 0, Math.PI * 0.55);
		const canopyMat = new THREE.MeshStandardMaterial({
			color: 0xff6b3d, roughness: 0.85, side: THREE.DoubleSide,
		});
		const canopy = new THREE.Mesh(canopyGeom, canopyMat);
		group.add(canopy);

		const lineGeom = new THREE.BufferGeometry();
		const pts = [];
		for (let i = 0; i < 8; i++) {
			const a = (i / 8) * Math.PI * 2;
			pts.push(Math.cos(a), 0, Math.sin(a));
			pts.push(0, -2, 0);
		}
		lineGeom.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
		const lines = new THREE.LineSegments(lineGeom, new THREE.LineBasicMaterial({ color: 0xf2f2f2 }));
		group.add(lines);

		group.visible = false;
		this.chute = group;
		this.scene.add(group);
	}

	buildSmoke() {
		const COUNT = 4000;
		const positions = new Float32Array(COUNT * 3);
		const alphas = new Float32Array(COUNT);
		const sizes = new Float32Array(COUNT);
		const geom = new THREE.BufferGeometry();
		geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
		geom.setAttribute('alpha', new THREE.BufferAttribute(alphas, 1));
		geom.setAttribute('size', new THREE.BufferAttribute(sizes, 1));

		const tex = makeSmokeTexture();
		const mat = new THREE.ShaderMaterial({
			uniforms: { map: { value: tex }, color: { value: new THREE.Color(0xf2f2f4) } },
			vertexShader: `
				attribute float alpha;
				attribute float size;
				varying float vAlpha;
				void main() {
					vAlpha = alpha;
					vec4 mv = modelViewMatrix * vec4(position, 1.0);
					gl_PointSize = size * 320.0 / max(1.0, -mv.z);
					gl_Position = projectionMatrix * mv;
				}`,
			fragmentShader: `
				uniform sampler2D map;
				uniform vec3 color;
				varying float vAlpha;
				void main() {
					vec4 tex = texture2D(map, gl_PointCoord);
					gl_FragColor = vec4(color, tex.a * vAlpha);
					if (gl_FragColor.a < 0.01) discard;
				}`,
			transparent: true,
			depthWrite: false,
			blending: THREE.NormalBlending,
		});

		this.smoke = {
			points: new THREE.Points(geom, mat),
			count: COUNT,
			next: 0,
			positions,
			alphas,
			sizes,
			life: new Float32Array(COUNT),
			vel: new Float32Array(COUNT * 3),
			age: new Float32Array(COUNT),
		};
		this.smoke.points.frustumCulled = false;
		this.scene.add(this.smoke.points);
	}

	/* -------------------------------------------------------------- */

	sampleAt(t) {
		const s = this.flight.samples;
		if (!s.length) return null;
		if (t <= s[0].t) return s[0];
		if (t >= s[s.length - 1].t) return s[s.length - 1];
		let lo = 0;
		let hi = s.length - 1;
		while (hi - lo > 1) {
			const mid = (lo + hi) >> 1;
			if (s[mid].t <= t) lo = mid;
			else hi = mid;
		}
		const a = s[lo];
		const b = s[hi];
		const f = (t - a.t) / (b.t - a.t || 1);
		const mix = (u, v) => u + (v - u) * f;
		const axis = new THREE.Vector3(
			mix(a.axis[0], b.axis[0]),
			mix(a.axis[1], b.axis[1]),
			mix(a.axis[2], b.axis[2])
		).normalize();
		return {
			t,
			pos: [mix(a.pos[0], b.pos[0]), mix(a.pos[1], b.pos[1]), mix(a.pos[2], b.pos[2])],
			vel: [mix(a.vel[0], b.vel[0]), mix(a.vel[1], b.vel[1]), mix(a.vel[2], b.vel[2])],
			axis: [axis.x, axis.y, axis.z],
			altitude: mix(a.altitude, b.altitude),
			speed: mix(a.speed, b.speed),
			mach: mix(a.mach, b.mach),
			thrust: mix(a.thrust, b.thrust),
			mass: mix(a.mass, b.mass),
			chute: a.chute || b.chute,
			onRail: a.onRail && b.onRail,
		};
	}

	/** Position/orient the rocket for the given flight time. */
	setTime(t) {
		this.time = t;
		const s = this.sampleAt(t);
		if (!s) return;
		this.current = s;

		const pos = new THREE.Vector3(...s.pos);
		const axis = new THREE.Vector3(...s.axis).normalize();

		// Local +X points from nose to tail, i.e. opposite the flight axis.
		const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(1, 0, 0), axis.clone().negate());
		this.rocketRoot.position.copy(pos);
		this.rocketRoot.quaternion.copy(q);

		// Stage separation visuals.
		for (const sep of this.flight.separations) {
			if (t >= sep.t && !this.detached.has(sep.stage)) {
				const group = this.stageGroups.get(sep.stage);
				if (group) {
					const clone = group.clone(true);
					const worldPos = new THREE.Vector3(...sep.position);
					const worldAxis = new THREE.Vector3(...sep.axis).normalize();
					clone.position.copy(worldPos);
					clone.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), worldAxis.clone().negate());
					clone.userData.velocity = new THREE.Vector3(...sep.velocity);
					clone.userData.t0 = sep.t;
					this.scene.add(clone);
					this.detached.set(sep.stage, clone);
					group.visible = false;
				}
			}
		}
		for (const [, clone] of this.detached) {
			const age = Math.max(0, t - clone.userData.t0);
			const v = clone.userData.velocity;
			clone.position.add(new THREE.Vector3(v.x * age, v.y * age - 4.9 * age * age, v.z * age));
			if (clone.position.y < 0) clone.position.y = 0.02;
		}

		// Flame
		const thrust = Math.max(0, s.thrust || 0);
		if (thrust > 0.5) {
			const tail = pos.clone().sub(axis.clone().multiplyScalar(this.rocket.length));
			this.flameGroup.position.copy(tail);
			this.flameGroup.quaternion.copy(q);
			const scale = 0.6 + Math.min(2.6, thrust / 25);
			this.flame.scale.set(scale * 0.8, scale, scale * 0.8);
			this.flame.visible = true;
			this.flame.material.opacity = 0.55 + Math.random() * 0.35;
			this.flameLight.position.copy(tail);
			this.flameLight.intensity = Math.min(12, thrust * 0.35);
		} else {
			this.flame.visible = false;
			this.flameLight.intensity = 0;
		}

		// Canopy
		if (s.chute) {
			const canopyR = this.chuteRadius();
			this.chute.visible = true;
			const anchor = pos.clone().sub(axis.clone().multiplyScalar(this.rocket.length * 0.6));
			this.chute.position.copy(anchor.clone().add(axis.clone().multiplyScalar(1.4 + canopyR)));
			this.chute.quaternion.copy(q);
			this.chute.scale.setScalar(canopyR);
			void anchor;
		} else {
			this.chute.visible = false;
		}

		this.emitSmoke(s, thrust);
	}

	chuteRadius() {
		let area = 0;
		for (const c of this.rocket.components) {
			if (c.type === 'parachute') area = Math.max(area, c.diameter / 2);
		}
		return Math.max(0.15, area || 0.25);
	}

	emitSmoke(s, thrust) {
		const dt = Math.max(0.001, this.time - this.lastTime);
		this.lastTime = this.time;
		if (thrust > 0.5) {
			const axis = new THREE.Vector3(...s.axis).normalize();
			const pos = new THREE.Vector3(...s.pos);
			const tail = pos.clone().sub(axis.clone().multiplyScalar(this.rocket.length));
			const emit = Math.min(40, Math.ceil(thrust * 0.4 + 2));
			for (let i = 0; i < emit; i++) {
				const idx = this.smoke.next;
				this.smoke.next = (this.smoke.next + 1) % this.smoke.count;
				const p = idx * 3;
				this.smoke.positions[p] = tail.x + (Math.random() - 0.5) * 0.12;
				this.smoke.positions[p + 1] = tail.y + (Math.random() - 0.5) * 0.12;
				this.smoke.positions[p + 2] = tail.z + (Math.random() - 0.5) * 0.12;
				this.smoke.vel[p] = (Math.random() - 0.5) * 0.6 - axis.x * 2;
				this.smoke.vel[p + 1] = (Math.random() - 0.5) * 0.6 - axis.y * 2;
				this.smoke.vel[p + 2] = (Math.random() - 0.5) * 0.6 - axis.z * 2;
				this.smoke.age[idx] = 0;
				this.smoke.life[idx] = 2.5 + Math.random() * 2.5;
				this.smoke.sizes[idx] = 0.25 + Math.random() * 0.35;
				this.smoke.alphas[idx] = 0.55;
			}
		}
		void dt;
	}

	updateSmoke(dt) {
		const { positions, alphas, age, life, vel, sizes } = this.smoke;
		for (let i = 0; i < this.smoke.count; i++) {
			if (age[i] >= life[i]) {
				alphas[i] = 0;
				continue;
			}
			age[i] += dt;
			const p = i * 3;
			positions[p] += vel[p] * dt;
			positions[p + 1] += vel[p + 1] * dt;
			positions[p + 2] += vel[p + 2] * dt;
			vel[p] *= 0.985;
			vel[p + 1] = vel[p + 1] * 0.985 + 0.12 * dt;
			vel[p + 2] *= 0.985;
			sizes[i] += dt * 0.25;
			alphas[i] = Math.max(0, 0.55 * (1 - age[i] / life[i]));
		}
		this.smoke.points.geometry.attributes.position.needsUpdate = true;
		this.smoke.points.geometry.attributes.alpha.needsUpdate = true;
		this.smoke.points.geometry.attributes.size.needsUpdate = true;
	}

	updateCamera(dt) {
		const s = this.current;
		if (!s) return;
		const pos = new THREE.Vector3(...s.pos);
		const axis = new THREE.Vector3(...s.axis).normalize();
		const size = Math.max(0.6, this.rocket.length);

		switch (this.cameraMode) {
			case 'pad': {
				const target = pos.clone();
				this.camera.position.set(size * 4 + 1.5, size * 2.2 + 0.8, size * 4 + 1.5);
				this.camera.lookAt(target);
				break;
			}
			case 'ground': {
				this.camera.position.set(size * 6 + 2, 1.2, size * 6 + 2);
				this.camera.lookAt(pos);
				break;
			}
			case 'onboard': {
				const camPos = pos.clone().sub(axis.clone().multiplyScalar(size * 0.15));
				this.camera.position.copy(camPos);
				this.camera.lookAt(pos.clone().add(axis.clone().multiplyScalar(6)));
				break;
			}
			case 'orbit': {
				this.orbit += dt * 0.35;
				const r = size * 5 + 1.5;
				this.camera.position.set(pos.x + Math.cos(this.orbit) * r, pos.y + size * 1.6, pos.z + Math.sin(this.orbit) * r);
				this.camera.lookAt(pos);
				break;
			}
			case 'chase':
			default: {
				const back = axis.clone().multiplyScalar(-size * 1.8).add(new THREE.Vector3(0, size * 0.9, 0));
				const desired = pos.clone().sub(axis.clone().multiplyScalar(-size * 1.9));
				const target = pos.clone().add(back.clone().multiplyScalar(0.35));
				this.camera.position.lerp(desired.add(new THREE.Vector3(size * 1.2, size * 0.8, size * 1.2)), Math.min(1, dt * 2.5));
				this.camera.lookAt(target);
				break;
			}
		}

		// Keep the ground/sun centred near the rocket for stable shadows.
		this.sun.position.set(pos.x + 18, pos.y + 30, pos.z + 12);
		this.sun.target.position.copy(pos);
		this.sun.target.updateMatrixWorld();
	}

	dispose() {
		this.scene.traverse((node) => {
			if (node.geometry) node.geometry.dispose?.();
			if (node.material) {
				const mats = Array.isArray(node.material) ? node.material : [node.material];
				for (const m of mats) {
					for (const v of Object.values(m)) {
						if (v && v.isTexture) v.dispose();
					}
					m.dispose?.();
				}
			}
		});
		this.renderer.dispose();
	}

	resize() {
		const parent = this.canvas.parentElement;
		const w = parent?.clientWidth || this.canvas.clientWidth || 800;
		const h = parent?.clientHeight || this.canvas.clientHeight || 600;
		this.renderer.setSize(w, h, false);
		this.camera.aspect = w / h;
		this.camera.updateProjectionMatrix();
	}

	render(dt = 1 / 60) {
		this.updateSmoke(dt);
		this.updateCamera(dt);
		this.renderer.render(this.scene, this.camera);
	}
}

export { UP };
