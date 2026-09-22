'use client';

import { updateStaffMemberRequestSchema, type StaffMember } from '@spa/shared';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Notification } from '@/components/ui/notification';
import { TextArea } from '@/components/ui/textarea';

import { updateStaffMemberAction } from '../actions';
import { useAdminSessionRenewal } from '../../components/use-admin-session-renewal';

/**
 * Corriger une fiche praticien, la suspendre, la réactiver — #705.
 *
 * ## Le geste qui manquait
 *
 * `PATCH /v1/staff/:id` est servi depuis #694, et aucun écran ne l'appelait : une
 * fiche créée avec une faute de frappe restait fautive, et un praticien qui
 * quittait le salon continuait d'apparaître dans le tunnel de réservation. La
 * liste du personnel affichait pourtant déjà le badge « Active » / « Suspendue »,
 * que seul le jeu d'essai Prisma savait faire basculer.
 *
 * La place de ce panneau est ici, sur la fiche, et non dans la liste : c'est là
 * que vivent déjà les horaires, les congés et les prestations de la personne, et
 * une bascule dans une ligne de tableau ne dit pas ce qu'elle emporte.
 *
 * ## Suspendre n'est pas supprimer, et il n'y a pas de suppression
 *
 * Les rendez-vous passés citent la fiche et le reporting doit continuer à savoir
 * qui a tenu la cabine. Une fiche suspendue reste donc listée, garde ses
 * horaires et ses affectations — elle cesse seulement de produire des créneaux.
 * Le bouton le dit, et l'écran ne propose rien qui ressemble à une suppression.
 *
 * ## La présentation se relit, depuis #771
 *
 * Elle ne se relisait pas : `StaffMemberDto` ne portait que `id`, `displayName`
 * et `isActive`, si bien que le champ s'ouvrait **vide** au-dessus d'un texte
 * déjà enregistré. La gérante ne pouvait ni savoir ce que le salon retenait de
 * sa praticienne, ni le corriger sans le réécrire de mémoire — et l'aide qu'elle
 * lisait lui expliquait une contrainte de l'API au lieu de lui dire quoi faire.
 *
 * `GET /v1/staff` sert désormais `bio`, et le champ s'ouvre donc sur le texte
 * enregistré. Le geste redevient celui qu'on attend d'un formulaire : ce qu'on
 * lit est ce qui est en base, ce qu'on laisse est ce qui y reste, ce qu'on
 * efface disparaît — sans manœuvre, ni bouton dédié à l'effacement.
 *
 * ## Ce que l'aide ne promet pas
 *
 * Elle ne dit pas « affichée sur la page publique du salon ». **Aucune surface
 * publique ne rend `bio` aujourd'hui** — le catalogue public sert
 * `staffMemberSummarySchema`, soit l'identifiant et le nom —, et le CDC ne
 * prescrit nulle part une présentation de praticien en vitrine. Le ticket porte
 * sur une microcopie qui disait faux ; lui en substituer une autre serait le
 * rouvrir en le fermant.
 *
 * Deux conséquences dans ce fichier :
 *
 * - **Ce qui part est ce qui a changé**, mesuré contre la valeur enregistrée et
 *   non contre un drapeau « ce champ a été touché ». Retaper un texte à
 *   l'identique n'envoie rien, et corriger le seul nom ne touche pas à la
 *   présentation.
 * - **Un champ vidé envoie `null`** — « il n'y a pas de présentation » — et non
 *   `""`, qui écrirait une chaîne vide en base là où `NULL` porte déjà ce sens.
 *   C'est le premier des deux constats laissés par la revue de #694, et l'écran
 *   reste l'endroit où il se referme : l'API accepte les deux formes.
 *
 * La réponse, elle, omet `bio` quand la fiche n'en porte pas — le contrat le
 * déclare facultatif et non nullable —, d'où les `?? ''` : c'est la traduction
 * entre « pas de présentation » et « champ vide », et elle n'a qu'un sens.
 *
 * ## Deux boutons plutôt qu'un formulaire unique
 *
 * Enregistrer une correction et suspendre une personne ne se décident pas au
 * même moment ni avec la même prudence. Les réunir sous un seul « Enregistrer »
 * ferait de la suspension l'effet de bord d'une faute de frappe corrigée.
 */

/** Les champs de saisie de ce panneau — `isActive` a son propre bouton. */
type ProfileField = 'displayName' | 'bio';

type ProfileFieldErrors = Partial<Record<ProfileField, string>>;

function isProfileField(value: unknown): value is ProfileField {
  return value === 'displayName' || value === 'bio';
}

export function StaffProfilePanel({
  tenantSlug,
  member,
  canManage = true,
}: {
  readonly tenantSlug: string;
  readonly member: StaffMember;
  /**
   * `false` au rang praticien : `PATCH /v1/staff/:id` est
   * `@AuthAtLeast('MANAGER')`. La fiche reste lisible, ses contrôles
   * disparaissent — comme sur les panneaux voisins, et pour la même raison : ne
   * pas offrir un bouton qui répondrait 403.
   */
  readonly canManage?: boolean;
}) {
  const t = useTranslations('admin-staff');
  const router = useRouter();
  const { renewIfExpired } = useAdminSessionRenewal(tenantSlug);
  // La présentation publiée, telle que la fiche la rend. Absente vaut « aucune
  // présentation » (le contrat la déclare facultative, pas nullable) et se lit
  // dans un champ de saisie comme une chaîne vide : la traduction se fait ici,
  // une fois, et les deux comparaisons ci-dessous portent sur la même valeur.
  const publishedBio = member.bio ?? '';
  const [displayName, setDisplayName] = useState(member.displayName);
  const [bio, setBio] = useState(publishedBio);
  const [active, setActive] = useState(member.isActive);
  // Ce que le dernier rendu serveur disait. La fiche relue — après
  // `router.refresh()`, ou parce qu'une collègue a modifié depuis un autre poste
  // — reprend la main sur l'état local, qui ne sert qu'à tenir l'écran juste
  // entre la réponse de l'API et la fin de la revalidation.
  //
  // La comparaison porte sur les **valeurs** et non sur l'identité de `member` :
  // les panneaux voisins de cette page appellent aussi `router.refresh()`, et
  // chaque rendu serveur rend un objet neuf. Se fier à sa référence effacerait
  // le nom en cours de saisie chaque fois qu'un congé est posé au-dessous.
  const [knownName, setKnownName] = useState(member.displayName);
  if (knownName !== member.displayName) {
    setKnownName(member.displayName);
    setDisplayName(member.displayName);
  }
  const [knownBio, setKnownBio] = useState(publishedBio);
  if (knownBio !== publishedBio) {
    setKnownBio(publishedBio);
    setBio(publishedBio);
  }
  const [knownActive, setKnownActive] = useState(member.isActive);
  if (knownActive !== member.isActive) {
    setKnownActive(member.isActive);
    setActive(member.isActive);
  }
  const [pending, setPending] = useState<'profil' | 'statut' | null>(null);
  const [refreshing, startRefresh] = useTransition();
  const [fieldErrors, setFieldErrors] = useState<ProfileFieldErrors>({});
  const [notice, setNotice] = useState<{ tone: 'success' | 'danger'; message: string } | null>(null);

  const trimmedName = displayName.trim();
  const trimmedBio = bio.trim();
  const nameChanged = trimmedName !== member.displayName;
  // La comparaison porte sur la valeur **publiée**, et non sur un drapeau « ce
  // champ a été touché » : depuis que la présentation se relit, retaper le même
  // texte n'est plus une modification, et le bouton n'a pas à s'allumer pour un
  // aller-retour dans le champ. Les deux côtés sont rognés — `longTextSchema`
  // rogne à l'entrée, si bien qu'une espace ajoutée en fin de ligne partirait
  // sinon pour être écrite à l'identique.
  const bioChanged = trimmedBio !== publishedBio;
  const somethingToSave = nameChanged || bioChanged;
  /*
   * Écran neutralisé : une écriture est en vol, ou la fiche se relit.
   *
   * La conduite de `StaffScheduleEditor` (`locked = saving || !canManage`), et
   * pour deux raisons qui valent ici aussi.
   *
   * Les **champs** : la resynchronisation d'en haut reprend la main dès que le
   * serveur rend un nom différent de celui du dernier rendu — c'est-à-dire,
   * juste après un enregistrement, le nom qu'on vient d'enregistrer. Une frappe
   * glissée entre la réponse de l'API et la fin de `router.refresh()` serait
   * écrasée sans un mot. Le champ ne se rouvre donc qu'une fois la fiche relue.
   *
   * Les **deux boutons** : `pending` n'a qu'une case pour les deux gestes, et
   * chacun rend la main en la remettant à `null`. Sans cette borne croisée, la
   * réponse de l'enregistrement effacerait l'attente d'une suspension encore en
   * vol, rendant son bouton cliquable une seconde fois — deux `PATCH`
   * concurrents dont l'ordre d'arrivée déciderait de ce que l'écran affiche.
   */
  const locked = pending !== null || refreshing;

  function clearMark(field: ProfileField): void {
    // Le refus disparaît dès qu'on corrige : le laisser afficher « Modification
    // impossible » au-dessus d'une saisie déjà reprise ferait douter du bouton.
    // `null` sur `null` ne coûte pas de rendu, React court-circuite.
    setNotice((current) => (current?.tone === 'danger' ? null : current));
    setFieldErrors((current) => {
      if (current[field] === undefined) {
        // Rendre la même référence plutôt qu'un objet neuf : sans cela, chaque
        // frappe dans un champ sain provoquerait un rendu pour rien.
        return current;
      }

      const next = { ...current };
      delete next[field];
      return next;
    });
  }

  async function save(): Promise<void> {
    // Le corps ne porte que ce qui change — c'est tout l'objet d'un `PATCH`, et
    // c'est ce qui empêche deux gérants d'écraser mutuellement leurs
    // corrections.
    const parsed = updateStaffMemberRequestSchema.safeParse({
      ...(nameChanged ? { displayName: trimmedName } : {}),
      ...(bioChanged ? { bio: trimmedBio === '' ? null : trimmedBio } : {}),
    });

    if (!parsed.success) {
      const errors: ProfileFieldErrors = {};
      let form: string | null = null;

      for (const issue of parsed.error.issues) {
        const field = issue.path[0];

        if (isProfileField(field)) {
          errors[field] ??= issue.message;
        } else {
          form ??= issue.message;
        }
      }

      setFieldErrors(errors);
      setNotice(
        form === null && Object.keys(errors).length > 0
          ? null
          // Le message du contrat partagé est un littéral français : il ne
          // remonte plus à l'écran depuis #848, seul le champ fautif en vient.
          : { tone: 'danger', message: t('profile.invalid') },
      );
      return;
    }

    setPending('profil');
    setFieldErrors({});
    setNotice(null);

    const result = await updateStaffMemberAction(tenantSlug, member.id, parsed.data);

    setPending(null);

    if (!result.ok) {
      if (renewIfExpired(result)) {
        return;
      }
      setNotice({ tone: 'danger', message: result.message });
      return;
    }

    setDisplayName(result.data.displayName);
    setBio(result.data.bio ?? '');
    setNotice({ tone: 'success', message: t('profile.saved') });
    startRefresh(() => {
      router.refresh();
    });
  }

  async function toggleStatus(): Promise<void> {
    const next = !active;

    setPending('statut');
    setNotice(null);

    const result = await updateStaffMemberAction(tenantSlug, member.id, { isActive: next });

    setPending(null);

    if (!result.ok) {
      if (renewIfExpired(result)) {
        return;
      }
      setNotice({ tone: 'danger', message: result.message });
      return;
    }

    setActive(result.data.isActive);
    setNotice({
      tone: 'success',
      message: result.data.isActive ? t('profile.reactivated') : t('profile.suspended'),
    });
    startRefresh(() => {
      router.refresh();
    });
  }

  // `spa-admin-form` borne la colonne de saisie, comme les formulaires de la
  // liste du personnel (#630).
  return (
    <section className="spa-admin__section spa-admin-form" aria-labelledby="fiche-titre">
      <h2 className="spa-admin__section-title" id="fiche-titre">
        {t('profile.title')}
      </h2>
      <p className="spa-admin-toolbar__hint">{t('profile.hint')}</p>

      {notice === null ? null : (
        <Notification
          title={
            notice.tone === 'success' ? t('profile.updatedTitle') : t('profile.failedTitle')
          }
          tone={notice.tone}
        >
          <p>{notice.message}</p>
        </Notification>
      )}

      <Field
        disabled={!canManage || locked}
        error={fieldErrors.displayName}
        hint={t('profile.displayNameHint')}
        id="fiche-nom"
        label={t('profile.displayName')}
        onChange={(event) => {
          setDisplayName(event.target.value);
          clearMark('displayName');
        }}
        required
        value={displayName}
      />

      <TextArea
        disabled={!canManage || locked}
        error={fieldErrors.bio}
        /*
         * Ce que cette phrase dit, et ce qu'elle se garde de promettre.
         *
         * Elle nomme l'état réel — « voici le texte enregistré », « il n'y en a
         * pas » — et le geste qui l'efface. Elle ne dit pas « affichée sur la
         * page publique du salon », comme le faisait la précédente : **aucune
         * surface publique ne rend `bio` aujourd'hui**. Le catalogue public sert
         * `staffMemberSummarySchema`, c'est-à-dire l'identifiant et le nom, et
         * le CDC ne prescrit nulle part une présentation de praticien en
         * vitrine. Remplacer une phrase fausse par une autre serait rouvrir le
         * ticket en le fermant.
         */
        hint={
          publishedBio === '' ? t('profile.bioHintEmpty') : t('profile.bioHintFilled')
        }
        id="fiche-presentation"
        label={t('profile.bio')}
        onChange={(event) => {
          setBio(event.target.value);
          clearMark('bio');
        }}
        value={bio}
      />

      {canManage ? (
        <div className="spa-admin-toolbar">
          <Button
            disabled={!somethingToSave || locked}
            loading={pending === 'profil'}
            loadingLabel={t('profile.saving')}
            onClick={() => void save()}
            variant="accent"
          >
            {t('profile.save')}
          </Button>

          <Button
            disabled={locked}
            loading={pending === 'statut'}
            loadingLabel={t('profile.saving')}
            onClick={() => void toggleStatus()}
            variant={active ? 'quiet' : 'neutral'}
          >
            {active ? t('profile.suspend') : t('profile.reactivate')}
            <span className="spa-visually-hidden">
              {t('profile.statusFor', { name: member.displayName })}
            </span>
          </Button>
        </div>
      ) : (
        <p className="spa-admin-toolbar__hint">{t('profile.restricted')}</p>
      )}
    </section>
  );
}
