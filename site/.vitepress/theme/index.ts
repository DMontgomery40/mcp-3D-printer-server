import DefaultTheme from 'vitepress/theme'
import type { Theme } from 'vitepress'
import '@fontsource-variable/archivo/wdth.css'
import '@fontsource-variable/jetbrains-mono/index.css'
import './style.css'
import HomeHero from './components/HomeHero.vue'
import HomeSetupSteps from './components/HomeSetupSteps.vue'
import HomePrintPath from './components/HomePrintPath.vue'
import HomeTools from './components/HomeTools.vue'
import HomePrinters from './components/HomePrinters.vue'
import HomePrompts from './components/HomePrompts.vue'

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component('HomeHero', HomeHero)
    app.component('HomeSetupSteps', HomeSetupSteps)
    app.component('HomePrintPath', HomePrintPath)
    app.component('HomeTools', HomeTools)
    app.component('HomePrinters', HomePrinters)
    app.component('HomePrompts', HomePrompts)
  },
} satisfies Theme
