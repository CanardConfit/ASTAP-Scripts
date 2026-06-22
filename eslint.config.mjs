import eslint from "@eslint/js";
import typescriptEslint from "@typescript-eslint/eslint-plugin";
import typescriptParser from "@typescript-eslint/parser";
import { defineConfig, globalIgnores } from "eslint/config";
import prettierConfig from "eslint-config-prettier";
import prettierPlugin from "eslint-plugin-prettier";
import globals from "globals";

const typescriptFiles = ["src/**/*.ts"];

export default defineConfig([
  globalIgnores(["dist/**", "node_modules/**"]),
  {
    ...eslint.configs.recommended,
    files: typescriptFiles,
  },
  ...typescriptEslint.configs["flat/recommended"].map((config) => ({
    ...config,
    files: typescriptFiles,
  })),
  {
    files: typescriptFiles,
    languageOptions: {
      parser: typescriptParser,
      parserOptions: {
        project: "./tsconfig.json",
        tsconfigRootDir: import.meta.dirname,
      },
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    plugins: {
      prettier: prettierPlugin,
    },
    rules: {
      ...prettierConfig.rules,
      "no-multiple-empty-lines": "error",
      "prettier/prettier": "error",
    },
  },
]);
