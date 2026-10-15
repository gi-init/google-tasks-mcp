import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = [
  { ignores: [".next/**", "next-env.d.ts", "coverage/**"] },
  ...nextVitals,
  ...nextTs,
  { linterOptions: { reportUnusedDisableDirectives: "error" } },
];

export default eslintConfig;
