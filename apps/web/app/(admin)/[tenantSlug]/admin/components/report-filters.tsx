'use client';

import { useId, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Select } from '@/components/ui/select';
import type { ReportFilterOption, ReportScope } from '@/lib/admin/reporting-view';
import {
  REPORT_PERIODS,
  REPORT_PERIOD_LABELS,
  rangeRefusal,
  type ReportPeriod,
  type ReportRange,
} from '@/lib/admin/reporting-window';

import { adminReportingPath } from '../paths';

/**
 * La barre de filtres du tableau de bord — premier critère de #75, « sélection
 * de période et filtres par praticien et par service ».
 *
 * ## Pourquoi ce composant est le seul client de l'écran
 *
 * Tout le reste du reporting est du texte et des rectangles, rendus côté serveur
 * (web-frontend §1). Ici il y a un état — la saisie en cours — et une
 * navigation ; le `"use client"` s'arrête donc à ce composant, aussi bas que
 * possible dans l'arbre. Les chiffres, eux, ne traversent jamais la frontière du
 * client : ils sont déjà peints quand ce formulaire se monte.
 *
 * ## Un seul filtre, praticien **ou** prestation
 *
 * Ce n'est pas une simplification d'écran, c'est ce que l'API sait répondre.
 * `GET /reports/appointments` sert **un** axe à la fois et n'accepte aucun
 * filtre : il n'existe pas de réponse à « les coupes de Camille ». Deux
 * sélecteurs combinables auraient donc affiché, sur toute combinaison, un
 * chiffre que rien ne calcule. Le sélecteur unique à deux groupes dit la même
 * chose sans promettre ce qui n'existe pas — et le jour où une route croise les
 * deux axes, c'est ici qu'un second sélecteur s'ajoute.
 *
 * ## Les bornes personnalisées ne s'affichent que si elles servent
 *
 * Les deux champs de date apparaissent sur la période « personnalisée » et
 * seulement là. Toujours visibles, ils auraient laissé croire qu'ils bornent une
 * période nommée — alors que « les 30 derniers jours » se recalculent chaque
 * matin, ce qui est précisément leur intérêt.
 *
 * ## Pourquoi la saisie se resynchronise sur l'URL
 *
 * `useState(range.from)` ne lit sa valeur qu'au **montage**, et une navigation
 * ne remonte pas ce composant : Next rejoue la page et lui passe une nouvelle
 * période, mais React conserve l'instance — et avec elle la saisie précédente.
 * La recette de #75 l'a pris sur le fait : après être passé au mois précédent,
 * rouvrir « personnalisée » pré-remplissait les bornes des **trente derniers
 * jours**, celles du premier rendu, pendant que l'écran affichait bien août. Les
 * deux volets doivent dire la même chose, et c'est l'URL qui fait foi.
 *
 * C'est le défaut que #480 a corrigé sur la recherche du fichier client, et la
 * correction est la même : un **ajustement d'état pendant le rendu**, et non un
 * effet. On mémorise ce que l'URL disait au rendu précédent, et l'on remet les
 * contrôles à sa valeur quand elle change. React relance le rendu avant de
 * peindre, si bien qu'aucun champ n'affiche jamais la valeur périmée.
 *
 * Les deux conduites plus évidentes sont écartées pour les mêmes raisons que
 * là-bas : une `key` sur le formulaire le remonterait et **retirerait le focus**,
 * un `useEffect` ne corrigerait qu'après une première image affichée. Et
 * l'ajustement ne se déclenche pas sous la saisie — seule une navigation change
 * ces trois propriétés.
 */

interface ReportFiltersProps {
  readonly tenantSlug: string;
  readonly period: ReportPeriod;
  readonly range: ReportRange;
  readonly scope: ReportScope;
  readonly staff: readonly ReportFilterOption[];
  readonly services: readonly ReportFilterOption[];
  /** Le fuseau du salon, dit sous les champs — les journées sont les siennes. */
  readonly timeZone: string;
}

/** La valeur du sélecteur de filtre, telle que l'URL la porte. */
function scopeValue(scope: ReportScope): string {
  return scope.key === null ? '' : `${scope.kind}:${scope.key}`;
}

/**
 * Ce que l'URL dit de l'écran, réduit à une chaîne comparable.
 *
 * Une chaîne plutôt qu'un objet : la comparaison se fait à chaque rendu, et deux
 * objets de même contenu ne sont jamais égaux.
 */
function urlState(period: ReportPeriod, range: ReportRange, scope: ReportScope): string {
  return `${period}|${range.from}|${range.to}|${scopeValue(scope)}`;
}

export function ReportFilters({
  tenantSlug,
  period,
  range,
  scope,
  staff,
  services,
  timeZone,
}: ReportFiltersProps) {
  const router = useRouter();
  const fieldId = useId();
  const [pending, startTransition] = useTransition();
  const [selectedPeriod, setSelectedPeriod] = useState<ReportPeriod>(period);
  const [from, setFrom] = useState(range.from);
  const [to, setTo] = useState(range.to);
  const [selectedScope, setSelectedScope] = useState(scopeValue(scope));
  const [error, setError] = useState<string | null>(null);
  // Ce que l'URL disait au rendu précédent — la seule chose qui permette de
  // distinguer « on a navigué » de « la gérante est en train de saisir ».
  const [lastFromUrl, setLastFromUrl] = useState(() => urlState(period, range, scope));

  const fromUrl = urlState(period, range, scope);

  if (fromUrl !== lastFromUrl) {
    setLastFromUrl(fromUrl);
    setSelectedPeriod(period);
    setFrom(range.from);
    setTo(range.to);
    setSelectedScope(scopeValue(scope));
    // Le refus portait sur la saisie qu'on vient de remplacer : le laisser sous
    // des champs redevenus valides accuserait l'URL de ce qu'un autre écran a
    // saisi.
    setError(null);
  }

  const isCustom = selectedPeriod === 'personnalisee';

  const submit = (): void => {
    // Les deux refus sont ceux de l'API (422). Les dire ici évite un
    // aller-retour, et le message se pose sur le champ (web-frontend §4).
    const refusal = isCustom ? rangeRefusal({ from, to }) : null;

    if (refusal !== null) {
      setError(refusal);
      return;
    }

    setError(null);
    startTransition(() => {
      router.push(
        adminReportingPath(tenantSlug, {
          period: selectedPeriod,
          from,
          to,
          scope: selectedScope === '' ? null : selectedScope,
        }),
      );
    });
  };

  return (
    <form
      className="spa-admin-report-filters"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <Select
        id={`${fieldId}-periode`}
        label="Période"
        value={selectedPeriod}
        onChange={(event) => {
          setSelectedPeriod(event.target.value as ReportPeriod);
          setError(null);
        }}
      >
        {REPORT_PERIODS.map((value) => (
          <option key={value} value={value}>
            {REPORT_PERIOD_LABELS[value]}
          </option>
        ))}
      </Select>

      {isCustom ? (
        <>
          <Field
            id={`${fieldId}-du`}
            label="Du"
            type="date"
            value={from}
            onChange={(event) => {
              setFrom(event.target.value);
              setError(null);
            }}
          />
          <Field
            id={`${fieldId}-au`}
            label="Au (inclus)"
            type="date"
            value={to}
            hint={`Journées du salon — ${timeZone}.`}
            {...(error === null ? {} : { error })}
            onChange={(event) => {
              setTo(event.target.value);
              setError(null);
            }}
          />
        </>
      ) : null}

      <Select
        id={`${fieldId}-filtre`}
        label="Filtrer"
        value={selectedScope}
        hint="Un praticien ou une prestation — les deux ne se croisent pas."
        onChange={(event) => {
          setSelectedScope(event.target.value);
        }}
      >
        <option value="">Tout l’établissement</option>
        {staff.length === 0 ? null : (
          <optgroup label="Praticiens">
            {staff.map((option) => (
              <option key={option.key} value={`praticien:${option.key}`}>
                {option.label}
              </option>
            ))}
          </optgroup>
        )}
        {services.length === 0 ? null : (
          <optgroup label="Prestations">
            {services.map((option) => (
              <option key={option.key} value={`prestation:${option.key}`}>
                {option.label}
              </option>
            ))}
          </optgroup>
        )}
      </Select>

      <Button type="submit" variant="accent" loading={pending} loadingLabel="Chargement…">
        Afficher
      </Button>
    </form>
  );
}
