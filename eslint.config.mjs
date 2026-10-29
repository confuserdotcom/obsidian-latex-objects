import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";

export default defineConfig([
  ...obsidianmd.configs.recommended,
  {
    files: ["main.js"],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
      parserOptions: { projectService: { allowDefaultProject: ["main.js"] } },
    },
    rules: {
      // UI text names keys (]M gU F T), the Vim adapter and Obsidian's own settings: keep their case
      "obsidianmd/ui/sentence-case": ["warn", {
        brands: ["Vim", "Vim Motions", "Settings", "Editor", "Vim key bindings"],
        ignoreRegex: ["[\\]\\[][A-Za-z({]", "\\bg[UuP]\\b", "\\b[FT]\\b"],
      }],
    },
  },
]);
