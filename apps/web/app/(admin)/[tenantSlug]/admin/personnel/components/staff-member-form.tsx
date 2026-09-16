'use client';

import { createStaffMemberRequestSchema } from '@spa/shared';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import type { ZodIssue } from 'zod';

import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Notification } from '@/components/ui/notification';
import { Select } from '@/components/ui/select';
import { TextArea } from '@/components/ui/textarea';
import { suggestedStaffDisplayName } from '@/lib/admin/staff-directory';
import type { StaffAccount } from '@/lib/admin/staff-contract';

import { roleLabel } from '../../components/navigation';
import { createStaffMemberAction } from '../actions';
import { useAdminSessionRenewal } from '../../components/use-admin-session-renewal';

/**
 * Création d'une fiche praticien — #694.
 *
 * ## Le geste qui manquait
 *
 * Inviter un compte ne rendait personne réservable : le compte porte l'accès, la
 * fiche porte l'agenda, et aucune route n'écrivait la seconde. Un salon neuf
 * restait donc à « Praticiens — 0 », « Ajouter un praticien » désactivé sur
 * chaque prestation, et le tunnel public répondait « aucun créneau ». Ce
 * formulaire est l'endroit — le seul — où le lien entre un compte et une fiche
 * se pose.
 *
 * ## Pourquoi un compte se choisit, et ne se crée pas ici
 *
 * Une fiche se rattache à un compte existant : c'est ce que l'unicité
 * `(tenant_id, user_id)` exprime, et c'est ce qui permet à la personne de se
 * connecter pour voir son propre planning. Créer les deux d'un même geste
 * paraîtrait plus court, et coûterait la distinction : il faudrait décider à la
 * place de la gérante si la personne a un accès, et on ne saurait plus créer une
 * fiche pour une collègue déjà invitée. L'invitation est juste au-dessous sur
 * l'écran ; l'enchaînement se fait en deux temps, ce qui est aussi l'ordre dans
 * lequel les choses arrivent au salon.
 *
 * ## La liste des comptes n'est pas filtrée, et c'est assumé
 *
 * Elle propose **tous** les comptes du personnel, y compris ceux qui ont déjà
 * leur fiche. L'API ne publie pas `userId` en lecture — `StaffMemberDto` le
 * masque délibérément —, si bien que l'écran ne peut pas savoir lequel des
 * comptes est déjà servi par l'une des fiches affichées au-dessus. Les apparier
 * sur le nom serait une devinette, et une devinette qui se trompe cacherait un
 * collègue de la liste. Le doublon est donc rattrapé à la soumission, par le 409
 * de l'API, avec un message qui le dit — plutôt que par un filtre qui mentirait.
 *
 * ## Une soumission, toutes les erreurs
 *
 * Même conduite que le formulaire d'invitation depuis #631 : la moisson de
 * `safeParse` est rangée par champ, et la saisie n'efface que la marque du champ
 * qu'on corrige. Ce qui ne désigne aucun champ remonte au bandeau — sans ce
 * filet, un refus du `.strict()` disparaîtrait sans trace et le bouton
 * semblerait ne rien faire.
 */

type MemberField = 'userId' | 'displayName' | 'bio';

const MEMBER_FIELDS = ['userId', 'displayName', 'bio'] as const satisfies readonly MemberField[];

/**
 * Garde de compilation : le jour où `MemberField` gagne un champ, cette ligne
 * cesse de compiler tant qu'il n'est pas ajouté à `MEMBER_FIELDS`.
 *
 * Le `satisfies` ci-dessus ne tient qu'un sens — il refuse un nom qui ne serait
 * pas un champ — et laisserait donc l'oubli inverse passer en silence. Celui-là
 * rejouerait exactement #631, comme sur le formulaire d'invitation : l'erreur du
 * champ neuf ne serait pas reconnue par `isMemberField`, elle retomberait dans
 * le bandeau au lieu de marquer son contrôle, et `clearMark` ne saurait plus
 * l'effacer quand on corrige la saisie.
 */
type AucunChampOublie<T extends never> = T;
type _ChampsCouverts = AucunChampOublie<Exclude<MemberField, (typeof MEMBER_FIELDS)[number]>>;

type MemberFieldErrors = Partial<Record<MemberField, string>>;

function isMemberField(value: unknown): value is MemberField {
  return typeof value === 'string' && (MEMBER_FIELDS as readonly string[]).includes(value);
}

/**
 * Range les erreurs d'une soumission : celles qui désignent un champ d'un côté,
 * le reste de l'autre. Un seul message par champ — le premier rencontré : empiler
 * « vide » et « trop court » sous le même contrôle n'apprend rien de plus.
 */
function collectMemberErrors(issues: readonly ZodIssue[]): {
  readonly fields: MemberFieldErrors;
  readonly form: string | null;
} {
  const fields: MemberFieldErrors = {};
  let form: string | null = null;

  for (const issue of issues) {
    const field = issue.path[0];

    if (isMemberField(field)) {
      fields[field] ??= issue.message;
    } else {
      form ??= issue.message;
    }
  }

  return { fields, form };
}

interface StaffMemberFormProps {
  readonly tenantSlug: string;
  /** Les comptes internes de l'établissement — la source du choix. */
  readonly accounts: readonly StaffAccount[];
}

export function StaffMemberForm({ tenantSlug, accounts }: StaffMemberFormProps) {
  const router = useRouter();
  const { renewIfExpired } = useAdminSessionRenewal(tenantSlug);
  const [userId, setUserId] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [bio, setBio] = useState('');
  // Tant que le nom n'a pas été touché, il suit le compte choisi. Dès qu'il l'a
  // été, il ne bouge plus : réécrire par-dessus une saisie serait le pire des
  // deux mondes.
  const [nameEdited, setNameEdited] = useState(false);
  const [saving, setSaving] = useState(false);
  const [, startRefresh] = useTransition();
  const [fieldErrors, setFieldErrors] = useState<MemberFieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [created, setCreated] = useState<string | null>(null);

  function clearMark(field: MemberField): void {
    setFormError(null);
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

  function chooseAccount(value: string): void {
    setUserId(value);
    clearMark('userId');

    if (!nameEdited) {
      const account = accounts.find((candidate) => candidate.id === value);
      setDisplayName(account === undefined ? '' : suggestedStaffDisplayName(account));
      clearMark('displayName');
    }
  }

  async function create(): Promise<void> {
    const parsed = createStaffMemberRequestSchema.safeParse({
      userId,
      displayName: displayName.trim(),
      // « Absente » et « vide » disent la même chose : pas de présentation. Le
      // contrat accepterait la chaîne vide — `longTextSchema` n'a pas de
      // minimum —, et elle descendrait jusqu'à la colonne, où elle se
      // distinguerait de `NULL` sans rien vouloir dire de plus. L'omettre laisse
      // l'API poser le `null` qu'elle sait poser.
      ...(bio.trim() === '' ? {} : { bio: bio.trim() }),
    });

    if (!parsed.success) {
      const { fields, form } = collectMemberErrors(parsed.error.issues);

      // La confirmation de la fiche précédente ne survit pas au refus de la
      // suivante : deux bandeaux contradictoires — « Fiche créée » en vert et
      // « Création impossible » en rouge — laisseraient croire que la saisie en
      // cours est passée.
      setCreated(null);
      setFieldErrors({
        ...fields,
        // Un compte non choisi n'est pas un identifiant mal formé. Le contrat
        // ne peut dire que « identifiant attendu au format UUID v4 » — il ne
        // sait pas qu'à l'écran ce champ est un sélecteur, et que la valeur
        // vide y est le choix par défaut. Afficher ce message sous une liste
        // déroulante ne s'adresse à personne.
        ...(userId === '' ? { userId: 'Choisissez le compte à rendre réservable.' } : {}),
      });
      setFormError(
        form ??
          (Object.keys(fields).length === 0 ? 'Les informations saisies sont invalides.' : null),
      );
      return;
    }

    setSaving(true);
    setFieldErrors({});
    setFormError(null);
    setCreated(null);

    const result = await createStaffMemberAction(tenantSlug, parsed.data);

    setSaving(false);

    if (!result.ok) {
      if (renewIfExpired(result)) {
        return;
      }
      setFormError(result.message);
      return;
    }

    setCreated(result.data.displayName);
    setUserId('');
    setDisplayName('');
    setBio('');
    setNameEdited(false);
    startRefresh(() => {
      router.refresh();
    });
  }

  // `spa-admin-form` borne la colonne de saisie (#630), comme le formulaire
  // d'invitation juste en dessous.
  return (
    <section className="spa-admin__section spa-admin-form" aria-labelledby="fiche-praticien-titre">
      <h2 className="spa-admin__section-title" id="fiche-praticien-titre">
        Créer une fiche praticien
      </h2>
      <p className="spa-admin-toolbar__hint">
        Rattachez un compte du personnel à un agenda. Tant qu’une personne n’a pas sa fiche, aucune
        prestation ne peut lui être affectée et le parcours de réservation ne propose aucun créneau.
      </p>

      {formError === null ? null : (
        <Notification tone="danger" title="Création impossible">
          <p>{formError}</p>
        </Notification>
      )}

      {created === null ? null : (
        <Notification tone="success" title="Fiche créée">
          <p>
            {created} apparaît désormais dans les praticiens. Ouvrez sa fiche pour saisir ses
            horaires, ses congés et les prestations qu’elle pratique.
          </p>
        </Notification>
      )}

      <Select
        error={fieldErrors.userId}
        emptyLabel={
          accounts.length === 0
            ? 'Aucun compte du personnel à rattacher. Invitez d’abord une personne ci-dessous.'
            : undefined
        }
        hint="Le compte porte l’accès au back-office ; la fiche porte l’agenda."
        id="fiche-praticien-compte"
        label="Compte à rendre réservable"
        onChange={(event) => chooseAccount(event.target.value)}
        value={userId}
      >
        <option value="">Choisissez un compte…</option>
        {accounts.map((account) => (
          <option key={account.id} value={account.id}>
            {account.firstName} {account.lastName} — {roleLabel(account.role)}
          </option>
        ))}
      </Select>

      <Field
        disabled={accounts.length === 0}
        error={fieldErrors.displayName}
        hint="C’est ce nom que la cliente lit au moment de choisir son praticien."
        id="fiche-praticien-nom"
        label="Nom d’affichage"
        onChange={(event) => {
          setNameEdited(true);
          setDisplayName(event.target.value);
          clearMark('displayName');
        }}
        required
        value={displayName}
      />

      <TextArea
        disabled={accounts.length === 0}
        error={fieldErrors.bio}
        hint="Facultatif — affichée sur la page publique du salon."
        id="fiche-praticien-presentation"
        label="Présentation"
        onChange={(event) => {
          setBio(event.target.value);
          clearMark('bio');
        }}
        value={bio}
      />

      <Button
        disabled={accounts.length === 0}
        loading={saving}
        loadingLabel="Création…"
        onClick={() => void create()}
        variant="accent"
      >
        Créer la fiche
      </Button>
    </section>
  );
}
