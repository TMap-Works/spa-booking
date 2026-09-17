'use client';

import { STAFF_ROLES, type StaffRole } from '@spa/shared';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import type { ZodIssue } from 'zod';

import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Notification } from '@/components/ui/notification';
import { Select } from '@/components/ui/select';
import { inviteStaffAccountRequestSchema } from '@/lib/admin/staff-contract';

import { roleLabel } from '../../components/navigation';
import { inviteStaffAccountAction } from '../actions';
import { useAdminSessionRenewal } from '../../components/use-admin-session-renewal';

/**
 * Invitation d'un membre du personnel (#53, premier critère).
 *
 * ## Aucun mot de passe, et le champ n'existe pas
 *
 * Un administrateur qui choisirait le mot de passe d'un tiers créerait un secret
 * partagé dès la naissance du compte, qu'il faudrait ensuite transmettre par un
 * canal que personne ne maîtrise. Le compte naît sans secret ; c'est la personne
 * invitée qui pose le sien, contre le jeton que cette réponse porte.
 *
 * ## Pourquoi le jeton s'affiche ici
 *
 * Parce que le module `notifications` n'expédie pas encore de courriel : aucune
 * chaîne d'envoi ne peut porter le lien, et l'API rend donc le jeton à
 * l'administrateur qui invite — lequel vient de créer ce compte et peut de toute
 * façon réémettre l'invitation à volonté. L'écran l'affiche une fois, à lui
 * seul, avec ce qu'il faut en faire. Le jour où l'envoi existera, ce bloc
 * disparaîtra avec le champ de la réponse.
 *
 * ## Les rôles proposés s'arrêtent au personnel
 *
 * `client` n'est pas invitable : une cliente s'inscrit d'elle-même ou est saisie
 * au comptoir par le module `crm`, et un compte `client` créé ici serait aussitôt
 * invisible — la liste du personnel ne le rendrait pas.
 *
 * ## Une soumission, toutes les erreurs
 *
 * Le formulaire ne retient plus le seul `issues[0]` de `safeParse` (#631) : trois
 * champs obligatoires vides réclamaient trois soumissions pour être découverts un
 * par un, chaque essai n'en marquant qu'un. La moisson est donc rangée par champ,
 * et la saisie n'efface que la marque du champ qu'on est en train de corriger —
 * tout effacer d'une frappe re-cacherait les autres et rendrait la soumission
 * précédente inutile.
 */

const EMPTY = { firstName: '', lastName: '', email: '', phone: '', role: 'staff' } as const;

type InviteDraft = {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  role: StaffRole;
};

type InviteField = keyof InviteDraft;

/** Le message porté par chaque champ fautif, `undefined` pour les autres. */
type InviteFieldErrors = Partial<Record<InviteField, string>>;

const INVITE_FIELDS = ['firstName', 'lastName', 'email', 'phone', 'role'] as const satisfies
  readonly InviteField[];

/**
 * Garde de compilation : le jour où `InviteDraft` gagne un champ, cette ligne
 * cesse de compiler tant qu'il n'est pas ajouté à `INVITE_FIELDS`.
 *
 * Sans elle, l'oubli serait silencieux et rejouerait exactement #631 : l'erreur
 * du champ neuf ne serait pas reconnue par `isInviteField`, elle retomberait
 * dans le bandeau au lieu de marquer son contrôle, et `change` ne saurait plus
 * l'effacer quand on corrige la saisie.
 */
type AucunChampOublie<T extends never> = T;
type _ChampsCouverts = AucunChampOublie<Exclude<InviteField, (typeof INVITE_FIELDS)[number]>>;

function isInviteField(value: unknown): value is InviteField {
  return typeof value === 'string' && (INVITE_FIELDS as readonly string[]).includes(value);
}

/**
 * Range **toutes** les erreurs d'une soumission : celles qui désignent un champ
 * du formulaire d'un côté, le reste de l'autre.
 *
 * Deux règles, et elles ont chacune leur raison :
 *
 * - **un seul message par champ**, le premier rencontré. Un même champ cumule
 *   volontiers deux règles (vide *et* trop court) et empiler les phrases sous le
 *   contrôle n'apprend rien de plus sur ce qu'il faut taper ;
 * - **ce qui ne désigne aucun champ remonte au formulaire.** Le schéma est
 *   `.strict()` : une clé inattendue produit une erreur de chemin vide, qu'aucun
 *   contrôle ne saurait afficher. Sans ce filet, elle disparaîtrait sans trace et
 *   le bouton semblerait ne rien faire.
 */
function collectInviteErrors(issues: readonly ZodIssue[]): {
  readonly fields: InviteFieldErrors;
  readonly form: string | null;
} {
  const fields: InviteFieldErrors = {};
  let form: string | null = null;

  for (const issue of issues) {
    const field = issue.path[0];

    if (isInviteField(field)) {
      fields[field] ??= issue.message;
    } else {
      form ??= issue.message;
    }
  }

  return { fields, form };
}

export function StaffInviteForm({ tenantSlug }: { readonly tenantSlug: string }) {
  const router = useRouter();
  const { renewIfExpired } = useAdminSessionRenewal(tenantSlug);
  const [draft, setDraft] = useState<InviteDraft>({ ...EMPTY });
  const [sending, setSending] = useState(false);
  const [, startRefresh] = useTransition();
  const [fieldErrors, setFieldErrors] = useState<InviteFieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [invitation, setInvitation] = useState<{ email: string; token: string } | null>(null);

  function change(changes: Partial<InviteDraft>): void {
    setDraft((current) => ({ ...current, ...changes }));
    setFormError(null);
    setFieldErrors((current) => {
      const corrected = Object.keys(changes)
        .filter(isInviteField)
        .filter((field) => current[field] !== undefined);

      if (corrected.length === 0) {
        // Rendre la même référence plutôt qu'un objet neuf : sans cela, chaque
        // frappe dans un champ sain provoquerait un rendu pour rien.
        return current;
      }

      const next = { ...current };

      for (const field of corrected) {
        delete next[field];
      }

      return next;
    });
  }

  async function invite(): Promise<void> {
    const parsed = inviteStaffAccountRequestSchema.safeParse({
      firstName: draft.firstName,
      lastName: draft.lastName,
      email: draft.email,
      role: draft.role,
      // « Absent » et « vide » disent la même chose à la création : pas de
      // numéro. Envoyer une chaîne vide se ferait refuser par le motif.
      ...(draft.phone.trim() === '' ? {} : { phone: draft.phone.trim() }),
    });

    if (!parsed.success) {
      const { fields, form } = collectInviteErrors(parsed.error.issues);

      setFieldErrors(fields);
      // Le bandeau ne double pas les marques de champ : il ne parle que lorsque
      // rien n'a pu être rattaché à un contrôle, sans quoi le refus resterait
      // muet.
      setFormError(
        form ??
          (Object.keys(fields).length === 0 ? 'Les informations saisies sont invalides.' : null),
      );
      return;
    }

    setSending(true);
    setFieldErrors({});
    setFormError(null);
    setInvitation(null);

    const result = await inviteStaffAccountAction(tenantSlug, parsed.data);

    setSending(false);

    if (!result.ok) {
      if (renewIfExpired(result)) {
        return;
      }
      setFormError(result.message);
      return;
    }

    setInvitation({ email: result.data.user.email, token: result.data.invitationToken });
    setDraft({ ...EMPTY });
    startRefresh(() => {
      router.refresh();
    });
  }

  // `spa-admin-form` borne la colonne de saisie (#630) : cinq champs d'identité
  // étirés sur 1 637 px à 1920 px de fenêtre ne profitent pas de la place, là où
  // les listes du personnel en profitent.
  //
  // La carte n'a plus de titre à elle depuis #766 : le formulaire a son propre
  // écran, dont le `<h1>` reprend ce libellé. Le redire ici ferait deux titres
  // pour une seule chose.
  return (
    <section className="spa-admin__section spa-admin-form">
      {formError === null ? null : (
        <Notification tone="danger" title="Invitation impossible">
          <p>{formError}</p>
        </Notification>
      )}

      {invitation === null ? null : (
        <Notification tone="success" title="Invitation émise">
          <p>
            Transmettez ce jeton à {invitation.email}&nbsp;: il lui sert à poser son mot de passe,
            une seule fois. Il n’est affiché qu’ici, et une nouvelle invitation peut être réémise à
            tout moment depuis la liste.
          </p>
          {/* Un champ en lecture seule plutôt qu'un `<code>` : le jeton fait
              trois cents caractères d'un seul tenant, et sans coupure possible
              il pousse la page entière en défilement horizontal. Le champ le
              borne à sa propre boîte — et se sélectionne d'un raccourci, ce
              qu'on vient précisément faire ici. */}
          <Field
            id="invitation-jeton"
            label="Jeton d’invitation"
            readOnly
            value={invitation.token}
          />
        </Notification>
      )}

      <Field
        error={fieldErrors.firstName}
        id="invitation-prenom"
        label="Prénom"
        onChange={(event) => change({ firstName: event.target.value })}
        required
        value={draft.firstName}
      />
      <Field
        error={fieldErrors.lastName}
        id="invitation-nom"
        label="Nom"
        onChange={(event) => change({ lastName: event.target.value })}
        required
        value={draft.lastName}
      />
      <Field
        error={fieldErrors.email}
        hint="C’est l’identifiant de connexion, et il ne se modifie pas ensuite."
        id="invitation-email"
        label="Adresse électronique"
        onChange={(event) => change({ email: event.target.value })}
        required
        type="email"
        value={draft.email}
      />
      <Field
        error={fieldErrors.phone}
        hint="Facultatif."
        id="invitation-telephone"
        label="Téléphone"
        onChange={(event) => change({ phone: event.target.value })}
        type="tel"
        value={draft.phone}
      />
      <Select
        error={fieldErrors.role}
        hint="Le rôle décide de ce que la personne pourra faire ; il se change ensuite depuis la liste."
        id="invitation-role"
        label="Rôle"
        onChange={(event) => change({ role: event.target.value as StaffRole })}
        value={draft.role}
      >
        {STAFF_ROLES.map((role) => (
          <option key={role} value={role}>
            {roleLabel(role)}
          </option>
        ))}
      </Select>

      <Button
        loading={sending}
        loadingLabel="Envoi…"
        onClick={() => void invite()}
        variant="accent"
      >
        Inviter
      </Button>
    </section>
  );
}
