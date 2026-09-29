<script setup lang="ts">
import { withBase } from 'vitepress'
</script>

<template>
  <ol class="setup-steps">
    <li>
      <strong>Copy the request.</strong>
      It points your agent at the current setup guide and the list of supported printer systems.
    </li>
    <li>
      <strong>Paste it into the agent you want to connect.</strong>
      It uses that harness's own MCP configuration or installer and keeps your existing servers.
    </li>
    <li>
      <strong>Name your printer system.</strong>
      The agent asks only for what that backend needs, such as an API key or a Bambu access code, and keeps
      it out of chat.
    </li>
    <li>
      <strong>Check the result.</strong>
      The agent confirms that the server starts, lists its tools, and reads printer status. It doesn't start a print as a test.
    </li>
  </ol>
  <p class="setup-alt">
    Prefer to do it yourself? Follow the
    <a class="home-link" :href="withBase('/guide/setup')">installation guide</a>, find your
    <a class="home-link" :href="withBase('/guide/setup#printer-backend-setup')">printer's credentials</a>, or
    <a class="home-link" :href="withBase('/guide/setup#running-with-docker')">run it in Docker</a>.
  </p>
</template>

<style scoped>
.setup-steps {
  list-style: none;
  counter-reset: step;
  margin: 0 0 28px;
  padding: 0;
  display: grid;
  gap: 18px;
}

.setup-steps li {
  counter-increment: step;
  position: relative;
  padding-left: 44px;
  line-height: 1.55;
  color: var(--vp-c-text-2);
}

.setup-steps li::before {
  content: counter(step);
  position: absolute;
  left: 0;
  top: -1px;
  width: 28px;
  height: 28px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  border: 1.5px solid var(--vp-c-brand-1);
  color: var(--vp-c-brand-1);
  font-size: 14px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}

.setup-steps strong {
  display: block;
  color: var(--vp-c-text-1);
  font-weight: 680;
  margin-bottom: 2px;
}

.setup-alt {
  margin: 0;
  padding-top: 20px;
  border-top: 1px solid var(--bp-line);
  color: var(--vp-c-text-2);
  line-height: 1.6;
}
</style>
