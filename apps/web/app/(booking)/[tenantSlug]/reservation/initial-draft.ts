import type { PublicService } from '@spa/shared';

import {
  draftFromSearch,
  emptyBookingDraft,
  reachableStep,
  type BookingDraft,
} from '@/lib/booking/draft';

/**
 * L'étape que l'URL décrit, résolue **côté serveur** (#1055).
 *
 * ## Le défaut qu'elle corrige
 *
 * Le tunnel est un Client Component : il relit l'URL et `sessionStorage` dans un
 * effet, c'est-à-dire **après** le premier rendu. Jusqu'ici son état de départ
 * était `emptyBookingDraft()`, si bien que le premier rendu — celui que le
 * serveur envoie, et que l'hydratation rejoue à l'identique — affichait toujours
 * « Étape 1 sur 4 · Quelle prestation ? » au-dessus d'une carte grise sans
 * forme. Ouvrir `?etape=creneau&prestation=…` montrait donc la mauvaise pastille
 * et un cadre vide, puis basculait sur l'étape reprise (audit `d20260918-1`,
 * `ds:etats`, `BM-ECRAN-01`).
 *
 * Or `etape=` et `prestation=` sont dans l'adresse, et l'adresse, le serveur
 * l'a. La page la lit, la résout contre le catalogue qu'elle vient de charger,
 * et passe au tunnel l'état de départ correspondant : la progression et le
 * squelette sont justes **dès le premier octet**.
 *
 * ## Ce que le serveur peut savoir, et ce qu'il ne peut pas
 *
 * L'URL porte l'étape et les choix — prestation, praticien, créneau
 * (`lib/booking/draft.ts`). Elle ne porte **ni les coordonnées ni le rendez-vous
 * obtenu**, qui vivent dans `sessionStorage` et n'ont rien à faire dans une
 * adresse qu'on partage. Le serveur ne peut donc pas distinguer un
 * `?etape=recapitulatif` légitime — le formulaire est rempli dans cet onglet —
 * d'un lien collé dans un onglet neuf.
 *
 * `reachableStep` tranche exactement comme il tranchera à l'hydratation : sans
 * coordonnées utilisables, le récapitulatif retombe sur « Coordonnées », et
 * `?etape=confirmation` avec lui. Le pire cas est donc un squelette de
 * formulaire remplacé par un récapitulatif — deux blocs de même famille, au même
 * endroit —, jamais la pastille « Prestation » d'un tunnel qu'on a déjà traversé
 * aux trois quarts.
 *
 * ## Pourquoi le catalogue entre dans le calcul
 *
 * Le tunnel retombe sur « Prestation » dès que le `serviceId` du brouillon ne se
 * résout plus dans le catalogue — une prestation retirée entre deux visites
 * laisse un identifiant mort dans un lien mis en favori (`booking-tunnel.tsx`,
 * `const step`). Sans ce contrôle ici, le serveur annoncerait « Étape 2 sur 4 »
 * et l'hydratation reviendrait aussitôt à la première : le saut que ce ticket
 * supprime serait simplement déplacé.
 */
export function initialBookingDraft(
  search: Readonly<Record<string, string | readonly string[] | undefined>>,
  services: readonly PublicService[],
): BookingDraft {
  const fromUrl = draftFromSearch(toSearchParams(search), emptyBookingDraft());
  // Le catalogue a le dernier mot sur la prestation, et le praticien comme le
  // créneau tombent avec elle : ils décrivent l'agenda d'un soin qui n'existe
  // plus.
  const grounded: BookingDraft = services.some((service) => service.id === fromUrl.serviceId)
    ? fromUrl
    : { ...fromUrl, serviceId: null, staffId: null, startsAt: null };

  return { ...grounded, step: reachableStep(grounded) };
}

/**
 * Les `searchParams` de Next, rendus à la forme que `draftFromSearch` lit.
 *
 * Next donne une valeur **ou un tableau** par clé — `?etape=creneau&etape=`
 * arrive en tableau. La **première** l'emporte, parce que c'est ce que rend le
 * `URLSearchParams.get()` que le tunnel posera sur la même adresse à
 * l'hydratation : les deux chemins doivent lire la même étape, sans quoi le
 * premier rendu et l'hydratation divergeraient sur une URL bricolée — le saut
 * que ce ticket supprime, simplement déplacé.
 */
function toSearchParams(
  search: Readonly<Record<string, string | readonly string[] | undefined>>,
): URLSearchParams {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(search)) {
    if (typeof value === 'string') {
      params.set(key, value);
      continue;
    }

    const first = value?.[0];

    if (first !== undefined) {
      params.set(key, first);
    }
  }

  return params;
}
