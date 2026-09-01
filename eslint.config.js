// @ts-check
/**
 * Lint for defects, not for style — prettier owns formatting, and every rule
 * here has to earn its place by catching something that could reach a user.
 *
 * The type-checked rules are the point. `no-floating-promises` in particular:
 * this codebase is full of deliberate fire-and-forget calls on the memory path,
 * and the ones that are deliberate say so with `void`. Without this rule there
 * is no way to tell a considered `void` from a forgotten `await`.
 */

import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  { ignores: ["node_modules/", "dist/", "assets/", "*.config.js"] },

  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // The repo already writes `import type` everywhere; tsconfig's
      // verbatimModuleSyntax makes it load-bearing rather than decorative.
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],

      // An unhandled rejection on the turn path kills the session. A deliberate
      // fire-and-forget writes `void promise` and is allowed.
      "@typescript-eslint/no-floating-promises": ["error", { ignoreVoid: true }],

      // `_`-prefixed args are the documented "intentionally unused" convention
      // (interface implementations that ignore a parameter).
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],

      // Provider payloads are genuinely unknown shapes. `unknown` + a narrowing
      // parse is the house pattern; `any` silently disables the parse.
      "@typescript-eslint/no-explicit-any": "error",

      // Too noisy to be useful against JSON from providers, which is `any` by
      // nature until narrowed. The narrowing casts are the documented pattern.
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-unsafe-call": "off",

      // `async` with no `await` is usually an interface being satisfied, which
      // is legitimate and frequent here (InMemory* stores implementing async
      // interfaces synchronously).
      "@typescript-eslint/require-await": "off",

      // Template literals over provider values are how every log line is built.
      "@typescript-eslint/restrict-template-expressions": "off",

      // Every hit is the same deliberate pattern: a value parsed out of an
      // unknown provider payload, coerced defensively before it is logged or
      // spoken — `String(msg["transcript"] ?? "")`. The rule is right that a
      // non-string there stringifies to "[object Object]"; that string is the
      // intended, visible-in-the-log outcome rather than a crash on the turn
      // path. Same reasoning as the no-unsafe-* family above.
      "@typescript-eslint/no-base-to-string": "off",
    },
  },

  {
    // Tests reach into internals and build deliberately malformed payloads.
    files: ["test/**/*.ts", "scripts/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-floating-promises": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },

  prettier,
);
