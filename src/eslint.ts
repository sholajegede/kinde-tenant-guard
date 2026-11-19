import type { ESLint, Linter, Rule } from "eslint";
import { createUnguardedChecker, UNGUARDED_MESSAGES, type UnguardedOptions } from "./unguarded.js";

export type NoUnguardedDbOptions = UnguardedOptions;

const rule: Rule.RuleModule = {
  meta: {
    type: "problem",
    docs: {
      description: "Reach tenant data through kinde-tenant-guard, not the raw database client.",
      url: "https://github.com/sholajegede/kinde-tenant-guard#lint-for-database-access-outside-the-guard",
    },
    schema: [
      {
        type: "object",
        properties: {
          clients: { type: "array", items: { type: "string" } },
          convexContexts: { type: "array", items: { type: "string" } },
          allowIn: { type: "array", items: { type: "string" } },
        },
        additionalProperties: false,
      },
    ],
    messages: { ...UNGUARDED_MESSAGES },
  },
  create(context) {
    const check = createUnguardedChecker((context.options[0] ?? {}) as NoUnguardedDbOptions);
    const visit = (node: Rule.Node) => {
      const finding = check(node, context.sourceCode.getAncestors(node));
      if (finding) context.report({ node, messageId: finding.messageId, data: { name: finding.name } });
    };
    return { MemberExpression: visit, VariableDeclarator: visit };
  },
};

const plugin: ESLint.Plugin & { configs: Record<string, Linter.Config> } = {
  meta: { name: "kinde-tenant-guard" },
  rules: { "no-unguarded-db": rule },
  configs: {},
};

/** Turns on no-unguarded-db as an error. Spread it into eslint.config.js. */
plugin.configs.recommended = {
  plugins: { "kinde-tenant-guard": plugin },
  rules: { "kinde-tenant-guard/no-unguarded-db": "error" },
};

export const noUnguardedDb = rule;
export default plugin;
