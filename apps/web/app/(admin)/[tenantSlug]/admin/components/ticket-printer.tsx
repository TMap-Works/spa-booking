'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { Button } from '@/components/ui/button';

/** La classe posée sur `<html>` le temps d'une impression de ticket. */
const PRINTING_CLASS = 'spa-printing-ticket';

/**
 * « Imprimer le ticket » — et **seulement** le ticket, pas la page.
 *
 * `window.print()` imprime le document entier : le rail, la liste des
 * rendez-vous, le panneau de paiement. C'est ce que le comptoir obtenait, et ce
 * n'est pas un ticket.
 *
 * Le clic monte donc une copie du ticket **directement sous `<body>`** (un
 * portail), pose une classe sur `<html>`, et la feuille d'impression masque tout
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
 */
export function TicketPrinter({
  children,
  label = 'Imprimer le ticket',
}: {
  /** Ce qui s'imprime — le même rendu que l'aperçu à l'écran. */
  readonly children: ReactNode;
  readonly label?: string;
}) {
  const [requests, setRequests] = useState(0);

  useEffect(() => {
    if (requests === 0) {
      return;
    }

    const root = document.documentElement;
    const done = (): void => {
      root.classList.remove(PRINTING_CLASS);
    };

    root.classList.add(PRINTING_CLASS);
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
        {label}
      </Button>
      {requests === 0
        ? null
        : createPortal(<div className="spa-print-ticket">{children}</div>, document.body)}
    </>
  );
}
