import { BOOKING_QUERY_KEYS } from '@/lib/booking/draft';

/**
 * L'adresse qui ouvre le tunnel **sur une prestation**, à l'étape du créneau
 * (#1046, BM-VITRINE-05).
 *
 * ## Pourquoi une URL, et rien d'autre
 *
 * La vitrine et le tunnel sont deux écrans. Le second porte tout son état dans
 * son adresse depuis #733 — c'est ce qui lui permet de survivre à un
 * rafraîchissement et de se partager par lien — et la vitrine n'a donc rien à
 * lui passer d'autre : un `<Link>` suffit. Aucun composant du tunnel n'est
 * importé ici, aucune de ses règles n'est recopiée.
 *
 * Les **clés** viennent de `BOOKING_QUERY_KEYS`, le registre que le tunnel lit
 * lui-même (`lib/booking/draft.ts`). Les réécrire ici — `?etape=creneau` en
 * clair — aurait produit exactement la divergence que ce registre existe pour
 * empêcher : un renommage côté tunnel, et le bouton « Choisir » retomberait
 * silencieusement sur l'étape « prestation ».
 *
 * ## Pourquoi `creneau` et pas `prestation`
 *
 * La prestation vient d'être choisie : la redemander serait faire recommencer ce
 * qu'on vient de faire. `reachableStep` garde le dernier mot — une prestation
 * que le catalogue ne résout plus ramène d'elle-même à la première étape — si
 * bien qu'une URL périmée ne peut pas ouvrir un écran troué.
 */
export function serviceBookingHref(reservationPath: string, serviceId: string): string {
  const params = new URLSearchParams();

  params.set(BOOKING_QUERY_KEYS.step, 'creneau');
  params.set(BOOKING_QUERY_KEYS.service, serviceId);

  return `${reservationPath}?${params.toString()}`;
}
