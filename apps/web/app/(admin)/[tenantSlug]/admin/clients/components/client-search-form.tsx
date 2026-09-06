'use client';

import { CUSTOMER_SEARCH_MAX_LENGTH, CUSTOMER_SEARCH_MIN_LENGTH } from '@spa/shared';
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

interface ClientSearchFormProps {
  readonly tenantSlug: string;
  /** Le terme que la page a retenu de l'URL — jamais la saisie brute. */
  readonly term: string;
  /** Ce que la recherche a rendu, dit sous le champ. */
  readonly hint: string;
}

export function ClientSearchForm({ tenantSlug, term, hint }: ClientSearchFormProps) {
  const router = useRouter();
  const fieldId = useId();
  const [value, setValue] = useState(term);
  const [error, setError] = useState<string | null>(null);
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
      setError(
        `Il faut au moins ${String(CUSTOMER_SEARCH_MIN_LENGTH)} caractères pour chercher — une lettre seule ramènerait tout le fichier.`,
      );
      return;
    }

    // La borne haute compte autant que la basse, et depuis la resynchronisation
    // ci-dessus elle compte davantage : un terme trop long partait dans l'URL,
    // `parseSearchTerm` le rejetait en silence, la page affichait le fichier
    // entier — et le champ, remis à l'URL, effaçait la saisie sans rien dire.
    if (trimmed.length > CUSTOMER_SEARCH_MAX_LENGTH) {
      setError(
        `La recherche s’arrête à ${String(CUSTOMER_SEARCH_MAX_LENGTH)} caractères — au-delà, aucune fiche ne peut correspondre.`,
      );
      return;
    }

    setError(null);
    startTransition(() => {
      router.push(adminClientsPath(tenantSlug, { term: trimmed }));
    });
  };

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
        label="Rechercher un client"
        type="search"
        value={value}
        hint={hint}
        autoComplete="off"
        {...(error === null ? {} : { error })}
        onChange={(event) => {
          setValue(event.target.value);
        }}
      />
      <Button type="submit" variant="accent" block loading={pending} loadingLabel="Recherche…">
        Rechercher
      </Button>
    </form>
  );
}
