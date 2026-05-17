import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/.next/**",
      "**/node_modules/**",
      "**/*.html",
      // Playwright writes a bundled HTML report and trace viewer on failure.
      // Linting a vendored bundle turns any red test into a red lint too,
      // which buries the real failure under a thousand errors from code
      // nobody here wrote.
      "**/playwright-report/**",
      "**/test-results/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-console": ["warn", { allow: ["warn", "error"] }],
    },
  },
  {
    // Build and tooling scripts run in Node, not the browser. Placed after the
    // general rules deliberately — flat config is order-dependent, and an
    // override before them is silently overridden by them.
    files: ["**/scripts/**/*.mjs", "**/*.config.{js,mjs,ts}"],
    languageOptions: {
      globals: { console: "readonly", process: "readonly" },
    },
    // A command-line tool's output is the point of it.
    rules: { "no-console": "off" },
  },
  prettier,
);
