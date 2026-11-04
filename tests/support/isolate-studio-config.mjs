// Tests never read the developer's own BambuStudio.conf: print options resolve from
// Bambu Studio's defaults unless a test points BAMBU_STUDIO_CONFIG at a fixture.
process.env.BAMBU_STUDIO_CONFIG ??= "";
