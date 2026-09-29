<script setup lang="ts">
import { withBase } from 'vitepress'
import data from '../../generated/home.json'

const groups = data.tools
const total = groups.reduce((sum, group) => sum + group.tools.length, 0)
</script>

<template>
  <section class="home-section home-tools" aria-labelledby="tools-heading">
    <div class="home-wrap">
      <h2 id="tools-heading" class="home-h2">What your agent can use</h2>
      <p class="home-lede">
        {{ total }} documented tools. Each name links to its reference entry, with example arguments.
      </p>
      <div class="home-tools__groups">
        <div v-for="group in groups" :key="group.title" class="home-tools__group">
          <h3>
            <a :href="withBase(group.link)">{{ group.title }}</a>
            <span class="home-tools__count">{{ group.tools.length }}</span>
          </h3>
          <ul>
            <li v-for="tool in group.tools" :key="tool.name">
              <a :href="withBase(tool.link)" :title="tool.summary">{{ tool.name }}</a>
            </li>
          </ul>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.home-tools__groups {
  margin-top: 44px;
  border-bottom: 1px solid var(--bp-line);
}

.home-tools__group {
  display: grid;
  grid-template-columns: 220px minmax(0, 1fr);
  gap: 24px;
  padding: 22px 0;
  border-top: 1px solid var(--bp-line);
}

.home-tools__group h3 {
  margin: 0;
  font-size: 1.125rem;
  font-stretch: 110%;
  font-weight: 720;
  display: flex;
  align-items: baseline;
  gap: 10px;
}

.home-tools__group h3 a {
  color: var(--vp-c-text-1);
}

.home-tools__group h3 a:hover {
  color: var(--vp-c-brand-1);
}

.home-tools__count {
  font-size: 0.8125rem;
  font-weight: 600;
  color: var(--vp-c-text-3);
  font-variant-numeric: tabular-nums;
}

.home-tools__group ul {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 6px 22px;
}

.home-tools__group li a {
  font-family: var(--vp-font-family-mono);
  font-size: 14px;
  line-height: 1.9;
  color: var(--vp-c-text-2);
  text-decoration: underline;
  text-decoration-color: transparent;
  text-underline-offset: 4px;
  transition: color 0.15s, text-decoration-color 0.15s;
}

.home-tools__group li a:hover {
  color: var(--vp-c-brand-1);
  text-decoration-color: currentColor;
}

@media (max-width: 760px) {
  .home-tools__group {
    grid-template-columns: minmax(0, 1fr);
    gap: 10px;
  }
}
</style>
