import { createApp } from "vue";
import { createPinia } from "pinia";
import App from "./App.vue";

/**
 * SPA entry point (llm-quota web). Boots the Vue root with Pinia state and
 * mounts onto `#app`. Phase 6 wires routing, auth and the API client here.
 */
const app = createApp(App);
app.use(createPinia());
app.mount("#app");
