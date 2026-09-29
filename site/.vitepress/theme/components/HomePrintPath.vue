<script setup lang="ts">
import { withBase } from 'vitepress'
</script>

<template>
  <section class="home-section print-path" aria-labelledby="print-path-heading">
    <div class="home-wrap">
      <h2 id="print-path-heading" class="home-h2">From slicer to printer</h2>
      <p class="home-lede">
        The most predictable path starts from a file you've sliced and previewed yourself. Your agent can also
        run your slicer's command line, check the result, and send it to whichever printer you choose.
      </p>
      <ol class="print-path__steps">
        <li>
          <h3>Slice it</h3>
          <p>
            Export G-code from PrusaSlicer, OrcaSlicer, or Cura, or a sliced project from FULU
            OrcaSlicer-bambulab or Bambu Studio. Or let <code>slice_stl</code> run the slicer for you.
          </p>
        </li>
        <li>
          <h3>Check the temperatures</h3>
          <p>
            <code>confirm_temperatures</code> reads the extruder and bed targets from the G-code, so they can be
            compared with the filament before anything is sent.
          </p>
        </li>
        <li>
          <h3>Send it</h3>
          <p>
            <code>upload_gcode</code> sends G-code to OctoPrint, Moonraker, PrusaLink, and the other HTTP backends.
            Bambu Lab projects go through <code>print_3mf</code> over FTPS and MQTT.
          </p>
        </li>
        <li>
          <h3>Start and check</h3>
          <p>
            Start it with the upload or <code>start_print</code>. A sent command isn't a finished print, so check
            status afterward; what status reports depends on the backend.
          </p>
        </li>
      </ol>
      <p class="print-path__more">
        <a class="home-link" :href="withBase('/guide/slicing')">Read the slicing guide</a>
        <a class="home-link" :href="withBase('/guide/setup#choose-your-printer-backend')">Compare printer backends</a>
        <a class="home-link" :href="withBase('/reference/bambu-tools')">Print on Bambu Lab</a>
      </p>
    </div>
  </section>
</template>

<style scoped>
.print-path__steps {
  list-style: none;
  counter-reset: step;
  margin: 48px 0 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  position: relative;
}

/* The rail: a strand of filament running through the steps. */
.print-path__steps::before {
  content: '';
  position: absolute;
  top: 17px;
  left: 18px;
  right: 18px;
  height: 3px;
  border-radius: 2px;
  background: linear-gradient(90deg, var(--tp-outer), var(--tp-inner) 45%, var(--vp-c-brand-1));
  opacity: 0.85;
}

.print-path__steps li {
  counter-increment: step;
  position: relative;
  padding: 56px 28px 0 0;
}

.print-path__steps li::before {
  content: counter(step);
  position: absolute;
  top: 0;
  left: 0;
  width: 37px;
  height: 37px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  background: var(--vp-c-bg);
  border: 2px solid var(--vp-c-text-1);
  color: var(--vp-c-text-1);
  font-weight: 750;
  font-size: 15px;
  font-variant-numeric: tabular-nums;
}

.print-path__steps h3 {
  margin: 0 0 8px;
  font-size: 1.1875rem;
  line-height: 1.3;
  font-stretch: 110%;
  font-weight: 720;
}

.print-path__steps p {
  margin: 0;
  color: var(--vp-c-text-2);
  line-height: 1.6;
}

.print-path__steps code {
  font-family: var(--vp-font-family-mono);
  font-size: 0.88em;
}

.print-path__more {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 28px;
  margin: 44px 0 0;
}

@media (max-width: 960px) {
  .print-path__steps {
    grid-template-columns: minmax(0, 1fr);
    gap: 28px;
  }

  .print-path__steps::before {
    top: 18px;
    bottom: 18px;
    left: 17px;
    right: auto;
    width: 3px;
    height: auto;
    background: linear-gradient(180deg, var(--tp-outer), var(--tp-inner) 45%, var(--vp-c-brand-1));
  }

  .print-path__steps li {
    padding: 4px 0 0 60px;
  }
}
</style>
