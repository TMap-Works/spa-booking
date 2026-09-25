'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { Button } from '@/components/ui/button';

/**
 * L'attribut posé sur `<html>` le temps d'une impression de ticket —
 * `data-printing="ticket"`. Un attribut et non une classe : ce n'est pas un
 * style du design system, c'est un état que la feuille d'impression lit.
 */
const PRINTING_ATTRIBUTE = 'data-printing';

/**
 * « Imprimer le ticket » — et **seulement** le ticket, pas la page.
 *
 * `window.print()` imprime le document entier : le rail, la liste des
 * rendez-vous, le panneau de paiement. C'est ce que le comptoir obtenait, et ce
 * n'est pas un ticket.
 *
 * Le clic monte donc une copie du ticket **directement sous `<body>`** (un
 * portail), pose un attribut sur `<html>`, et la feuille d'impression masque tout
 * ce qui n'est pas cette copie (`styles/admin/receipt-ticket.css`). La page
 * n'est pas cachée par `visibility` mais retirée du flux : sinon sa hauteur
 * produirait des pages blanches derrière le ticket.
 *
 * La copie n'est montée qu'au premier clic, et reste ensuite en place, masquée
 * à l'écran (`display: none`, donc hors de l'arbre d'accessibilité) : un
 * navigateur qui ne signale pas la fin de l'impression ne doit pas empêcher
 * d'imprimer une seconde fois. Chaque clic incrémente `requests`, et c'est ce
 * compteur — pas un booléen qu'`afterprint` devrait rabattre — qui relance
 * l'impression.
 *
 * ## Le libellé vient du catalogue — #1199
 *
 * `label` était une **prop facultative dont le défaut était français**, et son
 * unique appelant (`checkout-receipt.tsx`) ne la passait pas : le bouton disait
 * « Imprimer le ticket » sous un rouleau entièrement traduit par #1248, à côté
 * de deux boutons de PDF qui, eux, suivaient la langue. C'était le dernier mot
 * français de l'aperçu du ticket de caisse anglais.
 *
 * La prop est retirée plutôt que rebranchée sur un défaut traduit : une valeur
 * par défaut écrite ici resterait hors de portée de la règle de lint — un défaut
 * de paramètre n'est pas du JSX —, et aucun appelant n'en voulait d'autre. Le
 * libellé se lit donc sur `admin-checkout`, le namespace du comptoir, seul lieu
 * d'où ce bouton est monté.
 *
 * `useTranslations` et non `getTranslations` : le fichier porte `'use client'`
 * — il tient un état et un effet — et `next-intl/server` lève « not supported in
 * Client Components » (web-frontend §1).
 */
export function TicketPrinter({
  children,
}: {
  /** Ce qui s'imprime — le même rendu que l'aperçu à l'écran. */
  readonly children: ReactNode;
}) {
  const t = useTranslations('admin-checkout');
  const [requests, setRequests] = useState(0);

  useEffect(() => {
    if (requests === 0) {
      return;
    }

    const root = document.documentElement;
    const done = (): void => {
      root.removeAttribute(PRINTING_ATTRIBUTE);
    };

    root.setAttribute(PRINTING_ATTRIBUTE, 'ticket');
    window.addEventListener('afterprint', done, { once: true });
    window.print();

    return () => {
      window.removeEventListener('afterprint', done);
      done();
    };
  }, [requests]);

  return (
    <>
      <Button
        onClick={() => {
          setRequests((count) => count + 1);
        }}
        variant="accent"
      >
        {t('receipt.print')}
      </Button>
      {requests === 0
        ? null
        : createPortal(<div data-print-ticket="">{children}</div>, document.body)}
    </>
  );
}
