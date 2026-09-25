'use client';

import { e164PhoneSchema, STAFF_ROLES, zodErrorMap, type Locale, type StaffRole } from '@spa/shared';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import type { ZodIssue } from 'zod';

import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Notification } from '@/components/ui/notification';
import { PhoneField } from '@/components/ui/phone-field';
import { Select } from '@/components/ui/select';
import { inviteStaffAccountRequestSchema } from '@/lib/admin/staff-contract';

import { roleLabel } from '../../components/navigation';
import { adminInvitationPath } from '../../invitation/paths';
import { inviteStaffAccountAction } from '../actions';
import { useAdminSessionRenewal } from '../../components/use-admin-session-renewal';
import { InvitationLink } from './invitation-link';

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
 * ## Pourquoi le lien d'activation s'affiche ici
 *
 * Parce que le module `notifications` n'expédie pas encore de courriel : aucune
 * chaîne d'envoi ne peut porter le lien, et l'API rend donc le jeton à
 * l'administrateur qui invite — lequel vient de créer ce compte et peut de toute
 * façon réémettre l'invitation à volonté. L'écran l'affiche une fois, à lui
 * seul, avec ce qu'il faut en faire. Le jour où l'envoi existera, ce bloc
 * disparaîtra avec le champ de la réponse.
 *
 * ## Un lien, et non le jeton nu (#1143)
 *
 * L'écran rendait le JWT seul, trois cents caractères dans un champ en lecture
 * seule. Il n'était utilisable nulle part : la page d'activation n'accepte qu'un
 * lien, et celui-ci n'existait dans aucune interface — le seul chemin connu pour
 * activer un compte invité était de composer l'URL à la main. Ce qui s'affiche
 * ici est donc l'adresse complète, prête à coller dans un message, et le bouton
 * qui la dépose dans le presse-papiers — le même geste que la console de
 * l'éditeur remet au gérant d'un salon (`plateforme/components/access-links.tsx`).
 *
 * L'origine est lue de `window.location` et non d'`APP_URL` : le composant est
 * rendu dans le navigateur de l'administrateur, sous l'origine même par laquelle
 * la personne invitée joindra ce back-office. En recette comme en production,
 * c'est la seule valeur qui soit sûrement joignable par le destinataire, et elle
 * n'est lue qu'au clic sur « Inviter » — jamais au rendu, que le serveur joue
 * aussi.
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
  const t = useTranslations('admin-staff');
  const locale = useLocale() as Locale;
  const router = useRouter();
  const { renewIfExpired } = useAdminSessionRenewal(tenantSlug);
  const [draft, setDraft] = useState<InviteDraft>({ ...EMPTY });
  const [sending, setSending] = useState(false);
  const [, startRefresh] = useTransition();
  const [fieldErrors, setFieldErrors] = useState<InviteFieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [invitation, setInvitation] = useState<{ email: string; url: string } | null>(null);

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
    // La carte d'erreurs est **passée** : les bornes du contrat ne se disent que
    // par elle depuis #1232, et sans elle ce formulaire afficherait la langue du
    // repli de `@spa/shared`, pas celle de la page.
    const parsed = inviteStaffAccountRequestSchema.safeParse(
      {
        firstName: draft.firstName,
        lastName: draft.lastName,
        email: draft.email,
        role: draft.role,
        // « Absent » et « vide » disent la même chose à la création : pas de
        // numéro. Envoyer une chaîne vide se ferait refuser par le motif.
        ...(draft.phone === '' ? {} : { phone: draft.phone }),
      },
      { errorMap: zodErrorMap(locale) },
    );
    // Le contrat de la requête décrit la **forme** d'un numéro, et laisse au
    // serveur le soin de le compléter avec le pays du salon (#824). Le champ
    // émet déjà un E.164 (#825) : il se juge donc ici, avec la règle de l'API,
    // plutôt que de revenir refusé en bandeau après l'envoi.
    const phoneRejected = draft.phone !== '' && !e164PhoneSchema.safeParse(draft.phone).success;

    if (!parsed.success || phoneRejected) {
      const collected = parsed.success
        ? { fields: {}, form: null }
        : collectInviteErrors(parsed.error.issues);
      const fields: InviteFieldErrors = phoneRejected
        ? { ...collected.fields, phone: collected.fields.phone ?? t('invite.phoneInvalid') }
        : collected.fields;

      setFieldErrors(fields);
      // Le bandeau ne double pas les marques de champ : il ne parle que lorsque
      // rien n'a pu être rattaché à un contrôle, sans quoi le refus resterait
      // muet. Le message du contrat partagé, lui, ne remonte plus — c'est un
      // littéral français, et il aurait parlé français sous un champ anglais
      // (#848).
      setFormError(Object.keys(fields).length === 0 ? t('invite.invalid') : null);
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

    setInvitation({
      email: result.data.user.email,
      url: `${window.location.origin}${adminInvitationPath(tenantSlug, result.data.invitationToken)}`,
    });
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
        <Notification tone="danger" title={t('invite.failureTitle')}>
          <p>{formError}</p>
        </Notification>
      )}

      {invitation === null ? null : (
        <Notification tone="success" title={t('invite.issuedTitle')}>
          <p>{t('invite.issuedBody', { email: invitation.email })}</p>
          <InvitationLink id="invitation-lien" url={invitation.url} />
        </Notification>
      )}

      <Field
        error={fieldErrors.firstName}
        id="invitation-prenom"
        label={t('invite.firstName')}
        onChange={(event) => change({ firstName: event.target.value })}
        required
        value={draft.firstName}
      />
      <Field
        error={fieldErrors.lastName}
        id="invitation-nom"
        label={t('invite.lastName')}
        onChange={(event) => change({ lastName: event.target.value })}
        required
        value={draft.lastName}
      />
      <Field
        error={fieldErrors.email}
        hint={t('invite.emailHint')}
        id="invitation-email"
        label={t('invite.email')}
        onChange={(event) => change({ email: event.target.value })}
        required
        type="email"
        value={draft.email}
      />
      {/* Le message est celui du champ, qui nomme le pays choisi : le
          contrat ne dit que « invalide », sans pouvoir dire pour où. */}
      <PhoneField
        autoComplete="off"
        hint={t('invite.phoneHint')}
        id="invitation-telephone"
        invalid={fieldErrors.phone !== undefined}
        label={t('invite.phone')}
        onChange={(phone) => change({ phone })}
        value={draft.phone}
      />
      <Select
        error={fieldErrors.role}
        hint={t('invite.roleHint')}
        id="invitation-role"
        label={t('invite.role')}
        onChange={(event) => change({ role: event.target.value as StaffRole })}
        value={draft.role}
      >
        {STAFF_ROLES.map((role) => (
          <option key={role} value={role}>
            {roleLabel(role, locale)}
          </option>
        ))}
      </Select>

      <Button
        loading={sending}
        loadingLabel={t('invite.sending')}
        onClick={() => void invite()}
        variant="accent"
      >
        {t('invite.submit')}
      </Button>
    </section>
  );
}
