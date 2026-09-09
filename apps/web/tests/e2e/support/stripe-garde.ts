/**
 * La garde qui interdit à la suite E2E de toucher l'environnement Stripe live —
 * quatrième critère de #80.
 *
 * ## Ce qui est réellement en jeu
 *
 * Une suite E2E encaisse. Si elle le fait avec une clé live, elle débite de
 * vraies cartes, inscrit de vraies pièces comptables chez le prestataire, et
 * personne ne s'en aperçoit avant le rapprochement. Le risque n'est pas
 * théorique : les clés vivent dans des variables d'environnement, et une
 * variable d'environnement se copie d'un poste à l'autre, d'un secret de dépôt à
 * un autre, sans qu'aucun mécanisme ne signale qu'on a changé de monde.
 *
 * La règle de `payments-stripe` §7 — « les tests utilisent les cartes de test
 * Stripe ; aucun test n'appelle l'environnement live » — n'est donc pas tenue
 * par une consigne mais par ce module, qui **refuse de démarrer** sur une clé
 * live plutôt que de laisser le choix à l'exécutant.
 *
 * ## Refuser, et non sauter
 *
 * Deux situations très différentes, deux conduites opposées :
 *
 * - **aucune clé** — cas normal d'une CI publique sans secret : la scène carte
 *   n'a rien à exercer, elle se saute en le disant. Rien de dangereux n'a été
 *   tenté.
 * - **une clé live** — la suite s'arrête net, et bruyamment. Sauter serait la
 *   pire des réponses : cela laisserait un dépôt configuré pour débiter de
 *   vraies cartes passer au vert en silence, et la prochaine personne à ajouter
 *   une scène de paiement hériterait du piège intact.
 *
 * Le module est pur — aucun import de Playwright, aucun accès direct à
 * `process.env` — pour que ces deux conduites soient éprouvées par le harnais
 * unitaire du dépôt (`apps/web/tests/unit/e2e-stripe-garde.test.ts`,
 * `npm run verify`) plutôt que par un essai en conditions réelles, qui
 * demanderait justement de poser une clé live quelque part.
 */

/**
 * Les cartes d'essai de Stripe, telles que le prestataire les publie.
 *
 * Ces numéros ne sont **pas** des données de carte au sens PCI : ils
 * n'appartiennent à personne, ne sont acceptés que par l'environnement de test
 * du prestataire, et sont documentés publiquement. Ils ne franchissent par
 * ailleurs jamais notre code — ils sont saisis dans l'iframe servie par Stripe
 * (`payments-stripe` §1), et ne font ici que nommer le cas à jouer.
 */
export const CARTES_DE_TEST = {
  /** Autorisation acceptée sans friction. */
  succes: '4242 4242 4242 4242',
  /** Refus générique de l'émetteur — éprouve le message d'échec du comptoir. */
  refusee: '4000 0000 0000 0002',
  /** Authentification forte exigée — hors périmètre du parcours nominal. */
  authentificationRequise: '4000 0025 0000 3155',
} as const;

/** Date d'expiration et CVC admis par toutes les cartes d'essai. */
export const EXPIRATION_DE_TEST = '12 / 34';
export const CVC_DE_TEST = '123';

/** Ce qu'une clé peut être. */
export type ModeCle = 'test' | 'live' | 'absente' | 'invalide';

/**
 * Le mode d'une clé, déduit de son préfixe.
 *
 * Le préfixe est la seule information disponible sans appeler le prestataire, et
 * il suffit : Stripe garantit `sk_test_` / `pk_test_` pour l'environnement de
 * test et `sk_live_` / `pk_live_` pour le live. Une clé restreinte
 * (`rk_test_`, `rk_live_`) suit la même règle et est traitée à l'identique.
 *
 * Tout ce qui ne se range pas est `'invalide'` — jamais `'test'` par défaut.
 * Une valeur qu'on ne sait pas classer n'est pas une valeur qu'on peut déclarer
 * inoffensive.
 */
export function modeCle(valeur: string | undefined): ModeCle {
  const cle = (valeur ?? '').trim();
  if (cle === '') {
    return 'absente';
  }
  if (/^[a-z]{2}_test_/.test(cle)) {
    return 'test';
  }
  if (/^[a-z]{2}_live_/.test(cle)) {
    return 'live';
  }
  return 'invalide';
}

/** Les variables que ce module regarde, et leur mode. */
export interface DiagnosticStripe {
  /**
   * Le mode de chaque variable de `VARIABLES_SURVEILLEES`.
   *
   * **Ce n'est pas une liste d'anomalies.** `modeCle` ne connaît que les
   * préfixes de clé, et `STRIPE_WEBHOOK_SECRET` — préfixé `whsec_`, sans mode —
   * y figure donc comme `'invalide'` dès qu'il est posé, alors que sa valeur est
   * parfaitement normale (non posé, il vaut `'absente'` comme les autres). Qui
   * veut dériver des anomalies de cette carte doit d'abord décider du sort des
   * variables sans mode (#508).
   */
  readonly cles: ReadonlyMap<string, ModeCle>;
  /** Les noms des variables porteuses d'une clé live. */
  readonly live: readonly string[];
  /** `true` quand les deux clés nécessaires à la scène carte sont en mode test. */
  readonly carteJouable: boolean;
}

/** Les variables dont dépend la scène carte du comptoir. */
export const VARIABLES_STRIPE = ['STRIPE_SECRET_KEY', 'STRIPE_PUBLISHABLE_KEY'] as const;

/**
 * Toutes les variables susceptibles de porter une clé Stripe.
 *
 * Plus large que `VARIABLES_STRIPE` **à dessein** : la garde doit voir une clé
 * live posée dans une variable dont la scène carte ne se sert pas. Une clé live
 * présente dans l'environnement d'un poste de test est un défaut de
 * configuration à signaler, qu'elle soit lue ou non — c'est même le cas le plus
 * insidieux, puisque rien ne la révélerait autrement.
 */
export const VARIABLES_SURVEILLEES = [
  ...VARIABLES_STRIPE,
  'STRIPE_WEBHOOK_SECRET',
  'STRIPE_API_KEY',
  'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY',
] as const;

export function inspecterStripe(env: Readonly<Record<string, string | undefined>>): DiagnosticStripe {
  const cles = new Map<string, ModeCle>();
  for (const nom of VARIABLES_SURVEILLEES) {
    cles.set(nom, modeCle(env[nom]));
  }

  const live = [...cles.entries()]
    .filter(([, mode]) => mode === 'live')
    .map(([nom]) => nom);

  // Le secret de webhook n'est pas préfixé `whsec_test_` : il ne porte pas de
  // mode, et n'entre donc pas dans la condition de jouabilité.
  //
  // Il n'existe volontairement **aucun** pendant de `live` pour les valeurs non
  // classables (#508). Un tel champ n'aurait eu aucun lecteur — ni
  // `refuserCleLive`, qui ne s'intéresse qu'au live, ni `motifDeSaut`, qui
  // dérive les siennes de `VARIABLES_STRIPE` seul — et il aurait porté
  // `STRIPE_WEBHOOK_SECRET` dès qu'il est posé, que `modeCle` range en
  // `'invalide'` faute de savoir lire un `whsec_`. Le premier à s'en servir
  // aurait hérité d'un faux positif installé. `cles` porte toute l'information :
  // la liste se reconstruit en une ligne le jour où quelqu'un en a l'usage — et
  // ce jour-là, c'est lui qui tranchera le sort des variables sans mode, en
  // connaissance de cause.
  const carteJouable = VARIABLES_STRIPE.every((nom) => cles.get(nom) === 'test');

  return { cles, live, carteJouable };
}

/** Levée quand l'environnement porte de quoi appeler Stripe en live. */
export class CleLiveInterditeError extends Error {
  public readonly variables: readonly string[];

  public constructor(variables: readonly string[]) {
    super(
      `Clé Stripe live détectée dans ${variables.join(', ')}. ` +
        "La suite E2E encaisse : elle ne s'exécute jamais contre l'environnement live " +
        '(payments-stripe §7). Remplacer ces variables par des clés `sk_test_` / `pk_test_`, ' +
        'ou les retirer de cet environnement.',
    );
    this.name = 'CleLiveInterditeError';
    this.variables = variables;
  }
}

/**
 * La post-condition à poser avant toute scène qui touche au paiement.
 *
 * Lève sur une clé live. Ne lève **pas** sur une clé absente ni sur une valeur
 * non classable : la première est un environnement sans paiement, la seconde
 * n'atteindra de toute façon pas Stripe — l'API refuse d'amorcer sur un préfixe
 * inconnu (`stripe.config.ts`). C'est le live, et lui seul, qui est interdit.
 */
export function refuserCleLive(diagnostic: DiagnosticStripe): void {
  if (diagnostic.live.length > 0) {
    throw new CleLiveInterditeError(diagnostic.live);
  }
}

/**
 * La raison de sauter la scène carte, ou `null` si elle est jouable.
 *
 * Rendue en toutes lettres pour être annotée sur le test : un `skip` sans motif
 * se lit, six mois plus tard, comme un test qu'on a renoncé à écrire.
 */
export function motifDeSaut(diagnostic: DiagnosticStripe): string | null {
  if (diagnostic.carteJouable) {
    return null;
  }

  const manquantes = VARIABLES_STRIPE.filter((nom) => diagnostic.cles.get(nom) === 'absente');
  if (manquantes.length > 0) {
    return (
      `Scène carte sautée : ${manquantes.join(' et ')} non posée(s). ` +
      'Poser des clés de test Stripe (`sk_test_…`, `pk_test_…`) pour la jouer.'
    );
  }

  const invalides = VARIABLES_STRIPE.filter((nom) => diagnostic.cles.get(nom) === 'invalide');
  return (
    `Scène carte sautée : ${invalides.join(' et ')} ne porte(nt) pas un préfixe Stripe reconnu. ` +
    'Attendu `sk_test_…` et `pk_test_…`.'
  );
}

/**
 * Les domaines du prestataire.
 *
 * `stripe.network` autant que `stripe.com` : le premier sert les signaux de
 * fraude que Stripe.js pose (`m.stripe.network`), et l'omettre laisserait la
 * contre-épreuve du chemin espèces passer au vert alors qu'un appel serait
 * bel et bien parti chez le prestataire.
 *
 * L'ancrage de fin est ce qui empêche `stripe.com.exemple.test` de passer pour
 * un domaine de Stripe.
 */
const HOTES_STRIPE = /(^|\.)stripe\.(com|network)$/i;

/** `true` si l'URL part chez Stripe — quel que soit le sous-domaine. */
export function estAppelStripe(url: string): boolean {
  try {
    return HOTES_STRIPE.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * La contre-épreuve du chemin espèces.
 *
 * `payments-stripe` §4 et le commentaire de `counter-payments.controller.ts`
 * affirment tous deux qu'aucun appel au prestataire n'a lieu sur ce chemin. Le
 * test unitaire de l'API le prouve côté serveur, en constatant que le service
 * n'a pas la passerelle parmi ses dépendances ; ceci le prouve **côté
 * navigateur**, en constatant qu'aucune requête n'est partie.
 */
export function assertAucunAppelStripe(urls: readonly string[], contexte: string): void {
  const fautives = urls.filter((url) => estAppelStripe(url));
  if (fautives.length > 0) {
    throw new Error(
      `${contexte} : ${fautives.length} appel(s) à Stripe alors qu'aucun n'est attendu — ` +
        `${fautives.slice(0, 3).join(', ')}. ` +
        "Le règlement en espèces ne passe par aucun prestataire (payments-stripe §4).",
    );
  }
}

/**
 * La contre-épreuve du chemin carte.
 *
 * Aucune requête partant chez Stripe ne doit porter une clé publiable live. La
 * clé publiable voyage en clair dans les appels de Stripe.js — c'est ce qui rend
 * ce contrôle possible depuis le navigateur, et c'est le dernier filet si une
 * clé live avait échappé à `refuserCleLive` (posée par l'API, par exemple, et
 * non par l'environnement de la suite).
 */
export function assertAucuneCleLiveEnVol(urls: readonly string[]): void {
  const fautives = urls.filter((url) => /pk_live_|sk_live_/.test(url));
  if (fautives.length > 0) {
    throw new Error(
      `Une clé Stripe live est partie sur le réseau (${fautives.length} requête(s)). ` +
        "La suite E2E n'appelle jamais l'environnement live (payments-stripe §7).",
    );
  }
}
