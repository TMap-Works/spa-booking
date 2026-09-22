'use client';

import { errorMessage, localeSchema, type Locale, type SessionUser } from '@spa/shared';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Notification } from '@/components/ui/notification';
import { Select } from '@/components/ui/select';
import { SUPPORTED_LOCALES } from '@/i18n/resolve';

import { useAdminSessionRenewal } from '../../components/use-admin-session-renewal';
import { saveMemberLocaleAction } from '../actions';

/**
 * La langue préférée du **compte connecté**, réglée depuis le back-office
 * (#853, troisième critère d'acceptation : *« un membre de l'équipe peut
 * enregistrer sa langue préférée ; après sa connexion, le back-office s'affiche
 * dans cette langue »*).
 *
 * ## Pourquoi elle est ici et non dans le formulaire de l'établissement
 *
 * Ce ne sont pas les mêmes réglages, ni la même autorisation. `PATCH /tenant`
 * est fermé au rang `ADMIN` ; `PATCH /users/me` est ouvert à tout compte
 * authentifié, et c'est bien ce que le critère demande — un **membre de
 * l'équipe**, pas seulement le gérant. Les deux cartes sont donc distinctes :
 * une praticienne qui ouvre cet écran voit « Accès réservé » sur les réglages du
 * salon et règle quand même sa langue, sur la carte d'à côté.
 *
 * ## Trois valeurs, parce que le contrat en porte trois
 *
 * `fr`, `en`, et **`null`** — « aucune préférence », qui rend la main à la
 * langue de l'établissement (`Tenant.defaultLocale`, #844). La chaîne vide est
 * la façon dont un `<select>` transporte ce `null`, un `<option value="">` étant
 * le seul moyen d'offrir « rien » dans un contrôle natif ; la conversion se fait
 * dans l'action.
 *
 * ## Le choix s'applique tout de suite, et partout
 *
 * L'action pose les cookies de langue (`account-locale.ts`) et le
 * `router.refresh()` qui suit repeint l'écran dans la langue enregistrée. Une
 * préférence qui n'aurait d'effet qu'à la visite suivante se lirait comme un
 * réglage qui n'a pas pris. Elle vaut ensuite sur **tous** les appareils : c'est
 * le compte qui la porte, et `session.ts` en recopie le miroir à chaque
 * ouverture de session.
 *
 * ## Sans état du formulaire
 *
 * Un seul contrôle, aucune règle de saisie que le `<select>` ne tienne déjà :
 * `react-hook-form` n'apporterait rien ici qu'un résolveur à construire. La
 * valeur est tenue par un `useState`, et le bouton reste désarmé tant qu'elle
 * n'a pas changé — le même « rien à enregistrer » que l'écran des coordonnées
 * obtient de `isDirty`.
 */

interface MemberLocaleFormProps {
  /** Le compte connecté, ou `null` quand `/auth/me` n'a pas répondu. */
  readonly profile: SessionUser | null;
  readonly tenantSlug: string;
}

/** La valeur du contrôle : une langue, ou la chaîne vide pour « aucune ». */
type LocaleChoice = Locale | '';

export function MemberLocaleForm({ profile, tenantSlug }: MemberLocaleFormProps) {
  const t = useTranslations('admin-settings.member');
  // Les noms de langues viennent du sélecteur partagé : « Français » et
  // « English », chacun dans sa propre langue (#845).
  const languages = useTranslations('locale');
  const locale = useLocale() as Locale;
  const router = useRouter();
  const { renewIfExpired } = useAdminSessionRenewal(tenantSlug);
  const stored: LocaleChoice = profile?.locale ?? '';
  const [choice, setChoice] = useState<LocaleChoice>(stored);
  const [known, setKnown] = useState<LocaleChoice>(stored);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  /*
   * La préférence enregistrée peut arriver **après** le premier rendu : un
   * `router.refresh()` déclenché ailleurs sur l'écran — le « Réessayer » de la
   * carte voisine, quand `GET /auth/me` avait d'abord échoué — repeint le
   * serveur sans démonter ce composant. Sans ce recalage, le sélecteur serait
   * resté sur « Langue de l'établissement » pendant que le compte porte le
   * français, et le bouton actif aurait proposé d'effacer une préférence que
   * personne n'a touchée.
   *
   * Recalé sur le **changement** de la valeur enregistrée, et non à chaque
   * rendu : un choix en cours de saisie n'est pas écrasé par un rafraîchissement
   * qui ne dit rien de neuf. C'est le motif de recalage d'état de React, qui se
   * règle pendant le rendu plutôt que dans un effet — l'écran n'est jamais peint
   * avec la valeur périmée.
   */
  if (known !== stored) {
    setKnown(stored);
    setChoice(stored);
  }

  async function save(): Promise<void> {
    if (saving) {
      return;
    }

    setSaving(true);
    setSaved(false);
    setFailure(null);

    try {
      const result = await saveMemberLocaleAction(tenantSlug, choice);

      if (!result.ok) {
        // Une session à renouveler part vers la route de renouvellement, qui
        // rend la main sur cette page ; le message n'aurait été qu'un cul-de-sac.
        if (!renewIfExpired(result)) {
          // Le `code` et non le `message` : celui de l'API n'est pas traduit.
          setFailure(errorMessage(result.code, locale));
        }
        return;
      }

      setSaved(true);
      // La page et la coquille sont rendues côté serveur : sans ce
      // rafraîchissement, l'écran resterait peint dans la langue d'avant.
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  return (
    <section aria-labelledby="reglages-ma-langue-titre" className="spa-admin__section">
      <h2 className="spa-admin__section-title" id="reglages-ma-langue-titre">
        {t('title')}
      </h2>

      {profile === null ? (
        <Notification tone="warning" title={t('unavailableTitle')}>
          <p>{t('unavailableBody')}</p>
        </Notification>
      ) : (
        <>
          {saved ? (
            <Notification tone="success" title={t('savedTitle')}>
              <p>{t('savedBody')}</p>
            </Notification>
          ) : null}

          {failure === null ? null : (
            <Notification tone="danger" title={t('failureTitle')}>
              <p>{failure}</p>
            </Notification>
          )}

          <Select
            id="member-locale"
            label={t('label')}
            hint={t('hint')}
            onChange={(event) => {
              const next = localeSchema.safeParse(event.target.value);
              setChoice(next.success ? next.data : '');
              setSaved(false);
            }}
            value={choice}
          >
            {/* « Langue de l'établissement » d'abord : c'est la valeur d'un
                compte qui n'a jamais choisi, et le contrat la distingue d'une
                langue (`locale: null`). */}
            <option value="">{t('establishmentOption')}</option>
            {SUPPORTED_LOCALES.map((supported) => (
              <option key={supported} value={supported} lang={supported}>
                {languages(`names.${supported}` as 'names.en')}
              </option>
            ))}
          </Select>

          <Button
            disabled={choice === stored}
            loading={saving}
            loadingLabel={t('submitting')}
            onClick={() => void save()}
            type="button"
            variant="accent"
          >
            {t('submit')}
          </Button>
        </>
      )}
    </section>
  );
}
