import { createApp } from "vue";
import { createPinia } from "pinia";
import App from "./App.vue";
import { router, setSetupRequired } from "./router/index.js";
import { PublicApiClient } from "./lib/api";
import { setUnauthorizedHandler } from "./stores/auth";
import "./styles/base.css";

// A 401 on any authenticated request clears the session and returns to login.
setUnauthorizedHandler(() => {
  void router.push({ name: "login" });
});

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
