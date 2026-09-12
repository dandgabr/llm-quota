import { createApp } from "vue";
import { createPinia } from "pinia";
import App from "./App.vue";
import { router, setSetupRequired } from "./router/index.js";
import { PublicApiClient } from "./lib/api";
import "./styles/base.css";

// Resolve first-run state once before the first navigation so the guard can
// redirect to /setup without a network call in the hot path. Fail-open: if the
// probe fails we assume the instance is already initialized.
new PublicApiClient()
  .setupStatus()
  .then((s) => setSetupRequired(s.required))
  .catch(() => setSetupRequired(false))
  .finally(() => {
    const app = createApp(App);
    app.use(createPinia());
    app.use(router);
    app.mount("#app");
  });
