export const COMMODITIES = [
  "water_ice",
  "metal_ore",
  "rare_minerals",
  "propellant",
  "refined_metals",
  "life_support",
  "machinery_parts",
  "electronics",
] as const;

export type Commodity = (typeof COMMODITIES)[number];

export const FEE = 0.01;
export const STARTING_CREDITS = 100_000;
export const GRACE_S = 5 * 86400;
export const DEFAULT_SPEED = 60;

/** Tonnes of life support one person consumes per game-day. */
export const LIFE_PER_PERSON_DAY = 0.002;
/** Tonnes of electronics one person consumes per game-day. */
export const ELEC_PER_PERSON_DAY = 0.00008;
/** Machinery-parts upkeep per facility per game-day, scaled by condition later. */
export const PARTS_PER_FACILITY_DAY = 0.04;
export const PARTS_PER_SHIP_DAY = 0.02;

export const WORKERS: Record<string, number> = {
  mine_water: 36,
  mine_metal: 40,
  mine_rare: 28,
  refinery_propellant: 24,
  refinery_metals: 30,
  factory_life_support: 40,
  factory_parts: 44,
  factory_electronics: 48,
  shipyard: 70,
};

/** Richness multiplies mine capacity. Missing or 0 means the deposit is not there. */
export const DEPOSITS: Record<string, Partial<Record<Commodity, number>>> = {
  mercury: { metal_ore: 0.8, rare_minerals: 0.35 },
  venus: { metal_ore: 0.25 },
  earth: { metal_ore: 0.55, water_ice: 0.15 },
  moon: { metal_ore: 0.45, rare_minerals: 0.4, water_ice: 0.2 },
  mars: { metal_ore: 0.5, water_ice: 0.55 },
  phobos: { metal_ore: 0.3, water_ice: 0.15 },
  deimos: { metal_ore: 0.25, water_ice: 0.2 },
  ceres: { water_ice: 0.95, metal_ore: 0.2 },
  vesta: { metal_ore: 0.85, rare_minerals: 0.15 },
  pallas: { water_ice: 0.4, metal_ore: 0.35 },
  psyche: { metal_ore: 1, rare_minerals: 0.7 },
  io: { rare_minerals: 0.75, metal_ore: 0.55 },
  europa: { water_ice: 0.9 },
  ganymede: { water_ice: 0.8, metal_ore: 0.3 },
  callisto: { water_ice: 0.6, metal_ore: 0.2 },
  enceladus: { water_ice: 0.95 },
  rhea: { water_ice: 0.7 },
  titan: { water_ice: 0.65, rare_minerals: 0.45 },
  iapetus: { water_ice: 0.4, metal_ore: 0.2 },
  titania: { water_ice: 0.55, metal_ore: 0.25 },
  oberon: { water_ice: 0.5, metal_ore: 0.3 },
  triton: { water_ice: 0.75, rare_minerals: 0.35 },
  pluto: { water_ice: 0.85, rare_minerals: 0.2 },
};

export interface TransformRecipe {
  out: Commodity;
  /** Tonnes of input per tonne of output. */
  inputs: Partial<Record<Commodity, number>>;
}

export const TRANSFORMS: Record<string, TransformRecipe> = {
  refinery_propellant: { out: "propellant", inputs: { water_ice: 1.6 } },
  refinery_metals: { out: "refined_metals", inputs: { metal_ore: 2 } },
  factory_life_support: { out: "life_support", inputs: { water_ice: 0.8, refined_metals: 0.05 } },
  factory_parts: { out: "machinery_parts", inputs: { refined_metals: 1 } },
  factory_electronics: { out: "electronics", inputs: { rare_minerals: 0.4, refined_metals: 0.4 } },
};

export const MINE_OUTPUT: Record<string, Commodity> = {
  mine_water: "water_ice",
  mine_metal: "metal_ore",
  mine_rare: "rare_minerals",
};

export interface ShipClass {
  dry: number;
  tank: number;
  cargo: number;
  isp: number;
  crew: number;
}

export const SHIP_CLASSES: Record<string, ShipClass> = {
  hauler: { dry: 40, tank: 160, cargo: 50, isp: 900, crew: 6 },
  tanker: { dry: 55, tank: 280, cargo: 20, isp: 900, crew: 5 },
};

export interface BuildRecipe {
  kind: "facility" | "ship" | "warehouse";
  facilityKind?: string;
  shipClass?: string;
  days: number;
  credits: number;
  materials: Partial<Record<Commodity, number>>;
  capacity?: number;
  warehouseTons?: number;
  requiresShipyard?: boolean;
  requiresDeposit?: Commodity;
}

export const BUILD: Record<string, BuildRecipe> = {
  mine_water: { kind: "facility", facilityKind: "mine_water", days: 4, credits: 8000, materials: { refined_metals: 8, machinery_parts: 4 }, capacity: 12, requiresDeposit: "water_ice" },
  mine_metal: { kind: "facility", facilityKind: "mine_metal", days: 4, credits: 9000, materials: { refined_metals: 10, machinery_parts: 4 }, capacity: 14, requiresDeposit: "metal_ore" },
  mine_rare: { kind: "facility", facilityKind: "mine_rare", days: 5, credits: 14000, materials: { refined_metals: 8, machinery_parts: 6, electronics: 1 }, capacity: 4, requiresDeposit: "rare_minerals" },
  refinery_propellant: { kind: "facility", facilityKind: "refinery_propellant", days: 4, credits: 12000, materials: { refined_metals: 12, machinery_parts: 6 }, capacity: 8 },
  refinery_metals: { kind: "facility", facilityKind: "refinery_metals", days: 4, credits: 12000, materials: { refined_metals: 10, machinery_parts: 6 }, capacity: 8 },
  factory_life_support: { kind: "facility", facilityKind: "factory_life_support", days: 5, credits: 15000, materials: { refined_metals: 8, machinery_parts: 6, electronics: 1 }, capacity: 6 },
  factory_parts: { kind: "facility", facilityKind: "factory_parts", days: 5, credits: 16000, materials: { refined_metals: 10, machinery_parts: 4, electronics: 1 }, capacity: 5 },
  factory_electronics: { kind: "facility", facilityKind: "factory_electronics", days: 6, credits: 22000, materials: { refined_metals: 6, machinery_parts: 4, electronics: 2 }, capacity: 1.5 },
  shipyard: { kind: "facility", facilityKind: "shipyard", days: 8, credits: 40000, materials: { refined_metals: 30, machinery_parts: 12, electronics: 4 }, capacity: 1 },
  warehouse_small: { kind: "warehouse", days: 3, credits: 6000, materials: { refined_metals: 12, machinery_parts: 3 }, warehouseTons: 400 },
  hauler: { kind: "ship", shipClass: "hauler", days: 5, credits: 20000, materials: { refined_metals: 25, machinery_parts: 10, electronics: 2 }, requiresShipyard: true },
  tanker: { kind: "ship", shipClass: "tanker", days: 6, credits: 28000, materials: { refined_metals: 30, machinery_parts: 12, electronics: 2 }, requiresShipyard: true },
};

export function isCommodity(value: string): value is Commodity {
  return (COMMODITIES as readonly string[]).includes(value);
}

export function depositOf(bodyId: string, commodity: Commodity): number {
  return DEPOSITS[bodyId]?.[commodity] ?? 0;
}
