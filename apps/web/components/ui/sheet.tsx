'use client';

import { useEffect, useId, useRef, type MouseEvent, type ReactNode } from 'react';

import { Icon } from '@/components/ui/icon';

interface SheetProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly title: string;
  readonly children: ReactNode;
  /** L'action qui conclut le panneau, collée en bas. */
  readonly footer?: ReactNode;
}

/**
 * Panneau de choix secondaire (#1044) — le mois complet depuis la bande de
 * jours, le choix du praticien, le récapitulatif déplié (BM-TUNNEL-12).
 *
 * Il monte du bas de l'écran sur un téléphone, là où le pouce l'attend, et
 * s'ouvre sur le côté au-delà de 48 rem. Bâti comme la modale sur `<dialog>`
 * ouvert par `showModal()` : piège de focus, Échap, inertie du fond et calque
 * supérieur viennent du navigateur, et le focus revient seul à l'élément qui
 * l'a ouvert à la fermeture.
 *
 * Contrôlé : l'appelant tient `open`. Toute fermeture — Échap, le bouton,
 * un clic sur le voile — passe par `onClose`.
 */
export function Sheet({ open, onClose, title, children, footer }: SheetProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const element = dialog.current;
    if (element === null) {
      return;
    }
    if (open && !element.open) {
      // jsdom n'implémente pas `showModal` : l'attribut suffit à le simuler.
      if (typeof element.showModal === 'function') {
        element.showModal();
      } else {
        element.setAttribute('open', '');
      }
    } else if (!open && element.open) {
      if (typeof element.close === 'function') {
        element.close();
      } else {
        element.removeAttribute('open');
      }
    }
  }, [open]);

  // Un clic dont la cible est le `<dialog>` lui-même est tombé sur le voile :
  // le panneau occupe tout le reste.
  const onBackdropClick = (event: MouseEvent<HTMLDialogElement>): void => {
    if (event.target === event.currentTarget) {
      onClose();
    }
  };

  return (
    <dialog
      ref={dialog}
      className="spa-sheet"
      aria-labelledby={titleId}
      onClose={() => {
        if (open) {
          onClose();
        }
      }}
      onClick={onBackdropClick}
    >
      <div className="spa-sheet__panel">
        <header className="spa-sheet__header">
          <h2 id={titleId} className="spa-sheet__title">
            {title}
          </h2>
          <button type="button" className="spa-sheet__close" onClick={onClose}>
            <Icon name="close" />
            <span className="spa-visually-hidden">Fermer</span>
          </button>
        </header>
        <div className="spa-sheet__body">{children}</div>
        {footer === undefined ? null : <footer className="spa-sheet__footer">{footer}</footer>}
      </div>
    </dialog>
  );
}
