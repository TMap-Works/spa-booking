'use client';

import type { TimeZone } from '@spa/shared';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';

import { appointmentTimeRange, RESCHEDULED_NOTE } from '@/components/account/appointment-brief';
import {
  groupHistoryByMonth,
  HISTORY_FILTERS,
  HISTORY_PAGE_SIZE,
  matchesHistoryFilter,
  sortHistoryMostRecentFirst,
  type HistoryEntry,
  type HistoryFilter,
  type HistoryMonth,
} from '@/components/account/appointment-history';
import { Badge } from '@/components/ui/badge';
import { DateBlock } from '@/components/ui/date-block';
import { Icon } from '@/components/ui/icon';
import { Tabs, tabPanelProps } from '@/components/ui/tabs';
import { appointmentBadge, RESCHEDULED_LABEL } from '@/lib/appointment-status';
import { formatDuration, formatMoney, timeZoneMention } from '@/lib/format';

/**
 * L'historique de l'espace client : une **liste**, groupée par mois, filtrable
 * et rejouable — #1054.
 *
 * ## Ce qui change, et pourquoi
 *
 * L'audit `d20260918-1` relève neuf cartes de même habillage, sans regroupement,
 * sans filtre et sans action, chacune titrée par la date longue suivie de
 * « (heure de Europe/Paris) » : deux cartes et demie par écran à 360 px. Quatre
 * motifs du benchmark y répondent, et cet écran les applique dans cet ordre.
 *
 * | Motif | Ce qu'il demande | Ce que la liste en fait |
 * |---|---|---|
 * | `BM-HISTO-01` | un rendez-vous honoré reste consultable | rien ne disparaît : le filtre par défaut est « Tous » |
 * | `BM-HISTO-02` | « Réserver à nouveau » depuis un rendez-vous passé | un lien par ligne honorée ou annulée, vers le tunnel déjà rempli |
 * | `BM-VISUEL-05` | un statut s'écrit, la couleur l'appuie | `Badge`, dont le libellé est toujours écrit |
 * | `BM-RDV-06` | le fuseau se mentionne quand il apprend quelque chose | une fois, en tête de liste, et seulement hors du fuseau du salon |
 *
 * ## Pourquoi cet îlot est un Client Component
 *
 * Pour une seule raison, et c'est un critère d'acceptation : **le filtre ne
 * recharge pas la page**. Le porter par l'URL aurait demandé un aller-retour
 * serveur — donc une attente — pour masquer des lignes déjà chargées. Tout le
 * reste de l'onglet — la lecture de l'API avec le jeton, la résolution des noms,
 * la fabrication des liens de reprise — est fait par la page, qui est un Server
 * Component : cet îlot ne reçoit que des lignes prêtes à peindre, et jamais la
 * session.
 *
 * ## Les trois panneaux existent, un seul porte des lignes
 *
 * Chaque onglet déclare `aria-controls` vers son panneau : n'en rendre qu'un
 * laisserait deux onglets désigner des `id` absents du document — ce qu'un audit
 * d'accessibilité relève, et ce qu'aucun test de rendu ne voit. Les trois
 * panneaux sont donc présents, et seul celui qui est ouvert est peuplé : aucun
 * rendez-vous n'est peint deux fois.
 */
interface AppointmentHistoryProps {
  readonly entries: readonly HistoryEntry[];
  readonly timeZone: TimeZone;
}

const ID_PREFIX = 'historique';

export function AppointmentHistory({ entries, timeZone }: AppointmentHistoryProps) {
  const [filter, setFilter] = useState<HistoryFilter>('tous');
  const [visible, setVisible] = useState(HISTORY_PAGE_SIZE);

  /**
   * La mention du fuseau attend le montage, comme sur la carte compacte (#680) :
   * `timeZoneMention` lit le fuseau du **navigateur**, que le rendu serveur n'a
   * aucun moyen de connaître. Absente des deux côtés au premier rendu, les
   * balises s'accordent ; l'effet ne joue qu'ensuite.
   */
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const counts = useMemo(
    () =>
      HISTORY_FILTERS.map((item) => ({
        ...item,
        count: entries.filter((entry) =>
          matchesHistoryFilter(entry.brief.appointment.status, item.id),
        ).length,
      })),
    [entries],
  );

  const currentLabel = HISTORY_FILTERS.find((item) => item.id === filter)?.label ?? '';
  // Trié **avant** d'être coupé par « Voir plus » : la première page doit être
  // celle des dix rendez-vous les plus récents, quel que soit l'ordre où l'API
  // les a servis — `groupHistoryByMonth` ne trierait plus que la tranche.
  const shown = useMemo(
    () =>
      sortHistoryMostRecentFirst(
        entries.filter((entry) => matchesHistoryFilter(entry.brief.appointment.status, filter)),
      ),
    [entries, filter],
  );
  const months = useMemo(
    () => groupHistoryByMonth(shown.slice(0, visible), timeZone),
    [shown, timeZone, visible],
  );

  const remaining = shown.length - visible;
  const mention = mounted ? timeZoneMention(timeZone) : null;

  /**
   * Le filtre repart de sa première page : « Voir plus » cliqué sur « Tous »
   * n'a rien à dire du nombre de lignes qu'« Annulés » mérite d'ouvrir.
   */
  const select = (id: string): void => {
    const next = HISTORY_FILTERS.find((item) => item.id === id);

    if (next === undefined) {
      return;
    }

    setFilter(next.id);
    setVisible(HISTORY_PAGE_SIZE);
  };

  return (
    <div className="spa-history">
      <div className="spa-history__toolbar">
        <Tabs
          idPrefix={ID_PREFIX}
          items={counts.map((item) => ({ id: item.id, label: item.label, count: item.count }))}
          label="Filtrer l’historique"
          onChange={select}
          value={filter}
          variant="segmented"
        />

        {/* Une fois, en tête de liste, et seulement si la visiteuse n'est pas
            déjà dans le fuseau du salon — au lieu d'une fois par ligne. */}
        {mention === null ? null : (
          <p className="spa-history__timezone">Horaires donnés en {mention}.</p>
        )}
      </div>

      {HISTORY_FILTERS.map((item) => (
        // `spa-history__panel` porte sa propre règle `[hidden] { display: none }` :
        // une classe qui pose `display` l'emporterait sinon sur la feuille de
        // l'agent utilisateur, et les trois panneaux resteraient visibles à la
        // fois (même piège que `spa-salon__panel`, #1046).
        <div
          key={item.id}
          {...tabPanelProps(ID_PREFIX, item.id)}
          className="spa-history__panel"
          hidden={item.id !== filter}
        >
          {item.id !== filter ? null : (
            <HistoryMonths empty={item.empty} months={months} timeZone={timeZone} />
          )}
        </div>
      ))}

      {remaining <= 0 ? null : (
        <button
          className="spa-button spa-button--neutral spa-history__more"
          onClick={() => {
            setVisible((shownSoFar) => shownSoFar + HISTORY_PAGE_SIZE);
          }}
          type="button"
        >
          {/* Le libellé dit ce que le clic va faire, et non « Voir plus » : la
              cliente sait alors s'il lui reste une page ou dix lignes. */}
          <span className="spa-button__label">
            Voir {Math.min(HISTORY_PAGE_SIZE, remaining)} rendez-vous de plus
          </span>
        </button>
      )}

      {/* L'effectif servi, annoncé aux lecteurs d'écran à chaque changement de
          filtre : une rangée de pastilles qui masque huit lignes sur neuf ne se
          perçoit pas au clavier autrement. */}
      <p aria-live="polite" className="spa-visually-hidden">
        {countSentence(Math.min(shown.length, visible), shown.length, currentLabel)}
      </p>
    </div>
  );
}

interface HistoryMonthsProps {
  readonly months: readonly HistoryMonth[];
  /** Ce que le filtre ouvert dit de lui-même quand il ne retient rien. */
  readonly empty: string;
  readonly timeZone: TimeZone;
}

/**
 * Le contenu du panneau ouvert : les intertitres de mois et leurs lignes.
 *
 * Le regroupement par mois n'est pas qu'une respiration visuelle : c'est ce qui
 * situe une visite dans le temps sans que chaque ligne ait à porter son année.
 * Chaque mois est une `<section>` nommée par son intertitre, donc un point de
 * repère de la navigation par régions d'un lecteur d'écran.
 */
function HistoryMonths({ months, empty, timeZone }: HistoryMonthsProps) {
  if (months.length === 0) {
    return <p className="spa-history__empty">{empty}</p>;
  }

  return (
    <>
      {months.map((month) => (
        <section
          key={month.key}
          aria-labelledby={`${ID_PREFIX}-mois-${month.key}`}
          className="spa-history__month"
        >
          <h3 className="spa-history__month-title" id={`${ID_PREFIX}-mois-${month.key}`}>
            {month.label}
          </h3>

          <ul className="spa-history__list">
            {month.entries.map((entry) => (
              <HistoryRow key={entry.brief.appointment.id} entry={entry} timeZone={timeZone} />
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}

interface HistoryRowProps {
  readonly entry: HistoryEntry;
  readonly timeZone: TimeZone;
}

/**
 * Une ligne d'historique — bloc date, prestation, statut, et ce qu'on peut en
 * refaire.
 *
 * Trois colonnes plutôt qu'une carte : le bloc date à gauche rend la liste
 * balayable sans lire, la pastille et le prix à droite s'alignent d'une ligne à
 * l'autre, et le tout tient en une hauteur de ligne au lieu d'un encadré. C'est
 * ce qui fait passer l'écran de deux cartes et demie à cinq rendez-vous par
 * écran à 360 px, premier critère d'acceptation de #1054.
 */
function HistoryRow({ entry, timeZone }: HistoryRowProps) {
  const { appointment, serviceName, practitioner, durationMinutes } = entry.brief;
  const badge = appointmentBadge(appointment, 'past');
  const note = appointment.clientNote ?? '';

  return (
    <li className="spa-history__row">
      <DateBlock instant={appointment.startsAt} timeZone={timeZone} />

      <div className="spa-history__body">
        {/* Prestation à gauche, prix à droite sur la même ligne : c'est ce qui
            garde le titre sur une seule ligne à 360 px, là où une colonne de
            droite le comprimait à la moitié de la largeur. Même appariement que
            la liste de prestations de la vitrine. */}
        <div className="spa-history__head">
          <p className="spa-history__service">{serviceName ?? 'Prestation'}</p>
          <p className="spa-history__price">{formatMoney(appointment.price)}</p>
        </div>

        {/* Sans la mention du fuseau : elle est en tête de liste, une fois. */}
        <p className="spa-history__meta">
          {appointmentTimeRange(appointment, timeZone)}
          <span className="spa-history__dot"> · </span>
          {formatDuration(durationMinutes)}
          {practitioner === null ? null : (
            <>
              <span className="spa-history__dot"> · </span>
              {practitioner}
            </>
          )}
        </p>

        {/* « Déplacé » est le seul mot de la table de statuts qui ne dise pas de
            lui-même ce qu'il est advenu du rendez-vous : il garde donc la ligne
            que la carte compacte lui donnait déjà (#1053). Les autres pastilles
            de l'historique — « Honoré », « Annulé par vous », « Non honoré » —
            ne laissent aucune question ouverte, et ne reçoivent rien. */}
        {badge.label !== RESCHEDULED_LABEL ? null : (
          <p className="spa-history__status-note">{RESCHEDULED_NOTE}</p>
        )}

        {note === '' ? null : <ClientNote note={note} />}
      </div>

      <div className="spa-history__aside">
        <Badge tone={badge.tone}>{badge.label}</Badge>

        {entry.rebookHref === null ? null : (
          <Link className="spa-button spa-button--quiet spa-history__rebook" href={entry.rebookHref}>
            {/* Le nom de la prestation est repris pour les lecteurs d'écran :
                dix liens « Réserver à nouveau » identiques ne se distinguent pas
                dans une liste de liens (WCAG 2.4.4). */}
            <span className="spa-button__label">
              Réserver à nouveau
              {serviceName === null ? null : (
                <span className="spa-visually-hidden"> — {serviceName}</span>
              )}
            </span>
          </Link>
        )}
      </div>
    </li>
  );
}

/**
 * La note laissée au salon : une ligne tronquée, dépliable.
 *
 * Elle occupait un encart gris pleine largeur entre guillemets, sous chaque
 * carte — l'audit la relève comme ce qui repousse le rendez-vous suivant hors de
 * l'écran. Elle tient désormais sur la ligne, coupée par le CSS.
 *
 * `<details>` **sans contenu propre** : le texte entier est dans le `<summary>`,
 * et c'est l'ouverture qui lève la troncature (`[open]`, feuille de styles). Le
 * répéter dans le corps du `<details>` l'aurait fait lire deux fois par un
 * lecteur d'écran, alors que la troncature est purement visuelle — la note est
 * toujours entière dans l'arbre d'accessibilité. Et comme rien ici n'est
 * scripté, le pli fonctionne avant même l'hydratation.
 */
function ClientNote({ note }: { readonly note: string }) {
  return (
    <details className="spa-history__note">
      <summary className="spa-history__note-summary">
        <Icon className="spa-history__note-chevron" name="chevron-down" />
        <span className="spa-history__note-text">
          <span className="spa-visually-hidden">Votre note au salon : </span>« {note} »
        </span>
      </summary>
    </details>
  );
}

/** « 5 rendez-vous sur 12 · Annulés » — pour la région animée, jamais à l'écran. */
function countSentence(shown: number, total: number, label: string): string {
  if (total === 0) {
    return `Aucun rendez-vous · ${label}`;
  }

  return `${String(shown)} rendez-vous affichés sur ${String(total)} · ${label}`;
}
