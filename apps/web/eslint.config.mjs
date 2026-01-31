import tseslint from "typescript-eslint";

export default [
  { ignores: [".next/", "node_modules/", "dist/"] },
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": "warn",
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
];
