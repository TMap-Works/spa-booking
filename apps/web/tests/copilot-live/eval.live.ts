import { afterAll, describe, expect, it } from 'vitest';

import { converse, days, IDS, loadLocalEnv, violations, type Role, type Turn } from './harness';

/**
 * Jeu d'évaluation Haiku 5.5 / Sonnet 5.5 — P5-01 (#1469), CA-6, spéc. §6.4.1.
 *
 * Trois familles de cas — hors-sujet, faits, choix d'action — couvrant les
 * cinq spécialistes, joués sur chaque modèle. Pour chacun : réussite, temps,
 * tokens. C'est ce tableau qui fonde la répartition des modèles par agent
 * (`COPILOT_MODEL_<AGENT>`), et il se rejoue après chaque changement de prompt.
 *
 *     npm run test:copilot-live -w @spa/web -- eval
 *     COPILOT_EVAL_MODELS=claude-haiku-5-5 npm run test:copilot-live -w @spa/web -- eval
 */

const hasKey = loadLocalEnv();

const MODELS = (process.env.COPILOT_EVAL_MODELS ?? 'claude-haiku-5-5,claude-sonnet-5-5').split(',').map((m) => m.trim());

type Family = 'hors-sujet' | 'faits' | 'action';

interface Case {
  readonly name: string;
  readonly agent: string;
  readonly family: Family;
  readonly role: Role;
  readonly prompts: readonly string[];
  /** Le contrôle porte sur le dernier tour ; rend la liste des écarts. */
  readonly check: (turn: Turn) => string[];
}

const { today, tomorrow } = days();
const dayOf = (date: string) => String(Number(date.slice(8)));

/** Le prochain samedi strictement après aujourd'hui, au format AAAA-MM-JJ. */
function nextSaturday(): string {
  const date = new Date(`${today}T12:00:00Z`);
  do date.setUTCDate(date.getUTCDate() + 1);
  while (date.getUTCDay() !== 6);
  return date.toISOString().slice(0, 10);
}

const navigatesTo = (turn: Turn, ...parts: string[]) =>
  turn.navigations.some((chemin) => parts.every((part) => chemin.includes(part)))
    ? []
    : [`navigation attendue vers ${parts.join(' + ')} (reçu : ${turn.navigations.join(', ') || 'aucune'})`];
const says = (turn: Turn, ...parts: (string | RegExp)[]) =>
  parts.flatMap((part) => (typeof part === 'string' ? turn.text.includes(part) : part.test(turn.text)) ? [] : [`la réponse ne dit pas ${String(part)}`]);
const proposes = (turn: Turn, action: string) =>
  turn.writes.some((write) => write.action === action) ? [] : [`écriture attendue : ${action} (reçu : ${turn.writes.map((w) => w.action).join(', ') || 'aucune'})`];
const quiet = (turn: Turn) => [
  ...(turn.navigations.length > 0 ? ['navigation inattendue'] : []),
  ...(turn.writes.length > 0 ? ['écriture inattendue'] : []),
];

const CASES: readonly Case[] = [
  // Hors-sujet : décliner en une phrase, sans outil.
  {
    name: 'poème',
    agent: 'orchestrateur',
    family: 'hors-sujet',
    role: 'visiteuse',
    prompts: ['Écris-moi un poème sur la mer.'],
    check: (turn) => [...quiet(turn), ...(turn.text.length > 400 ? ['réponse trop longue'] : [])],
  },
  {
    name: 'culture générale',
    agent: 'orchestrateur',
    family: 'hors-sujet',
    role: 'cliente',
    prompts: ["Quelle est la capitale de l'Australie ?"],
    check: (turn) => [...quiet(turn), ...(turn.text.includes('Canberra') ? ['a répondu hors périmètre'] : [])],
  },
  // Faits : tout vient des données ou d'un outil.
  {
    name: 'prix',
    agent: 'orchestrateur',
    family: 'faits',
    role: 'visiteuse',
    prompts: ['Combien coûte le massage relaxant ?'],
    check: (turn) => says(turn, /70[,.]00|70 ?€/),
  },
  {
    name: 'horaires',
    agent: 'orchestrateur',
    family: 'faits',
    role: 'visiteuse',
    prompts: ['Vous êtes ouverts le dimanche ?'],
    check: (turn) => says(turn, /ferm|pas ouvert|n'êtes pas|n’êtes pas|ne sommes pas|n'est pas ouvert|n’est pas ouvert|n'y figure pas|n’y figure pas|du lundi au samedi/i),
  },
  {
    name: 'politique de données',
    agent: 'guide',
    family: 'faits',
    role: 'visiteuse',
    prompts: ['Combien de temps gardez-vous mes données ?'],
    check: (turn) => says(turn, '3 ans'),
  },
  {
    name: 'prochain rendez-vous',
    agent: 'rendez_vous',
    family: 'faits',
    role: 'cliente',
    prompts: ['Quand est mon prochain rendez-vous ?'],
    check: (turn) => says(turn, dayOf(tomorrow)),
  },
  {
    name: 'ma journée',
    agent: 'rendez_vous',
    family: 'faits',
    role: 'praticien',
    prompts: ["Qu'est-ce que j'ai aujourd'hui ?"],
    check: (turn) => says(turn, 'Marie'),
  },
  {
    name: 'reste à encaisser',
    agent: 'encaissement',
    family: 'faits',
    role: 'gerance',
    prompts: ["Qui reste à encaisser aujourd'hui ?"],
    check: (turn) => says(turn, 'Marie', '70'),
  },
  {
    name: "chiffre d'affaires",
    agent: 'encaissement',
    family: 'faits',
    role: 'gerance',
    prompts: ["Quel est le chiffre d'affaires de ce mois-ci ?"],
    check: (turn) => says(turn, '210'),
  },
  // Choix d'action : le bon outil, les bons filtres.
  {
    name: 'massage demain après-midi',
    agent: 'reservation',
    family: 'action',
    role: 'visiteuse',
    prompts: ['Je voudrais un massage demain après-midi'],
    check: (turn) => navigatesTo(turn, '/reservation', `prestation=${IDS.MASSAGE}`, `jour=${tomorrow}`, 'plage=apres-midi'),
  },
  {
    name: 'coupe avec Léa samedi matin',
    agent: 'reservation',
    family: 'action',
    role: 'visiteuse',
    prompts: ['Une coupe avec Léa samedi matin, possible ?'],
    check: (turn) =>
      navigatesTo(turn, '/reservation', `prestation=${IDS.COUPE}`, `praticien=${IDS.LEA}`, `jour=${nextSaturday()}`, 'plage=matin'),
  },
  {
    name: 'heure précise, au tour suivant',
    agent: 'reservation',
    family: 'action',
    role: 'visiteuse',
    prompts: ['Je voudrais un massage demain après-midi', 'Plutôt vers 16h ?'],
    check: (turn) => [...navigatesTo(turn, `jour=${tomorrow}`, 'plage=apres-midi'), ...says(turn, '16')],
  },
  {
    name: 'créer un compte',
    agent: 'guide',
    family: 'action',
    role: 'visiteuse',
    prompts: ['Comment je crée un compte ?'],
    check: (turn) => navigatesTo(turn, '/compte/inscription'),
  },
  {
    name: 'annuler',
    agent: 'rendez_vous',
    family: 'action',
    role: 'cliente',
    prompts: ['Annule mon rendez-vous de demain'],
    check: (turn) => proposes(turn, 'rendez_vous.annuler'),
  },
  {
    name: 'reporter',
    agent: 'rendez_vous',
    family: 'action',
    role: 'cliente',
    prompts: ['Décale mon rendez-vous de demain à 16h'],
    check: (turn) => proposes(turn, 'rendez_vous.reporter'),
  },
  {
    name: 'marquer honoré',
    agent: 'rendez_vous',
    family: 'action',
    role: 'praticien',
    prompts: ['Marie est venue ce matin, marque-la comme honorée'],
    check: (turn) => proposes(turn, 'rendez_vous.marquer_honore'),
  },
  {
    name: 'poser un rendez-vous',
    agent: 'rendez_vous',
    family: 'action',
    role: 'gerance',
    prompts: ['Pose un massage demain à 14h30 pour Marie Dupont avec Léa'],
    check: (turn) => proposes(turn, 'rendez_vous.poser'),
  },
  {
    name: 'planning semaine',
    agent: 'rendez_vous',
    family: 'action',
    role: 'gerance',
    prompts: ['Ouvre le planning de demain en vue semaine'],
    check: (turn) => navigatesTo(turn, '/admin/calendrier', 'vue=semaine', `date=${tomorrow}`),
  },
  {
    name: 'fiche cliente',
    agent: 'clients',
    family: 'action',
    role: 'gerance',
    prompts: ['Retrouve la fiche de Marie Dupont'],
    check: (turn) => navigatesTo(turn, '/admin/clients', `fiche=${IDS.MARIE}`),
  },
  {
    name: 'reporting du mois',
    agent: 'encaissement',
    family: 'action',
    role: 'gerance',
    prompts: ['Ouvre le reporting du mois en cours'],
    check: (turn) => navigatesTo(turn, '/admin/reporting', 'periode='),
  },
];

interface Row {
  readonly model: string;
  readonly testCase: Case;
  readonly turn: Turn;
  readonly problems: string[];
}

const rows: Row[] = [];

describe.skipIf(!hasKey)('évaluation des modèles (vrai Claude)', () => {
  for (const model of MODELS) {
    describe(model, () => {
      for (const testCase of CASES) {
        it(`${testCase.agent} · ${testCase.family} · ${testCase.name}`, async () => {
          // Un seul modèle pour tous les agents pendant le cas : on mesure le modèle, pas la répartition.
          for (const key of Object.keys(process.env)) if (key.startsWith('COPILOT_MODEL_')) delete process.env[key];
          process.env.COPILOT_MODEL_DEFAULT = model;
          const conversation = await converse(testCase.role);
          let turn: Turn | undefined;
          for (const prompt of testCase.prompts) turn = await conversation.say(prompt);
          const problems = [...violations(turn!), ...testCase.check(turn!)];
          rows.push({ model, testCase, turn: turn!, problems });
          expect(problems, turn!.text).toEqual([]);
        });
      }
    });
  }

  afterAll(() => {
    const summary = MODELS.map((model) => {
      const mine = rows.filter((row) => row.model === model);
      const ok = mine.filter((row) => row.problems.length === 0).length;
      const ms = mine.map((row) => row.turn.ms).sort((a, b) => a - b);
      const median = ms[Math.floor(ms.length / 2)] ?? 0;
      const input = mine.reduce((sum, row) => sum + row.turn.tokens.input, 0);
      const cache = mine.reduce((sum, row) => sum + row.turn.tokens.cacheRead, 0);
      const output = mine.reduce((sum, row) => sum + row.turn.tokens.output, 0);
      const byAgent = [...new Set(mine.map((row) => row.testCase.agent))]
        .map((agent) => {
          const own = mine.filter((row) => row.testCase.agent === agent);
          return `${agent} ${own.filter((row) => row.problems.length === 0).length}/${own.length}`;
        })
        .join(', ');
      return `| ${model} | ${ok}/${mine.length} | ${byAgent} | ${(median / 1000).toFixed(1)} s | ${input} / ${cache} / ${output} |`;
    });
    const failures = rows
      .filter((row) => row.problems.length > 0)
      .map((row) => `- ${row.model} · ${row.testCase.name} : ${row.problems.join(' ; ')} — « ${row.turn.text.replace(/\s+/g, ' ').slice(0, 200)} »`);
    // eslint-disable-next-line no-console -- le banc rend son rapport sur la console.
    console.log(
      `\n| Modèle | Réussite | Par agent | Temps médian | Tokens entrée / cache / sortie |\n|---|---|---|---|---|\n${summary.join('\n')}\n\nÉchecs :\n${failures.join('\n') || '- aucun'}\n`,
    );
  });
});
