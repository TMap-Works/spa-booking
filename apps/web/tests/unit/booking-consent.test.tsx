/**
 * Information et consentement avant toute collecte — #734.
 *
 * ## Ce que l'audit a relevé
 *
 * L'étape « Vos coordonnées » du tunnel demande prénom, nom, e-mail, téléphone
 * et un champ libre où le jeu d'essai montre une allergie — donc une donnée de
 * santé — sans dire à quoi tout cela sert, ni demander l'accord de personne.
 * `/{salon}/compte/inscription` faisait de même. CDC §5.1 exige l'inverse :
 * *« Information claire des utilisateurs, base légale explicite pour chaque
 * traitement »*, et `docs/design/appointments/wireframes.md` dessine la case à
 * l'étape 4.
 *
 * ## Ce que cette suite tient
 *
 * 1. l'information est **lisible sans rien déplier**, et le détail nomme chaque
 *    donnée demandée ;
 * 2. la case n'est jamais cochée d'avance — un consentement pré-coché n'en est
 *    pas un ;
 * 3. elle est **bloquante** sur les deux écrans : rien ne part tant qu'elle
 *    n'est pas cochée ;
 * 4. son refus se dit **sur la case**, comme tout message de champ du produit
 *    (skill `web-frontend` §4), et pas avant que la question ait été posée ;
 * 5. le récapitulatif du tunnel reste hors d'atteinte sans consentement, y
 *    compris par une URL écrite à la main — la garde de `reachableStep` ;
 * 6. le consentement survit à un rafraîchissement, et un brouillon écrit avant
 *    ce ticket ne coûte ni la prestation ni le créneau, seulement la case ;
 * 7. depuis #790, l'information en place porte à côté d'elle le lien vers la
 *    politique de données **de cet établissement**, ouvert dans un nouvel
 *    onglet — un lien qui se rabattrait sur une adresse générique, ou qui
 *    emporterait le tunnel à moitié rempli, serait un lien de moins qu'aucun.
 *
 * Suite propre au ticket : les suites voisines — `contact-step`,
 * `register-form`, `booking-tunnel`, `draft` — cochent la case comme un
 * préalable et n'ont rien à dire d'elle.
 */

import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RegisterForm } from '@/app/(account)/[tenantSlug]/compte/components/register-form';
import { ContactStep } from '@/app/(booking)/[tenantSlug]/reservation/steps/contact-step';
import { emptyBookingDraft, readBookingDraft, reachableStep } from '@/lib/booking/draft';

const registerAction = vi.fn();

// Mêmes doubles que `register-form.test.tsx` : l'action serveur et le routeur
// n'existent pas hors de Next, et ce qu'on éprouve ici est le formulaire.
vi.mock('@/app/(account)/[tenantSlug]/compte/actions', () => ({
  registerAction: (...args: unknown[]) => registerAction(...args),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), replace: vi.fn(), push: vi.fn() }),
}));

const SLUG = 'maison-lotus';
const PRESTATION = '22222222-2222-4222-8222-222222222222';
const CRENEAU = '2026-09-01T06:00:00.000Z';

afterEach(() => {
  cleanup();
  registerAction.mockReset();
});

beforeEach(() => {
  window.sessionStorage.clear();
});

function renderContactStep() {
  const onSubmit = vi.fn();
  const onSave = vi.fn();

  render(
    <ContactStep
      contact={emptyBookingDraft().contact}
      tenantSlug="salon-zen"
      // Le consentement ne dépend pas du pays : l'établissement sans adresse est
      // le cas par défaut, et il laisse cette suite sur la règle du téléphone
      // qu'elle connaissait (#1028).
      countryCode={null}
      // Le rappel de la barre basse (#1047) : cette suite ne parle que du
      // consentement, et rien à rappeler est un état que l'étape sait rendre.
      summary={null}
      onSave={onSave}
      onBack={vi.fn()}
      onSubmit={onSubmit}
    />,
  );

  return { onSubmit, onSave, user: userEvent.setup() };
}

async function saisirLesCoordonnees(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.type(screen.getByLabelText(/Prénom/), 'Camille');
  await user.type(screen.getByLabelText(/^Nom/), 'Rakoto');
  await user.type(screen.getByLabelText(/Adresse e-mail/), 'camille@example.test');
}

describe('l’information due avant la collecte (CDC §5.1)', () => {
  it('dit à quoi servent les données sans qu’il faille déplier quoi que ce soit', () => {
    renderContactStep();

    const case_ = screen.getByRole('checkbox');
    const finalites = document.getElementById('consent-finalites');

    // La phrase est dans le document, hors du `<details>` — donc lue par qui ne
    // clique nulle part.
    expect(finalites?.closest('details')).toBeNull();
    expect(finalites?.textContent).toMatch(/confirmation par e-mail/);
    expect(finalites?.textContent).toMatch(/rappel/);
    // Et elle est rattachée à la case : un lecteur d'écran qui arrive sur le
    // contrôle entend ce qu'il engage, sans avoir à remonter le formulaire.
    expect(case_.getAttribute('aria-describedby')).toContain('consent-finalites');
  });

  it('nomme chaque donnée demandée et la raison de la demander', async () => {
    const { user } = renderContactStep();

    const resume = screen.getByText('Ce que nous faisons de vos données');

    expect(resume.tagName).toBe('SUMMARY');

    const details = resume.closest('details');

    // Replié au départ : l'essentiel est déjà lisible au-dessus, et déplier
    // pousserait le bouton de l'étape hors de l'écran sur un mobile.
    expect(details?.open).toBe(false);

    await user.click(resume);

    expect(details?.open).toBe(true);

    // Recherché **dans le dépliant** : « Adresse e-mail » et « Téléphone » sont
    // aussi les libellés des champs, quelques lignes plus haut.
    const dedans = within(details as HTMLElement);

    // Les quatre champs de l'étape, et le champ libre nommé pour ce qu'il est :
    // c'est lui que le jeu d'essai remplissait d'une allergie.
    for (const donnee of ['Prénom et nom', 'Adresse e-mail', 'Téléphone', 'Le mot pour le salon']) {
      expect(dedans.getByText(donnee)).toBeDefined();
    }
    // Droits des personnes — la troisième exigence de la même section du CDC.
    expect(details?.textContent).toMatch(/suppression/);
  });

  it('mène à la politique de données de l’établissement, dans un nouvel onglet', () => {
    renderContactStep();

    // Le lien vit **dans** le paragraphe d'intro, jamais dans le libellé de la
    // case : un lien à l'intérieur d'un `<label>` serait activé par le clic qui
    // coche (#790).
    const finalites = document.getElementById('consent-finalites') as HTMLElement;
    const lien = within(finalites).getByRole('link', { name: /politique de données/i });

    // Par salon : il n'existe pas d'adresse générique, et c'est la politique de
    // **cet** établissement que la cliente s'apprête à accepter.
    expect(lien.getAttribute('href')).toBe('/salon-zen/politique-donnees');
    // Nouvel onglet : le tunnel est à moitié rempli, et rien de ce qui informe
    // ne doit le faire perdre. `rel` va avec — sans lui, la page ouverte garde
    // une prise sur celle qui l'a ouverte.
    expect(lien.getAttribute('target')).toBe('_blank');
    expect(lien.getAttribute('rel')).toContain('noopener');
  });

  it('ne coche jamais la case d’avance', () => {
    renderContactStep();

    expect(screen.getByRole<HTMLInputElement>('checkbox').checked).toBe(false);
  });

  it('ne reproche rien tant que la question n’a pas été posée', async () => {
    const { user } = renderContactStep();

    // Tabuler jusqu'à la case en lisant, puis la quitter, n'est pas une faute :
    // le formulaire valide pourtant `onTouched`, et sans l'exception posée par
    // #734 le message serait apparu ici.
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('checkbox'));
    await user.tab();

    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('le consentement est bloquant', () => {
  it('retient l’étape « Coordonnées » du tunnel et le dit sur la case', async () => {
    const { onSubmit, user } = renderContactStep();

    await saisirLesCoordonnees(user);
    await user.click(screen.getByRole('button', { name: /Vérifier ma réservation/ }));

    expect(onSubmit).not.toHaveBeenCalled();

    const message = await screen.findByRole('alert');

    expect(message.textContent).toMatch(/cochez cette case/);
    // Sur la case, jamais en bloc en haut de page (web-frontend §4).
    const case_ = screen.getByRole('checkbox');
    expect(case_.getAttribute('aria-describedby')).toContain(message.id);
    expect(case_.getAttribute('aria-invalid')).toBe('true');
  });

  it('laisse passer dès que la case est cochée, et porte l’accord au brouillon', async () => {
    const { onSubmit, user } = renderContactStep();

    await saisirLesCoordonnees(user);
    await user.click(screen.getByRole('button', { name: /Vérifier ma réservation/ }));
    await screen.findByRole('alert');

    await user.click(screen.getByRole('checkbox'));

    // Le message part à la seconde où la case est cochée — sans resoumettre.
    expect(screen.queryByRole('alert')).toBeNull();

    await user.click(screen.getByRole('button', { name: /Vérifier ma réservation/ }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({ consent: true });
  });

  it('retient la création de compte : rien ne part sans accord', async () => {
    const user = userEvent.setup();

    render(<RegisterForm tenantSlug={SLUG} />);

    await user.type(screen.getByLabelText(/Prénom/), 'Zoé');
    await user.type(screen.getByLabelText(/^Nom/), 'Ranaivo');
    await user.type(screen.getByLabelText(/Adresse e-mail/), 'zoe@example.test');
    await user.type(screen.getByLabelText(/Mot de passe/), 'correct horse battery');
    await user.click(screen.getByRole('button', { name: /Créer mon compte/ }));

    expect(await screen.findByText(/cochez cette case/)).toBeDefined();
    expect(registerAction).not.toHaveBeenCalled();

    await user.click(screen.getByRole('checkbox'));
    registerAction.mockResolvedValue({ ok: true, data: { id: 'x' } });
    await user.click(screen.getByRole('button', { name: /Créer mon compte/ }));

    expect(registerAction).toHaveBeenCalledTimes(1);
    // Le consentement descend désormais au contrat (#880) : c'est lui que
    // l'API horodate. Ce qui ne descend pas, c'est la **date** — le serveur la
    // relève, et le `.strict()` du contrat refuserait celle d'un navigateur.
    expect(registerAction.mock.calls[0]?.[1]).toMatchObject({ dataConsent: true });
    expect(registerAction.mock.calls[0]?.[1]).not.toHaveProperty('dataConsentAt');
  });

  it('annonce la même chose des deux côtés du parcours', () => {
    render(<RegisterForm tenantSlug={SLUG} />);

    const finalites = document.getElementById('register-consent-finalites');

    expect(finalites?.textContent).toMatch(/aucune prospection, aucune revente/);
    expect(screen.getByText('Ce que nous faisons de vos données').tagName).toBe('SUMMARY');
    // Et la même sortie vers la politique de données, sur le salon de cet
    // écran-ci : le lien ne se rabat sur aucune adresse générique (#790).
    expect(
      within(finalites as HTMLElement)
        .getByRole('link', { name: /politique de données/i })
        .getAttribute('href'),
    ).toBe(`/${SLUG}/politique-donnees`);
  });
});

describe('la garde du récapitulatif (#733, étendue par #734)', () => {
  const brouillonComplet = {
    ...emptyBookingDraft(),
    step: 'recapitulatif' as const,
    serviceId: PRESTATION,
    startsAt: CRENEAU,
    contact: {
      firstName: 'Camille',
      lastName: 'Rakoto',
      email: 'camille@example.test',
      phone: '',
      clientNote: '',
      consent: true,
    },
  };

  it('renvoie aux coordonnées un récapitulatif atteint sans consentement', () => {
    // C'est ce qu'ouvrirait un `?etape=recapitulatif` écrit à la main : tout est
    // là, et « Confirmer la réservation » enverrait à l'API des données que
    // personne n'a accepté de nous confier.
    expect(reachableStep(brouillonComplet)).toBe('recapitulatif');
    expect(
      reachableStep({
        ...brouillonComplet,
        contact: { ...brouillonComplet.contact, consent: false },
      }),
    ).toBe('coordonnees');
  });

  it('ne fait pas recommencer le tunnel à un brouillon antérieur au ticket', () => {
    // Le brouillon d'une cliente qui avait la page ouverte au déploiement : la
    // clé `consent` n'existe pas encore. Elle recoche une case, elle ne
    // rechoisit ni sa prestation ni son créneau.
    window.sessionStorage.setItem(
      `spa.booking.${SLUG}`,
      JSON.stringify({
        step: 'recapitulatif',
        serviceId: PRESTATION,
        staffId: null,
        startsAt: CRENEAU,
        contact: {
          firstName: 'Camille',
          lastName: 'Rakoto',
          email: 'camille@example.test',
          phone: '',
          clientNote: '',
        },
        appointment: null,
      }),
    );

    const relu = readBookingDraft(SLUG);

    expect(relu.serviceId).toBe(PRESTATION);
    expect(relu.startsAt).toBe(CRENEAU);
    expect(relu.contact.firstName).toBe('Camille');
    expect(relu.contact.consent).toBe(false);
    expect(reachableStep(relu)).toBe('coordonnees');
  });
});
