'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { Button } from '@/components/ui/button';

/**
 * Le lien d'activation d'une invitation, prêt à être transmis (#1143).
 *
 * ## Ce qu'il remplace
 *
 * Les deux écrans qui émettent une invitation — le formulaire d'invitation et
 * la réémission depuis la liste des comptes — rendaient le **jeton nu**, trois
 * cents caractères de JWT dans un champ en lecture seule. Il n'était utilisable
 * nulle part : la page d'activation n'accepte qu'un lien, et ce lien n'existait
 * dans aucune interface. Le seul chemin connu pour activer un compte invité
 * était de composer l'URL à la main.
 *
 * Ce composant rend donc l'adresse complète et le bouton qui la dépose dans le
 * presse-papiers — le même geste que la console de l'éditeur remet au gérant
 * d'un salon (`plateforme/components/access-links.tsx`).
 *
 * ## Pourquoi ce balisage plutôt que `Field`
 *
 * `Field` n'admet pas d'action à côté de son contrôle, et le bouton doit être
 * sur la même ligne que ce qu'il copie — sans quoi rien ne dit lequel des champs
 * de l'écran il vise. Les classes restent celles du design system, à l'exception
 * de la rangée et de sa valeur, déclarées dans `styles/admin/staff.css` et
 * montrées par `mockups/admin/personnel.html`.
 *
 * ## L'état « copié » n'a pas à être remis à zéro
 *
 * Les deux appelants effacent l'invitation précédente **avant** de demander la
 * suivante : le composant est démonté entre deux liens, et son état repart de
 * lui-même. Un effet de remise à zéro sur `url` ne servirait qu'à masquer une
 * régression de ce côté-là.
 */

interface InvitationLinkProps {
  /** Identifiant du contrôle — unique dans la page, le libellé le désigne. */
  readonly id: string;
  /** L'adresse d'activation complète, jeton compris. */
  readonly url: string;
}

export function InvitationLink({ id, url }: InvitationLinkProps) {
  const t = useTranslations('admin-staff.invitationLink');
  const [copied, setCopied] = useState(false);

  /**
   * Dépose le lien dans le presse-papiers, et le dit.
   *
   * Le refus est avalé sans bruit : `navigator.clipboard` n'existe pas hors
   * contexte sécurisé, et l'autorisation peut être retirée. Le champ reste alors
   * en lecture seule, sélectionné au premier coup de tabulation — c'est le
   * repli, et il suffit.
   */
  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="spa-admin-invite-link">
      <label className="spa-field__label" htmlFor={id}>
        {t('label')}
      </label>
      <p className="spa-field__hint" id={`${id}-hint`}>
        {t('hint')}
      </p>
      <div className="spa-admin-invite-link__row">
        {/* Un champ en lecture seule plutôt qu'un `<code>` : le lien fait plus
            de trois cents caractères d'un seul tenant, et sans coupure possible
            il pousse la page entière en défilement horizontal. Le champ le borne
            à sa propre boîte. */}
        <input
          aria-describedby={`${id}-hint`}
          className="spa-field__control spa-admin-invite-link__value"
          id={id}
          onFocus={(event) => event.currentTarget.select()}
          readOnly
          value={url}
        />
        <Button onClick={() => void copy()} variant="neutral">
          {copied ? t('copied') : t('copy')}
        </Button>
      </div>
    </div>
  );
}
