/**
 * vue-router configuration for llm-quota (Phase 6).
 *
 * Routes are lazy-loaded; an auth guard redirects unauthenticated users to
 * `/login`. The `admin` route additionally requires the admin role.
 */

import { createRouter, createWebHistory } from "vue-router";

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: "/login",
      name: "login",
      component: () => import("../views/LoginView.vue"),
      meta: { public: true },
    },
    {
      path: "/",
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
      path: "/:pathMatch(.*)*",
      redirect: "/",
    },
  ],
});

/** Auth guard: public routes need no token; others require it + admin check. */
router.beforeEach((to) => {
  const token = localStorage.getItem("llm-quota.token");
  if (to.meta.public) {
    // Logged-in users visiting /login go to the dashboard.
    if (to.name === "login" && token) return { name: "dashboard" };
    return true;
  }
  if (!token) return { name: "login" };
  if (to.meta.requiresAdmin) {
    const role = localStorage.getItem("llm-quota.role");
    if (role !== "admin") return { name: "dashboard" };
  }
  return true;
});
