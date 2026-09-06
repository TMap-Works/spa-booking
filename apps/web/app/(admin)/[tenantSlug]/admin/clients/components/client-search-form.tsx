'use client';

import { CUSTOMER_SEARCH_MIN_LENGTH } from '@spa/shared';
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

    // La borne est celle du contrat, lue et non recopiée. La signaler ici évite
    // un aller-retour qui reviendrait en 400 — et le message est posé **sur le
    // champ**, pas en bloc en haut de l'écran (web-frontend §4).
    if (trimmed.length < CUSTOMER_SEARCH_MIN_LENGTH) {
      setError(
        `Il faut au moins ${String(CUSTOMER_SEARCH_MIN_LENGTH)} caractères pour chercher — une lettre seule ramènerait tout le fichier.`,
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
