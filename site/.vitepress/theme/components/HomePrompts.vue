<script setup lang="ts">
import { withBase } from 'vitepress'
import data from '../../generated/home.json'

const groups = data.prompts
</script>

<template>
  <section class="home-section home-prompts" aria-labelledby="prompts-heading">
    <div class="home-wrap">
      <h2 id="prompts-heading" class="home-h2">Ask for what you want</h2>
      <p class="home-lede">
        Send a link, a photo, or a message from wherever you are. Your agent works out the steps and checks in
        when a choice matters.
        <a :href="withBase('/guide/examples')">More on what to ask</a>.
      </p>
      <div class="home-prompts__grid">
        <div v-for="group in groups" :key="group.title" class="home-prompts__group">
          <h3>{{ group.title }}</h3>
          <p v-if="group.intro" class="home-prompts__intro">{{ group.intro }}</p>
          <ul>
            <li v-for="prompt in group.prompts" :key="prompt.text">
              <p class="home-prompts__text">“{{ prompt.text }}”</p>
              <p v-if="prompt.context" class="home-prompts__context">{{ prompt.context }}</p>
              <p class="home-prompts__detail">{{ prompt.detail }}</p>
            </li>
          </ul>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.home-prompts__grid {
  margin-top: 48px;
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 40px;
}

.home-prompts__group h3 {
  margin: 0 0 12px;
  padding-bottom: 12px;
  border-bottom: 2px solid var(--vp-c-text-1);
  font-size: 1.0625rem;
  font-stretch: 112%;
  font-weight: 740;
}

.home-prompts__intro {
  margin: 0 0 20px;
  font-size: 0.9375rem;
  line-height: 1.55;
  color: var(--vp-c-text-2);
}

.home-prompts__group ul {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 24px;
}

.home-prompts__group li p {
  margin: 0;
}

.home-prompts__text {
  font-size: 1.125rem;
  line-height: 1.42;
  font-weight: 620;
  color: var(--vp-c-text-1);
  text-indent: -0.42em;
}

.home-prompts__context {
  margin-top: 4px !important;
  font-size: 0.875rem;
  font-style: italic;
  color: var(--vp-c-brand-1);
}

.home-prompts__detail {
  margin-top: 6px !important;
  font-size: 0.9375rem;
  line-height: 1.55;
  color: var(--vp-c-text-2);
}

@media (max-width: 960px) {
  .home-prompts__grid {
    grid-template-columns: minmax(0, 1fr);
    gap: 44px;
  }

  .home-prompts__group {
    max-width: 62ch;
  }
}
</style>
