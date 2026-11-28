# Credits

ACS draws the solar system with equirectangular maps bundled in `apps/web/public/textures/`. Nothing is loaded from a third-party host at runtime. Mean radii in `packages/astro` are the volumetric means published by NASA/JPL ([Planetary Physical Parameters](https://ssd.jpl.nasa.gov/planets/phys_par.html) and the NASA planetary fact sheets). Saturn's rings span the D ring inner edge (66,900 km) to the A ring outer edge (136,780 km) from the [NASA Saturnian Rings Fact Sheet](https://nssdc.gsfc.nasa.gov/planetary/factsheet/satringfact.html).

Display scale is a rendering transform. Orbits, ships, and parking burns stay in kilometers.

## Solar System Scope (CC BY 4.0)

Sun, Mercury, Venus (atmosphere), Earth day map, Earth clouds, Mars, Jupiter, Saturn, Uranus, Neptune, the Moon, and Saturn's ring alpha are from the [Solar System Scope texture library](https://www.solarsystemscope.com/textures/) by Solar System Scope / INOVE.

Those maps are based on NASA imagery. Colors are adjusted, and unmapped areas in the published maps were filled by the publisher. They are illustrative surfaces, not live spacecraft frames.

License: [Creative Commons Attribution 4.0 International](https://creativecommons.org/licenses/by/4.0/).

Changes made here: the 2048×1024 JPEGs were recompressed at quality 82 so the repository stays small. They were not reprojected, recolored, or cropped. `saturn_ring.png` is the published 2k ring file, unmodified.

## NASA and USGS (public domain)

The following maps are public-domain products of NASA and the USGS Astrogeology Science Center (or, for Deimos, a NASA PDS archive the author placed in the public domain). Please credit the authors. Public domain is not an endorsement.

Browse JPEGs were recompressed at quality 82. Deimos was resized from 7200×3600 to 2048×1024. No other reprojection.

| Body | Product | Source |
| --- | --- | --- |
| Io | Galileo SSI / Voyager color merged global mosaic, 1 km | [USGS](https://astrogeology.usgs.gov/search/map/io_galileo_ssi_voyager_color_merged_global_mosaic_1km) |
| Europa | Voyager / Galileo SSI global mosaic, 500 m | [USGS](https://astrogeology.usgs.gov/search/map/europa_voyager_galileo_ssi_global_mosaic_500m) |
| Ganymede | Voyager / Galileo SSI color global mosaic, 1.4 km | [USGS](https://astrogeology.usgs.gov/search/map/ganymede_voyager_galileo_ssi_color_global_mosaic_1_4km) |
| Callisto | Galileo / Voyager global mosaic, 1 km | [USGS](https://astrogeology.usgs.gov/search/map/callisto_galileo_voyager_global_mosaic_1km) |
| Titan | Cassini ISS global mosaic, 4 km (PIA19658) | [USGS](https://astrogeology.usgs.gov/search/map/titan_cassini_iss_global_mosaic_4005m) |
| Enceladus | Cassini ISS global mosaic, 100 m | [USGS](https://astrogeology.usgs.gov/search/map/enceladus_cassini_iss_global_mosaic_hpf_110m) |
| Rhea | Cassini / Voyager global mosaic, 417 m | [USGS](https://astrogeology.usgs.gov/search/map/rhea_cassini_voyager_global_mosaic_417m) |
| Iapetus | Cassini / Voyager global mosaic, 803 m | [USGS](https://astrogeology.usgs.gov/search/map/iapetus_cassini_voyager_global_mosaic_803m) |
| Triton | Voyager 2 global color mosaic, 600 m | [USGS](https://astrogeology.usgs.gov/search/map/triton_voyager_2_global_color_mosaic_600m) |
| Phobos | Viking global mosaic, DLR control | [USGS](https://astrogeology.usgs.gov/search/map/phobos_viking_global_mosaic_5m) |
| Deimos | Stooke cylindrical Viking / MRO mosaic | [PDS map guide](https://sbnarchive.psi.edu/pds4/non_mission/small_bodies.stooke.maps/miscellaneous/00_map_guide.html#deimos) |
| Ceres | Dawn FC global mosaic, 400 m | [USGS](https://astrogeology.usgs.gov/search/map/ceres_dawn_fc_global_mosaic_400m) |
| Vesta | Dawn FC HAMO global mosaic, 60 m | [USGS](https://astrogeology.usgs.gov/search/map/vesta_dawn_fc_hamo_global_mosaic_60m) |
| Pluto | New Horizons LORRI / MVIC global mosaic, 300 m | [USGS](https://astrogeology.usgs.gov/search/map/pluto_new_horizons_lorri_mvic_global_mosaic_300m) |

Notes on those files:

- Europa, Ganymede, Callisto, Ceres, and Vesta still have small unmapped polar gaps from the browse JPEG. They are dark caps, not invented terrain.
- Triton and Pluto leave large regions unobserved (Triton's north, Pluto's far south). Those pure-black gaps were filled by growing the neighboring observed pixels outward, with a little brightness variation, so a sphere does not show a black hemisphere. That fill is not spacecraft imagery.
- Enceladus's mosaic is a high-pass product centered on mid-gray. A contrast stretch maps it onto a brighter ice range so the relief reads. It is not a natural-color albedo.
- Titan's file is the grayscale surface mosaic. The observer tints it warm at draw time so the haze color is closer to what you see from space. The file itself is unchanged apart from JPEG compression.
- Several of these mosaics are enhanced color or single-band, not natural RGB. Longitude of the prime meridian is whatever the publisher used.

Deimos credit, as requested by the archive: Stooke, P., Stooke Small Bodies Maps. NASA Planetary Data System. The map guide states the maps are public domain and should be credited.

## No published global map

Pallas, Psyche, Titania, and Oberon have no complete equirectangular map in this set. They use a procedural rocky texture generated in the browser (noise and craters). Psyche's palette is metallic; Titania and Oberon are icy gray. These are not photographs.
