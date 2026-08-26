import type { Rule } from 'eslint';

/**
 * Déclarations du plugin local `tenant`.
 *
 * Les règles elles-mêmes sont en CommonJS : ESLint charge sa configuration
 * avant tout compilateur TypeScript, et un plugin en `.ts` demanderait un
 * chargeur supplémentaire pour deux fichiers. Ce `.d.ts` rend malgré tout le
 * plugin typé pour la suite de tests, qui, elle, est en TypeScript.
 */
declare const tenantPlugin: {
  meta: { name: string; version: string };
  rules: {
    'raw-sql-tenant-filter': Rule.RuleModule;
    'unscoped-prisma-name': Rule.RuleModule;
  };
};

export = tenantPlugin;
