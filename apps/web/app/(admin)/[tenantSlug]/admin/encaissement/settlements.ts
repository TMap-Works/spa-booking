import type { CalendarDate, TimeZone } from '@spa/shared';
import { MAX_PAGE_SIZE } from '@spa/shared';

import type { PaymentTransaction } from '@/lib/admin/payment-contract';
import { windowOfRange } from '@/lib/admin/reporting-window';
import { fetchPayments } from '@/lib/api-client';
import { addCalendarDays } from '@/lib/booking/calendar';

/**
 * Le nombre de pages qu'on accepte de lire — cinq, soit cinq cents
 * encaissements pour les trois journées de la fenêtre.
 *
 * Une borne plutôt qu'une boucle jusqu'à épuisement : cet écran reste ouvert
 * toute la journée et se rafraîchit souvent, et une fenêtre qui dépasserait ce
 * volume ne doit pas se payer en autant de requêtes à chaque affichage. Au-delà,
 * les rendez-vous non vus restent « à encaisser » et le refus 409 du serveur
 * reste le filet — l'écran ne ment pas, il en sait moins.
 */
const MAX_SETTLEMENT_PAGES = 5;

/**
 * Ce que la journée a **déjà** encaissé — la lecture qui manquait à l'écran
 * d'encaissement (#828).
 *
 * ## Pourquoi une lecture à part, et pas un champ du rendez-vous
 *
 * Parce que `GET /api/v1/appointments` ne porte pas l'état de règlement : le
 * contrat partagé décrit un rendez-vous sans son paiement, et l'y joindre
 * relèverait d'`apps/api` et de `packages/shared`, hors de l'empreinte de ce
 * ticket. `GET /api/v1/payments` sert en revanche déjà tout ce qu'il faut —
 * `appointmentId`, moyen, statut, montant, instant de capture —, et la
 * contrainte `@@unique([tenantId, appointmentId])` de la table en fait au plus
 * une ligne par rendez-vous. Une requête de plus, et la jointure se fait ici.
 *
 * ## La fenêtre : la journée affichée, **et ses deux voisines**
 *
 * `from` inclus, `to` exclu, aux bornes civiles du salon — la conversion passe
 * par `windowOfRange`, seule implémentation du décalage horaire du dépôt ; la
 * redoubler ici aurait fait diverger deux idées d'un jour de caisse le jour
 * d'un changement d'heure.
 *
 * Trois journées et non une seule, parce que le filtre de `GET /payments` porte
 * sur l'**ouverture** de l'encaissement (`payments.createdAt`) et non sur le
 * rendez-vous qu'il règle. Deux gestes ordinaires du comptoir tombent hors de la
 * seule journée du rendez-vous, et les manquer aurait laissé l'écran répéter le
 * défaut qu'il corrige :
 *
 * - **la veille au soir** — une prestation payée d'avance au comptoir pour le
 *   lendemain, cas vu dès la recette de ce ticket ;
 * - **le lendemain matin** — une cliente partie sans payer, réglée à l'ouverture.
 *
 * La borne reste étroite : trois journées de caisse d'un salon, pas un
 * historique. Au-delà — un règlement inscrit une semaine après —, l'écran
 * retombe sur son comportement d'avant, et le 409 reste le filet, comme il
 * l'était pour tous les cas avant ce ticket.
 *
 * ## Un refus n'est pas une panne
 *
 * La route est au seuil `MANAGER` quand l'encaissement est ouvert à `STAFF`.
 * Un comptoir tenu par un compte `STAFF` reçoit donc un 403, et il n'y a rien à
 * en conclure sinon que l'état de règlement est **inconnu** : `null` plutôt
 * qu'un tableau vide, que l'écran lirait comme « rien n'est réglé » et qui
 * ferait réapparaître le défaut que ce ticket corrige. Même conduite sur toute
 * autre panne de lecture — l'encaissement doit rester possible quand
 * l'historique ne répond pas.
 */
export async function readDaySettlements(
  accessToken: string,
  day: CalendarDate,
  timeZone: TimeZone,
): Promise<PaymentTransaction[] | null> {
  const window = windowOfRange(
    { from: addCalendarDays(day, -1), to: addCalendarDays(day, 1) },
    timeZone,
  );
  const collected: PaymentTransaction[] = [];

  try {
    // Séquentiel, et non un lot de requêtes parallèles : le nombre de pages
    // n'est connu qu'une fois la première réponse lue, et une journée de salon
    // en tient une.
    for (let page = 1; page <= MAX_SETTLEMENT_PAGES; page += 1) {
      const result = await fetchPayments(accessToken, {
        ...window,
        page,
        pageSize: MAX_PAGE_SIZE,
      });

      collected.push(...result.items);

      if (page >= result.totalPages) {
        break;
      }
    }
  } catch {
    return null;
  }

  return collected;
}
