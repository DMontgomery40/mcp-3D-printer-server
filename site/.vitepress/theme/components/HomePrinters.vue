<script setup lang="ts">
import { withBase } from 'vitepress'
import data from '../../generated/home.json'

// Generated from the backend table in docs/SETUP.md by site/scripts/sync-docs.mjs.
const backends = data.printers.backends
const bambuModels = data.printers.bambuModels
const tiers = [
  { key: 'tested', label: 'Most tested' },
  { key: 'community', label: 'Community-reported' },
  { key: 'unverified', label: 'Unverified' },
].filter((tier) => backends.some((backend) => backend.tier === tier.key))
</script>

<template>
  <section class="home-section home-printers" aria-labelledby="printers-heading">
    <div class="home-wrap home-printers__grid">
      <div>
        <h2 id="printers-heading" class="home-h2">Works with the printer you have</h2>
        <p class="home-lede">
          Set <code>PRINTER_TYPE</code> for your printer system. Every printer tool also takes a per-call
          <code>type</code> and <code>host</code>, so one server can reach more than one printer.
        </p>
        <ul class="home-printers__legend" aria-label="Testing evidence">
          <li v-for="tier in tiers" :key="tier.key" :class="`tier-${tier.key}`">
            <i aria-hidden="true"></i>{{ tier.label }}
          </li>
        </ul>
        <ul class="home-printers__list" aria-label="Supported printer systems">
          <li v-for="backend in backends" :key="backend.code" :class="`tier-${backend.tier}`">
            <span class="home-printers__plate">{{ backend.label }}</span>
            <span class="home-printers__meta">
              <code>{{ backend.code }}</code>
              <span class="home-printers__tier">{{ backend.tierLabel }}</span>
            </span>
            <span class="home-printers__note">{{ backend.note }}</span>
          </li>
        </ul>
        <p class="home-printers__models">
          <span>Bambu Lab models</span>
          <span v-for="model in bambuModels" :key="model.code" class="home-printers__model">{{ model.label }}</span>
        </p>
        <p class="home-printers__more">
          <a class="home-link" :href="withBase('/guide/setup#printer-backend-setup')">See what each backend needs</a>
        </p>
      </div>
      <div class="home-printers__guard">
        <h3>It stops instead of guessing</h3>
        <ul>
          <li>
            A person confirms every print start and heat-up, on every printer, through MCP elicitation. Clients that
            can't ask are refused. Heater-off and cancel are never held up.
          </li>
          <li>
            The exact G-code is inspected first. Every heater target has to fit hardware and material ceilings that
            only the server's configuration can raise.
          </li>
          <li>
            Bambu print tools need your exact model, from <code>BAMBU_MODEL</code> or <code>bambu_model</code>.
            Without it they ask or stop, because G-code for the wrong model can damage hardware.
          </li>
          <li>
            Slicer, bridge, and Blender programs come from server configuration. A per-call path is refused unless
            you opt in.
          </li>
          <li>
            A successful response means the command was sent. Check status and the printer itself.
          </li>
        </ul>
        <p class="home-printers__guard-links">
          <a class="home-link" :href="withBase('/guide/setup#print-and-heating-safety')">How the safety gate works</a>
          <a class="home-link" :href="withBase('/reference/limitations')">Read the limitations</a>
        </p>
      </div>
    </div>
  </section>
</template>

<style scoped>
.home-printers__grid {
  display: grid;
  grid-template-columns: minmax(0, 7fr) minmax(0, 5fr);
  gap: 64px;
  align-items: start;
}

.home-lede code,
.home-printers__guard code {
  font-family: var(--vp-font-family-mono);
  font-size: 0.86em;
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--vp-code-bg);
  color: var(--vp-c-text-1);
  white-space: nowrap;
}

.home-printers__legend {
  list-style: none;
  margin: 32px 0 0;
  padding: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 8px 22px;
  font-size: 0.875rem;
  color: var(--vp-c-text-2);
}

.home-printers__legend li {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.home-printers__legend i {
  width: 18px;
  height: 12px;
  border-radius: 3px;
  border: 1.5px solid var(--vp-c-text-1);
  background: var(--bp-raised);
}

.home-printers__legend .tier-tested i {
  border-color: var(--vp-c-brand-1);
  box-shadow: inset 0 -3px 0 var(--vp-c-brand-1);
}

.home-printers__legend .tier-unverified i {
  border-style: dashed;
  border-color: var(--vp-c-text-3);
  background: transparent;
}

.home-printers__list {
  list-style: none;
  margin: 18px 0 0;
  padding: 0;
  border-top: 1px solid var(--bp-line);
}

.home-printers__list li {
  display: grid;
  grid-template-columns: 196px minmax(0, 1fr);
  grid-template-areas:
    'plate meta'
    'plate note';
  column-gap: 20px;
  row-gap: 2px;
  align-items: center;
  padding: 14px 0;
  border-bottom: 1px solid var(--bp-line);
}

/* Styled after the model badge on a printer's front panel. */
.home-printers__plate {
  grid-area: plate;
  justify-self: start;
  padding: 9px 14px;
  border-radius: 8px;
  border: 1.5px solid var(--vp-c-text-1);
  font-size: 1.0625rem;
  font-stretch: 118%;
  font-weight: 760;
  letter-spacing: 0.01em;
  line-height: 1.2;
  color: var(--vp-c-text-1);
  background: var(--bp-raised);
}

.tier-tested .home-printers__plate {
  border-color: var(--vp-c-brand-1);
  box-shadow: inset 0 -3px 0 var(--vp-c-brand-1);
}

.tier-unverified .home-printers__plate {
  border-style: dashed;
  border-color: var(--vp-c-text-3);
  color: var(--vp-c-text-2);
  background: transparent;
}

.home-printers__meta {
  grid-area: meta;
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 12px;
  font-size: 0.875rem;
}

.home-printers__meta code {
  font-family: var(--vp-font-family-mono);
  font-size: 0.8125rem;
  color: var(--vp-c-text-2);
}

.home-printers__tier {
  font-weight: 650;
  color: var(--vp-c-text-1);
}

.tier-tested .home-printers__tier {
  color: var(--vp-c-brand-1);
}

.tier-unverified .home-printers__tier {
  color: var(--vp-c-text-3);
}

.home-printers__note {
  grid-area: note;
  font-size: 0.9375rem;
  line-height: 1.5;
  color: var(--vp-c-text-2);
}

.home-printers__models {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin: 22px 0 0;
  font-size: 0.875rem;
  color: var(--vp-c-text-2);
}

.home-printers__models > span:first-child {
  margin-right: 6px;
  font-weight: 650;
  color: var(--vp-c-text-1);
}

.home-printers__model {
  padding: 3px 9px;
  border-radius: 6px;
  border: 1px solid var(--vp-c-border);
  font-stretch: 112%;
  font-weight: 680;
  color: var(--vp-c-text-1);
  background: var(--bp-raised);
}

.home-printers__more {
  margin: 24px 0 0;
}

.home-printers__guard {
  padding: 28px;
  border-radius: 14px;
  background: var(--bp-panel);
  border: 1px solid var(--bp-line);
}

.home-printers__guard h3 {
  margin: 0 0 16px;
  font-size: 1.1875rem;
  font-stretch: 112%;
  font-weight: 740;
}

.home-printers__guard ul {
  margin: 0 0 20px;
  padding: 0 0 0 18px;
  list-style: disc outside;
  display: grid;
  gap: 12px;
  color: var(--vp-c-text-2);
  line-height: 1.55;
}

.home-printers__guard li::marker {
  color: var(--vp-c-brand-1);
}

.home-printers__guard-links {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 24px;
  margin: 0;
}

@media (max-width: 960px) {
  .home-printers__grid {
    grid-template-columns: minmax(0, 1fr);
    gap: 40px;
  }
}

@media (max-width: 640px) {
  .home-printers__list li {
    grid-template-columns: minmax(0, 1fr);
    grid-template-areas:
      'plate'
      'meta'
      'note';
    row-gap: 8px;
  }

  .home-printers__plate {
    font-size: 1rem;
  }

  .home-printers__guard {
    padding: 22px 18px;
  }
}
</style>
