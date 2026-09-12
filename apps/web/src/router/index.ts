/**
 * vue-router configuration for llm-quota.
 *
 * Routes are lazy-loaded. An auth guard redirects unauthenticated users to
 * `/login`; `/admin*` require the matching role. Onboarding adds two public
 * routes (`/setup`, `/invite`) and a first-run redirect handled by the shell.
 */

import { createRouter, createWebHistory } from "vue-router";

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: "/",
      name: "landing",
      component: () => import("../views/LandingView.vue"),
      meta: { public: true, bare: true },
    },
    {
      path: "/login",
      name: "login",
      component: () => import("../views/LoginView.vue"),
      meta: { public: true, bare: true },
    },
    {
      path: "/setup",
      name: "setup",
      component: () => import("../views/SetupWizard.vue"),
      meta: { public: true, bare: true },
    },
    {
      path: "/invite",
      name: "invite",
      component: () => import("../views/InviteWizard.vue"),
      meta: { public: true, bare: true },
    },
    {
      path: "/dashboard",
      name: "dashboard",
      component: () => import("../views/DashboardView.vue"),
    },
    {
      path: "/connections",
      name: "connections",
      component: () => import("../views/ConnectionsView.vue"),
    },
    {
      path: "/history",
      name: "history",
      component: () => import("../views/HistoryView.vue"),
    },
    {
      path: "/admin",
      name: "admin",
      component: () => import("../views/AdminView.vue"),
      meta: { requiresAdmin: true },
    },
    {
      path: "/admin/users",
      name: "admin-users",
      component: () => import("../views/UsersView.vue"),
      meta: { requiresAdmin: true },
    },
    {
      path: "/admin/audit",
      name: "admin-audit",
      component: () => import("../views/AuditView.vue"),
      meta: { requiresSupervisor: true },
    },
    {
      path: "/:pathMatch(.*)*",
      redirect: "/",
    },
  ],
});

/**
 * Auth + onboarding guard. `setupRequired` is injected by the shell (single
 * fetch) so routing never blocks on a network call.
 */
let setupRequired = false;
export function setSetupRequired(value: boolean): void {
  setupRequired = value;
}

router.beforeEach((to) => {
  const token = localStorage.getItem("llm-quota.token");
  // First run: everything funnels to /setup except the invite flow.
  if (setupRequired && to.name !== "setup" && to.name !== "invite") {
    return { name: "setup" };
  }
  if (to.meta.public) {
    // Logged-in users skip landing/login.
    if ((to.name === "login" || to.name === "landing") && token) return { name: "dashboard" };
    return true;
  }
  if (!token) return { name: "login" };
  const role = localStorage.getItem("llm-quota.role");
  if (to.meta.requiresAdmin && role !== "admin") return { name: "dashboard" };
  if (to.meta.requiresSupervisor && role !== "admin" && role !== "supervisor") {
    return { name: "dashboard" };
  }
  return true;
});
