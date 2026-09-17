import { isTenantSubdomainLabel, slugSchema } from '@spa/shared';

/**
 * Ce qu'une personne tape pour désigner son salon, ramené au slug qui le
 * désigne — ou `null` s'il n'y a rien à en tirer (#927).
 *
 * ## Pourquoi un champ libre, et pas une liste
 *
 * La racine du domaine n'a pas le droit de lister les établissements : un
 * annuaire est une fonctionnalité de place de marché, hors périmètre du MVP
 * (CDC §1.4). La personne apporte donc l'adresse qu'elle connaît — et elle la
 * connaît sous l'une de ces formes, qu'aucune ne doit refuser :
 *
 * | Saisie | Slug |
 * |---|---|
 * | `salon-des-lilas` | `salon-des-lilas` |
 * | `Salon des Lilas` — le nom lu sur la devanture | `salon-des-lilas` |
 * | `https://exemple.fr/salon-des-lilas/reservation` — le lien d'un e-mail | `salon-des-lilas` |
 * | `salon-des-lilas.exemple.fr` — l'adresse par sous-domaine (#832) | `salon-des-lilas` |
 *
 * Le nom n'est qu'une **présomption** : rien ne garantit que le slug d'un salon
 * soit son nom écrit en minuscules. C'est pourquoi la fonction ne dit jamais
 * qu'un salon existe — c'est l'API qui le dit, et l'action qui l'appelle rend
 * son verdict sur le champ.
 *
 * ## Ce qui est refusé d'emblée
 *
 * Tout ce que `slugSchema` refuse : un slug que le contrat interdit de créer ne
 * peut désigner aucun salon, et l'envoyer à l'API coûterait un aller-retour pour
 * un 404 connu d'avance. Les noms réservés (`www`, `admin`…) en font partie.
 */
export function salonSlugFromAddress(raw: string): string | null {
  const input = raw.trim();

  if (input === '') {
    return null;
  }

  if (input.includes('/') && !/\s/.test(input)) {
    // Un lien ou un chemin — qui ne porte jamais d'espace : `Coiffure 24/7` est
    // un nom, et se relit comme tel. S'il ne désigne aucun salon, le relire comme un
    // nom fabriquerait `https-exemple-fr` — un slug que personne n'a tapé.
    return slugFromAddress(input);
  }

  // Un point dans un mot sans espace — `maison-lotus.exemple.fr` — a la forme
  // d'un nom d'hôte. Un nom de salon qui en porterait un retombe sur la lecture
  // comme nom.
  const fromHost = input.includes('.') && !/\s/.test(input) ? slugFromAddress(input) : null;

  return fromHost ?? slugFromName(input);
}

/** Le slug porté par une adresse : son premier segment de chemin, sinon son sous-domaine. */
function slugFromAddress(input: string): string | null {
  let url: URL;
  try {
    // Un chemin nu se résout contre une origine factice : préfixé d'un schéma,
    // `/salon-des-lilas/reservation` ferait de son premier segment un nom d'hôte.
    url = input.startsWith('/')
      ? new URL(input, 'https://site.invalid')
      : new URL(input.includes('://') ? input : `https://${input}`);
  } catch {
    return null;
  }

  const [, firstSegment = ''] = url.pathname.split('/');
  const segment = decodeSegment(firstSegment).toLowerCase();
  const fromPath = canonical(segment);
  const fromHost = slugFromHost(url.hostname);

  // Par sous-domaine (#832), le lien d'un e-mail est `maison-lotus.exemple.fr/compte` :
  // son premier segment est une page du salon, pas le salon.
  if (fromHost !== null && SALON_ROUTE_SEGMENTS.has(segment)) {
    return fromHost;
  }

  return fromPath ?? fromHost;
}

/** Les pages d'un salon, telles qu'elles suivent son slug dans un chemin. */
const SALON_ROUTE_SEGMENTS: ReadonlySet<string> = new Set([
  'compte',
  'reservation',
  'politique-donnees',
]);

/**
 * `salon-des-lilas.exemple.fr` : le salon est l'étiquette de tête, à condition
 * qu'il reste un domaine derrière elle. `exemple.fr` seul n'en désigne aucun.
 */
function slugFromHost(hostname: string): string | null {
  const labels = hostname.toLowerCase().split('.');
  const [head = ''] = labels;
  const baseLabels = labels.slice(1).filter((label) => label !== '');
  const hasBase = baseLabels.length >= 2 || baseLabels.at(-1) === 'localhost';

  return hasBase && isTenantSubdomainLabel(head) ? head : null;
}

/** `decodeURIComponent` lève sur un échappement tronqué : la saisie est libre. */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return '';
  }
}

/**
 * Le nom tel qu'on l'écrirait en slug : sans accents, en minuscules, chaque
 * suite de caractères hors `[a-z0-9]` changée en un tiret.
 */
function slugFromName(input: string): string | null {
  const slug = input
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return canonical(slug);
}

/** Le slug s'il est de ceux que le contrat accepte, `null` sinon. */
function canonical(candidate: string): string | null {
  const parsed = slugSchema.safeParse(candidate);

  return parsed.success ? parsed.data : null;
}
