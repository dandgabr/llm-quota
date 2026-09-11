import pluginVue from "eslint-plugin-vue";
import rootConfig from "../../eslint.config.js";

export default [
  ...rootConfig,
  {
    ignores: ["dist/**", "node_modules/**"],
  },
  ...pluginVue.configs["flat/recommended"],
  {
    files: ["**/*.{ts,vue}"],
    rules: {
      "@typescript-eslint/consistent-type-imports": "off",
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
];
