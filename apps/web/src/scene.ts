import {
  BODIES,
  arcPosition,
  childBodies,
  getBody,
  orbitalPeriodS,
  position,
  viewBodyRadius,
  viewOffset,
  viewRingRadii,
  type BodyDef,
  type FlightArc,
  type Vec3,
  type ViewFocus,
} from "@acs/astro";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { createBodies, disposeBodies, setRingRadii, spinBody, type BodyNode } from "./surfaces";

export type Focus = ViewFocus;

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

function toThree(v: Vec3): THREE.Vector3 {
  return new THREE.Vector3(v.x, v.z, v.y);
}

export function scenePosition(helio: Vec3, t: number, focus: Focus): THREE.Vector3 {
  return toThree(viewOffset(helio, t, focus));
}

/** Keep dwarf planets and asteroids from disappearing in the system overview, still smaller than Mercury. */
function shownRadius(body: BodyDef, focus: Focus, distance: number, height: number): number {
  const real = viewBodyRadius(body.id, focus);
  if (focus.level !== "system" || (body.kind !== "dwarf" && body.kind !== "asteroid")) return real;
  const cap = viewBodyRadius("mercury", focus) * 0.75;
  const fov = (50 * Math.PI) / 180;
  const diameter = (3.2 / Math.max(height, 1)) * Math.max(distance, 1) * 2 * Math.tan(fov / 2);
  return Math.max(real, Math.min(cap, diameter / 2));
}

function line(points: THREE.Vector3[], color: string, opacity: number): THREE.Line {
  const geometry = new THREE.BufferGeometry().setFromPoints(points);
  const material = new THREE.LineBasicMaterial({ color, transparent: true, opacity });
  return new THREE.Line(geometry, material);
}

function visibleBody(body: BodyDef, focus: Focus): boolean {
  if (focus.level === "system") return body.systemView;
  if (focus.level === "planet") return body.id === focus.id || body.parentId === focus.id;
  const parentId = getBody(focus.id).parentId;
  return body.id === focus.id || body.id === parentId || body.parentId === parentId;
}

export function mountScene(canvas: HTMLCanvasElement, labelRoot: HTMLElement, hooks: SceneHooks): () => void {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x07080c, 1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, 1, 0.08, 80_000);
  camera.position.set(0, 48, 110);

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.target.set(0, 0, 0);
  controls.minDistance = 0.35;
  controls.maxDistance = 6000;

  scene.add(new THREE.AmbientLight(0xc5ced8, 0.11));
  scene.add(new THREE.HemisphereLight(0x1a2433, 0x07080c, 0.03));
  const sunLight = new THREE.PointLight(0xfff4e0, 9, 0, 0);
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

  const nodes = createBodies(renderer);
  const byId = new Map<string, BodyNode>();
  const pickables: THREE.Object3D[] = [];
  for (const node of nodes) {
    scene.add(node.pivot);
    byId.set(node.id, node);
    pickables.push(node.mesh);
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
  let follow = new THREE.Vector3(0, 48, 110);
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
  const dotGeo = new THREE.SphereGeometry(1, 12, 10);

  const clearDynamic = () => {
    for (const child of [...dynamic.children]) {
      dynamic.remove(child);
      const mesh = child as THREE.Line | THREE.Mesh;
      if (mesh.geometry && mesh.geometry !== dotGeo) mesh.geometry.dispose();
      const material = mesh.material;
      if (Array.isArray(material)) material.forEach((item) => item !== dotMaterial && item.dispose());
      else if (material && material !== dotMaterial) material.dispose();
    }
    shipDots.clear();
  };

  const sampleCount = (focus: Focus, kind: "system" | "heliocentric" | "moon" | "ship") => {
    if (kind === "system") return 160;
    if (kind === "heliocentric") return focus.level === "system" ? 160 : 96;
    if (kind === "moon") return 72;
    return 28;
  };

  const rebuildDynamics = (t: number, focus: Focus, ships: ShipView[]) => {
    clearDynamic();
    const dotScale = focus.level === "system" ? 0.26 : 0.22;
    if (focus.level === "system") {
      for (const body of BODIES) {
        if (!body.systemView || body.id === "sun") continue;
        const period = Math.min(orbitalPeriodS(body.id), 400 * 86400 * 365);
        const count = sampleCount(focus, "system");
        const points: THREE.Vector3[] = [];
        for (let i = 0; i <= count; i++) points.push(scenePosition(position(body.id, t + (period * i) / count), t, focus));
        dynamic.add(line(points, body.color, 0.35));
      }
    } else {
      const centerId = focus.level === "planet" ? focus.id : getBody(focus.id).parentId ?? focus.id;
      const period = Math.min(orbitalPeriodS(centerId), 400 * 86400 * 365);
      const orbitPts: THREE.Vector3[] = [];
      const count = sampleCount(focus, "heliocentric");
      for (let i = 0; i <= count; i++) orbitPts.push(scenePosition(position(centerId, t + (period * i) / count), t, focus));
      dynamic.add(line(orbitPts, getBody(centerId).color, 0.28));
      for (const moon of childBodies(centerId)) {
        const moonPeriod = orbitalPeriodS(moon.id);
        const pts: THREE.Vector3[] = [];
        const moonCount = sampleCount(focus, "moon");
        const parentNow = position(centerId, t);
        for (let i = 0; i <= moonCount; i++) {
          const at = t + (moonPeriod * i) / moonCount;
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
      const steps = sampleCount(focus, "ship");
      for (let i = 0; i <= steps; i++) {
        const at = arc.departAt + ((arc.arriveAt - arc.departAt) * i) / steps;
        pts.push(scenePosition(arcPosition(arc, at), t, focus));
      }
      dynamic.add(line(pts, "#ffd48a", 0.85));
      const dot = new THREE.Mesh(dotGeo, dotMaterial);
      dot.scale.setScalar(dotScale);
      dot.userData.shipId = ship.id;
      dynamic.add(dot);
      shipDots.set(ship.id, dot);
    }
    for (const ship of ships) {
      if (ship.state !== "orbiting") continue;
      const mark = new THREE.Mesh(dotGeo, dotMaterial);
      mark.scale.setScalar(dotScale);
      mark.userData.shipId = ship.id;
      mark.userData.orbitBody = ship.bodyId;
      dynamic.add(mark);
      shipDots.set(ship.id, mark);
    }
  };

  const world = new THREE.Vector3();
  const tick = () => {
    frame = requestAnimationFrame(tick);
    const t = hooks.getSimTime();
    const focus = hooks.getFocus();
    const ships = hooks.getShips();
    const key = `${focus.level}:${"id" in focus ? focus.id : ""}:${ships.map((s) => s.id + s.state + (s.flight?.departAt ?? "")).join("|")}`;
    const keyChanged = key !== focusKey;
    if (keyChanged) {
      focusKey = key;
      if (!userDrag) {
        if (focus.level === "system") {
          controls.target.set(0, 0, 0);
          follow.set(0, 48, 110);
        } else if (focus.level === "moon") {
          const look = scenePosition(position(focus.id, t), t, focus);
          const parentId = getBody(focus.id).parentId ?? focus.id;
          const parent = scenePosition(position(parentId, t), t, focus);
          const away = look.clone().sub(parent);
          if (away.lengthSq() < 1e-8) away.set(0, 0.2, 1);
          else away.normalize();
          controls.target.copy(look);
          follow.copy(away.multiplyScalar(7.2));
          follow.y += 1.6;
        } else {
          const look = scenePosition(position(focus.id, t), t, focus);
          controls.target.copy(look);
          follow.set(0, 24, 64);
        }
        camera.position.copy(controls.target).add(follow);
      }
    }
    if (keyChanged || focus.level !== "system") rebuildDynamics(t, focus, ships);

    const height = canvas.clientHeight || 1;
    for (const node of nodes) {
      const body = getBody(node.id);
      const visible = visibleBody(body, focus);
      node.pivot.visible = visible;
      if (!visible) continue;
      node.pivot.position.copy(scenePosition(position(body.id, t), t, focus));
      const distance = Math.max(camera.position.distanceTo(node.pivot.position), 0.5);
      const shown = shownRadius(body, focus, distance, height);
      node.shown = shown;
      node.mesh.scale.setScalar(Math.max(shown, 1e-4));
      node.pickRadius = focus.level === "system" ? 0.72 : focus.level === "planet" ? 0.42 : 0.5;
      spinBody(node, t);
    }
    const saturn = byId.get("saturn");
    const rings = viewRingRadii(focus);
    if (saturn && rings) setRingRadii(saturn, rings.inner, rings.outer);

    const sunAt = scenePosition({ x: 0, y: 0, z: 0 }, t, focus);
    if (sunAt.lengthSq() < 1e-8) sunLight.position.set(0, 0, 0);
    else {
      const reach = Math.min(Math.max(sunAt.length(), 80), 5000);
      sunLight.position.copy(sunAt).multiplyScalar(reach / sunAt.length());
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
        const host = byId.get(ship.bodyId);
        const base = scenePosition(position(ship.bodyId, t), t, focus);
        const angle = ship.id.split("").reduce((sum, ch) => sum + ch.charCodeAt(0), 0);
        const gap = (host?.shown ?? viewBodyRadius(ship.bodyId, focus)) + 0.22;
        base.x += Math.cos(angle) * gap;
        base.z += Math.sin(angle) * gap;
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
    const nextIds = new Set<string>();
    for (const node of nodes) {
      if (!node.pivot.visible) continue;
      node.pivot.getWorldPosition(world);
      const projected = world.clone().project(camera);
      if (projected.z > 1) continue;
      nextIds.add(node.id);
      let span = labelRoot.querySelector<HTMLSpanElement>(`[data-id="${node.id}"]`);
      if (!span) {
        span = document.createElement("span");
        span.dataset.id = node.id;
        span.textContent = getBody(node.id).name;
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
    clearDynamic();
    dotGeo.dispose();
    dotMaterial.dispose();
    disposeBodies(nodes);
    renderer.dispose();
  };
}
