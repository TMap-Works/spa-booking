import Link from 'next/link';
import type { ReactNode } from 'react';

import { Button, type ButtonVariant } from '@/components/ui/button';

/**
 * La barre « période précédente · période · période suivante · aujourd'hui » du
 * back-office (#629).
 *
 * ## Pourquoi un composant, et pas deux barres qui se ressemblent
 *
 * Le planning et l'encaissement font exactement le même geste — reculer et
 * avancer d'une journée — et le rendaient de deux façons : le planning avec deux
 * boutons encadrés à chevrons encadrant la date, plus un retour au jour courant ;
 * l'encaissement avec deux liens en texte turquoise posés **avant** la date, et
 * sans retour au jour courant. Le back-office s'ouvre à longueur de journée sur
 * ces deux écrans, et l'opérateur y cherchait la même flèche à deux endroits
 * différents.
 *
 * Le rendu du planning fait foi : c'est le plus employé, et c'est celui qui
 * tenait déjà la cible de 44 px du bout du doigt là où un lien texte ne
 * l'atteint pas. La barre de l'encaissement s'aligne donc dessus, et non
 * l'inverse.
 *
 * ## Le même composant sur un écran serveur et un écran client
 *
 * Le fichier ne porte **pas** de directive `'use client'`, et c'est délibéré :
 * il ne tient aucun état et n'appelle aucun hook, si bien que Next.js le compile
 * dans le graphe de celui qui l'importe. Le planning — `CalendarBoard`, un Client
 * Component qui garde en cache les périodes voisines — l'importe donc côté
 * client et lui passe des gestes ; l'encaissement — un Server Component qui n'a
 * aucune raison d'embarquer du JavaScript pour changer de jour — l'importe côté
 * serveur et lui passe des chemins (web-frontend §1).
 *
 * D'où la forme de `PeriodNavControl` : **soit** un `href`, **soit** un
 * `onSelect`. Une fonction n'est pas sérialisable à travers la frontière serveur
 * → client ; imposer `onSelect` aurait forcé l'encaissement à devenir client
 * pour trois liens, et imposer `href` aurait fait repasser le planning par le
 * serveur à chaque flèche, alors qu'il a précisément préchargé la période
 * voisine pour ne pas le faire.
 *
 * Les deux branches rendent la même chose : `.spa-button` est écrit sans
 * sélecteur d'élément et remet `text-decoration` à zéro, un `<a>` et un
 * `<button>` y sont donc peints à l'identique (`styles/components/button.css`).
 */

/** Ce qu'un contrôle de la barre déclenche : une navigation, ou un geste local. */
export type PeriodNavControl = { readonly href: string } | { readonly onSelect: () => void };

interface PeriodNavProps {
  /** La période ouverte, telle qu'elle s'annonce — « Vendredi 11 septembre 2026 ». */
  readonly label: string;
  readonly previous: PeriodNavControl;
  /**
   * Ce que le lecteur d'écran annonce sur le chevron gauche. Le chevron seul ne
   * dit rien : il est `aria-hidden`, et c'est ce libellé qui nomme le contrôle.
   * Il est demandé à l'appelant parce qu'il dépend de la vue — « Jour précédent »
   * sur l'encaissement et sur la vue jour, « Semaine précédente » sur la vue
   * semaine.
   */
  readonly previousLabel: string;
  readonly next: PeriodNavControl;
  /** Ce que le lecteur d'écran annonce sur le chevron droit. */
  readonly nextLabel: string;
  /** Le retour au jour courant **du salon**, jamais à celui du navigateur. */
  readonly today: PeriodNavControl;
}

export function PeriodNav({
  label,
  previous,
  previousLabel,
  next,
  nextLabel,
  today,
}: PeriodNavProps) {
  return (
    <div className="spa-admin-toolbar__group">
      <PeriodNavButton control={previous} variant="neutral">
        <span aria-hidden="true">‹</span>
        <span className="spa-visually-hidden">{previousLabel}</span>
      </PeriodNavButton>

      {/* La date **entre** les deux chevrons : c'est ce qui les lit comme un
       * couple, et c'est ce que le planning rendait déjà. Posée avant eux, comme
       * le faisait l'encaissement, elle laissait deux contrôles orphelins. */}
      <span className="spa-admin-toolbar__caption">{label}</span>

      <PeriodNavButton control={next} variant="neutral">
        <span aria-hidden="true">›</span>
        <span className="spa-visually-hidden">{nextLabel}</span>
      </PeriodNavButton>

      <PeriodNavButton control={today} variant="quiet">
        Aujourd’hui
      </PeriodNavButton>
    </div>
  );
}

/**
 * Un contrôle de la barre, rendu en lien ou en bouton selon ce qu'on lui donne.
 *
 * La branche lien reproduit la structure interne de `Button` — le libellé dans
 * un `.spa-button__label` — plutôt qu'un enfant nu : c'est cette enveloppe que
 * la feuille de style vise pour l'état de chargement, et deux structures
 * différentes sous la même classe finiraient par diverger au premier ajustement.
 */
function PeriodNavButton({
  control,
  variant,
  children,
}: {
  readonly control: PeriodNavControl;
  readonly variant: ButtonVariant;
  readonly children: ReactNode;
}) {
  if ('href' in control) {
    return (
      <Link className={`spa-button spa-button--${variant}`} href={control.href}>
        <span className="spa-button__label">{children}</span>
      </Link>
    );
  }

  return (
    <Button variant={variant} onClick={control.onSelect}>
      {children}
    </Button>
  );
}
