// SPDX-FileCopyrightText: 2026 jtekk <jtekk@jtekk.dev>
// SPDX-License-Identifier: GPL-3.0-or-later

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
        readConfig: "readonly",
        callDBus: "readonly",
      },
    },
  },
];
