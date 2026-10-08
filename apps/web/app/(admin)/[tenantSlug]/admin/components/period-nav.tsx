import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { Fragment, type ReactNode } from 'react';

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
  /**
   * La période ouverte **contient déjà** la journée courante.
   *
   * Le retour au jour courant n'a alors nulle part où mener : il se rend
   * désactivé, et le dit. Laissé actif, il se presse sans que rien ne bouge —
   * relevé sur « Mon planning », où l'écran s'ouvre précisément sur aujourd'hui,
   * si bien que le tout premier clic de la praticienne ne produisait rien. Un
   * contrôle qui ne fait rien n'est pas un état neutre, c'est un défaut : le
   * gris dit « vous y êtes » là où le noir promettait un déplacement.
   *
   * Omis, la barre se comporte comme avant — l'encaissement et le planning du
   * salon ne sont pas modifiés par ce seul ajout.
   */
  readonly todayIsCurrent?: boolean;
}

export function PeriodNav({
  label,
  previous,
  previousLabel,
  next,
  nextLabel,
  today,
  todayIsCurrent = false,
}: PeriodNavProps) {
  /*
   * Le seul libellé que cette barre écrit elle-même — les deux autres lui sont
   * passés, parce qu'ils dépendent de la vue de l'appelant (#848).
   *
   * `useTranslations` et non une prop de plus : la barre est aussi rendue par
   * l'encaissement, qui est hors du périmètre de ce ticket, et lui imposer une
   * prop l'aurait fait entrer dedans. Le crochet fonctionne des deux côtés de la
   * frontière serveur/client — c'est précisément ce qui permet à ce fichier de
   * rester sans directive.
   */
  const t = useTranslations('admin-planning');

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

      {/* Désactivé plutôt que masqué : la barre garde ses quatre contrôles au
       * même endroit d'une période à l'autre, et le bouton grisé reste ce qui
       * annonce qu'on est sur aujourd'hui. Un `<button disabled>` sort de
       * l'ordre de tabulation et s'annonce « indisponible » — c'est la forme
       * que le design system peint déjà (`styles/components/button.css`). */}
      {todayIsCurrent ? (
        <Button disabled variant="quiet">
          {t('toolbar.today')}
        </Button>
      ) : (
        <PeriodNavButton control={today} variant="quiet">
          {t('toolbar.today')}
        </PeriodNavButton>
      )}
    </div>
  );
}

/** Ce qu'un segment porte, quel que soit ce qu'il déclenche. */
interface PeriodViewSegmentBase {
  /**
   * La clé de la vue — celle que porte l'adresse (`?vue=semaine`).
   *
   * Elle sert de clé React et d'`id` au bouton radio de la variante geste. Les
   * clés restent françaises dans ce back-office, et ce composant ne les traduit
   * pas : seul `label` suit la langue.
   */
  readonly key: string;
  readonly label: string;
  /** Le segment de la vue ouverte. */
  readonly current: boolean;
}

/** Un segment qui mène à une adresse — la variante lien. */
export interface PeriodViewLinkSegment extends PeriodViewSegmentBase {
  readonly control: { readonly href: string };
}

/** Un segment qui déclenche un geste local — la variante radio. */
export interface PeriodViewActionSegment extends PeriodViewSegmentBase {
  readonly control: { readonly onSelect: () => void };
}

/** Un segment du sélecteur de vue : sa clé, son libellé, son état, son geste. */
export type PeriodViewSegment = PeriodViewLinkSegment | PeriodViewActionSegment;

/**
 * Le sélecteur de vue de la barre d'outils — « Jour / Semaine », et « À venir »
 * là où l'écran l'offre (#1412, BM-AGENDA-01).
 *
 * ## Pourquoi un composant, et pas deux rangées qui se ressemblent
 *
 * Même raison que `PeriodNav`, et même constat de campagne : les deux plannings
 * du back-office changeaient de vue de deux façons. Le planning du salon posait
 * un groupe segmenté **dans** la barre, à droite de la date — ce que
 * `BM-AGENDA-01` décrit chez Fresha, Boulevard, Square et Vagaro : « un
 * sélecteur Jour / Semaine dans la barre d'outils, à côté de la navigation de
 * date ». « Mon planning », lui, posait une rangée d'onglets **au-dessus** de la
 * barre, dans une autre brique (`NavTabs`) et une autre allure. L'opérateur qui
 * passe d'un écran à l'autre cherchait le même geste à deux endroits.
 *
 * Le rendu du planning du salon fait foi : c'est lui qui suit le standard du
 * marché, et c'est le groupe segmenté que `styles/admin/shell.css` peint déjà.
 * Le nombre de segments, lui, n'est pas figé — « Mon planning » en a trois.
 *
 * ## Deux variantes, un seul balisage
 *
 * Comme `PeriodNavButton`, et pour la raison écrite en tête de ce fichier : le
 * planning du salon est un Client Component qui garde les périodes voisines en
 * cache et passe donc des **gestes** ; « Mon planning » est rendu par le serveur
 * et sa vue vit dans l'adresse, il passe des **chemins** (web-frontend §1).
 *
 *   - des gestes → des boutons radio natifs dans un `<fieldset>`, d'où viennent
 *     la navigation par flèches et l'annonce « 1 sur 2 » ;
 *   - des chemins → de vrais liens dans un groupe nommé, l'ouvert portant
 *     `aria-current="page"` — qui dit « vous êtes ici » là où `checked`
 *     promettrait un contrôle de formulaire. C'est exactement la paire
 *     `Tabs` / `NavTabs` du design system, et son état ouvert se peint de la
 *     même façon (`styles/components/tabs.css`).
 *
 * Un `<fieldset>` autour de liens aurait été un groupe de champs sans champ : la
 * variante lien emploie `role="group"` et porte son nom en `aria-label`, le
 * `<legend>` n'existant que dans un `<fieldset>`.
 */
export function PeriodViewSwitch({
  label,
  segments,
}: {
  /** Ce qui nomme le groupe — « Vue du planning ». Masqué à l'œil. */
  readonly label: string;
  /**
   * Une seule nature par rangée : un écran passe des gestes **ou** des chemins,
   * jamais les deux. C'est le type qui le tient, et non une convention — c'est
   * la nature des segments qui décide du conteneur, et un mélange rendrait des
   * liens dans un `<fieldset>` dont le `<legend>` nommerait un groupe de champs
   * sans champ, pendant que le segment ouvert resterait sans son fond (la règle
   * `:checked + __option` ne suit pas un `<a>`).
   */
  readonly segments: readonly PeriodViewLinkSegment[] | readonly PeriodViewActionSegment[];
}) {
  // La lecture se fait sur l'union, le mélange étant déjà refusé à l'appel :
  // appeler `.map` sur une union de tableaux n'est pas résoluble autrement.
  const list: readonly PeriodViewSegment[] = segments;
  const navigates = list.every((segment) => 'href' in segment.control);

  const options = list.map((segment) =>
    'href' in segment.control ? (
      <Link
        aria-current={segment.current ? 'page' : undefined}
        className="spa-admin-segmented__option"
        href={segment.control.href}
        key={segment.key}
      >
        {segment.label}
      </Link>
    ) : (
      /* L'entrée masquée **précède** son libellé peint : c'est elle que la règle
         `:checked + __option` de `admin/shell.css` suit, et l'ordre du document
         est ce qui la lui donne. */
      <Fragment key={segment.key}>
        <input
          checked={segment.current}
          className="spa-admin-segmented__input spa-visually-hidden"
          id={`vue-${segment.key}`}
          name="vue"
          onChange={segment.control.onSelect}
          type="radio"
        />
        <label className="spa-admin-segmented__option" htmlFor={`vue-${segment.key}`}>
          {segment.label}
        </label>
      </Fragment>
    ),
  );

  return navigates ? (
    <div aria-label={label} className="spa-admin-segmented" role="group">
      {options}
    </div>
  ) : (
    <fieldset className="spa-admin-segmented">
      <legend className="spa-visually-hidden">{label}</legend>
      {options}
    </fieldset>
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
