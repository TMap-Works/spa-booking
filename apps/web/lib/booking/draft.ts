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
});

export type ContactDraft = z.infer<typeof contactDraftSchema>;

export const bookingDraftSchema = z.object({
  step: bookingStepSchema,
  serviceId: uuidSchema.nullable(),
  /** `null` = « premier disponible » (CDC §1.4), pas « pas encore choisi ». */
  staffId: uuidSchema.nullable(),
  startsAt: utcInstantSchema.nullable(),
  contact: contactDraftSchema,
  /** Le rendez-vous obtenu, qui fait vivre l'écran de confirmation après un F5. */
  appointment: bookedAppointmentSchema.nullable(),
});

export type BookingDraft = z.infer<typeof bookingDraftSchema>;

export function emptyBookingDraft(): BookingDraft {
  return {
    step: 'prestation',
    serviceId: null,
    staffId: null,
    startsAt: null,
    contact: { firstName: '', lastName: '', email: '', phone: '', clientNote: '' },
    appointment: null,
  };
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
 */
function contactIsUsable(contact: ContactDraft): boolean {
  return (
    contact.firstName.trim() !== '' && contact.lastName.trim() !== '' && contact.email.trim() !== ''
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
