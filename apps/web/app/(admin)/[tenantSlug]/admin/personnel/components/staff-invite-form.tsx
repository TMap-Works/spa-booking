'use client';

import { STAFF_ROLES, type StaffRole } from '@spa/shared';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Notification } from '@/components/ui/notification';
import { Select } from '@/components/ui/select';
import { inviteStaffAccountRequestSchema } from '@/lib/admin/staff-contract';

import { roleLabel } from '../../components/navigation';
import { inviteStaffAccountAction } from '../actions';

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
 */

const EMPTY = { firstName: '', lastName: '', email: '', phone: '', role: 'staff' } as const;

type InviteDraft = {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  role: StaffRole;
};

export function StaffInviteForm({ tenantSlug }: { readonly tenantSlug: string }) {
  const router = useRouter();
  const [draft, setDraft] = useState<InviteDraft>({ ...EMPTY });
  const [sending, setSending] = useState(false);
  const [, startRefresh] = useTransition();
  const [error, setError] = useState<{ field: keyof InviteDraft | null; message: string } | null>(
    null,
  );
  const [invitation, setInvitation] = useState<{ email: string; token: string } | null>(null);

  function change(changes: Partial<InviteDraft>): void {
    setDraft((current) => ({ ...current, ...changes }));
    setError(null);
  }

  function fieldError(field: keyof InviteDraft): string | undefined {
    return error !== null && error.field === field ? error.message : undefined;
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
      const issue = parsed.error.issues[0];
      const path = issue?.path[0];

      setError({
        field: typeof path === 'string' ? (path as keyof InviteDraft) : null,
        message: issue?.message ?? 'Les informations saisies sont invalides.',
      });
      return;
    }

    setSending(true);
    setError(null);
    setInvitation(null);

    const result = await inviteStaffAccountAction(tenantSlug, parsed.data);

    setSending(false);

    if (!result.ok) {
      setError({ field: null, message: result.message });
      return;
    }

    setInvitation({ email: result.data.user.email, token: result.data.invitationToken });
    setDraft({ ...EMPTY });
    startRefresh(() => {
      router.refresh();
    });
  }

  return (
    <section className="spa-admin__section" aria-labelledby="invitation-titre">
      <h2 className="spa-admin__section-title" id="invitation-titre">
        Inviter un membre du personnel
      </h2>

      {error !== null && error.field === null ? (
        <Notification tone="danger" title="Invitation impossible">
          <p>{error.message}</p>
        </Notification>
      ) : null}

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
        error={fieldError('firstName')}
        id="invitation-prenom"
        label="Prénom"
        onChange={(event) => change({ firstName: event.target.value })}
        required
        value={draft.firstName}
      />
      <Field
        error={fieldError('lastName')}
        id="invitation-nom"
        label="Nom"
        onChange={(event) => change({ lastName: event.target.value })}
        required
        value={draft.lastName}
      />
      <Field
        error={fieldError('email')}
        hint="C’est l’identifiant de connexion, et il ne se modifie pas ensuite."
        id="invitation-email"
        label="Adresse électronique"
        onChange={(event) => change({ email: event.target.value })}
        required
        type="email"
        value={draft.email}
      />
      <Field
        error={fieldError('phone')}
        hint="Facultatif."
        id="invitation-telephone"
        label="Téléphone"
        onChange={(event) => change({ phone: event.target.value })}
        type="tel"
        value={draft.phone}
      />
      <Select
        error={fieldError('role')}
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
