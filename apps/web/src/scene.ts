import {
  AU_KM,
  BODIES,
  arcPosition,
  childBodies,
  getBody,
  orbitalPeriodS,
  parkingRadiusKm,
  position,
  type FlightArc,
  type Vec3,
} from "@acs/astro";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

export type Focus =
  | { level: "system" }
  | { level: "planet"; id: string }
  | { level: "moon"; id: string };

export interface ShipView {
  id: string;
  name: string;
  state: string;
  bodyId: string;
  flight: {
    fromBodyId: string;
    toBodyId: string;
    departAt: number;
    arriveAt: number;
    frameId: string;
    mu: number;
    r0: [number, number, number];
    v0: [number, number, number];
  } | null;
}

export interface SceneHooks {
  getSimTime: () => number;
  getFocus: () => Focus;
  getShips: () => ShipView[];
  onPick: (id: string) => void;
}

const SYSTEM_SCALE = 16;

function compress(km: Vec3): Vec3 {
  const r = Math.hypot(km.x, km.y, km.z);
  const au = r / AU_KM;
  if (au < 1e-8) return { x: 0, y: 0, z: 0 };
  const factor = (Math.sqrt(au) * SYSTEM_SCALE) / r;
  return { x: km.x * factor, y: km.y * factor, z: km.z * factor };
}

function toThree(v: Vec3, mag = 1): THREE.Vector3 {
  return new THREE.Vector3(v.x * mag, v.z * mag, v.y * mag);
}

function fixedA(id: string): number {
  const orbit = getBody(id).orbit;
  if (orbit && orbit.model === "fixed") return orbit.aKm;
  return parkingRadiusKm(id);
}

function localMag(focus: Focus): number {
  if (focus.level === "system") return 1;
  if (focus.level === "moon") return 36 / fixedA(focus.id);
  const moons = childBodies(focus.id);
  if (!moons.length) return 10 / parkingRadiusKm(focus.id);
  return 34 / Math.max(...moons.map((moon) => fixedA(moon.id)));
}

function bubbleKm(focus: Focus): number {
  if (focus.level === "moon") return Math.max(fixedA(focus.id) * 3, 50_000);
  if (focus.level === "planet") {
    const moons = childBodies(focus.id);
    if (!moons.length) return parkingRadiusKm(focus.id) * 40;
    return Math.max(...moons.map((moon) => fixedA(moon.id))) * 1.8;
  }
  return Number.POSITIVE_INFINITY;
}

export function scenePosition(helio: Vec3, t: number, focus: Focus): THREE.Vector3 {
  if (focus.level === "system") return toThree(compress(helio));
  const centerId = focus.level === "planet" ? focus.id : getBody(focus.id).parentId ?? focus.id;
  const center = position(centerId, t);
  const offset = { x: helio.x - center.x, y: helio.y - center.y, z: helio.z - center.z };
  const dist = Math.hypot(offset.x, offset.y, offset.z);
  if (dist < bubbleKm(focus)) return toThree(offset, localMag(focus));
  const far = compress(helio);
  const origin = compress(center);
  return toThree({ x: far.x - origin.x, y: far.y - origin.y, z: far.z - origin.z });
}

function line(points: THREE.Vector3[], color: string, opacity: number): THREE.Line {
  const geometry = new THREE.BufferGeometry().setFromPoints(points);
  const material = new THREE.LineBasicMaterial({ color, transparent: true, opacity });
  return new THREE.Line(geometry, material);
}

function sampleOrbit(id: string, t: number, count: number): THREE.Vector3[] {
  const period = Math.min(orbitalPeriodS(id), 400 * 86400 * 365);
  const points: THREE.Vector3[] = [];
  for (let i = 0; i <= count; i++) {
    const at = t + (period * i) / count;
    points.push(toThree(compress(position(id, at))));
  }
  return points;
}

export function mountScene(canvas: HTMLCanvasElement, labelRoot: HTMLElement, hooks: SceneHooks): () => void {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x07080c, 1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, 1, 0.05, 8000);
  camera.position.set(0, 42, 96);

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.target.set(0, 0, 0);
  controls.maxDistance = 400;

  scene.add(new THREE.AmbientLight(0xffffff, 0.55));
  const sunLight = new THREE.PointLight(0xfff1d0, 80, 0, 0);
  scene.add(sunLight);

  const stars = new THREE.Points(
    new THREE.BufferGeometry().setAttribute(
      "position",
      new THREE.BufferAttribute(
        Float32Array.from({ length: 1200 * 3 }, () => (Math.random() - 0.5) * 1400),
        3,
      ),
    ),
    new THREE.PointsMaterial({ color: 0x9aa6b8, size: 0.6, sizeAttenuation: true }),
  );
  scene.add(stars);

  const bodyMeshes = new Map<string, THREE.Mesh>();
  const pickables: THREE.Object3D[] = [];
  for (const body of BODIES) {
    const radius = body.kind === "star" ? 4.2 : body.kind === "planet" ? 1.7 : body.systemView ? 0.7 : 0.55;
    const material = new THREE.MeshStandardMaterial({
      color: body.color,
      emissive: body.kind === "star" ? body.color : "#000000",
      emissiveIntensity: body.kind === "star" ? 1 : 0,
      roughness: 0.85,
      metalness: body.kind === "star" ? 0 : 0.15,
    });
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 28, 20), material);
    mesh.userData.bodyId = body.id;
    scene.add(mesh);
    bodyMeshes.set(body.id, mesh);
    pickables.push(mesh);
  }

  const dynamic = new THREE.Group();
  scene.add(dynamic);

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  let downX = 0;
  let downY = 0;
  const onDown = (event: PointerEvent) => {
    downX = event.clientX;
    downY = event.clientY;
  };
  const onUp = (event: PointerEvent) => {
    if (Math.hypot(event.clientX - downX, event.clientY - downY) > 5) return;
    const rect = canvas.getBoundingClientRect();
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const hit = raycaster.intersectObjects(pickables, false)[0];
    const id = hit?.object.userData.bodyId as string | undefined;
    if (id) hooks.onPick(id);
  };
  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointerup", onUp);

  let focusKey = "";
  let follow = new THREE.Vector3(0, 42, 96);
  let userDrag = false;
  controls.addEventListener("start", () => {
    userDrag = true;
  });
  controls.addEventListener("end", () => {
    userDrag = false;
    follow.copy(camera.position).sub(controls.target);
  });

  const resize = () => {
    const width = canvas.clientWidth || 1;
    const height = canvas.clientHeight || 1;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  };
  const observer = new ResizeObserver(resize);
  observer.observe(canvas);
  resize();

  let frame = 0;
  const shipDots = new Map<string, THREE.Mesh>();
  const dotMaterial = new THREE.MeshBasicMaterial({ color: 0xffd48a });

  const rebuildDynamics = (t: number, focus: Focus, ships: ShipView[]) => {
    for (const child of [...dynamic.children]) {
      dynamic.remove(child);
      const mesh = child as THREE.Line | THREE.Mesh;
      mesh.geometry?.dispose();
      const material = mesh.material;
      if (Array.isArray(material)) material.forEach((item) => item !== dotMaterial && item.dispose());
      else if (material && material !== dotMaterial) material.dispose();
    }
    shipDots.clear();
    if (focus.level === "system") {
      for (const body of BODIES) {
        if (!body.systemView || body.id === "sun") continue;
        dynamic.add(line(sampleOrbit(body.id, t, 160), body.color, 0.35));
      }
    } else {
      const centerId = focus.level === "planet" ? focus.id : getBody(focus.id).parentId ?? focus.id;
      const period = Math.min(orbitalPeriodS(centerId), 400 * 86400 * 365);
      const orbitPts: THREE.Vector3[] = [];
      for (let i = 0; i <= 180; i++) orbitPts.push(scenePosition(position(centerId, t + (period * i) / 180), t, focus));
      dynamic.add(line(orbitPts, getBody(centerId).color, 0.28));
      for (const moon of childBodies(centerId)) {
        const moonPeriod = orbitalPeriodS(moon.id);
        const pts: THREE.Vector3[] = [];
        const count = 96;
        const parentNow = position(centerId, t);
        for (let i = 0; i <= count; i++) {
          const at = t + (moonPeriod * i) / count;
          const moonAt = position(moon.id, at);
          const parentAt = position(centerId, at);
          pts.push(
            scenePosition(
              {
                x: parentNow.x + moonAt.x - parentAt.x,
                y: parentNow.y + moonAt.y - parentAt.y,
                z: parentNow.z + moonAt.z - parentAt.z,
              },
              t,
              focus,
            ),
          );
        }
        dynamic.add(line(pts, moon.color, focus.level === "moon" && moon.id !== focus.id ? 0.25 : 0.7));
      }
    }
    for (const ship of ships) {
      if (ship.state !== "in_transit" || !ship.flight) continue;
      const arc: FlightArc = ship.flight;
      const pts: THREE.Vector3[] = [];
      const steps = 32;
      for (let i = 0; i <= steps; i++) {
        const at = arc.departAt + ((arc.arriveAt - arc.departAt) * i) / steps;
        pts.push(scenePosition(arcPosition(arc, at), t, focus));
      }
      dynamic.add(line(pts, "#ffd48a", 0.85));
      const dot = new THREE.Mesh(new THREE.SphereGeometry(0.35, 12, 10), dotMaterial);
      dot.userData.shipId = ship.id;
      dynamic.add(dot);
      shipDots.set(ship.id, dot);
    }
    for (const ship of ships) {
      if (ship.state !== "orbiting") continue;
      const mark = new THREE.Mesh(new THREE.SphereGeometry(0.28, 10, 8), dotMaterial);
      mark.userData.shipId = ship.id;
      mark.userData.orbitBody = ship.bodyId;
      dynamic.add(mark);
      shipDots.set(ship.id, mark);
    }
  };

  const tick = () => {
    frame = requestAnimationFrame(tick);
    const t = hooks.getSimTime();
    const focus = hooks.getFocus();
    const ships = hooks.getShips();
    const key = `${focus.level}:${"id" in focus ? focus.id : ""}:${ships.map((s) => s.id + s.state + (s.flight?.departAt ?? "")).join("|")}`;
    if (key !== focusKey) {
      focusKey = key;
      rebuildDynamics(t, focus, ships);
      if (!userDrag) {
        if (focus.level === "system") {
          controls.target.set(0, 0, 0);
          follow.set(0, 42, 96);
        } else {
          const look = scenePosition(position(focus.id, t), t, focus);
          controls.target.copy(look);
          follow.set(0, focus.level === "moon" ? 14 : 18, focus.level === "moon" ? 28 : 34);
        }
        camera.position.copy(controls.target).add(follow);
      }
    }
    for (const body of BODIES) {
      const mesh = bodyMeshes.get(body.id);
      if (!mesh) continue;
      const visible =
        focus.level === "system"
          ? body.systemView
          : focus.level === "planet"
            ? body.id === focus.id || body.parentId === focus.id
            : body.id === focus.id || body.id === getBody(focus.id).parentId || body.parentId === getBody(focus.id).parentId;
      mesh.visible = visible;
      if (!visible) continue;
      mesh.position.copy(scenePosition(position(body.id, t), t, focus));
    }
    for (const ship of ships) {
      const dot = shipDots.get(ship.id);
      if (!dot) continue;
      if (ship.state === "in_transit" && ship.flight) {
        const at = Math.min(Math.max(t, ship.flight.departAt), ship.flight.arriveAt);
        dot.position.copy(scenePosition(arcPosition(ship.flight, at), t, focus));
        continue;
      }
      if (ship.state === "orbiting") {
        const base = scenePosition(position(ship.bodyId, t), t, focus);
        const angle = ship.id.split("").reduce((sum, ch) => sum + ch.charCodeAt(0), 0);
        const radius = focus.level === "system" ? 2.4 : 3.4;
        base.x += Math.cos(angle) * radius;
        base.z += Math.sin(angle) * radius;
        dot.position.copy(base);
      }
    }
    if (!userDrag && focus.level !== "system") {
      const look = scenePosition(position(focus.id, t), t, focus);
      const delta = look.clone().sub(controls.target);
      controls.target.copy(look);
      camera.position.add(delta);
    }
    controls.update();
    const width = canvas.clientWidth || 1;
    const height = canvas.clientHeight || 1;
    const nextIds = new Set<string>();
    for (const body of BODIES) {
      const mesh = bodyMeshes.get(body.id);
      if (!mesh?.visible) continue;
      const projected = mesh.position.clone().project(camera);
      if (projected.z > 1) continue;
      nextIds.add(body.id);
      let span = labelRoot.querySelector<HTMLSpanElement>(`[data-id="${body.id}"]`);
      if (!span) {
        span = document.createElement("span");
        span.dataset.id = body.id;
        span.textContent = body.name;
        labelRoot.appendChild(span);
      }
      span.style.left = `${(projected.x * 0.5 + 0.5) * width}px`;
      span.style.top = `${(-projected.y * 0.5 + 0.5) * height}px`;
    }
    for (const span of [...labelRoot.querySelectorAll<HTMLSpanElement>("span")]) {
      if (!span.dataset.id || !nextIds.has(span.dataset.id)) span.remove();
    }
    renderer.render(scene, camera);
  };
  tick();

  return () => {
    cancelAnimationFrame(frame);
    observer.disconnect();
    canvas.removeEventListener("pointerdown", onDown);
    canvas.removeEventListener("pointerup", onUp);
    controls.dispose();
    renderer.dispose();
    scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      mesh.geometry?.dispose();
      const material = mesh.material;
      if (Array.isArray(material)) material.forEach((item) => item.dispose());
      else material?.dispose();
    });
  };
}
