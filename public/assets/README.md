# Local production assets

Place production GLB files at these exact same-origin paths:

- `weapons/ak74m_fps.glb`
- `zombies/zombie_basic.glb`
- `environment/environment.glb`

Put any external image files referenced by the GLBs in `textures/`. Binary GLBs
with embedded textures are also supported. Do not use remote texture or model URLs.

`zombie_basic.glb` is “Zombie (Rigged & Animated)” by Aiden Studios,
licensed under CC BY 4.0; attribution metadata is also embedded in the GLB.

The game automatically tries these files at startup. Missing or invalid files keep
the existing procedural rifle, zombies, and environment active.
