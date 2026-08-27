# Contribuer

## Prérequis

- Node.js 20 LTS, npm 10
- Python 3.12 (outillage de `scripts/` et ses tests)
- Docker (Postgres + Redis en local)
- AWS CLI et Terraform (pour l'infrastructure)
- GitHub CLI (`gh`), authentifié sur l'organisation TMap-Works

## Prérequis Windows — pas d'esperluette dans le chemin du dépôt

npm exécute ses scripts par `cmd.exe /d /s /c <script>`, et dans `cmd.exe` `&`
est un **séparateur de commandes**. Si le chemin du dépôt en contient une —
`D:\spyle\Spa & Booking` — les shims de `node_modules/.bin` sont coupés en deux
et **plus aucun binaire local ne se résout** : ni `eslint`, ni `tsc`, ni `jest`,
ni `nest`. Donc pas de `npm run verify`, donc pas de ticket franchissable.

```
> @spa/api@0.1.0 lint
> eslint .

'Booking\node_modules\.bin\' n'est pas reconnu en tant que commande interne…
Error: Cannot find module 'D:\spyle\eslint\bin\eslint.js'
```

Le chemin annoncé, `D:\spyle\eslint\bin\eslint.js`, est le chemin réel **tronqué
à l'esperluette**. Deux correctifs, au choix.

**1. Renommer le dossier de travail** — `D:\spyle\Spa-Booking`. Définitif et sans
réglage : le défaut ne touche pas que npm, mais tout outil qui compose une ligne
de commande Windows à partir du chemin du dépôt. À refaire ensuite : les chemins
enregistrés **hors** du dépôt — entrées de `~/.claude.json`, tâche planifiée
`SpaBooking-Milestone-Watchdog`, état de run sous `.claude/.milestone/`.

**2. Faire exécuter les scripts npm par bash** — plus léger, et suffisant :

```bash
npm config set script-shell "C:/Program Files/Git/bin/bash.exe"
npm run verify        # doit désormais aller au bout
```

Le chemin est celui de Git for Windows ; l'adapter si l'installation diffère.
Aucun script du dépôt n'est spécifique à `cmd.exe`, le changement de shell est
donc sans effet de bord ici.

### Le réglage est propre au poste — il ne se versionne jamais

Sans `--location`, `npm config set` écrit dans `~/.npmrc` : c'est le bon endroit,
et il n'y a rien à faire de plus. Avec `--location=project`, il écrirait un
`.npmrc` **dans le dépôt** — qui partirait en CI, où `C:/Program Files/…`
n'existe pas, et casserait le job Linux pour tout le monde. Un correctif de
poste devenu panne collective.

Deux verrous l'empêchent : `.npmrc` est exclu par [.gitignore](.gitignore), et
[scripts/tests/test_npmrc.py](scripts/tests/test_npmrc.py) échoue si un `.npmrc`
versionné porte malgré tout un chemin absolu. Ce test tourne dans
`npm run test:scripts`, donc dans `npm run verify` et en CI.

Un agent `/ticket` qui bute sur cette barrière trouve la conduite à tenir en
phase 4 de [.claude/commands/ticket.md](.claude/commands/ticket.md) : appliquer
le remède et poursuivre, sans traiter l'incident comme un échec du ticket.

## Démarrage

```bash
npm install
cp .env.example .env.local        # renseigner les valeurs locales
docker compose up -d              # Postgres sur 5433, Redis sur 6380
npm run db:migrate
npm run dev                       # api + web en parallèle
```

## Règle n°1 : rien ne se code sans issue

L'issue rattache le travail à son sprint, son workstream et son module. Une PR
sans issue liée ne peut pas être suivie dans le GitHub Project et sera refusée.

Toute issue porte : un **milestone** (`S1` à `S4`), un label `ws:*`, un label
`mod:*`, un label `type:*` et une priorité (`P0`/`P1`/`P2`).

Une demande hors du périmètre MVP (voir [CLAUDE.md](CLAUDE.md) et le CDC §1.4)
reçoit le label `post-mvp`, aucun milestone, et n'est pas travaillée.

## Commits

[Conventional Commits](https://www.conventionalcommits.org), validés par
commitlint en CI.

```
<type>(<scope>): <sujet à l'impératif, ≤ 100 caractères, sans point final>
```

Types : `feat` `fix` `docs` `ci` `chore` `security` `perf` `hotfix` `test` `refactor`
Scope : le module métier concerné (`availability`, `payments`…) ou `infra`, `web`, `ci`.

```
feat(availability): calcul des créneaux avec buffers avant/après
fix(notifications): ne pas envoyer le rappel d'un RDV annulé
security(payments): vérifier la signature des webhooks sur le corps brut
```

## Pull requests

- Cible `develop` (ou `main` pour un `hotfix/*`).
- Titre en Conventional Commits — il devient le message de merge.
- Corps contenant **`Closes #<numéro>`** : c'est ce qui ferme l'issue et déplace
  la carte du Project en `Done`.
- Une PR = une issue.
- CI verte obligatoire : lint, types, tests, commitlint, scan de sécurité.

## Tests de l'outillage

`scripts/` porte la barrière de merge du dépôt (`pr_gate.py`) : une régression y
remergerait des PR sensibles sans que rien ne rougisse. Ses tests vivent dans
`scripts/tests/` et n'ont aucune dépendance — `unittest` de la bibliothèque
standard suffit.

```bash
npm run test:scripts                          # inclus dans npm run verify
python -m unittest discover -s scripts/tests  # le même, sans passer par npm
python -m unittest scripts.tests.test_pr_gate.TestSensitive -v   # un seul cas
```

La CI l'exécute sur chaque PR, dans le job « Tests de l'outillage (Python) » de
[ci.yml](.github/workflows/ci.yml).

## Definition of Done

- [ ] Code revu et approuvé
- [ ] Tests unitaires et d'intégration passants
- [ ] Test d'isolation inter-tenant pour tout endpoint nouveau
- [ ] Déployé et vérifié en recette (`staging`)
- [ ] Documenté (README de module, ADR si décision structurante)
- [ ] Critères d'acceptation de l'issue cochés

## Travailler avec Claude Code

Le dépôt embarque un environnement Claude Code complet dans [.claude/](.claude/) :

**Skills** — chargées automatiquement selon le contexte, ou explicitement :

| Skill | Quand |
|---|---|
| `booking-engine` | Créneaux, disponibilité, RDV, concurrence |
| `tenant-isolation` | Toute écriture de requête, migration ou endpoint |
| `api-module` | Tout travail dans `apps/api` |
| `web-frontend` | Tout travail dans `apps/web` |
| `payments-stripe` | Paiement, Stripe, encaissement, PCI |
| `notifications` | E-mail, SMS, rappels, SES/SNS |
| `aws-infra` | Terraform, AWS, déploiement |
| `project-flow` | Issues, branches, PR, Project |

**Commandes**

| Commande | Usage |
|---|---|
| `/ticket <issue>` | **Traitement complet et automatique** : worktree, branche, implémentation, `npm run verify`, PR, revue, merge, mise à jour du ticket et de la carte |
| `/feature-start <issue>` | Même départ, mais **pas à pas** : ouvre la branche et le plan, vous gardez la main sur la suite |
| `/pr-open` | Ouvre la PR de la branche courante avec les contrôles attendus |
| `/sprint-status [S1-S4]` | Point d'avancement factuel du sprint |
| `/adr-new <titre>` | Rédige un Architecture Decision Record |
| `/ticket-new` | Ouvre le ticket de traçabilité de la demande en cours |
| `/ticket-close` | Le referme avec le résumé des changements produits |

`/ticket` va jusqu'au merge sans approbation humaine — GitHub interdit
d'approuver sa propre PR, la revue automatique est donc un commentaire, pas une
approbation. Utiliser `/ticket <issue> --no-merge`, ou `/feature-start`, dès
qu'une relecture humaine compte : paiements, sécurité, migrations, infrastructure.

**Agents** : `tenant-leak-auditor` (audit d'isolation multi-tenant),
`mvp-scope-guard` (verdict dans/hors périmètre MVP)

**Traçabilité des demandes** : `/ticket-new` ouvre un ticket GitHub (label
`tracking`) pour historiser une demande faite à Claude Code, `/ticket-close` le
referme avec le résumé des changements produits. L'ouverture est délibérée — ce
qui ne mérite pas d'être documenté n'ouvre rien. Ces tickets historisent la
collaboration ; ils sont exclus du board de suivi du MVP et ne remplacent pas
les issues du backlog. Doctrine dans
[.claude/skills/project-flow/SKILL.md](.claude/skills/project-flow/SKILL.md) §12.
