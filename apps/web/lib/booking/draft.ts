/**
 * L'état du tunnel de réservation, sa place dans l'URL et sa survie à un
 * rafraîchissement (#45, #733).
 *
 * Troisième critère d'acceptation de #45, et §3 de la skill `web-frontend` :
 * *« un client qui recharge et perd sa progression abandonne »*. Tout ce que le
 * visiteur a saisi ou choisi vit donc dans `sessionStorage`, réécrit à chaque
 * changement et relu au montage.
 *
 * ## Pourquoi l'URL porte la progression, et le stockage seulement le reste
 *
 * `docs/design/appointments/README.md` — « Le modèle en six étapes » : *« la
 * progression est portée par l'URL (`/book/{salon}?step=slot&service=...`) et
 * doublée en `sessionStorage` »*. Le stockage seul ne suffisait pas : les cinq
 * étapes partageaient une même adresse, si bien que le geste retour du
 * navigateur — la navigation principale sur mobile — ne revenait pas d'une
 * étape mais **sortait du tunnel** (#733). Une étape n'était ni partageable ni
 * marquable.
 *
 * L'URL porte donc l'étape et les **choix** — prestation, praticien, créneau ;
 * `sessionStorage` reste le doublon et garde en plus ce qui n'a rien à faire
 * dans une adresse qu'on partage ou qu'un serveur journalise : les
 * **coordonnées** du visiteur et le rendez-vous obtenu.
 *
 * ## Pourquoi `sessionStorage` et non `localStorage`
 *
 * Le brouillon porte des coordonnées — nom, e-mail, téléphone. `localStorage`
 * les laisserait sur la machine jusqu'à effacement manuel, y compris sur un
 * poste partagé ; `sessionStorage` disparaît avec l'onglet, ce qui est
 * exactement la durée de vie d'une prise de rendez-vous.
 *
 * ## Pourquoi une clé par établissement
 *
 * Deux salons ouverts dans deux onglets du même navigateur ne partagent pas
 * `sessionStorage` entre onglets, mais un même onglet peut passer de l'un à
 * l'autre. Une clé unique ferait alors apparaître, dans le tunnel du second
 * salon, la prestation choisie chez le premier — un identifiant qui n'existe
 * pas de ce côté de la frontière.
 *
 * ## Pourquoi le contenu relu est validé
 *
 * `sessionStorage` est modifiable par l'utilisateur et survit à un déploiement.
 * Un brouillon écrit par une version antérieure du tunnel, ou bricolé à la main,
 * ne doit pas faire planter le montage : il est rejoué contre son schéma, et
 * repart de zéro s'il ne le satisfait pas.
 *
 * ## Pourquoi le brouillon sait **à qui** ses coordonnées appartiennent (#1151)
 *
 * `sessionStorage` meurt avec l'onglet, et non avec la session du compte : entre
 * les deux, il y a tout l'espace d'une déconnexion suivie d'une connexion sous
 * un autre compte, dans le même onglet. La campagne du 22/09/2026 l'a relevé —
 * connectée en Clara, l'étape « Comment vous joindre ? » annonçait « Réservé au
 * nom de Zoé … · qa.cliente1@recette.test », case de consentement déjà cochée,
 * et l'écran de confirmation nommait l'adresse de Zoé.
 *
 * Le rendez-vous, lui, part désormais au bon compte : la route publique exige le
 * jeton de la cliente (#1136) et le corps de la demande ne porte plus aucune
 * coordonnée (#1222). Ce qui restait était **ce que l'écran montre**, et c'est
 * une donnée personnelle d'une tierce personne (CDC §5.1) autant qu'un
 * consentement qu'une autre a donné.
 *
 * D'où `contactAccount` : les coordonnées d'un brouillon ont un propriétaire, et
 * un changement de propriétaire les fait tomber — voir `draftForAccount`.
 */

import { bookedAppointmentSchema, uuidSchema, utcInstantSchema } from '@spa/shared';
import { z } from 'zod';

/**
 * Les étapes, dans l'ordre du parcours (skill web-frontend §3).
 *
 * Le paiement n'y figure pas : il est traité par son propre ticket, et le
 * rendez-vous est déjà pris à la confirmation.
 */
export const BOOKING_STEPS = [
  'prestation',
  'creneau',
  'coordonnees',
  'recapitulatif',
  'confirmation',
] as const;

export type BookingStep = (typeof BOOKING_STEPS)[number];

export const bookingStepSchema = z.enum(BOOKING_STEPS);

/**
 * Les coordonnées **telles qu'elles ont été tapées**, et non telles que le
 * contrat les normalise.
 *
 * C'est ce qui permet de réafficher le formulaire après un rafraîchissement
 * dans l'état où le visiteur l'a laissé — y compris un numéro incomplet en
 * cours de frappe. La normalisation E.164 et la validation restent l'affaire de
 * `guestContactSchema`, appliqué à la soumission.
 */
export const contactDraftSchema = z.object({
  firstName: z.string(),
  lastName: z.string(),
  email: z.string(),
  phone: z.string(),
  clientNote: z.string(),
  /**
   * Le consentement de l'étape « Coordonnées » (#734, CDC §5.1).
   *
   * Il vit dans le brouillon pour la même raison que le reste de la saisie :
   * une cliente qui rafraîchit la page n'a pas à recocher une case qu'elle
   * vient de cocher. Et il y vit pour une seconde raison, qui n'appartient
   * qu'à lui — c'est ce qui permet à `reachableStep` de refuser le
   * récapitulatif à qui n'a pas consenti, y compris arrivé là par une URL
   * écrite à la main.
   *
   * `.catch(false)` et non `z.boolean()` sec : un brouillon écrit avant ce
   * ticket n'a pas la clé, et faire échouer tout le schéma renverrait la
   * cliente à la première étape en lui prenant sa prestation et son créneau.
   * Elle recoche la case, elle ne recommence pas le tunnel. Le repli est
   * `false` dans tous les cas douteux : un consentement qu'on n'a pas lu n'est
   * pas un consentement.
   */
  consent: z.boolean().catch(false),
});

export type ContactDraft = z.infer<typeof contactDraftSchema>;

export const bookingDraftSchema = z.object({
  step: bookingStepSchema,
  serviceId: uuidSchema.nullable(),
  /** `null` = « premier disponible » (CDC §1.4), pas « pas encore choisi ». */
  staffId: uuidSchema.nullable(),
  startsAt: utcInstantSchema.nullable(),
  contact: contactDraftSchema,
  /**
   * Le compte sous lequel les coordonnées ci-dessus ont été saisies (#1151).
   *
   * `null` veut dire « ces coordonnées n'appartiennent à personne » : un
   * brouillon vierge, un brouillon écrit avant ce ticket, ou un brouillon dont
   * `draftForAccount` vient de faire tomber les coordonnées. Le repli est
   * délibérément `null` et non « le compte en cours » — un brouillon dont on
   * ignore l'auteur est traité comme celui d'une autre personne, ce qui est la
   * seule lecture prudente d'une donnée personnelle.
   *
   * C'est **l'adresse e-mail** du compte qui fait office de clé, parce que c'est
   * le seul discriminant que le tunnel ait : le cookie de présence ne porte ni
   * identifiant ni rôle, à dessein (`lib/account-presence.ts`). Elle n'ajoute
   * aucune donnée au stockage — `contact.email` y est déjà —, et elle est
   * normalisée par `contactAccountKey` pour qu'une différence de casse ne passe
   * pas pour un changement de compte.
   *
   * `.catch(null)` plutôt qu'un champ requis : un brouillon d'avant ce ticket ne
   * porte pas la clé, et faire échouer tout le schéma renverrait la cliente à la
   * première étape en lui prenant sa prestation et son créneau. Il est relu sans
   * propriétaire, donc traité comme celui d'une autre — c'est exactement la
   * conduite qu'on veut au déploiement.
   */
  contactAccount: z.string().nullable().catch(null),
  /** Le rendez-vous obtenu, qui fait vivre l'écran de confirmation après un F5. */
  appointment: bookedAppointmentSchema.nullable(),
});

export type BookingDraft = z.infer<typeof bookingDraftSchema>;

/** Des coordonnées que personne n'a encore saisies. */
export function emptyContactDraft(): ContactDraft {
  return { firstName: '', lastName: '', email: '', phone: '', clientNote: '', consent: false };
}

export function emptyBookingDraft(): BookingDraft {
  return {
    step: 'prestation',
    serviceId: null,
    staffId: null,
    startsAt: null,
    contact: emptyContactDraft(),
    contactAccount: null,
    appointment: null,
  };
}

/**
 * La clé d'un compte, telle que `contactAccount` la retient (#1151).
 *
 * L'adresse e-mail, mise à plat : les espaces de bord et la casse ne distinguent
 * pas deux comptes, et les laisser passer ferait tomber les coordonnées d'une
 * cliente qui n'a pourtant pas changé d'identité — le rendu d'un cookie relu
 * n'est pas garanti identique d'une écriture à l'autre.
 *
 * `''` vaut `null`, et non une clé vide : le cookie de présence accepte une
 * adresse vide — celle d'un cookie posé avant #1086, ou d'un champ que
 * `presenceSchema` a replié — et deux comptes sans adresse ne sont pas le même
 * compte. Sans propriétaire nommable, le brouillon n'en a pas.
 *
 * Ce que cette clé confond, et qu'on assume : une cliente qui **change
 * l'adresse de son compte** au milieu de son parcours, depuis
 * `compte/coordonnees`, est lue comme quelqu'un d'autre au retour sur le tunnel.
 * Elle y perd son mot au salon et sa case cochée, et repart de l'étape
 * « Coordonnées », préremplie de sa nouvelle adresse — jamais son rendez-vous,
 * qui reste dans son espace client. C'est le mauvais côté sur lequel se tromper
 * quand le signal est ambigu, et le cookie de présence ne porte pas
 * d'identifiant qui trancherait mieux : il n'en porte aucun, à dessein.
 */
export function contactAccountKey(email: string | null | undefined): string | null {
  const key = email?.trim().toLowerCase() ?? '';

  return key === '' ? null : key;
}

/**
 * Le brouillon, rendu au compte qui est en train de s'en servir (#1151).
 *
 * Inchangé tant que le compte est celui sous lequel les coordonnées ont été
 * saisies. Dès qu'il diffère — déconnexion, connexion sous un autre compte,
 * session échue —, **deux choses tombent**, et seulement elles :
 *
 * - les **coordonnées**, consentement compris. Elles décrivent une personne qui
 *   n'est pas celle qui tient l'écran, et le consentement au traitement des
 *   données est donné par quelqu'un, pas par un onglet (CDC §5.1). Vidées plutôt
 *   que recopiées du compte en cours : c'est `ContactStep` qui complète les
 *   champs vides avec ce que la session connaît (#1050, #1086), et le faire ici
 *   ferait entrer dans le brouillon une saisie que personne n'a faite ;
 * - le **rendez-vous obtenu**. Il a été pris par l'autre session, l'écran de
 *   confirmation le donnerait à lire — référence comprise — à quelqu'un qui n'en
 *   est pas la cliente, et la phrase « un e-mail a été envoyé à … » nommerait une
 *   adresse qui vient de disparaître du brouillon. Il reste consultable là où il
 *   appartient, dans l'espace de sa cliente.
 *
 * Ce qui **reste** est ce qui décrit la réservation et non la personne :
 * prestation, praticien, créneau. Ce sont les choix que l'URL porte déjà et
 * qu'un lien partage (`bookingSearchParams`) ; les faire tomber ici ne les
 * effacerait même pas, `draftFromSearch` les relisant aussitôt de l'adresse.
 * Celle qui vient de se connecter reprend donc le parcours de l'onglet là où il
 * en était, sur l'étape « Coordonnées » — ce que `reachableStep` rend d'un
 * brouillon dont les coordonnées sont reparties.
 *
 * ## Un brouillon sans propriétaire ne reconnaît **personne**
 *
 * Le repli `null` dit « on ignore à qui ces coordonnées sont », et `null` est
 * aussi ce que `contactAccountKey` rend d'une présence sans adresse — un cookie
 * posé avant #1086, ou un champ que `presenceSchema` a replié sur `''`. Une
 * égalité sèche confondrait les deux : le brouillon d'une cliente sans adresse
 * lisible se représenterait tel quel à la suivante, coordonnées, consentement et
 * rendez-vous compris, c'est-à-dire exactement la fuite que ce ticket referme.
 * D'où la garde `owner !== null` — sans propriétaire nommable, le brouillon n'en
 * a pas, et il n'est rendu à personne.
 *
 * Ce que cela coûte, et qu'on assume : cette cliente-là — présence sans adresse,
 * donc `contactAccount` écrit à `null` — reperd sa saisie à chaque relecture du
 * brouillon. C'est le même arbitrage que partout ailleurs ici, du côté prudent
 * d'un signal ambigu.
 *
 * Le propriétaire relu est **renormalisé** avant la comparaison : il est écrit
 * par `contactAccountKey`, mais `sessionStorage` se bricole à la main et un
 * brouillon d'une autre version du tunnel peut y avoir laissé l'adresse telle
 * quelle. Une différence de casse n'est pas un changement de compte, ici comme
 * dans la clé elle-même.
 */
export function draftForAccount(draft: BookingDraft, account: string | null): BookingDraft {
  const owner = contactAccountKey(draft.contactAccount);

  if (owner !== null && owner === account) {
    return draft;
  }

  return { ...draft, contact: emptyContactDraft(), contactAccount: null, appointment: null };
}

function storageKey(tenantSlug: string): string {
  return `spa.booking.${tenantSlug}`;
}

/**
 * Le `sessionStorage` du navigateur, ou `null`.
 *
 * `null` couvre trois cas qui ne sont pas des pannes : le rendu serveur, la
 * navigation privée de certains navigateurs, et un stockage désactivé par
 * politique. Le tunnel reste utilisable dans tous les trois — il perd la survie
 * au rafraîchissement, pas la capacité de réserver.
 */
function sessionStore(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

/** Le brouillon en cours pour cet établissement, ou un brouillon vierge. */
export function readBookingDraft(tenantSlug: string): BookingDraft {
  const store = sessionStore();
  const raw = store?.getItem(storageKey(tenantSlug));

  if (raw === null || raw === undefined) {
    return emptyBookingDraft();
  }

  try {
    const parsed = bookingDraftSchema.safeParse(JSON.parse(raw));

    return parsed.success ? parsed.data : emptyBookingDraft();
  } catch {
    return emptyBookingDraft();
  }
}

export function writeBookingDraft(tenantSlug: string, draft: BookingDraft): void {
  try {
    sessionStore()?.setItem(storageKey(tenantSlug), JSON.stringify(draft));
  } catch {
    // Quota dépassé ou stockage refusé : le tunnel continue sans persistance
    // plutôt que de s'interrompre au milieu d'une réservation.
  }
}

// Pas d'`effacement` : « prendre un nouveau rendez-vous » réécrit un brouillon
// vierge par `writeBookingDraft`, ce qui laisse le stockage dans le même état
// qu'un `removeItem` sans introduire un second chemin d'écriture à tenir.

/**
 * Les clés de la query string du tunnel (#733).
 *
 * En français, comme partout ailleurs dans l'application — le planning admin
 * lit `?vue=` et `?date=`, le fichier client `?recherche=` et `?fiche=`. La
 * référence de conception écrit `?step=slot&service=…` : c'est l'exemple d'un
 * document, pas le vocabulaire du dépôt, et ce qu'elle prescrit est que la
 * progression **soit dans l'URL**, pas qu'elle y soit en anglais.
 *
 * Les coordonnées n'y figurent pas, et ce n'est pas un oubli : une URL se
 * partage, se met en favori, et finit dans les journaux de tous les serveurs
 * qu'elle traverse. Un nom, un e-mail et un téléphone n'ont rien à y faire.
 */
export const BOOKING_QUERY_KEYS = {
  step: 'etape',
  service: 'prestation',
  staff: 'praticien',
  slot: 'creneau',
} as const;

/**
 * La query string qui décrit ce brouillon, posée **par-dessus** celle en cours.
 *
 * Partir de l'existante plutôt que d'en fabriquer une neuve préserve les
 * paramètres qui ne nous appartiennent pas — un `?utm_source=` d'une campagne
 * mène au tunnel, et le premier changement d'étape l'effacerait avec
 * l'attribution qui va avec.
 *
 * Un choix qui n'est pas fait n'apparaît pas : `praticien` absent vaut
 * « premier disponible » (CDC §1.4), et une prestation absente emporte le
 * praticien et le créneau, qui n'ont plus de sens sans elle.
 */
export function bookingSearchParams(
  draft: BookingDraft,
  current?: string | URLSearchParams,
): URLSearchParams {
  const params = new URLSearchParams(current ?? '');

  params.set(BOOKING_QUERY_KEYS.step, draft.step);

  if (draft.serviceId === null) {
    params.delete(BOOKING_QUERY_KEYS.service);
    params.delete(BOOKING_QUERY_KEYS.staff);
    params.delete(BOOKING_QUERY_KEYS.slot);

    return params;
  }

  params.set(BOOKING_QUERY_KEYS.service, draft.serviceId);

  for (const [key, value] of [
    [BOOKING_QUERY_KEYS.staff, draft.staffId],
    [BOOKING_QUERY_KEYS.slot, draft.startsAt],
  ] as const) {
    if (value === null) {
      params.delete(key);
    } else {
      params.set(key, value);
    }
  }

  return params;
}

/** La même chose, prête à concaténer à un chemin — `?etape=creneau&…`. */
export function bookingSearch(draft: BookingDraft, current?: string | URLSearchParams): string {
  const query = bookingSearchParams(draft, current).toString();

  return query === '' ? '' : `?${query}`;
}

/**
 * Le brouillon que décrit une query string, complété par celui qu'on a déjà.
 *
 * **L'URL fait foi dès qu'elle porte une de nos clés** : un lien partagé décrit
 * un parcours entier, et ce qu'il ne dit pas n'a pas été choisi. Sans cette
 * règle, ouvrir le lien d'une collègue ferait réapparaître la prestation restée
 * dans le `sessionStorage` de l'onglet, et le tunnel afficherait un mélange des
 * deux.
 *
 * Ce qui ne voyage pas dans l'URL — coordonnées, rendez-vous obtenu — vient
 * toujours de `base`, c'est-à-dire du stockage : un retour arrière ne doit
 * jamais coûter un formulaire déjà rempli.
 *
 * Une valeur illisible (URL bricolée, lien tronqué, contrat qui a changé) est
 * **ignorée** plutôt que propagée : elle vaut « pas choisi », et l'étape
 * atteignable ramènera le visiteur là où il a quelque chose à faire.
 */
export function draftFromSearch(search: string | URLSearchParams, base: BookingDraft): BookingDraft {
  const params = new URLSearchParams(search);
  const carriesBooking = Object.values(BOOKING_QUERY_KEYS).some((key) => params.has(key));

  if (!carriesBooking) {
    return base;
  }

  const step = bookingStepSchema.safeParse(params.get(BOOKING_QUERY_KEYS.step));
  const serviceId = uuidSchema.safeParse(params.get(BOOKING_QUERY_KEYS.service));
  const staffId = uuidSchema.safeParse(params.get(BOOKING_QUERY_KEYS.staff));
  const startsAt = utcInstantSchema.safeParse(params.get(BOOKING_QUERY_KEYS.slot));

  return {
    ...base,
    step: step.success ? step.data : base.step,
    serviceId: serviceId.success ? serviceId.data : null,
    staffId: staffId.success ? staffId.data : null,
    startsAt: startsAt.success ? startsAt.data : null,
  };
}

/**
 * Les coordonnées suffisent-elles à réserver ?
 *
 * Trois champs, ceux que `guestContactSchema` exige (le téléphone est
 * facultatif). On ne les **valide** pas ici — `ContactStep` le fait à la
 * soumission, avec le schéma partagé. Ce garde-fou répond à une autre question :
 * y a-t-il seulement quelqu'un au bout de ce récapitulatif ?
 *
 * Le consentement est de la partie depuis #734, et pour la même raison
 * qu'eux — pas parce qu'il manquerait un nom, mais parce qu'un récapitulatif
 * atteint sans lui porterait un bouton « Confirmer la réservation » qui
 * enverrait à l'API des données que personne n'a accepté de nous confier
 * (CDC §5.1). La case est **sur l'étape précédente**, et c'est là qu'on
 * renvoie : `reachableStep` ramène à `coordonnees`, où le formulaire garde ce
 * qui a déjà été tapé.
 */
function contactIsUsable(contact: ContactDraft): boolean {
  return (
    contact.firstName.trim() !== '' &&
    contact.lastName.trim() !== '' &&
    contact.email.trim() !== '' &&
    contact.consent
  );
}

/**
 * L'étape la plus avancée qu'un brouillon permet d'afficher.
 *
 * Un brouillon relu peut annoncer `recapitulatif` sans porter de créneau — il a
 * été bricolé, ou il vient d'une version antérieure du tunnel. Afficher
 * l'étape telle quelle donnerait un récapitulatif vide ; la ramener à la
 * première étape incomplète remet le visiteur là où il a quelque chose à faire.
 *
 * Depuis #733, ce n'est plus seulement le stockage qui alimente cette fonction
 * mais aussi la query string, que n'importe qui peut écrire à la main ou garder
 * en favori. D'où le contrôle des coordonnées, qui n'avait pas lieu d'être tant
 * qu'on ne pouvait atteindre le récapitulatif qu'en traversant le formulaire :
 * `?etape=recapitulatif` — ou `?etape=confirmation`, qui retombe dessus —
 * ouvert dans un onglet neuf donnerait un récapitulatif sans personne à qui
 * écrire, et un bouton « Confirmer » qui partirait en 400.
 */
export function reachableStep(draft: BookingDraft): BookingStep {
  if (draft.appointment !== null) {
    return 'confirmation';
  }
  if (draft.serviceId === null) {
    return 'prestation';
  }
  if (draft.startsAt === null) {
    return draft.step === 'prestation' ? 'prestation' : 'creneau';
  }

  // Le rendez-vous a disparu du brouillon : il n'y a plus rien à confirmer, et
  // le récapitulatif est ce qu'il reste de plus avancé. On le fait **passer par
  // la garde ci-dessous** plutôt que de le rendre tout de suite : un
  // `?etape=confirmation` partagé ou mis en favori arrive ici sans coordonnées,
  // et le récapitulatif qu'il ouvrirait n'aurait personne à qui écrire.
  const step = draft.step === 'confirmation' ? 'recapitulatif' : draft.step;

  if (step === 'recapitulatif' && !contactIsUsable(draft.contact)) {
    return 'coordonnees';
  }

  return step;
}
