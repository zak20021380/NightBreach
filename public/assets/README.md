# Local production assets

Place production GLB files at these exact same-origin paths:

- `weapons/ak74m_fps.glb`
- `zombies/zombie.glb`
- `environment/environment.glb`

Put any external image files referenced by the GLBs in `textures/`. Binary GLBs
with embedded textures are also supported. Do not use remote texture or model URLs.

The game automatically tries these files at startup. Missing or invalid files keep
the existing procedural rifle, zombies, and environment active.
