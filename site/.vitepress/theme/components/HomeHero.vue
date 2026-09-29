<script setup lang="ts">
import { ref } from 'vue'
import { withBase } from 'vitepress'
import HomePreview from './HomePreview.vue'

const command = 'npx -y mcp-3d-printer-server'
const copied = ref(false)
let timer: ReturnType<typeof setTimeout> | undefined

async function copyCommand() {
  try {
    await navigator.clipboard.writeText(command)
    copied.value = true
    clearTimeout(timer)
    timer = setTimeout(() => (copied.value = false), 2000)
  } catch {
    copied.value = false
  }
}
</script>

<template>
  <section class="hero" aria-labelledby="hero-title">
    <div class="home-wrap hero__grid">
      <div class="hero__copy">
        <h1 id="hero-title" class="hero__title">Print from a conversation.</h1>
        <p class="hero__lede">
          mcp-3d-printer-server connects Claude, Codex, and other MCP clients to the printers you already
          run: OctoPrint, Klipper, Duet, Repetier, Bambu Lab, Prusa, and Creality. Send your agent a link, a
          photo, or a message, and it can adapt the model, slice it, and start the print.
        </p>
        <div class="hero__install">
          <code><span class="hero__prompt" aria-hidden="true">$</span> {{ command }}</code>
          <button type="button" class="hero__copy-btn" @click="copyCommand">
            {{ copied ? 'Copied' : 'Copy' }}
          </button>
          <span class="visually-hidden" aria-live="polite">{{ copied ? 'Command copied' : '' }}</span>
        </div>
        <div class="hero__actions">
          <a class="hero__btn hero__btn--primary" href="#setup">Set up with your agent</a>
          <a class="hero__btn" :href="withBase('/guide/')">Read the docs</a>
        </div>
      </div>
      <HomePreview class="hero__preview" />
    </div>
  </section>
</template>

<style scoped>
.hero {
  padding: 72px 0 80px;
}

.hero__grid {
  display: grid;
  grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr);
  gap: 56px;
  align-items: center;
}

/* "conversation." is about 8.1em wide at this width axis; the sizes below keep
   it inside the copy column at every viewport so it never breaks mid-word. */
.hero__title {
  font-size: clamp(2.5rem, 6.4vw - 8px, 4.3rem);
  overflow-wrap: normal;
  word-break: normal;
  hyphens: none;
  line-height: 0.98;
  font-stretch: 125%;
  font-weight: 820;
  letter-spacing: -0.035em;
  margin: 0 0 28px;
  color: var(--vp-c-text-1);
  text-wrap: balance;
}

.hero__lede {
  font-size: 1.1875rem;
  line-height: 1.6;
  color: var(--vp-c-text-2);
  max-width: 50ch;
  margin: 0 0 32px;
}

.hero__install {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 100%;
  padding: 6px 6px 6px 16px;
  border: 1px solid var(--vp-c-border);
  border-radius: 10px;
  background: var(--bp-raised);
  margin-bottom: 28px;
}

.hero__install code {
  font-family: var(--vp-font-family-mono);
  font-size: 15px;
  color: var(--vp-c-text-1);
  white-space: nowrap;
  overflow-x: auto;
  padding-right: 12px;
}

.hero__prompt {
  color: var(--vp-c-text-3);
  user-select: none;
}

.hero__copy-btn {
  flex: none;
  font-size: 13px;
  font-weight: 650;
  padding: 6px 12px;
  border-radius: 7px;
  color: var(--vp-c-text-1);
  background: var(--bp-panel);
  transition: background-color 0.2s;
}

.hero__copy-btn:hover {
  background: var(--bp-line);
}

.hero__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}

.hero__btn {
  display: inline-flex;
  align-items: center;
  min-height: 46px;
  padding: 0 22px;
  border-radius: 10px;
  font-size: 15.5px;
  font-weight: 680;
  font-stretch: 108%;
  color: var(--vp-c-text-1);
  border: 1px solid var(--vp-c-border);
  background: transparent;
  transition: background-color 0.2s, border-color 0.2s;
}

.hero__btn:hover {
  border-color: var(--vp-c-text-3);
}

.hero__btn--primary {
  color: var(--vp-button-brand-text);
  background: var(--vp-button-brand-bg);
  border-color: var(--vp-button-brand-bg);
}

.hero__btn--primary:hover {
  background: var(--vp-button-brand-hover-bg);
  border-color: var(--vp-button-brand-hover-bg);
}

.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}

@media (max-width: 960px) {
  .hero {
    padding: 48px 0 64px;
  }

  .hero__grid {
    grid-template-columns: minmax(0, 1fr);
    gap: 44px;
  }

  .hero__title {
    font-size: clamp(2.2rem, 11vw - 6px, 4.5rem);
  }
}

@media (max-width: 640px) {
  .hero__install {
    display: flex;
  }

  .hero__install code {
    font-size: 14px;
  }

  .hero__btn {
    flex: 1 1 auto;
    justify-content: center;
  }
}
</style>
