// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import { FlatCompat } from "@eslint/eslintrc";
import prettier from "eslint-config-prettier";

const compat = new FlatCompat({
  baseDirectory: import.meta.dirname
});

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/build/**",
      "**/.next/**",
      "**/.expo/**",
      "**/coverage/**",
      "**/node_modules/**",
      "**/*.config.js",
      "**/*.config.mjs"
    ]
  },
  js.configs.recommended,
  ...compat.extends("next/core-web-vitals"),
  ...tseslint.configs.recommendedTypeChecked,
  prettier,
  {
    settings: {
      next: {
        rootDir: ["apps/web/", "apps/admin-dashboard/"]
      }
    },
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }
      ],
      "@typescript-eslint/explicit-function-return-type": "off",
      "@typescript-eslint/ban-ts-comment": "error",
      "@next/next/no-html-link-for-pages": "off",
      "no-console": ["warn", { allow: ["warn", "error"] }]
    }
  }
);
