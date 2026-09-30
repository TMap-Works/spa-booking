'use client';

import { CUSTOMER_SEARCH_MAX_LENGTH, CUSTOMER_SEARCH_MIN_LENGTH } from '@spa/shared';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useId, useState, useTransition } from 'react';

import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';

import { adminClientsPath } from '../paths';

/**
 * La recherche du fichier client — premier critère de #54.
 *
 * ## Un seul champ, trois axes
 *
 * Nom, téléphone et e-mail se cherchent d'un **seul terme** : au téléphone,
 * l'opérateur tape ce qu'il a sous la main — un nom, un numéro lu sur un SMS,
 * une adresse sur une confirmation — et n'a pas à choisir un champ avant de
 * chercher. Ce n'est pas une simplification d'écran, c'est le contrat
 * (`customerSearchQuerySchema`), et trois champs distincts auraient obligé
 * l'écran à deviner la nature de ce qui vient d'être tapé.
 *
 * ## Pourquoi le terme part dans l'URL et non dans un état
 *
 * Parce que la liste est rendue par un Server Component, qui lit
 * `?recherche=…` : c'est ce qui fait qu'une recherche se partage d'un poste du
 * comptoir à l'autre et survit à un rafraîchissement. Le composant ne détient
 * donc que la **saisie en cours** ; le résultat, lui, appartient à l'URL.
 *
 * ## Pourquoi une soumission plutôt qu'une frappe différée
 *
 * Le tiroir du planning (#50) cherche à la frappe parce qu'il rend ses résultats
 * lui-même, sans quitter l'écran. Ici chaque recherche est une **navigation** :
 * la différer ne ferait qu'empiler des entrées d'historique que le bouton
 * « retour » devrait ensuite dépiler une à une. `Entrée` et le bouton font la
 * même chose, et `useTransition` désactive le bouton le temps que le serveur
 * réponde — un double clic ne lance pas deux navigations (web-frontend §3).
 *
 * ## Pourquoi la saisie se resynchronise sur l'URL (#480)
 *
 * `useState(term)` ne lit sa valeur initiale qu'au **montage**. Or un « retour »
 * du navigateur ne remonte pas ce composant : Next rejoue la page et lui passe un
 * nouveau `term`, mais React conserve l'instance — et avec elle la saisie
 * précédente. Le champ affichait donc encore « rakoto » pendant que la liste,
 * elle, était revenue au fichier entier. Les deux volets doivent dire la même
 * chose, et c'est l'URL qui fait foi.
 *
 * La correction est un **ajustement d'état pendant le rendu**, et non un effet :
 * on mémorise le `term` déjà vu, et on remet la saisie à la valeur de l'URL
 * quand il change. React relance le rendu avant de peindre, si bien que le champ
 * n'affiche jamais la valeur périmée.
 *
 * Deux conduites plus évidentes ont été écartées, chacune pour une raison
 * précise :
 *
 * - **une `key={term}` sur le formulaire** remonterait le composant, donc
 *   **retirerait le focus** à l'opérateur en train de taper — sur le champ que
 *   le comptoir garde sous les doigts entre deux appels ;
 * - **un `useEffect`** ne corrigerait la valeur qu'**après** un premier rendu
 *   affiché : le champ montrerait la saisie périmée le temps d'une image.
 *
 * L'ajustement n'appelle aucune API du DOM : ni le focus, ni la sélection ne
 * bougent. Il ne se déclenche pas non plus sous la frappe — seule une navigation
 * change `term`.
 */

/**
 * Ce que l'état garde d'une borne franchie — un **motif**, jamais sa phrase
 * (#1354).
 *
 * Le refus ne vient d'aucune API : il est calculé ici, contre les bornes du
 * contrat. Il n'en restait pas moins une phrase en état, et le sélecteur de
 * langue du rail rejoue la route **sans démonter** ce formulaire
 * (`i18n/actions.ts`) : « Il faut au moins 2 caractères pour chercher » restait
 * donc écrit en français sous une liste passée en anglais, sur le champ même
 * qu'on venait de corriger.
 *
 * La clé de catalogue et la **borne qu'elle interpole** sont des données ; la
 * phrase s'écrit au rendu. La borne est rangée plutôt que relue d'une constante
 * parce que c'est elle qui donne son sens au motif — le jour où le contrat en
 * changera, le message affiché dira la borne qui a réellement refusé la saisie,
 * et non celle du rendu courant.
 */
type SearchRefusal =
  | { readonly key: 'tooShort'; readonly min: number }
  | { readonly key: 'tooLong'; readonly max: number };

interface ClientSearchFormProps {
  readonly tenantSlug: string;
  /** Le terme que la page a retenu de l'URL — jamais la saisie brute. */
  readonly term: string;
  /** Ce que la recherche a rendu, dit sous le champ. */
  readonly hint: string;
}

export function ClientSearchForm({ tenantSlug, term, hint }: ClientSearchFormProps) {
  const t = useTranslations('admin-clients.list.search');
  const router = useRouter();
  const fieldId = useId();
  const [value, setValue] = useState(term);
  /** Le **motif** du refus, pas sa phrase (#1354) — voir `SearchRefusal`. */
  const [error, setError] = useState<SearchRefusal | null>(null);
  const [pending, startTransition] = useTransition();
  // Le `term` du rendu précédent — la seule chose qui permette de distinguer
  // « l'URL a changé » de « l'opérateur a tapé ».
  const [lastTerm, setLastTerm] = useState(term);

  if (term !== lastTerm) {
    setLastTerm(term);
    setValue(term);
    // Le refus de la borne portait sur la saisie qu'on vient de remplacer : le
    // laisser sous un champ redevenu valide accuserait l'URL de ce qu'un autre
    // écran a tapé.
    setError(null);
  }

  const submit = (): void => {
    const trimmed = value.trim();

    // Un champ vidé n'est pas une saisie fautive : c'est le geste par lequel on
    // revient au fichier entier. Le refuser obligerait à recharger la page à la
    // main pour sortir d'une recherche.
    if (trimmed === '') {
      setError(null);
      startTransition(() => {
        router.push(adminClientsPath(tenantSlug));
      });
      return;
    }

    // Les bornes sont celles du contrat, lues et non recopiées. Les signaler ici
    // évite un aller-retour qui reviendrait en 400 — et le message est posé
    // **sur le champ**, pas en bloc en haut de l'écran (web-frontend §4).
    if (trimmed.length < CUSTOMER_SEARCH_MIN_LENGTH) {
      setError({ key: 'tooShort', min: CUSTOMER_SEARCH_MIN_LENGTH });
      return;
    }

    // La borne haute compte autant que la basse, et depuis la resynchronisation
    // ci-dessus elle compte davantage : un terme trop long partait dans l'URL,
    // `parseSearchTerm` le rejetait en silence, la page affichait le fichier
    // entier — et le champ, remis à l'URL, effaçait la saisie sans rien dire.
    if (trimmed.length > CUSTOMER_SEARCH_MAX_LENGTH) {
      setError({ key: 'tooLong', max: CUSTOMER_SEARCH_MAX_LENGTH });
      return;
    }

    setError(null);
    startTransition(() => {
      router.push(adminClientsPath(tenantSlug, { term: trimmed }));
    });
  };

  /**
   * La phrase du refus, écrite **ici**, dans la langue de ce rendu (#1354).
   *
   * Deux clés et deux noms d'argument distincts : la borne basse s'interpole en
   * `min`, la haute en `max`, et les confondre laisserait un `{min}` nu au
   * milieu de la phrase de la borne haute. Le branchement les tient séparées, et
   * `next-intl` vérifie les deux clés sans cast — elles sont littérales.
   */
  const refusalText =
    error === null
      ? null
      : error.key === 'tooShort'
        ? t('tooShort', { min: error.min })
        : t('tooLong', { max: error.max });

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      noValidate
    >
      <Field
        id={`${fieldId}-recherche`}
        label={t('label')}
        type="search"
        value={value}
        hint={hint}
        autoComplete="off"
        {...(refusalText === null ? {} : { error: refusalText })}
        onChange={(event) => {
          setValue(event.target.value);
        }}
      />
      <Button type="submit" variant="accent" block loading={pending} loadingLabel={t('searching')}>
        {t('submit')}
      </Button>
    </form>
  );
}
