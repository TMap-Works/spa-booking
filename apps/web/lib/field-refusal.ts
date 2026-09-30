import { zodErrorMap, type Locale } from '@spa/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { FieldErrors, FieldValues, UseFormSetError, UseFormTrigger } from 'react-hook-form';
import { defaultErrorMap, type ZodIssue } from 'zod';

import { refusalMessage, type Refusal } from './refusal';

/**
 * Un refus **de champ** qui suit la langue — #1354, seconde moitié de #1327.
 *
 * ## Le défaut que ce module referme
 *
 * #1327 a sorti les phrases des états de composant : ce qui va en état est un
 * code, et la phrase s'écrit au rendu (`lib/refusal.ts`). Il a laissé de côté,
 * à dessein, les messages **sous les champs** — et c'est là que le sélecteur de
 * langue laissait le plus de français sous un écran anglais.
 *
 * Deux sources les produisent, et elles n'ont pas le même remède :
 *
 * - **zod**, par `zodErrorMap(locale)`. La phrase est calculée à la validation
 *   et rangée telle quelle dans `formState.errors` de `react-hook-form`, ou
 *   dans la table de champs d'un formulaire qui `safeParse` à la main. Rien ne
 *   la recalcule : le bandeau du formulaire basculait, les messages des champs
 *   restaient dans l'ancienne langue ;
 * - **l'écran lui-même**, par `setError('slug', t('errors.slugTaken'))` après un
 *   refus de l'API. Celle-là n'est pas rejouable : aucune validation locale ne
 *   sait qu'une adresse est déjà prise chez le voisin.
 *
 * ## L'arbitrage que #1354 demandait
 *
 * L'issue posait la question en deux branches : rejouer la validation de tous
 * les champs fautifs — ce qui **efface** les erreurs posées à la main —, ou
 * ranger des clés plutôt que des phrases, ce qui suppose de restructurer la
 * remontée des `ZodIssue`. La réponse est : les deux, chacune là où elle est
 * juste, et le partage se fait sur l'**origine** du message.
 *
 * - Ce que zod a dit se **rejoue**, et seulement sur les champs qui portent
 *   déjà une erreur. Un formulaire ne se met pas à reprocher des champs qu'on
 *   n'a pas encore remplis parce qu'on a changé de langue — c'est déjà la
 *   précaution du champ de prix de `service-form.tsx` (#1327), généralisée ici.
 * - Ce que l'écran a posé se **réécrit** depuis son code, et le champ qui le
 *   porte est exclu du rejeu : sans cette exclusion, la validation locale le
 *   trouverait valable et effacerait le refus de l'API — exactement l'objection
 *   de l'issue.
 * - Un formulaire qui n'emploie pas `react-hook-form` range l'`issue` elle-même,
 *   qui est une **donnée**, et `issueMessage` l'écrit au rendu.
 *
 * Ce module ne connaît aucune phrase : celles du contrat viennent de
 * `zodErrorMap` et d'`errorMessage`, celles d'un écran de son catalogue.
 */

/**
 * La phrase d'une `issue` de zod, écrite **au rendu** dans la langue lue.
 *
 * Ce qui va en état est l'`issue` — son code, son chemin, ses bornes : des
 * données, qui ne se démodent pas quand la langue change. Sa phrase, si.
 *
 * `defaultErrorMap` fournit le `defaultError` que `zodErrorMap` consulte pour
 * les refus qu'elle ne traite pas — un défaut de schéma, pas une faute de
 * saisie. Reprendre `issue.message` à la place aurait remis dans la boucle
 * exactement la phrase périmée que ce module chasse.
 */
export function issueMessage(issue: ZodIssue, locale: Locale): string {
  return zodErrorMap(locale)(issue, {
    defaultError: defaultErrorMap(issue, { defaultError: issue.message, data: undefined }).message,
    data: undefined,
  }).message;
}

/**
 * Un champ fautif : son chemin, et **qui** lui a posé cette erreur-là.
 *
 * `fromResolver` se lit sur le `type` de la `FieldError` : le résolveur de zod
 * y écrit le code de l'issue (`{ message, type: issue.code }`), là où
 * `setError(name, { message })` n'en laisse aucun — `react-hook-form` retire le
 * `type` de l'erreur précédente avant de poser la nouvelle. C'est le seul
 * discriminant disponible, et c'est déjà celui que lisent `signup-form.tsx` et
 * `tenant-create-form.tsx` pour savoir de quelle main vient la phrase affichée.
 */
interface FaultyField {
  readonly path: string;
  readonly fromResolver: boolean;
}

/**
 * Les champs qui portent une erreur, en notation de `react-hook-form` —
 * `phone`, `openingHours.2.closesAt`.
 *
 * La descente s'arrête sur une `FieldError`, reconnue à son `message` ou à son
 * `type`. C'est ce qui garde la marche à l'écart de `ref`, qui porte un nœud du
 * DOM : une récursion naïve y entrerait et remonterait des chemins qui ne
 * désignent aucun champ.
 */
function faultyFieldPaths(errors: unknown, prefix = ''): readonly FaultyField[] {
  if (errors === null || typeof errors !== 'object') {
    return [];
  }

  const bag = errors as Record<string, unknown>;

  if (typeof bag.message === 'string' || typeof bag.type === 'string') {
    return prefix === '' ? [] : [{ path: prefix, fromResolver: typeof bag.type === 'string' }];
  }

  return Object.entries(bag).flatMap(([key, value]) =>
    faultyFieldPaths(value, prefix === '' ? key : `${prefix}.${key}`),
  );
}

/** Ce que le crochet ci-dessous rend à l'écran qui l'appelle. */
export interface FieldRefusals<TFieldValues extends FieldValues> {
  /**
   * Pose sur un champ le refus rendu par l'API, par son **code**.
   *
   * La phrase est écrite aussitôt et réécrite à chaque changement de langue,
   * tant que le champ la porte encore. Remplace `setError(name, { message })`,
   * qui figeait la langue du moment.
   */
  readonly postFieldRefusal: (name: FieldPathOf<TFieldValues>, code: string) => void;
  /** Oublie les refus posés — à appeler au début de chaque soumission. */
  readonly clearFieldRefusals: () => void;
}

/**
 * Le nom d'un champ tel que `setError` et `trigger` l'acceptent.
 *
 * `Parameters<…>[0]` plutôt que `FieldPath<TFieldValues>` importé de
 * `react-hook-form` : c'est **exactement** le type que les deux fonctions
 * attendent, sans qu'il faille en redire la dérivation ni risquer d'en diverger.
 */
type FieldPathOf<TFieldValues extends FieldValues> = Parameters<
  UseFormSetError<TFieldValues>
>[0];

/** Ce que l'écran passe au crochet — la forme des trois crochets de `useForm`. */
export interface LocalizedFieldErrorsOptions<TFieldValues extends FieldValues> {
  /** La langue de ce rendu. */
  readonly locale: Locale;
  /** `formState.errors` de `useForm`. */
  readonly errors: FieldErrors<TFieldValues>;
  readonly trigger: UseFormTrigger<TFieldValues>;
  readonly setError: UseFormSetError<TFieldValues>;
  /**
   * Ce que cet écran dit de mieux que le contrat pour un code donné, `null`
   * pour les autres — le même `own` que `refusalMessage`, et pour la même
   * raison : le repli est la phrase du contrat partagé, dans la langue lue.
   */
  readonly own?: (code: string) => string | null;
}

/**
 * Les messages de champ d'un formulaire `react-hook-form` suivent la langue.
 *
 * À appeler **après** `useForm`, et après tout effet qui réécrit la valeur d'un
 * champ au changement de langue : les effets se jouent dans l'ordre où leurs
 * crochets sont déclarés, et rejouer la validation d'un champ avant que sa
 * valeur n'ait été réécrite la jugerait sur le texte de la langue d'avant
 * (`service-form.tsx`, champ de prix).
 */
export function useLocalizedFieldErrors<TFieldValues extends FieldValues>({
  locale,
  errors,
  trigger,
  setError,
  own,
}: LocalizedFieldErrorsOptions<TFieldValues>): FieldRefusals<TFieldValues> {
  /**
   * Les refus posés par l'API, par champ : un **code**, jamais sa phrase.
   *
   * Une table et non un seul refus — rien n'interdit à une réponse d'en
   * désigner deux —, et les codes y sont rangés dans l'ordre où ils arrivent.
   */
  const [posted, setPosted] = useState<Readonly<Record<string, string>>>({});

  /*
   * Ce que l'effet doit lire sans en dépendre.
   *
   * `errors` change de référence à chaque validation et `own` à chaque rendu
   * (il capture le `t` de `next-intl`) : les mettre en dépendances ferait
   * rejouer la validation à chaque frappe, c'est-à-dire ferait apparaître les
   * messages que `mode: 'onTouched'` retient exprès. Seule la **langue**
   * déclenche cet effet, et la langue seule.
   */
  const errorsRef = useRef(errors);
  errorsRef.current = errors;
  const postedRef = useRef(posted);
  postedRef.current = posted;
  const ownRef = useRef(own);
  ownRef.current = own;
  /** La langue dans laquelle les messages affichés sont écrits. */
  const writtenRef = useRef(locale);

  useEffect(() => {
    if (writtenRef.current === locale) {
      return;
    }

    writtenRef.current = locale;

    const current = postedRef.current;
    const shown = faultyFieldPaths(errorsRef.current);
    /** Ce que chaque champ fautif affiche : `true` si c'est le résolveur qui l'a posé. */
    const origin = new Map(shown.map((field) => [field.path, field.fromResolver]));
    /*
     * Un refus posé ne se réécrit que si le champ l'affiche **encore**.
     *
     * Deux façons de ne plus l'afficher, et une seule condition les couvre
     * toutes deux : la saisie corrigée, dont `react-hook-form` a effacé
     * l'erreur — le code, lui, resterait dans cette table —, et la saisie
     * reprise mais restée fautive, sur laquelle le résolveur a posé la sienne
     * par-dessus. Réécrire dans ce second cas afficherait « cette adresse est
     * déjà prise » sur un champ dont ce qui cloche est la **forme**, et le
     * priverait au passage du rejeu qui, lui, traduit ce que zod a dit.
     */
    const kept: Record<string, string> = {};

    for (const [name, code] of Object.entries(current)) {
      if (origin.get(name) !== false) {
        continue;
      }

      kept[name] = code;
      setError(name as FieldPathOf<TFieldValues>, {
        message: refusalMessage({ code }, locale, ownRef.current),
      });
    }

    if (Object.keys(kept).length !== Object.keys(current).length) {
      setPosted(kept);
    }

    /*
     * Le reste des champs fautifs : leur phrase vient de zod, on la lui
     * redemande. Le résolveur a déjà été refabriqué pour la nouvelle langue —
     * il l'est par un `useMemo`, donc pendant le rendu, avant cet effet.
     *
     * `trigger` avec des noms ne touche que ces champs-là : les autres gardent
     * leur erreur, refus de l'API compris.
     */
    const replayed = shown.map((field) => field.path).filter((name) => !(name in kept));

    if (replayed.length > 0) {
      void trigger(replayed as Parameters<UseFormTrigger<TFieldValues>>[0]);
    }
  }, [locale, setError, trigger]);

  const postFieldRefusal = useCallback(
    (name: FieldPathOf<TFieldValues>, code: string) => {
      setPosted((current) => ({ ...current, [name]: code }));
      setError(name, { message: refusalMessage({ code }, locale, ownRef.current) });
    },
    [locale, setError],
  );

  const clearFieldRefusals = useCallback(() => {
    // La même référence quand il n'y a rien à oublier : un objet neuf
    // provoquerait un rendu à chaque soumission, pour rien.
    setPosted((current) => (Object.keys(current).length === 0 ? current : {}));
  }, []);

  return { postFieldRefusal, clearFieldRefusals };
}

/**
 * Ce qu'un formulaire **sans** `react-hook-form` range pour un champ fautif.
 *
 * Deux origines, deux formes, et aucune des deux n'est une phrase : l'`issue`
 * que le contrat a produite, ou la clé de catalogue que l'écran a choisie —
 * « le numéro n'est pas valable **pour ce pays** », que le contrat ne sait pas
 * dire. `key` est relatif à l'espace de noms que l'écran a ouvert avec
 * `useTranslations`, comme tous ses autres libellés.
 */
export type FieldRefusal =
  | { readonly kind: 'issue'; readonly issue: ZodIssue }
  | { readonly kind: 'key'; readonly key: string }
  | ({ readonly kind: 'code' } & Refusal);

/**
 * La phrase d'un refus de champ, écrite au rendu dans la langue lue.
 *
 * `translate` est le `t` de l'écran ; il n'est consulté que pour une clé, si
 * bien qu'un formulaire qui n'en pose aucune peut s'en passer.
 */
export function fieldRefusalMessage(
  refusal: FieldRefusal | undefined,
  locale: Locale,
  translate?: (key: string) => string,
): string | undefined {
  if (refusal === undefined) {
    return undefined;
  }

  if (refusal.kind === 'issue') {
    return issueMessage(refusal.issue, locale);
  }

  if (refusal.kind === 'code') {
    return refusalMessage(refusal, locale);
  }

  return translate?.(refusal.key);
}
