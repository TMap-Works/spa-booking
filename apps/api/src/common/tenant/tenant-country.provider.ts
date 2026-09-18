import type { Provider } from '@nestjs/common';

/**
 * Le contrat par lequel un socle transverse apprend le **pays** de
 * l'établissement de la requête en cours (#1028).
 *
 * ## Ce qu'il sert, et pourquoi il ne sert que cela
 *
 * Compléter un numéro de téléphone **national** — « 06 12 34 56 78 » — en E.164.
 * C'est la seule chose pour laquelle le code pays d'un établissement soit lu
 * hors de son module : `e164PhoneSchemaFor(pays)` porte la règle, et il lui faut
 * un pays par défaut que seule la requête connaît.
 *
 * Le contrat ne rend donc **rien d'autre** qu'un code ISO 3166-1 alpha-2, pour
 * la raison qui borne déjà `PublicTenantResolver` à un identifiant : rendre la
 * fiche de l'établissement ferait voyager son nom, son adresse et ses
 * coordonnées jusqu'à un pipe de validation qui n'en a que faire — et la
 * première fois qu'on chercherait où les afficher, ils seraient déjà là.
 *
 * `null` se lit « cet établissement n'a pas saisi son adresse », et c'est un
 * état normal : la contrainte `tenants_address_completeness_check` veut que
 * `address_line1`, `city` et `country_code` soient les trois nuls ou les trois
 * renseignés, si bien qu'un salon fraîchement inscrit n'a pas de pays. Le refus
 * qui s'ensuit — un numéro national irrattachable — est la bonne conduite :
 * deviner l'indicatif enverrait le rappel de quelqu'un à un inconnu.
 *
 * ## Le sens de la dépendance, comme pour `PublicTenantResolver`
 *
 * `common/` **déclare** ce dont il a besoin, un module métier le **remplit** —
 * jamais l'inverse (api-module §3). Aucun `import` ne relie le pipe au module
 * qui le sert : seul le jeton les met en rapport, et c'est ce qui laisse
 * `common/validation` ignorer jusqu'à l'existence de la table `tenants`.
 *
 * ## Ce que l'implémentation doit garantir
 *
 * Que le pays rendu est celui de **la portée de tenant ouverte**, et d'aucune
 * autre : ni un identifiant reçu en paramètre, ni un `where` écrit à la main.
 * C'est ce que donne gratuitement le client Prisma scopé — l'extension borne le
 * modèle racine sur l'identifiant du contexte (`tenant-scope.extension.ts`) —,
 * et c'est la propriété que `appointments-tenant.isolation-spec.ts` exerce : le
 * pays lu est celui du slug de l'URL, jamais celui de l'établissement voisin.
 *
 * Hors portée de tenant, l'implémentation **lève** plutôt que de rendre `null` :
 * une absence silencieuse ferait passer pour « salon sans adresse » ce qui est
 * un défaut de câblage.
 */
export interface TenantCountryProvider {
  /**
   * Le pays de l'établissement courant — ISO 3166-1 alpha-2 en majuscules
   * (« FR », « MG »), ou `null` s'il n'en a pas.
   */
  currentCountryCode(): Promise<string | null>;
}

/**
 * Jeton d'injection du fournisseur. Un `Symbol` plutôt qu'une chaîne, pour la
 * raison de `PUBLIC_TENANT_RESOLVER` : deux modules ne peuvent pas se marcher
 * dessus par homonymie.
 */
export const TENANT_COUNTRY_PROVIDER = Symbol('TENANT_COUNTRY_PROVIDER');

/** Le fournisseur tel qu'un module le déclare — la forme est écrite une fois. */
export type TenantCountryProviderRegistration = Provider<TenantCountryProvider>;
