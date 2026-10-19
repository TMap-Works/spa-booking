/**
 * Cohérence du registre d'actions du copilot (spécification §6.3, P1-02 #1449).
 *
 * Trois choses ne doivent jamais dériver : chaque écriture demande une
 * confirmation, chaque exigence est une valeur connue, et le registre dit la
 * même chose que l'inventaire des écrans, que lisent les humains.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  COPILOT_ACTIONS,
  COPILOT_ACTION_IDS,
  COPILOT_GUIDE_ROUTES,
  PERMISSIONS,
  copilotSessionSchema,
  exposedDomains,
  isCopilotRequirement,
  permittedActions,
  permittedGuideRoutes,
  surfaceOf,
  type CopilotSession,
  type Permission,
} from '../index';

const INVENTAIRE = resolve(__dirname, '..', '..', '..', '..', 'docs', 'copilot', 'inventaire.md');

const STAFF: readonly Permission[] = ['agenda:read:own', 'appointment:write:own', 'customers:read:own'];
const MANAGER: readonly Permission[] = PERMISSIONS.filter(
  (p) => p !== 'accounts:write' && p !== 'settings:write',
);

function session(role: CopilotSession['role'], permissions: readonly Permission[] = []): CopilotSession {
  return {
    surface: surfaceOf(role),
    role,
    permissions,
    tenant: { slug: 'salon-lea', timezone: 'Europe/Paris', currency: 'EUR' },
    locale: 'fr',
  };
}

describe('registre des actions du copilot', () => {
  it.each(COPILOT_ACTION_IDS)('%s : exigence connue, confirmation si et seulement si écriture', (id) => {
    const action = COPILOT_ACTIONS[id];
    expect(isCopilotRequirement(action.exige)).toBe(true);
    expect(action.confirmation).toBe(action.nature === 'ecriture');
    expect(action.description.length).toBeGreaterThan(10);
  });

  it('refuse un paramètre inventé par le modèle', () => {
    const tunnel = COPILOT_ACTIONS['reservation.ouvrir_tunnel'].parametres;
    expect(tunnel.safeParse({ jour: '2026-10-20', plage: 'apres-midi' }).success).toBe(true);
    expect(tunnel.safeParse({ jour: '2026-10-20', heure: '15:00' }).success).toBe(false);
    expect(tunnel.safeParse({ jour: '2026-02-30' }).success).toBe(false);
  });

  it('exige un décalage explicite sur le début d’une écriture', () => {
    const reporter = COPILOT_ACTIONS['rendez_vous.reporter'].parametres;
    const rendezVous = '0b6f8b8e-3f4a-4c2e-9a8e-2f1d3c4b5a69';
    expect(reporter.safeParse({ rendezVous, debut: '2026-10-22T14:30:00+02:00' }).success).toBe(true);
    expect(reporter.safeParse({ rendezVous, debut: '2026-10-22T14:30:00' }).success).toBe(false);
  });

  it('chaque route du guide porte une exigence connue', () => {
    for (const route of Object.values(COPILOT_GUIDE_ROUTES)) {
      expect(isCopilotRequirement(route.exige)).toBe(true);
      expect(route.chemin.startsWith('/')).toBe(true);
    }
  });

  it("dit la même chose que l'inventaire des écrans (§5)", () => {
    const doc = readFileSync(INVENTAIRE, 'utf8');
    const section = doc.slice(doc.indexOf('## 5.'), doc.indexOf('## 6.'));
    const rows = section
      .split('\n')
      .filter((line) => line.startsWith('| `'))
      .map((line) => line.split('|').map((cell) => cell.trim()));
    const documented = Object.fromEntries(
      rows.map(([, action = '', nature = '']) => [/`([^`]+)`/.exec(action)?.[1], nature]),
    );
    expect(Object.keys(documented).sort()).toEqual([...COPILOT_ACTION_IDS].sort());
    for (const id of COPILOT_ACTION_IDS) {
      expect(`${id} : ${documented[id]}`).toBe(`${id} : ${COPILOT_ACTIONS[id].nature.replace('ecriture', 'écriture')}`);
    }
  });
});

describe('session du copilot et filtrage', () => {
  it('déduit la surface du rôle', () => {
    expect(surfaceOf(null)).toBe('visiteur');
    expect(surfaceOf('client')).toBe('client');
    expect(surfaceOf('staff')).toBe('praticien');
    expect(surfaceOf('manager')).toBe('gerance');
    expect(surfaceOf('admin')).toBe('gerance');
  });

  it('valide une session cohérente et refuse une surface qui contredit le rôle', () => {
    expect(copilotSessionSchema.safeParse(session('staff', STAFF)).success).toBe(true);
    expect(copilotSessionSchema.safeParse({ ...session('staff', STAFF), surface: 'gerance' }).success).toBe(false);
    expect(copilotSessionSchema.safeParse({ ...session(null), permissions: ['agenda:read:all'] }).success).toBe(false);
    expect(copilotSessionSchema.safeParse({ ...session('client'), jeton: 'x' }).success).toBe(false);
  });

  it('une visiteuse ne voit que le public', () => {
    const actions = permittedActions(session(null));
    expect(actions).toEqual(COPILOT_ACTION_IDS.filter((id) => COPILOT_ACTIONS[id].exige === 'public'));
    expect(permittedGuideRoutes(session(null))).toEqual(['politique_donnees', 'connexion', 'inscription']);
  });

  it('une cliente voit ses rendez-vous, et rien du back-office', () => {
    const actions = permittedActions(session('client'));
    expect(actions).toEqual(expect.arrayContaining(['rendez_vous.reporter', 'rendez_vous.annuler']));
    expect(actions).not.toContain('planning.ma_journee');
    expect(permittedGuideRoutes(session('client'))).not.toContain('catalogue');
  });

  it("un praticien voit sa journée, pas l'encaissement ni les écritures de gérance", () => {
    const praticien = session('staff', STAFF);
    const actions = permittedActions(praticien);
    expect(actions).toEqual(expect.arrayContaining(['planning.ma_journee', 'rendez_vous.marquer_honore']));
    expect(actions).not.toContain('rendez_vous.poser');
    expect(actions).not.toContain('rendez_vous.reporter');
    expect(exposedDomains(praticien)).not.toContain('encaissement');
    expect(exposedDomains(praticien)).not.toContain('clients');
    expect(permittedGuideRoutes(praticien)).toContain('catalogue');
    expect(permittedGuideRoutes(praticien)).not.toContain('reglages');
  });

  it('la gérance voit tous les domaines, mais les réglages restent à l’administratrice', () => {
    const gerance = session('manager', MANAGER);
    expect(exposedDomains(gerance).sort()).toEqual(
      ['clients', 'encaissement', 'guide', 'rendez_vous', 'reservation', 'salon'].sort(),
    );
    expect(permittedGuideRoutes(gerance)).not.toContain('reglages');
    expect(permittedGuideRoutes(session('admin', PERMISSIONS))).toContain('reglages');
  });
});
