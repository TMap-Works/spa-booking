import { UNSTAFFED_SERVICE_LABEL } from '@/components/salon/service-catalog';

/**
 * Ce que la liste affiche quand une prestation reste rattachée à des praticiens
 * dont **aucun n'est actif** (#895).
 *
 * Deuxième libellé plutôt que réemploi de `UNSTAFFED_SERVICE_LABEL`, et ce n'est
 * pas une nuance de rédaction : « Aucun praticien » serait faux ici. La fiche de
 * la prestation liste le praticien, sous « Compte désactivé »
 * (`service-staff-panel.tsx`), et la liste qui l'ouvre ne peut pas prétendre qu'il
 * n'existe pas — c'est la règle d'alignement liste ↔ fiche posée par #885. La
 * seconde moitié de la phrase, elle, est mot pour mot celle de la vitrine : c'est
 * la conclusion qui doit coïncider d'un écran à l'autre, et elle coïncide.
 *
 * Pourquoi l'écart entre les deux écrans existe : le catalogue public ne publie
 * que les praticiens actifs (`PUBLIC_SERVICE_SELECT`), et l'aperçu affiche donc
 * « Aucun praticien — pas de créneau en ligne » dans les deux cas. Il dit vrai à
 * la cliente, qui n'a que faire de savoir *pourquoi* ; le back-office, lui, doit
 * distinguer les deux causes, parce que les gestes qui les corrigent ne sont pas
 * les mêmes — affecter un praticien, ou réactiver un compte. L'aperçu énonce
 * d'ailleurs déjà cette alternative dans son encart.
 */
export const INACTIVE_STAFF_SERVICE_LABEL = 'Aucun praticien actif — pas de créneau en ligne';

/**
 * Le badge de réservabilité d'une prestation, dans la liste du catalogue.
 *
 * ## Réservabilité et affectation sont deux axes, pas un
 *
 * Le badge est adossé à `activeAssignedStaffCount` — les praticiens **actifs**,
 * le même ensemble que celui dont le moteur de disponibilité tire des créneaux et
 * que la vitrine nomme. `assignedStaffCount` ne décide pas de sa présence : il ne
 * décide que du libellé, c'est-à-dire de la **cause** annoncée.
 *
 * Tant que le seul compte disponible était celui des affectations, désactivés
 * compris (#885), la liste se taisait sur une prestation dont l'unique praticien
 * venait d'être désactivé — quand l'aperçu public, lui, l'annonçait injoignable.
 * C'est l'écart `ds:coherence` que #895 referme.
 *
 * ## Rien quand la prestation est réservable
 *
 * Un badge « Réservable » sur la majorité des lignes serait du bruit : la colonne
 * « État » porte déjà l'activité, et un second badge présent partout n'apprendrait
 * rien. Le badge signale l'exception, comme il le faisait déjà.
 *
 * ## Pourquoi `--pending` dans les deux cas
 *
 * Les deux états appellent le même geste — il y a quelque chose à faire avant que
 * la prestation se vende en ligne — et le back-office n'a pas de troisième teinte
 * à leur consacrer (voir `CatalogStatusBadge`). Le texte porte seul la
 * distinction, et c'est la règle : jamais la couleur seule (WCAG 1.4.1).
 *
 * ## Il s'affiche quel que soit l'état d'activité
 *
 * Comme la fiche affiche « Aucun praticien affecté » sans regarder `isActive` :
 * une prestation désactivée que personne ne peut honorer n'offrira rien de plus le
 * jour où on la réactive, et c'est utile de l'apprendre avant.
 *
 * ## L'espace qui le précède est le sien
 *
 * Il sépare ce badge de celui d'activité, et vit ici plutôt que dans la cellule
 * appelante pour que la condition d'affichage n'ait qu'une écriture — une seconde,
 * côté page, se serait mise à diverger de celle-ci. Un espace plutôt qu'une marge :
 * les deux badges peuvent alors passer à la ligne quand la colonne se resserre, là
 * où un `white-space: nowrap` commun les aurait poussés hors du conteneur qui
 * défile (#612).
 */
export function ServiceBookabilityBadge({
  assignedStaffCount,
  activeAssignedStaffCount,
}: {
  readonly assignedStaffCount: number;
  readonly activeAssignedStaffCount: number;
}) {
  if (activeAssignedStaffCount > 0) {
    return null;
  }

  return (
    <>
      {' '}
      <span className="spa-admin-badge spa-admin-badge--pending">
        {assignedStaffCount === 0 ? UNSTAFFED_SERVICE_LABEL : INACTIVE_STAFF_SERVICE_LABEL}
      </span>
    </>
  );
}
