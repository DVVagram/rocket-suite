import * as THREE from "./vendor/three.module.js";

/**
 * Geometry comes from the converted design values (OpenRocket -> RocketSerializer),
 * and motion comes from RocketPy samples. Nothing is integrated here.
 */
export class Viewer {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.05, 5000);
    this.camera.position.set(1.4, 0.9, 1.4);

    const ambient = new THREE.HemisphereLight(0xdfe9ff, 0x1a2430, 1.1);
    const key = new THREE.DirectionalLight(0xffffff, 1.4);
    key.position.set(3, 6, 4);
    this.scene.add(ambient, key);

    this.rocket = new THREE.Group();
    this.scene.add(this.rocket);

    this.trajectory = new THREE.Line(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color: 0x4da3ff, transparent: true, opacity: 0.7 })
    );
    this.scene.add(this.trajectory);

    this.radius = 0.03;
    this.clock = new THREE.Clock();
    this.follow = true;
    this.flight = null;
    this.playing = false;
    this.offset = 0;
    this.resize();
    this.animate();
    window.addEventListener("resize", () => this.resize());
  }

  resize() {
    const width = this.canvas.clientWidth || 800;
    const height = Number(this.canvas.getAttribute("height")) || 480;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  setDesign(design) {
    this.rocket.clear();
    const surfaces = design?.surfaces || {};
    const nose = surfaces.nosecones?.[0];
    const radius = design?.radius || nose?.base_radius || 0.03;
    this.radius = radius;

    const noseLength = nose?.length ?? radius * 3;
    const fins = surfaces.trapezoidal_fins?.[0];
    const finPos = fins?.position ?? noseLength + radius * 6;
    const finChord = fins?.root_chord ?? radius * 2;
    const bodyLength = Math.max(finPos + finChord, noseLength + radius * 4) - noseLength;

    const material = new THREE.MeshStandardMaterial({ color: 0xd9e4f2, metalness: 0.25, roughness: 0.45 });
    const accent = new THREE.MeshStandardMaterial({ color: 0x4da3ff, metalness: 0.3, roughness: 0.35 });

    const cone = new THREE.Mesh(new THREE.ConeGeometry(radius, noseLength, 32), accent);
    cone.position.y = noseLength / 2;
    this.rocket.add(cone);

    const body = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, bodyLength, 32), material);
    body.position.y = noseLength + bodyLength / 2;
    this.rocket.add(body);

    if (fins) {
      const count = fins.number || 3;
      const span = fins.span ?? radius * 2;
      const tipChord = fins.tip_chord ?? finChord * 0.5;
      for (let i = 0; i < count; i += 1) {
        const shape = new THREE.Shape();
        shape.moveTo(0, 0);
        shape.lineTo(finChord, 0);
        shape.lineTo(finChord - (fins.sweep_length ?? finChord * 0.4) + tipChord, span);
        shape.lineTo(finChord - (fins.sweep_length ?? finChord * 0.4), span);
        shape.closePath();
        const geometry = new THREE.ExtrudeGeometry(shape, { depth: radius * 0.09, bevelEnabled: false });
        const fin = new THREE.Mesh(geometry, accent);
        fin.rotation.z = -Math.PI / 2;
        fin.rotation.y = (i / count) * Math.PI * 2;
        fin.position.y = finPos + finChord;
        fin.position.x = 0;
        const holder = new THREE.Group();
        holder.rotation.y = (i / count) * Math.PI * 2;
        const radial = new THREE.Mesh(geometry, accent);
        radial.rotation.z = -Math.PI / 2;
        radial.position.set(radius * 0.98, finPos + finChord, 0);
        holder.add(radial);
        this.rocket.add(holder);
        fin.visible = false;
      }
    }

    const total = noseLength + bodyLength;
    this.rocket.position.y = 0;
    this.rocket.scale.setScalar(1);
    this.total = total;
    this.focusOnRocket();
    this.buildTrajectory(null, total);
  }

  buildTrajectory(flight, total = this.total) {
    if (!flight) {
      this.trajectory.visible = false;
      return;
    }
    const scale = 4 / Math.max(total || 1, 0.1);
    const positions = [];
    const times = flight.series.time;
    flight.series.altitude.forEach((altitude, i) => {
      const downrange = flight.series.downrange?.[i] ?? 0;
      positions.push(downrange * scale, altitude * scale, 0);
    });
    this.trajectory.geometry.dispose();
    this.trajectory.geometry = new THREE.BufferGeometry();
    this.trajectory.geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    this.trajectory.visible = true;
    this.flightScale = scale;
  }

  setFlight(flight) {
    this.flight = flight;
    this.buildTrajectory(flight, this.total);
    this.rocket.scale.setScalar(flight ? Math.max(4 / Math.max(this.total || 1, 0.1), 1) : 1);
    this.offset = 0;
    this.focusOnRocket();
  }

  focusOnRocket() {
    this.camera.position.set(6, this.total ? this.total * 0.9 + 3 : 4, 6);
    this.camera.lookAt(0, (this.total || 1) * 0.5, 0);
  }

  play() {
    this.playing = Boolean(this.flight);
    this.offset = 0;
    this.clock.getDelta();
  }

  animate = () => {
    requestAnimationFrame(this.animate);
    const delta = this.clock.getDelta();
    if (this.playing && this.flight) {
      this.offset += delta;
    }
    if (this.flight) {
      const times = this.flight.series.time;
      const duration = times[times.length - 1] || 1;
      const t = this.playing ? Math.min(this.offset * (duration / 6), duration) : duration * 0.0;
      const series = this.flight.series;
      const at = (arr) => {
        if (!arr) return 0;
        const step = duration / (arr.length - 1);
        const idx = Math.min(arr.length - 1, Math.max(0, Math.round(t / step)));
        return arr[idx] ?? 0;
      };
      const scale = this.flightScale || 1;
      const altitude = at(series.altitude) * scale;
      const downrange = at(series.downrange) * scale;
      this.rocket.position.set(downrange, altitude, 0);
      if (this.follow) {
        this.camera.lookAt(downrange, altitude + (this.total || 1) * 0.5, 0);
        this.camera.position.set(downrange + 6, altitude + 4.5, 6);
      }
    }
    this.renderer.render(this.scene, this.camera);
  };
}
