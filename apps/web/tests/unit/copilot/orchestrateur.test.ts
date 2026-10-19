// @vitest-environment node

import { PERMISSIONS, type CopilotSession, type PublicService, type PublicTenant } from '@spa/shared';
import { describe, expect, it, vi } from 'vitest';

import { createOrchestrateur, sessionContext, SYSTEM_PROMPT } from '@/lib/copilot/orchestrateur';
import { salonData } from '@/lib/copilot/salon-data';
import type { ResolvedCopilotSession } from '@/lib/copilot/session';
import { specialistTools, type Specialist } from '@/lib/copilot/specialists';
import { suggestionsFor } from '@/lib/copilot/suggestions';
import { guideTool, toolNameOf } from '@/lib/copilot/tools';

/**
 * L'orchestrateur (P1-07) : outils exposés selon la session, données du salon
 * données d'avance, suggestions sans modèle. Aucun appel à Claude ni à l'API.
 */

const tenant = {
  name: 'Salon Léa',
  timezone: 'Europe/Paris',
  defaultCurrency: 'EUR',
  defaultLocale: 'fr',
  contactPhone: '+33 1 23 45 67 89',
  address: { line1: '3 rue des Lilas', postalCode: '75011', city: 'Paris', countryCode: 'FR' },
  openingHours: [{ weekday: 2, opensAt: '09:00', closesAt: '19:00' }],
} as unknown as PublicTenant;

function session(role: CopilotSession['role'], permissions: CopilotSession['permissions'] = []): CopilotSession {
  const surface = role === null ? 'visiteur' : role === 'client' ? 'client' : role === 'staff' ? 'praticien' : 'gerance';
  return {
    surface,
    role,
    permissions,
    tenant: { slug: 'salon-lea', timezone: 'Europe/Paris', currency: 'EUR' },
    locale: 'fr',
  };
}

function resolved(s: CopilotSession): ResolvedCopilotSession {
  return { session: s, accessToken: null, notice: null, subject: null, tenant };
}

const MANAGER = PERMISSIONS.filter((p) => p !== 'accounts:write' && p !== 'settings:write');

describe('guide_mener', () => {
  it('ne propose que les écrans que la session peut ouvrir', () => {
    const visiteur = guideTool(session(null))!;
    const routes = (visiteur.inputSchema.properties as { route: { enum: string[] } }).route.enum;
    expect(routes).toEqual(['politique_donnees', 'connexion', 'inscription']);
    expect(visiteur.name).toBe('guide_mener');
  });

  it("refuse une destination hors de la session, et navigue dans le salon sinon", async () => {
    const tool = guideTool(session(null))!;
    const signal = new AbortController().signal;

    expect(await tool.run({ route: 'reglages' }, signal)).toMatchObject({ kind: 'resultat', erreur: true });
    expect(await tool.run({ route: 'connexion' }, signal)).toEqual({
      kind: 'fin',
      contenu: 'Navigation lancée vers /salon-lea/compte/connexion.',
      navigateur: [{ outil: 'naviguer', arguments: { chemin: '/salon-lea/compte/connexion' } }],
    });
  });

  it("nomme les outils sans point, comme l'exige l'API", () => {
    expect(toolNameOf('rendez_vous.reporter')).toBe('rendez_vous_reporter');
  });
});

describe('spécialistes', () => {
  const reservation: Specialist = {
    domaine: 'reservation',
    description: 'Réservation',
    run: vi.fn(async () => ({
      reponse: 'Voici les créneaux de demain après-midi.',
      actionsFront: [{ outil: 'naviguer', arguments: { chemin: '/salon-lea/reservation' } }],
      confirmation: null,
      suggestions: [],
    })),
  };
  const encaissement: Specialist = { ...reservation, domaine: 'encaissement', description: 'Encaissement' };

  it("n'expose un spécialiste qu'à qui a au moins une de ses actions", () => {
    const praticien = session('staff', ['agenda:read:own', 'appointment:write:own', 'customers:read:own']);
    expect(specialistTools(praticien, [reservation, encaissement]).map((t) => t.name)).toEqual(['agent_reservation']);
    expect(specialistTools(session('manager', MANAGER), [reservation, encaissement])).toHaveLength(2);
  });

  it('passe-plat : la réponse du spécialiste est affichée telle quelle', async () => {
    const [tool] = specialistTools(session(null), [reservation]);
    const outcome = await tool!.run({ demande: 'Un massage le 2026-10-20 après-midi' }, new AbortController().signal);
    expect(outcome).toMatchObject({ kind: 'fin', texte: 'Voici les créneaux de demain après-midi.' });
    expect(reservation.run).toHaveBeenCalledWith({ demande: 'Un massage le 2026-10-20 après-midi', faits: {} }, expect.anything());
  });
});

describe('données du salon', () => {
  const services = [
    {
      id: '0b6f8b8e-3f4a-4c2e-9a8e-2f1d3c4b5a69',
      name: 'Massage relaxant',
      durationMinutes: 60,
      price: { amountMinor: 7000, currency: 'EUR' },
      category: { name: 'Massages' },
      staff: [{ id: '1c6f8b8e-3f4a-4c2e-9a8e-2f1d3c4b5a69', displayName: 'Léa' }],
    },
  ] as unknown as PublicService[];

  it('donne horaires, adresse et catalogue avec identifiants', async () => {
    const text = await salonData('salon-lea-1', tenant, 'fr', async () => services, 0);
    expect(text).toContain('<donnees_salon>');
    expect(text).toContain('Adresse : 3 rue des Lilas, 75011 Paris');
    expect(text).toContain('Horaires : mardi 09:00–19:00');
    expect(text).toMatch(/\[0b6f8b8e-[^\]]+\] Massage relaxant — 60 min — 70,00\s€ — rubrique Massages — avec Léa \[1c6f/);
  });

  it("dit que le catalogue manque plutôt que d'inventer, et garde le catalogue une minute", async () => {
    const failing = vi.fn(async () => {
      throw new Error('API');
    });
    expect(await salonData('salon-lea-2', tenant, 'fr', failing, 0)).toContain('catalogue indisponible');

    const load = vi.fn(async () => services);
    await salonData('salon-lea-3', tenant, 'fr', load, 0);
    await salonData('salon-lea-3', tenant, 'fr', load, 59_000);
    await salonData('salon-lea-3', tenant, 'fr', load, 61_000);
    expect(load).toHaveBeenCalledTimes(2);
  });
});

describe('prompt et contexte', () => {
  it('garde un prompt système identique pour tous les salons', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'k');
    const a = createOrchestrateur(resolved(session(null)), { systemData: 'salon A' }).options;
    const b = createOrchestrateur(resolved(session('manager', MANAGER)), { systemData: 'salon B' }).options;
    expect(a.system).toBe(SYSTEM_PROMPT);
    expect(b.system).toBe(SYSTEM_PROMPT);
    expect(a.systemData).toBe('salon A');
  });

  it('donne la date du jour dans le fuseau du salon', () => {
    // 23 h 30 UTC le 19 : déjà le 20 à Paris.
    const text = sessionContext(resolved(session(null)), new Date('2026-10-19T23:30:00Z'));
    expect(text).toContain("Aujourd'hui : mardi 2026-10-20, 01:30");
  });
});

describe('suggestions', () => {
  it('propose à la visiteuse de réserver en premier, sans modèle', () => {
    expect(suggestionsFor(session(null), '/salon-lea')).toEqual([
      { cle: 'reserver', type: 'navigation', chemin: '/salon-lea/reservation' },
      { cle: 'creneaux_demain', type: 'message' },
      { cle: 'tarifs', type: 'message' },
    ]);
  });

  it("ne mène pas à la page où l'on est déjà", () => {
    expect(suggestionsFor(session(null), '/salon-lea/reservation?etape=creneau').map((s) => s.cle)).not.toContain(
      'reserver',
    );
  });

  it('suit les permissions et la page de la gérance', () => {
    const gerance = suggestionsFor(session('manager', MANAGER), '/salon-lea/admin/encaissement');
    expect(gerance.map((s) => s.cle)).toEqual(['a_encaisser', 'creneaux_libres_aujourdhui', 'poser_rendez_vous']);
    const praticien = suggestionsFor(session('staff', ['agenda:read:own']), '/salon-lea/admin/mon-planning');
    expect(praticien.map((s) => s.cle)).toEqual(['ma_journee', 'prochain_client']);
  });
});
