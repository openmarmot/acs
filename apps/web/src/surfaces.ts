import { BODIES, type BodyDef } from "@acs/astro";
import * as THREE from "three";

export interface BodyNode {
  id: string;
  pivot: THREE.Group;
  mesh: THREE.Mesh;
  clouds?: THREE.Mesh;
  rings?: THREE.Mesh;
  glow?: THREE.Sprite;
  /** Minimum raycast radius in display units. The visible radius can be smaller. */
  pickRadius: number;
  /** Visible radius after the system-view speck floor. Ship markers read this. */
  shown: number;
  disposed: boolean;
}

const MAP_FILE: Record<string, string> = {
  sun: "sun.jpg",
  mercury: "mercury.jpg",
  venus: "venus.jpg",
  earth: "earth.jpg",
  mars: "mars.jpg",
  jupiter: "jupiter.jpg",
  saturn: "saturn.jpg",
  uranus: "uranus.jpg",
  neptune: "neptune.jpg",
  moon: "moon.jpg",
  phobos: "phobos.jpg",
  deimos: "deimos.jpg",
  io: "io.jpg",
  europa: "europa.jpg",
  ganymede: "ganymede.jpg",
  callisto: "callisto.jpg",
  titan: "titan.jpg",
  enceladus: "enceladus.jpg",
  rhea: "rhea.jpg",
  iapetus: "iapetus.jpg",
  triton: "triton.jpg",
  ceres: "ceres.jpg",
  vesta: "vesta.jpg",
  pluto: "pluto.jpg",
};

/** Approximate sidereal day, seconds. Negative is retrograde. */
const SPIN_S: Record<string, number> = {
  sun: 25.05 * 86400,
  mercury: 58.65 * 86400,
  venus: -243.02 * 86400,
  earth: 86164,
  mars: 88642,
  jupiter: 35730,
  saturn: 38054,
  uranus: -62064,
  neptune: 57996,
  moon: 27.322 * 86400,
};

/** Axial tilt relative to the ecliptic, degrees. Saturn's rings share this pivot. */
const OBLIQUITY_DEG: Record<string, number> = {
  earth: 23.44,
  mars: 25.19,
  jupiter: 3.13,
  saturn: 26.73,
  uranus: 97.77,
  neptune: 28.32,
};

const sphereGeo = new THREE.SphereGeometry(1, 48, 32);
const sunGeo = new THREE.SphereGeometry(1, 64, 48);

const loader = new THREE.TextureLoader();

function roughnessFor(body: BodyDef): number {
  if (body.id === "europa" || body.id === "enceladus" || body.id === "triton") return 0.36;
  if (body.id === "titan") return 0.7;
  if (body.kind === "planet" && body.radiusKm > 20_000) return 0.86;
  if (body.kind === "star") return 1;
  return 0.88;
}

function tintFor(id: string): number {
  if (id === "titan") return 0xf0d2a6;
  return 0xffffff;
}

function prepareTexture(texture: THREE.Texture, renderer: THREE.WebGLRenderer, colorSpace: THREE.ColorSpace): void {
  texture.colorSpace = colorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  texture.needsUpdate = true;
}

function hash(x: number, y: number, seed: number): number {
  const n = Math.sin(x * 127.1 + y * 311.7 + seed * 17.13) * 43758.5453;
  return n - Math.floor(n);
}

function fade(t: number): number {
  return t * t * (3 - 2 * t);
}

function noise(x: number, y: number, seed: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = fade(x - x0);
  const ty = fade(y - y0);
  const a = hash(x0, y0, seed) + (hash(x0 + 1, y0, seed) - hash(x0, y0, seed)) * tx;
  const b = hash(x0, y0 + 1, seed) + (hash(x0 + 1, y0 + 1, seed) - hash(x0, y0 + 1, seed)) * tx;
  return a + (b - a) * ty;
}

function fbm(x: number, y: number, seed: number): number {
  let v = 0;
  let amp = 0.5;
  let freq = 1;
  for (let i = 0; i < 5; i++) {
    v += amp * noise(x * freq, y * freq, seed + i * 19);
    amp *= 0.5;
    freq *= 2;
  }
  return v;
}

function palette(id: string): { low: number[]; high: number[]; speckle: boolean } {
  if (id === "psyche") return { low: [48, 44, 36], high: [196, 176, 122], speckle: true };
  if (id === "pallas") return { low: [36, 34, 32], high: [118, 112, 102], speckle: false };
  if (id === "titania" || id === "oberon") return { low: [62, 72, 82], high: [188, 198, 204], speckle: false };
  return { low: [58, 52, 46], high: [154, 144, 128], speckle: false };
}

/** Rocky fallback for bodies with no published global map (Pallas, Psyche, Titania, Oberon). */
export function proceduralTexture(id: string): THREE.CanvasTexture {
  const width = 768;
  const height = 384;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas 2d unavailable");
  const image = ctx.createImageData(width, height);
  const { low, high, speckle } = palette(id);
  let seed = 2166136261;
  for (const ch of id) seed = Math.imul(seed ^ ch.charCodeAt(0), 16777619);
  seed >>>= 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const u = x / width;
      const v = y / height;
      const n = fbm(u * 7, v * 4, seed);
      const grain = hash(x, y, seed);
      let t = Math.min(1, Math.max(0, n * 0.85 + grain * 0.15));
      if (speckle && grain > 0.92) t = Math.min(1, t + 0.35);
      const i = (y * width + x) * 4;
      image.data[i] = low[0]! + (high[0]! - low[0]!) * t;
      image.data[i + 1] = low[1]! + (high[1]! - low[1]!) * t;
      image.data[i + 2] = low[2]! + (high[2]! - low[2]!) * t;
      image.data[i + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  const rng = (n: number) => hash(n, n * 3, seed);
  const craters = speckle ? 28 : 64;
  for (let i = 0; i < craters; i++) {
    const cx = rng(i + 1) * width;
    const cy = rng(i + 40) * height;
    const r = 2 + rng(i + 80) * (speckle ? 10 : 18);
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(0, 0, 0, ${0.18 + rng(i + 7) * 0.25})`;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.72, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(255, 255, 255, ${0.08 + rng(i + 9) * 0.12})`;
    ctx.lineWidth = Math.max(1, r * 0.12);
    ctx.stroke();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.needsUpdate = true;
  return texture;
}

function radialRingGeometry(inner: number, outer: number): THREE.BufferGeometry {
  const geo = new THREE.RingGeometry(inner, outer, 192, 1);
  const pos = geo.getAttribute("position");
  const uv = geo.getAttribute("uv");
  for (let i = 0; i < pos.count; i++) {
    const radius = Math.hypot(pos.getX(i), pos.getY(i));
    const t = outer === inner ? 0 : (radius - inner) / (outer - inner);
    uv.setXY(i, t, 0.5);
  }
  uv.needsUpdate = true;
  return geo;
}

function applyMap(node: BodyNode, texture: THREE.Texture, renderer: THREE.WebGLRenderer): void {
  prepareTexture(texture, renderer, THREE.SRGBColorSpace);
  const material = node.mesh.material as THREE.MeshStandardMaterial | THREE.MeshBasicMaterial;
  material.map = texture;
  material.color.set(tintFor(node.id));
  material.needsUpdate = true;
}

function attachRaycast(node: BodyNode): void {
  const center = new THREE.Vector3();
  const hit = new THREE.Vector3();
  const sphere = new THREE.Sphere();
  node.mesh.raycast = (raycaster, intersects) => {
    node.mesh.getWorldPosition(center);
    sphere.center.copy(center);
    sphere.radius = Math.max(node.mesh.scale.x, node.pickRadius);
    const point = raycaster.ray.intersectSphere(sphere, hit);
    if (!point) return;
    const distance = raycaster.ray.origin.distanceTo(point);
    if (distance < raycaster.near || distance > raycaster.far) return;
    intersects.push({ distance, point: point.clone(), object: node.mesh });
  };
}

export function createBodies(renderer: THREE.WebGLRenderer): BodyNode[] {
  const nodes: BodyNode[] = [];
  for (const body of BODIES) {
    const pivot = new THREE.Group();
    const tilt = OBLIQUITY_DEG[body.id];
    if (tilt) pivot.rotation.z = (tilt * Math.PI) / 180;
    const material =
      body.kind === "star"
        ? new THREE.MeshBasicMaterial({ color: body.color, toneMapped: false })
        : new THREE.MeshStandardMaterial({
            color: body.color,
            roughness: roughnessFor(body),
            metalness: body.id === "psyche" ? 0.45 : 0.02,
          });
    const mesh = new THREE.Mesh(body.kind === "star" ? sunGeo : sphereGeo, material);
    mesh.userData.bodyId = body.id;
    pivot.add(mesh);
    const node: BodyNode = { id: body.id, pivot, mesh, pickRadius: 0.7, shown: 1, disposed: false };
    attachRaycast(node);

    const file = MAP_FILE[body.id];
    if (file) {
      loader.load(
        `/textures/${file}`,
        (texture) => {
          if (node.disposed) {
            texture.dispose();
            return;
          }
          applyMap(node, texture, renderer);
        },
        undefined,
        () => {
          if (node.disposed) return;
          applyMap(node, proceduralTexture(body.id), renderer);
        },
      );
    } else {
      applyMap(node, proceduralTexture(body.id), renderer);
    }

    if (body.id === "earth") {
      const clouds = new THREE.Mesh(
        sphereGeo,
        new THREE.MeshStandardMaterial({
          color: 0xffffff,
          transparent: true,
          opacity: 0,
          depthWrite: false,
          roughness: 0.95,
          metalness: 0,
        }),
      );
      clouds.scale.setScalar(1.012);
      clouds.raycast = () => undefined;
      clouds.renderOrder = 2;
      mesh.add(clouds);
      node.clouds = clouds;
      loader.load(
        "/textures/earth_clouds.jpg",
        (texture) => {
          if (node.disposed) {
            texture.dispose();
            return;
          }
          prepareTexture(texture, renderer, THREE.NoColorSpace);
          const cloudMat = clouds.material as THREE.MeshStandardMaterial;
          cloudMat.alphaMap = texture;
          cloudMat.opacity = 0.88;
          cloudMat.needsUpdate = true;
        },
      );
    }

    if (body.id === "saturn") {
      const rings = new THREE.Mesh(
        radialRingGeometry(1.15, 2.35),
        new THREE.MeshStandardMaterial({
          color: 0xffffff,
          side: THREE.DoubleSide,
          transparent: true,
          alphaTest: 0.05,
          roughness: 0.62,
          metalness: 0,
          depthWrite: true,
        }),
      );
      rings.rotation.x = Math.PI / 2;
      rings.raycast = () => undefined;
      rings.renderOrder = 2;
      pivot.add(rings);
      node.rings = rings;
      loader.load("/textures/saturn_ring.png", (texture) => {
        if (node.disposed) {
          texture.dispose();
          return;
        }
        prepareTexture(texture, renderer, THREE.SRGBColorSpace);
        texture.wrapS = THREE.ClampToEdgeWrapping;
        const ringMat = rings.material as THREE.MeshStandardMaterial;
        ringMat.map = texture;
        ringMat.needsUpdate = true;
      });
    }

    if (body.id === "sun") {
      const canvas = document.createElement("canvas");
      canvas.width = 256;
      canvas.height = 256;
      const ctx = canvas.getContext("2d");
      if (ctx) {
        const grd = ctx.createRadialGradient(128, 128, 20, 128, 128, 128);
        grd.addColorStop(0, "rgba(255, 246, 224, 0.42)");
        grd.addColorStop(0.62, "rgba(255, 214, 150, 0.2)");
        grd.addColorStop(0.82, "rgba(255, 170, 70, 0.1)");
        grd.addColorStop(1, "rgba(255, 150, 40, 0)");
        ctx.fillStyle = grd;
        ctx.fillRect(0, 0, 256, 256);
      }
      const glowTex = new THREE.CanvasTexture(canvas);
      glowTex.colorSpace = THREE.SRGBColorSpace;
      const glow = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: glowTex,
          transparent: true,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          toneMapped: false,
          opacity: 0.95,
        }),
      );
      // Sprite height is 2.45 local units. The mesh scale is the solar radius,
      // so the halo ends about 1.22 radii out and stays clear of Mercury.
      glow.scale.set(2.45, 2.45, 1);
      glow.raycast = () => undefined;
      glow.renderOrder = 1;
      mesh.add(glow);
      node.glow = glow;
    }

    nodes.push(node);
  }
  return nodes;
}

export function setRingRadii(node: BodyNode, inner: number, outer: number): void {
  const rings = node.rings;
  if (!rings) return;
  const prev = rings.userData as { inner?: number; outer?: number };
  if (prev.inner === inner && prev.outer === outer) return;
  const next = radialRingGeometry(inner, outer);
  rings.geometry.dispose();
  rings.geometry = next;
  rings.userData = { inner, outer };
}

export function spinBody(node: BodyNode, t: number): void {
  const period = SPIN_S[node.id] ?? 1.4 * 86400;
  const turn = ((t / period) % 1 + 1) % 1;
  const material = node.mesh.material as THREE.MeshBasicMaterial | THREE.MeshStandardMaterial;
  if (material.map) material.map.offset.x = turn;
  if (node.clouds) {
    const clouds = node.clouds.material as THREE.MeshStandardMaterial;
    if (clouds.alphaMap) clouds.alphaMap.offset.x = ((t / (period * 0.82)) % 1 + 1) % 1;
  }
}

export function disposeBodies(nodes: BodyNode[]): void {
  const geos = new Set<THREE.BufferGeometry>();
  const textures = new Set<THREE.Texture>();
  const materials = new Set<THREE.Material>();
  for (const node of nodes) {
    node.disposed = true;
    node.pivot.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.geometry) geos.add(mesh.geometry);
      const listed = mesh.material;
      const mats = Array.isArray(listed) ? listed : listed ? [listed] : [];
      for (const mat of mats) {
        materials.add(mat);
        const textured = mat as THREE.MeshStandardMaterial;
        if (textured.map) textures.add(textured.map);
        if (textured.alphaMap) textures.add(textured.alphaMap);
      }
    });
  }
  for (const geo of geos) geo.dispose();
  for (const texture of textures) texture.dispose();
  for (const mat of materials) mat.dispose();
}
