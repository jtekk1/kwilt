const js = require("@eslint/js");

module.exports = [
  js.configs.recommended,
  {
    files: ["contents/code/main.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "script",
      globals: {
        // Injected by KWin's QJSEngine — not standard JS.
        workspace: "readonly",
        KWin: "readonly",
        print: "readonly",
        registerShortcut: "readonly",
      },
    },
  },
];
