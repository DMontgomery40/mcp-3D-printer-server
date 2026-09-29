<script setup lang="ts">
// A slicer-style preview of one layer of a small charm tag, drawn once when
// the page loads. The geometry is shared with the social card.
import { infill, infillClip, walls } from '../toolpath.mjs'
</script>

<template>
  <figure class="preview">
    <div class="preview__bar" aria-hidden="true">
      <span class="preview__file">charm_tag.gcode</span>
      <span class="preview__layer">Layer 1 of 48</span>
    </div>
    <div class="preview__stage">
      <svg
        class="preview__svg"
        viewBox="0 0 400 280"
        role="img"
        aria-labelledby="preview-title"
      >
        <title id="preview-title">
          Slicer preview of one layer of a charm tag: an outer wall, two inner walls, and diagonal sparse infill.
        </title>
        <defs>
          <pattern id="preview-grid" width="20" height="20" patternUnits="userSpaceOnUse">
            <path d="M20 0H0V20" fill="none" stroke="var(--tp-grid)" stroke-width="1" />
          </pattern>
          <clipPath id="preview-infill">
            <path :d="infillClip" clip-rule="evenodd" />
          </clipPath>
        </defs>
        <rect width="400" height="280" fill="var(--tp-plate)" />
        <rect width="400" height="280" fill="url(#preview-grid)" />
        <g clip-path="url(#preview-infill)" stroke="var(--tp-infill)" stroke-width="3.4">
          <path
            v-for="(line, index) in infill"
            :key="index"
            class="tp"
            :d="line.d"
            pathLength="1"
            :style="{ '--delay': `${line.delay}s`, '--duration': '0.35s' }"
          />
        </g>
        <g v-for="group in walls" :key="group.key" :stroke="group.color" stroke-width="4.4">
          <path
            v-for="(d, index) in group.paths"
            :key="index"
            class="tp"
            :d="d"
            pathLength="1"
            :style="{ '--delay': `${group.delay}s`, '--duration': `${group.duration}s` }"
          />
        </g>
      </svg>
      <div class="preview__slider" aria-hidden="true">
        <span class="preview__track"></span>
        <span class="preview__handle"></span>
      </div>
    </div>
    <figcaption class="preview__legend">
      <span><i style="--swatch: var(--tp-outer)"></i>Outer wall</span>
      <span><i style="--swatch: var(--tp-inner)"></i>Inner wall</span>
      <span><i style="--swatch: var(--tp-infill)"></i>Sparse infill</span>
    </figcaption>
  </figure>
</template>

<style scoped>
.preview {
  margin: 0;
  border-radius: 16px;
  background: #11171d;
  border: 1px solid #262f39;
  box-shadow: 0 30px 60px -30px rgba(10, 20, 30, 0.45);
  overflow: hidden;
  color: #aab4c0;
}

.preview__bar {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  padding: 12px 16px;
  font-size: 13px;
  border-bottom: 1px solid #232c36;
}

.preview__file {
  font-family: var(--vp-font-family-mono);
  color: #d9dfe6;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.preview__layer {
  flex: none;
  font-variant-numeric: tabular-nums;
}

.preview__stage {
  position: relative;
  display: flex;
}

.preview__svg {
  display: block;
  width: 100%;
  height: auto;
}

.preview__slider {
  position: relative;
  flex: none;
  width: 28px;
  background: #151c23;
  border-left: 1px solid #232c36;
}

.preview__track {
  position: absolute;
  top: 16px;
  bottom: 16px;
  left: 50%;
  width: 3px;
  margin-left: -1.5px;
  border-radius: 2px;
  background: #2c3642;
}

.preview__handle {
  position: absolute;
  bottom: 12px;
  left: 50%;
  width: 16px;
  height: 10px;
  margin-left: -8px;
  border-radius: 3px;
  background: var(--tp-outer);
}

.preview__legend {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 20px;
  padding: 12px 16px;
  font-size: 13px;
  border-top: 1px solid #232c36;
}

.preview__legend span {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.preview__legend i {
  width: 16px;
  height: 4px;
  border-radius: 2px;
  background: var(--swatch);
}

.tp {
  fill: none;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-dasharray: 1;
  animation: draw var(--duration) cubic-bezier(0.45, 0, 0.3, 1) var(--delay) both;
}

@keyframes draw {
  0% {
    stroke-dashoffset: 1;
    opacity: 0;
  }
  1% {
    opacity: 1;
  }
  100% {
    stroke-dashoffset: 0;
    opacity: 1;
  }
}

@media (prefers-reduced-motion: reduce) {
  .tp {
    animation: none;
    stroke-dashoffset: 0;
    opacity: 1;
  }
}
</style>
