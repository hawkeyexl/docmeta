// @ts-check
/**
 * ESLint flat config.
 *
 * Type-aware linting is the point: `strictTypeChecked` is what catches the
 * floating promise, the misused `any`, and the comparison that can never be
 * true — none of which a syntax-only rule set can see. It needs type
 * information, supplied here by `projectService`.
 *
 * Three blocks, because the three code areas have genuinely different
 * constraints, not as a matter of taste.
 */
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

/**
 * Two `strictTypeChecked` rules that are wrong for *this* codebase rather than
 * wrong in general, so they are retuned here instead of being silenced at ~80
 * call sites. Applied to `src` and `test` alike.
 */
const houseRules = {
  // docmeta is a reporting CLI: "3 errors in 2 files", "exceeds the 1048576-byte
  // limit", "line 12". Interpolating a `number` is its main idiom, and the
  // conversion is total and unsurprising.
  //
  // Every other flag is restated at `strictTypeChecked`'s value rather than
  // omitted, because ESLint does not merge rule options with the config being
  // extended — it merges them with the *rule's own* defaults, which allow
  // `any`, `boolean`, nullish and RegExp. Passing `{ allowNumber: true }` alone
  // therefore relaxes four more flags silently, and it hid the two genuine
  // `string | undefined` interpolations this repo turned out to have.
  "@typescript-eslint/restrict-template-expressions": [
    "error",
    {
      allowAny: false,
      allowBoolean: false,
      allowNever: false,
      allowNullish: false,
      allowNumber: true,
      allowRegExp: false,
    },
  ],
  // `_name` already means "deliberately unused" throughout this repo — an
  // omit-by-destructuring (`{ sawEmptyString: _drop, ...rest }`) or a parameter
  // an interface requires but the implementation ignores. `tsc`'s
  // `noUnusedLocals`/`noUnusedParameters` honour the same convention, so
  // matching it here keeps one rule instead of two that disagree.
  "@typescript-eslint/no-unused-vars": [
    "error",
    {
      argsIgnorePattern: "^_",
      varsIgnorePattern: "^_",
      caughtErrorsIgnorePattern: "^_",
      destructuredArrayIgnorePattern: "^_",
      ignoreRestSiblings: true,
    },
  ],
};

export default tseslint.config(
  {
    ignores: [
      "dist/",
      "node_modules/",
      "coverage/",
      // A separate private package with its own lockfile and toolchain; it is
      // not covered by this repo's tsconfig and must not be by its lint either.
      "docs/",
      ".doc-detective/",
    ],
  },

  {
    files: ["src/**/*.ts"],
    extends: [tseslint.configs.strictTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: houseRules,
  },

  {
    files: ["test/**/*.ts"],
    extends: [tseslint.configs.strictTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      ...houseRules,
      // Four of the `no-unsafe-*` family, off for tests only.
      //
      // ~47 sites in `test/` do `JSON.parse(res.stdout)` and assert on the
      // result: parsing docmeta's own `--format json` output is how the CLI
      // integration suite checks it. `JSON.parse` returns `any` by contract, so
      // every one of those correct assertions trips this family. Typing each
      // payload would restate `src/`'s own types in the tests, which is how a
      // test stops proving anything about the shipped type.
      //
      // Only four, and the fifth is the point of saying so: with these off,
      // re-enabling `no-unsafe-argument` reports **nothing** in `test/`, because
      // `expect()` takes `unknown` and an `any` reaches almost no typed
      // parameter here. It stays on rather than being listed for symmetry.
      //
      // `src/` keeps all five, which is where they earn their keep: a stray
      // `any` in the product is a bug waiting to ship, and in a test it is an
      // assertion that fails loudly the moment the shape changes.
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
    },
  },

  {
    // Plain JavaScript, and *not* in tsconfig's `include` (`["src", "test"]`),
    // so type-aware linting cannot cover it — `disableTypeChecked` turns those
    // rules off rather than letting them fail on a file with no program.
    files: ["scripts/*.mjs"],
    extends: [js.configs.recommended, tseslint.configs.disableTypeChecked],
    languageOptions: {
      globals: globals.node,
    },
  },
);
