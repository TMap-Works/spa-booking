import { useTranslations } from 'next-intl';
import type { RefObject } from 'react';

import { BOOKING_STEPS, type BookingStep } from '@/lib/booking/draft';

/**
 * Les étapes que la progression compte — les quatre que la cliente parcourt.
 *
 * `confirmation` en est écartée, et l'issue #1047 le demande explicitement :
 * *« La confirmation ne figure pas dans la barre »*. Ce n'est pas une étape de
 * plus à franchir, c'est ce qui arrive une fois le tunnel terminé, et
 * `wireframes.md` l'écrit de son côté — *« Plus d'indicateur d'étape ni de barre
 * collante : le tunnel est terminé »*. La compter ferait afficher « Étape 4
 * sur 5 » au récapitulatif, c'est-à-dire promettre un écran de saisie de plus
 * juste avant de demander de confirmer.
 */
/*
 * Le type est écrit, et il est plus large que ce que TypeScript infère seul :
 * depuis les prédicats déduits de `filter`, la constante vaudrait l'union des
 * quatre étapes comptées, et `indexOf(step)` refuserait alors une `BookingStep`
 * qui peut valoir `confirmation` — c'est-à-dire précisément le cas que ce
 * composant a à traiter, en rendant `-1`.
 */
export const COUNTED_BOOKING_STEPS: readonly BookingStep[] = BOOKING_STEPS.filter(
  (step) => step !== 'confirmation',
);

interface BookingProgressProps {
  readonly step: BookingStep;
  /**
   * La mention de fuseau, ou `null` quand le visiteur est dans celui du salon.
   *
   * Elle est rendue **ici** parce qu'elle qualifie les horaires de l'étape, et
   * qu'elle n'a de sens qu'une fois : `timeZoneMention` (`lib/format.ts`) la
   * tait déjà quand les deux fuseaux coïncident, ce que la skill web-frontend
   * §3 demande — *« avec la mention explicite du fuseau si le visiteur est
   * ailleurs »*.
   */
  readonly timeZoneMention: string | null;
  /**
   * Le titre, pour que le tunnel y ramène le focus au retour en arrière (#1047).
   *
   * Il est passé en propriété plutôt que posé par un `id` : le titre appartient
   * à ce composant, et le chercher dans le document depuis le tunnel ferait
   * dépendre le rattrapage d'une chaîne qu'aucun type ne relie à ce fichier.
   */
  readonly titleRef?: RefObject<HTMLHeadingElement | null>;
  /**
   * Le titre, quand l'écran pose une autre question que celle de son étape.
   *
   * C'est le cas de l'étape « Coordonnées » devant une visiteuse sans compte :
   * elle y est arrêtée pour se connecter (`AccountGateStep`), et « Comment vous
   * joindre ? » demanderait ce que l'écran ne permet pas de donner. L'étape, et
   * donc le compte « Étape 3 sur 4 », reste la même : c'est bien là qu'elle en
   * est du parcours.
   */
  readonly title?: string | undefined;
}

/**
 * La progression du tunnel (#1047) — « Étape 2 sur 4 », un filet segmenté, et
 * le titre de l'étape.
 *
 * ## Ce qu'elle remplace
 *
 * Un fil de cinq pastilles de texte cliquables (#740). À 360 px, il occupait
 * **trois lignes** — la colonne utile n'en tient qu'une et demie — et poussait
 * le contenu de l'étape sous la ligne de flottaison (audit `d20260918-1`,
 * `ds:standard`). `BM-TUNNEL-09` demande que *« la cliente sache combien il
 * reste à faire »*, et note que Fresha perd ce fil à 390 px : *« c'est la
 * variante à ne pas reprendre »*. Un compte et un filet tiennent sur une ligne
 * à n'importe quelle largeur, et disent la même chose.
 *
 * ## Le retour en arrière n'est plus porté par la progression
 *
 * Les pastilles franchies étaient des boutons de retour. Cette fonction passe
 * à l'en-tête, où `BM-TUNNEL-10` la place — *« un "←" (étape précédente) »*,
 * en cible tactile large — et les étapes où l'on revient corriger quelque chose
 * gardent leur propre bouton nommé (« Corriger mes coordonnées »). Un filet de
 * quatre segments de 3 px, lui, n'est pas une cible cliquable.
 *
 * ## Le filet est décoratif, le compte ne l'est pas
 *
 * « Étape 2 sur 4 » est du texte : tout lecteur d'écran le restitue, sans
 * qu'aucun `role="progressbar"` ait à réécrire en ARIA ce qui est déjà écrit.
 * Le filet, lui, ne fait que dessiner ce compte et porte donc `aria-hidden` —
 * l'entendre reviendrait à entendre quatre fois « étape ».
 *
 * Ce n'est pas `components/ui/progress-bar.tsx` : celui-là est la barre
 * indéterminée de navigation (#830), sans segments ni position, et le
 * détourner obligerait à lui ajouter un état qu'aucun de ses deux appelants
 * n'a — il est consommé tel quel par `loading.tsx`, il n'est pas modifié ici.
 *
 * Server Component : ni état, ni écouteur. Il est rendu dans l'arbre client du
 * tunnel, qui porte l'étape, mais n'ajoute rien à son bundle.
 *
 * ## La langue (#846)
 *
 * Le compte, les cinq titres d'étape et la mention de fuseau viennent du
 * catalogue, sous `tunnel.progress`. `useTranslations` et non
 * `getTranslations` : ce composant n'est pas asynchrone.
 *
 * ### Les titres tiennent sur une ligne à 360 px, dans les deux langues
 *
 * `BM-TUNNEL-11` (`docs/design/benchmark/parcours-client.md`) demande *« un
 * grand titre par écran, formulé comme une action »*, et le critère
 * d'acceptation de #1047 donne 120 px à l'en-tête et à la progression réunis :
 * un titre qui passe à deux lignes en coûte 27 de plus et fait sortir le
 * budget. Une colonne de 328 px en tient environ 28 caractères au corps `xl` —
 * c'est la mesure à vérifier **dans chaque langue** avant d'allonger l'une de
 * ces cinq phrases, et `tests/booking-step-indicator.test.mjs` ne la tient que
 * du côté du corps et de la gouttière.
 *
 * La confirmation garde un titre, sans question : il n'y est plus rien attendu
 * de la cliente, et il ne reprend pas les mots de la pastille de succès qui le
 * suit — deux fois la même phrase à dix pixels d'intervalle.
 */
export function BookingProgress({
  step,
  timeZoneMention,
  titleRef,
  title,
}: BookingProgressProps) {
  const t = useTranslations('booking');
  const rank = COUNTED_BOOKING_STEPS.indexOf(step);
  const total = COUNTED_BOOKING_STEPS.length;

  return (
    <div className="spa-booking__progress">
      {rank === -1 ? null : (
        <p className="spa-booking__progress-line">
          {/* Le compte est écrit, et c'est lui qui porte l'information : le
              filet ci-dessous ne fait que le dessiner (WCAG 1.4.1). */}
          <span className="spa-booking__progress-count">
            {t('tunnel.progress.count', { rank: rank + 1, total })}
          </span>
          <span className="spa-booking__progress-track" aria-hidden="true">
            {COUNTED_BOOKING_STEPS.map((name, index) => (
              <span
                key={name}
                className={
                  index <= rank
                    ? 'spa-booking__progress-segment spa-booking__progress-segment--done'
                    : 'spa-booking__progress-segment'
                }
              />
            ))}
          </span>
        </p>
      )}

      {/*
        Le `<h1>` de la page, et il change à chaque étape.

        Il vivait jusqu'ici dans le layout du tunnel, figé à « Prendre
        rendez-vous » (#623) : le titre de la page ne disait donc jamais ce que
        l'écran demandait. Le déplacer ici est ce qui permet à `BM-TUNNEL-11`
        d'être tenu, et le tunnel n'a toujours qu'un seul titre de niveau 1 —
        le layout n'en pose plus.
      */}
      <h1
        className="spa-booking__title"
        ref={titleRef}
        /* Focalisable par programme sans entrer dans l'ordre de tabulation :
           c'est là que le tunnel ramène le focus au retour en arrière, et un
           titre qui deviendrait un arrêt de tabulation ferait une étape de plus
           à franchir à chaque écran. */
        tabIndex={-1}
      >
        {/* Clé construite, et c'est le seul endroit du composant : les cinq
            titres se distinguent par la seule étape, et cinq `t(...)` littéraux
            derrière une table de correspondance diraient deux fois la même
            chose. L'`as` désigne une clé réelle, que la parité des catalogues
            garantit — même détour que `components/ui/locale-switcher.tsx`. */}
        {title ?? t(`tunnel.progress.titles.${step}` as 'tunnel.progress.titles.prestation')}
      </h1>

      {timeZoneMention === null ? null : (
        // Une ligne, et non deux : cette mention entre dans le budget de hauteur
        // de l'écran, et « Tous les horaires sont affichés en … » passait à la
        // ligne à 360 px. Elle ne dit rien de moins.
        <p className="spa-booking__timezone">
          {t('tunnel.progress.timeZone', { zone: timeZoneMention })}
        </p>
      )}
    </div>
  );
}
