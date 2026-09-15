'use client';

import { updateStaffMemberRequestSchema, type StaffMember } from '@spa/shared';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Notification } from '@/components/ui/notification';
import { TextArea } from '@/components/ui/textarea';

import { updateStaffMemberAction } from '../actions';

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
 * ## La présentation ne se relit pas, donc elle ne s'écrase pas
 *
 * Aucune route ne publie `bio` : `StaffMemberDto` ne porte que `id`,
 * `displayName` et `isActive`, en lecture comme en réponse au `PATCH`. Le champ
 * s'ouvre donc **vide**, et le panneau n'envoie `bio` que s'il a été touché.
 * Préremplir avec du vide puis tout renvoyer effacerait, à chaque correction de
 * nom, une présentation que la gérante ne voit même pas.
 *
 * Quand il a été touché et qu'il est vide, ce qui part est `null` — « il n'y a
 * pas de présentation » — et non `""`, qui écrirait une chaîne vide en base là
 * où `NULL` porte déjà ce sens. C'est le premier des deux constats laissés par la
 * revue de #694, et l'écran est l'endroit où il se referme : l'API accepte les
 * deux formes.
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
  const router = useRouter();
  const [displayName, setDisplayName] = useState(member.displayName);
  const [bio, setBio] = useState('');
  // Tant que la présentation n'a pas été touchée, elle ne part pas : l'API ne la
  // rend jamais, et un champ vide ne veut donc pas dire « efface ».
  const [bioEdited, setBioEdited] = useState(false);
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
  const somethingToSave = nameChanged || bioEdited;
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
      ...(bioEdited ? { bio: trimmedBio === '' ? null : trimmedBio } : {}),
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
          : { tone: 'danger', message: form ?? 'Les informations saisies sont invalides.' },
      );
      return;
    }

    setPending('profil');
    setFieldErrors({});
    setNotice(null);

    const result = await updateStaffMemberAction(tenantSlug, member.id, parsed.data);

    setPending(null);

    if (!result.ok) {
      setNotice({ tone: 'danger', message: result.message });
      return;
    }

    setDisplayName(result.data.displayName);
    setBio('');
    setBioEdited(false);
    setNotice({ tone: 'success', message: 'Fiche enregistrée.' });
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
      setNotice({ tone: 'danger', message: result.message });
      return;
    }

    setActive(result.data.isActive);
    setNotice({
      tone: 'success',
      message: result.data.isActive
        ? 'Fiche réactivée : le moteur propose de nouveau ses créneaux.'
        : 'Fiche suspendue : aucun créneau ne sera plus proposé. Ses horaires, ses affectations et ses rendez-vous passés sont intacts.',
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
        Fiche praticien
      </h2>
      <p className="spa-admin-toolbar__hint">
        Le nom que la cliente lit au moment de choisir son praticien, et l’état de la fiche. Une
        fiche suspendue reste listée&nbsp;: elle cesse seulement d’être proposée à la réservation.
      </p>

      {notice === null ? null : (
        <Notification
          title={notice.tone === 'success' ? 'Fiche mise à jour' : 'Modification impossible'}
          tone={notice.tone}
        >
          <p>{notice.message}</p>
        </Notification>
      )}

      <Field
        disabled={!canManage || locked}
        error={fieldErrors.displayName}
        hint="C’est ce nom que la cliente lit au moment de choisir son praticien."
        id="fiche-nom"
        label="Nom d’affichage"
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
        hint="Facultatif — affichée sur la page publique du salon. L’API ne la relit pas : laissez ce champ vide pour ne pas y toucher, videz-le après l’avoir modifié pour l’effacer."
        id="fiche-presentation"
        label="Présentation"
        onChange={(event) => {
          setBioEdited(true);
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
            loadingLabel="Enregistrement…"
            onClick={() => void save()}
            variant="accent"
          >
            Enregistrer la fiche
          </Button>

          <Button
            disabled={locked}
            loading={pending === 'statut'}
            loadingLabel="Enregistrement…"
            onClick={() => void toggleStatus()}
            variant={active ? 'quiet' : 'neutral'}
          >
            {active ? 'Suspendre' : 'Réactiver'}
            <span className="spa-visually-hidden"> la fiche de {member.displayName}</span>
          </Button>
        </div>
      ) : (
        <p className="spa-admin-toolbar__hint">
          La correction d’une fiche et sa suspension sont réservées aux gérants du salon.
        </p>
      )}
    </section>
  );
}
